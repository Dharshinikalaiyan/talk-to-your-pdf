"""
CONCEPT: who is this request from? (the "tenant")

Two kinds of users:
  - GUEST:   every browser gets an anonymous id on its first visit. Its library lives
             only in that browser; clear cookies and it's gone.
  - ACCOUNT: after "Sign in with Google/Microsoft" (see auth.py). The id is derived from
             the provider's permanent user id, so the same person gets the same private
             library on any browser or device.

Either way the identity travels in a SIGNED cookie:

    cookie value:  base64(json payload) . HMAC-SHA256(server_secret, payload)

Change one character and the signature no longer matches; the server then treats the
browser as a brand-new guest. The cookie is HttpOnly (page scripts can't read it) and
SameSite=Lax (other sites can't make your browser use it in background requests).
"""

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import time
from dataclasses import asdict, dataclass
from pathlib import Path

USER_ID_RE = re.compile(r"^[0-9a-f]{32}$")
SESSION_DAYS = 30


@dataclass
class Identity:
    user_id: str                 # 32 hex chars; also the name of the user's upload folder
    kind: str = "guest"          # "guest" or "account"
    provider: str = ""           # "google" / "microsoft" for accounts
    name: str = ""
    email: str = ""
    issued_at: int = 0


def new_guest() -> Identity:
    return Identity(user_id=secrets.token_hex(16), issued_at=int(time.time()))


def account_id(provider: str, subject: str) -> str:
    """Stable library id for a signed-in person.

    `subject` is the provider's permanent id for the user ("sub" claim). We never key on
    email: emails can change or be reassigned to someone else, the sub can't.
    """
    return hashlib.sha256(f"{provider}:{subject}".encode()).hexdigest()[:32]


def load_secret(path: Path) -> bytes:
    """SESSION_SECRET from the environment, or a random one saved on first run.

    It must stay the same across restarts, or everyone gets logged out.
    """
    if os.environ.get("SESSION_SECRET"):
        return os.environ["SESSION_SECRET"].encode()
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(secrets.token_hex(32))
        path.chmod(0o600)  # readable by your user account only
    return path.read_text().strip().encode()


class SessionSigner:
    def __init__(self, secret: bytes):
        self.secret = secret

    def _signature(self, payload: str) -> str:
        return hmac.new(self.secret, payload.encode(), hashlib.sha256).hexdigest()

    def sign(self, identity: Identity) -> str:
        payload = base64.urlsafe_b64encode(json.dumps(asdict(identity)).encode()).decode().rstrip("=")
        return f"{payload}.{self._signature(payload)}"

    def verify(self, token: str | None) -> Identity | None:
        """Return the identity if the token is genuine and not expired, else None."""
        if not token or "." not in token:
            return None
        payload, signature = token.rsplit(".", 1)
        # compare_digest takes the same time however many characters match,
        # so an attacker can't guess a signature character by character.
        if not hmac.compare_digest(signature, self._signature(payload)):
            return None
        try:
            identity = Identity(**json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4))))
        except (ValueError, TypeError):
            return None
        if not USER_ID_RE.match(identity.user_id) or identity.kind not in ("guest", "account"):
            return None
        if time.time() - identity.issued_at > SESSION_DAYS * 24 * 3600:
            return None
        return identity
