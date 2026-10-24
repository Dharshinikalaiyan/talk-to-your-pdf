"""
CONCEPT: saved conversations, private to each user (same tenant rule as the PDFs).

Like ChatGPT: "+ New chat" starts a conversation, and every earlier one stays in the
sidebar, titled by its first question. Each message and its reply is one row, tagged with
its conversation. A conversation only exists once something has been said in it.

Replies are stored without the passage text (only page numbers), so the history never
becomes a second copy of anyone's documents. Every read checks the owner, and someone
else's conversation id looks exactly like one that doesn't exist.
"""

import json
import re
import secrets
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

KEEP_CONVERSATIONS = 100   # per user; the oldest beyond this are deleted
CONV_ID_RE = re.compile(r"^[0-9a-f]{16}$")


class ChatHistory:
    def __init__(self, db_path: Path):
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(db_path, check_same_thread=False)
        self.lock = threading.Lock()
        self.conn.executescript(
            """CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                title TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS conv_user ON conversations (user_id, updated_at);
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conv_id TEXT NOT NULL,
                at TEXT NOT NULL,
                message TEXT NOT NULL,
                via TEXT NOT NULL,
                reply TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS msg_conv ON messages (conv_id, id);"""
        )
        self.conn.commit()

    def _owns(self, user_id: str, conv_id: str | None) -> bool:
        if not conv_id or not CONV_ID_RE.match(conv_id):
            return False
        row = self.conn.execute("SELECT 1 FROM conversations WHERE id = ? AND user_id = ?", (conv_id, user_id)).fetchone()
        return row is not None

    def add(self, user_id: str, conv_id: str | None, message: str, via: str, reply: dict) -> str:
        """Save one exchange. Starts a new conversation unless `conv_id` is one of this user's. Returns its id."""
        now = datetime.now(timezone.utc).isoformat()
        # keep page numbers, drop the passage text
        reply = {**reply, "citations": [{"page": c["page"], "snippet": "", "score": c["score"]} for c in reply.get("citations", [])]}
        with self.lock:
            if not self._owns(user_id, conv_id):
                conv_id = secrets.token_hex(8)
                self.conn.execute(
                    "INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                    (conv_id, user_id, message[:80], now, now),
                )
                self._trim(user_id)
            self.conn.execute(
                "INSERT INTO messages (conv_id, at, message, via, reply) VALUES (?, ?, ?, ?, ?)",
                (conv_id, now, message[:500], via, json.dumps(reply)),
            )
            self.conn.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (now, conv_id))
            self.conn.commit()
        return conv_id

    def list(self, user_id: str) -> list[dict]:
        """The sidebar: this user's conversations, most recently used first."""
        with self.lock:
            rows = self.conn.execute(
                """SELECT c.id, c.title, c.updated_at, COUNT(m.id) FROM conversations c
                   LEFT JOIN messages m ON m.conv_id = c.id
                   WHERE c.user_id = ? GROUP BY c.id ORDER BY c.updated_at DESC""",
                (user_id,),
            ).fetchall()
        return [dict(zip(["id", "title", "updated_at", "messages"], r)) for r in rows]

    def get(self, user_id: str, conv_id: str) -> list[dict]:
        """One conversation's messages, oldest first. KeyError if it isn't this user's."""
        with self.lock:
            if not self._owns(user_id, conv_id):
                raise KeyError(conv_id)
            rows = self.conn.execute("SELECT message, via, reply FROM messages WHERE conv_id = ? ORDER BY id", (conv_id,)).fetchall()
        return [{"message": m, "via": v, "reply": json.loads(r)} for m, v, r in rows]

    def delete(self, user_id: str, conv_id: str) -> None:
        with self.lock:
            if not self._owns(user_id, conv_id):
                raise KeyError(conv_id)
            self._delete(conv_id)
            self.conn.commit()

    def delete_all(self, user_id: str) -> None:
        with self.lock:
            for (cid,) in self.conn.execute("SELECT id FROM conversations WHERE user_id = ?", (user_id,)).fetchall():
                self._delete(cid)
            self.conn.commit()

    def transfer(self, from_user: str, to_user: str) -> None:
        """A guest signs in: their conversations move into the account."""
        with self.lock:
            self.conn.execute("UPDATE conversations SET user_id = ? WHERE user_id = ?", (to_user, from_user))
            self.conn.commit()

    def expire(self, older_than: datetime) -> None:
        """Public demos: drop conversations nobody has touched since `older_than`."""
        with self.lock:
            for (cid,) in self.conn.execute("SELECT id FROM conversations WHERE updated_at < ?", (older_than.isoformat(),)).fetchall():
                self._delete(cid)
            self.conn.commit()

    def _delete(self, conv_id: str) -> None:
        self.conn.execute("DELETE FROM messages WHERE conv_id = ?", (conv_id,))
        self.conn.execute("DELETE FROM conversations WHERE id = ?", (conv_id,))

    def _trim(self, user_id: str) -> None:
        old = self.conn.execute(
            "SELECT id FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT -1 OFFSET ?",
            (user_id, KEEP_CONVERSATIONS),
        ).fetchall()
        for (cid,) in old:
            self._delete(cid)
