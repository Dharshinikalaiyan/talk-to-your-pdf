"""
CONCEPT: "Sign in with Google / Microsoft" (OpenID Connect).

The app never sees your password. The flow:

  1. You click "Continue with Google". We redirect you to Google with our client id,
     a random `state` (stops someone forging the callback) and a random `nonce`
     (stops someone replaying an old sign-in).
  2. You sign in on Google's own page. Google redirects back to /auth/google/callback
     with a one-time `code`.
  3. Our server swaps the code for tokens, server-to-server, using our client secret.
  4. Authlib checks the ID token: Google's signature, that it was issued for OUR app
     (audience), by the right issuer, not expired, and with our nonce.
  5. We take the user's permanent id (`sub`) and turn it into a library id.

Each provider is switched on only when its client id AND secret are set:
  GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
  MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET
See SIGN_IN_SETUP.md for how to get them.
"""

import os
import re

from authlib.integrations.starlette_client import OAuth

PROVIDERS = {
    "google": {
        "label": "Google",
        "server_metadata_url": "https://accounts.google.com/.well-known/openid-configuration",
    },
    "microsoft": {
        "label": "Microsoft",
        # "common" accepts both work/school and personal Microsoft accounts.
        "server_metadata_url": "https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration",
    },
}

oauth = OAuth()


def configured() -> list[str]:
    return [
        name
        for name in PROVIDERS
        if os.environ.get(f"{name.upper()}_CLIENT_ID") and os.environ.get(f"{name.upper()}_CLIENT_SECRET")
    ]


def register_configured() -> None:
    for name in configured():
        if oauth.create_client(name) is None:
            oauth.register(
                name,
                client_id=os.environ[f"{name.upper()}_CLIENT_ID"],
                client_secret=os.environ[f"{name.upper()}_CLIENT_SECRET"],
                server_metadata_url=PROVIDERS[name]["server_metadata_url"],
                client_kwargs={"scope": "openid email profile"},
            )


def _microsoft_issuer_ok(claims, value) -> bool:
    # Through the shared "common" endpoint, Microsoft's issuer includes the user's
    # directory (tenant) id, so a fixed expected value can't be used. Instead require
    # exactly https://login.microsoftonline.com/<that token's own tid>/v2.0.
    tid = claims.get("tid", "")
    return bool(re.fullmatch(r"[0-9a-f-]{36}", tid)) and value == f"https://login.microsoftonline.com/{tid}/v2.0"


def claims_options(provider: str) -> dict | None:
    if provider == "microsoft":
        return {"iss": {"essential": True, "validate": _microsoft_issuer_ok}}
    return None  # Authlib checks Google's fixed issuer from its metadata
