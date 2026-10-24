"""
CONCEPT: an audit log of who touched which document.

One row per action: upload, ask, voice, view, delete, and DENIED attempts to
open a document that belongs to someone else. Denied rows are the interesting
ones: they show someone guessing or reusing another user's document id.

Questions are logged because they can matter in an investigation, but answers
and PDF text are not, so the log doesn't become a second copy of the documents.
"""

import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path


class AuditLog:
    def __init__(self, db_path: Path):
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(db_path, check_same_thread=False)
        self.lock = threading.Lock()
        self.conn.execute(
            """CREATE TABLE IF NOT EXISTS audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                at TEXT NOT NULL,
                user_id TEXT NOT NULL,
                action TEXT NOT NULL,
                doc_id TEXT,
                allowed INTEGER NOT NULL,
                detail TEXT
            )"""
        )
        self.conn.commit()

    def record(self, user_id: str, action: str, doc_id: str | None, allowed: bool = True, detail: str = "") -> None:
        with self.lock:
            self.conn.execute(
                "INSERT INTO audit (at, user_id, action, doc_id, allowed, detail) VALUES (?, ?, ?, ?, ?, ?)",
                (datetime.now(timezone.utc).isoformat(), user_id, action, doc_id, int(allowed), detail[:500]),
            )
            self.conn.commit()

    def for_user(self, user_id: str, limit: int = 50) -> list[dict]:
        """A user's own history only; nobody can read another user's rows."""
        with self.lock:
            rows = self.conn.execute(
                "SELECT at, action, doc_id, allowed, detail FROM audit WHERE user_id = ? ORDER BY id DESC LIMIT ?",
                (user_id, limit),
            ).fetchall()
        return [dict(zip(["at", "action", "doc_id", "allowed", "detail"], r)) for r in rows]

    def denied(self, limit: int = 50) -> list[dict]:
        """For the operator (you): recent attempts to open someone else's document."""
        with self.lock:
            rows = self.conn.execute(
                "SELECT at, user_id, action, doc_id FROM audit WHERE allowed = 0 ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
        return [dict(zip(["at", "user_id", "action", "doc_id"], r)) for r in rows]
