"""
Builds the browser edition into docs/, which GitHub Pages serves as a free website.

Run me:  ../.venv/bin/python build_pages.py

Same UI files as the server edition (web/), plus web/local/: the search, answer and chat
logic running in the visitor's browser, with PDFs and chats kept on their device.
There is no server, so: no sign-in, no Groq/Claude, and voice uses the browser's own
speech recognition instead of Whisper.
"""

import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB, OUT = ROOT / "web", ROOT / "docs"

BOOT = """  <script>
    // Browser edition: answer "/api/..." inside the page (web/local/backend.js), no server.
    window.LOCAL_MODE = true;
    window.localBackendReady = new Promise((resolve) => (window.__resolveBackend = resolve));
  </script>
  <script type="module" src="local/backend.js"></script>
"""


def build() -> Path:
    if OUT.exists():
        shutil.rmtree(OUT)
    (OUT / "local").mkdir(parents=True)
    for name in ["style.css", "app.js", "scene3d.js", "sound.js"]:
        shutil.copy(WEB / name, OUT / name)
    for name in ["engine.js", "backend.js"]:
        shutil.copy(WEB / "local" / name, OUT / "local" / name)
    if (WEB / "logo.png").exists():
        shutil.copy(WEB / "logo.png", OUT / "logo.png")
    shutil.copy(ROOT / "data" / "sample_manual.pdf", OUT / "sample_manual.pdf")

    html = (WEB / "index.html").read_text()
    html = html.replace('"/static/', '"')                       # relative paths: the site lives under /<repo>/
    html = html.replace('  <script src="app.js"></script>', BOOT + '  <script src="app.js"></script>')
    html = html.replace(
        "Type or use the mic · with ambient music · change it any time in Settings",
        "Runs entirely in your browser · your PDFs never leave this device",
    )
    assert "LOCAL_MODE" in html, "couldn't find the app.js script tag"
    (OUT / "index.html").write_text(html)
    (OUT / ".nojekyll").write_text("")                           # serve files as they are
    return OUT


if __name__ == "__main__":
    print("built", build())
