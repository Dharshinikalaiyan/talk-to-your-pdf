"""
Save your Google sign-in keys into .env without opening an editor.

Run me:  ../.venv/bin/python set_google_keys.py

The secret is hidden while you type and is never printed. Other lines in .env are kept.
"""

import getpass
import re
from pathlib import Path

ENV = Path(__file__).resolve().parent / ".env"
EXAMPLE = Path(__file__).resolve().parent / ".env.example"


def ask(prompt: str, pattern: str, hint: str, secret: bool = False) -> str:
    while True:
        value = (getpass.getpass(prompt) if secret else input(prompt)).strip().strip("'\"")
        if re.fullmatch(pattern, value):
            return value
        print(f"  That doesn't look right: {hint} Try again (or Ctrl+C to stop).")


def save(values: dict[str, str]) -> None:
    lines = (ENV if ENV.exists() else EXAMPLE).read_text().splitlines()
    done = set()
    for i, line in enumerate(lines):
        key = line.split("=", 1)[0].strip()
        if key in values:
            lines[i] = f"{key}={values[key]}"
            done.add(key)
    lines += [f"{k}={v}" for k, v in values.items() if k not in done]
    ENV.write_text("\n".join(lines) + "\n")
    ENV.chmod(0o600)  # readable by your user account only


if __name__ == "__main__":
    print("Paste the values from Google Cloud: Google Auth Platform -> Clients -> your web client.\n")
    client_id = ask(
        "Client ID: ",
        r"[0-9]+-[0-9a-z]+\.apps\.googleusercontent\.com",
        "it ends with .apps.googleusercontent.com.",
    )
    secret = ask("Client secret (hidden as you type): ", r"[A-Za-z0-9_\-]{20,}", "it usually starts with GOCSPX-.", secret=True)
    save({"GOOGLE_CLIENT_ID": client_id, "GOOGLE_CLIENT_SECRET": secret})
    print(f"\nSaved to {ENV.name}. Now tell Claude \"done\" so the server can be restarted.")
