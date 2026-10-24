"""
Interactive PDF Assistant: web API + browser UI, multi-tenant.

Run me:   ../.venv/bin/uvicorn api:app --port 8766
Then open http://127.0.0.1:8766

Every visitor is a user with a private library: a guest (one browser), or an account
after "Sign in with Google/Microsoft" (any browser). Identity lives in a signed cookie,
see pdf_assistant/tenancy.py and auth.py. All document endpoints only ever see the
caller's own PDFs.

Sign-in (only when the provider's client id and secret are set, see SIGN_IN_SETUP.md):
  GET    /auth/{google|microsoft}/login     go to the provider's sign-in page
  GET    /auth/{google|microsoft}/callback  provider sends you back here
  POST   /auth/logout                       sign out (you become a new guest)

Endpoints (all scoped to the user in the session cookie):
  GET    /api/me                         who you are, your PDF count, available sign-in options
  POST   /api/documents                  upload a PDF (multipart form, field "file")
  GET    /api/documents                  list YOUR PDFs
  GET    /api/documents/{id}/file        the PDF itself, for the preview panel
  DELETE /api/documents/{id}             delete one of your PDFs
  POST   /api/documents/{id}/ask         {"question": "..."} -> answer + page citations
  POST   /api/documents/{id}/voice       raw 16 kHz mono 16-bit PCM audio -> same as /ask
  POST   /api/chat                       {"message": "...", "doc_id": optional} -> small talk, help,
                                         "which PDF?", or an answer (see pdf_assistant/conversation.py)
  POST   /api/chat/voice?doc_id=...      raw 16 kHz mono 16-bit PCM audio -> same as /api/chat
  GET    /api/activity                   your own audit history
  GET    /api/engines                    which answer engines are switched on

Answer engines (see pdf_assistant/answering.py):
  - Always:                  local re-ranker + reader, free
  - GROQ_API_KEY=...         Groq writes the answers (free tier, daily limits)
  - ANTHROPIC_API_KEY=...    Claude writes the answers (paid)
  CLOUD_DAILY_LIMIT=20       AI-written answers per visitor per day; after that, local answers
  SESSION_SECRET=...         cookie signing key (otherwise a random one is saved in data/)
  PUBLIC_URL=https://...     the app's public address, used to build sign-in callback URLs
  UPLOAD_TTL_HOURS=24        delete uploads after this many hours (public demos); 0 = keep them
  MAX_DOCS_PER_USER=100      how many PDFs one user can keep
"""

import os
import threading
import time
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from dotenv import load_dotenv

# Read settings and secrets from .env (git-ignored) before anything looks at os.environ.
# Real environment variables win over the file, so a deployment can override it.
load_dotenv(Path(__file__).resolve().parent / ".env", override=False)

import numpy as np
from fastapi import Depends, FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.middleware.sessions import SessionMiddleware

from pdf_assistant import Library
from authlib.integrations.starlette_client import OAuthError

from pdf_assistant import auth
from pdf_assistant.answering import GROQ_MODEL, generate_answer
from pdf_assistant.audit import AuditLog
from pdf_assistant.conversation import route
from pdf_assistant.library import Document
from pdf_assistant.models import Answer, DocumentInfo
from pdf_assistant.pdf_loader import PDFError
from pdf_assistant.tenancy import SESSION_DAYS, Identity, SessionSigner, account_id, load_secret, new_guest
from pdf_assistant.voice import SAMPLE_RATE, clean_for_speech, transcribe

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
app = FastAPI(title="Interactive PDF Assistant")
app.mount("/static", StaticFiles(directory=ROOT / "web"), name="static")
library = Library(DATA / "uploads")
audit = AuditLog(DATA / "audit.db")
SECRET = load_secret(DATA / "session_secret")
signer = SessionSigner(SECRET)
auth.register_configured()

COOKIE = "pdfa_session"
PUBLIC_URL = os.environ.get("PUBLIC_URL", "").rstrip("/")
SECURE_COOKIES = PUBLIC_URL.startswith("https://")
MAX_AUDIO_BYTES = 2 * 1024 * 1024  # ~60 seconds of 16 kHz audio


def _warm_up() -> None:
    """Load Whisper, the re-ranker and the reader in the background so the first question is fast."""
    from pdf_assistant.reader import warm_up

    warm_up()
    transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32))


threading.Thread(target=_warm_up, daemon=True).start()

# Public demo hygiene: strangers' uploads don't pile up on the server.
UPLOAD_TTL_HOURS = float(os.environ.get("UPLOAD_TTL_HOURS", "0"))


def _expire_uploads() -> None:
    while True:
        for owner, doc_id in library.expire(datetime.now(timezone.utc) - timedelta(hours=UPLOAD_TTL_HOURS)):
            audit.record(owner, "expired", doc_id, detail=f"older than {UPLOAD_TTL_HOURS:g} h")
        time.sleep(600)


if UPLOAD_TTL_HOURS > 0:
    threading.Thread(target=_expire_uploads, daemon=True).start()


# ---------------------------------------------------------------- who is asking? (the tenant)


@app.middleware("http")
async def session(request: Request, call_next):
    """Read the signed cookie; if it's missing, expired or forged, this browser becomes a new guest.

    A route can switch identity (sign in / sign out) by setting request.state.set_identity.
    """
    identity = signer.verify(request.cookies.get(COOKIE))
    request.state.set_identity = None if identity else new_guest()
    request.state.identity = identity or request.state.set_identity
    response = await call_next(request)
    if request.state.set_identity:
        response.set_cookie(
            COOKIE,
            signer.sign(request.state.set_identity),
            max_age=SESSION_DAYS * 24 * 3600,
            httponly=True,                                        # page scripts can't read it
            samesite="lax",                                       # other sites can't use it in background requests
            secure=SECURE_COOKIES or request.url.scheme == "https",  # HTTPS-only once deployed
        )
    return response


@app.middleware("http")
async def revalidate_static(request: Request, call_next):
    """Make browsers check for a newer UI on every load (cheap: unchanged files get a 304)."""
    response = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


# Short-lived cookie that holds the sign-in `state` and `nonce` while you're on Google's page.
# Added after the session middleware, so it wraps it and runs first.
app.add_middleware(SessionMiddleware, secret_key=SECRET.decode(), session_cookie="pdfa_signin",
                   max_age=600, same_site="lax", https_only=SECURE_COOKIES)


def current_identity(request: Request) -> Identity:
    return request.state.identity


def current_user(request: Request) -> str:
    return request.state.identity.user_id


def _doc(user: str, doc_id: str, action: str) -> Document:
    """Ownership check for every document endpoint. Denied attempts are audited."""
    try:
        return library.get(user, doc_id)
    except KeyError:
        audit.record(user, action, doc_id[:64], allowed=False)
        # Same message for "someone else's" and "doesn't exist", so ids can't be probed.
        raise HTTPException(status_code=404, detail="Document not found in your library.")


# ---------------------------------------------------------------- per-visitor limit for cloud engines
# Each visitor (by IP address) gets CLOUD_DAILY_LIMIT AI-written answers per day, then free
# local answers. Keyed by IP, not by user id: clearing cookies gives you a new user id,
# but not a new limit. It lives in memory, so it resets when the server restarts.
CLOUD_DAILY_LIMIT = int(os.environ.get("CLOUD_DAILY_LIMIT", "20"))
_cloud_uses: dict[tuple[str, date], int] = defaultdict(int)
_cloud_lock = threading.Lock()


def _take_cloud_slot(visitor: str) -> bool:
    with _cloud_lock:
        key = (visitor, date.today())
        if _cloud_uses[key] >= CLOUD_DAILY_LIMIT:
            return False
        _cloud_uses[key] += 1
        return True


def _cloud_enabled() -> bool:
    return any(os.environ.get(k) for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "GROQ_API_KEY"))


def _ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


# ---------------------------------------------------------------- answering


class AskRequest(BaseModel):
    question: str


def _answer(user: str, doc: Document, question: str, latency: dict[str, float], ip: str, action: str) -> Answer:
    t = time.perf_counter()
    citations = doc.search(question)  # searches this one document only
    latency["search"] = time.perf_counter() - t
    t = time.perf_counter()
    # Only spend a cloud slot when there is something to answer and a cloud engine is on.
    allow_cloud = bool(citations) and _cloud_enabled() and _take_cloud_slot(ip)
    result = generate_answer(question, citations, allow_cloud=allow_cloud)
    latency["answer"] = time.perf_counter() - t
    audit.record(user, action, doc.info.doc_id, detail=f"{question} | pages {[c.page for c in citations]} | {result.engine}")
    return Answer(
        question=question,
        answer=result.text,
        citations=citations,
        engine=result.engine,
        highlight=result.highlight,
        note=result.note,
        spoken=clean_for_speech(result.text),
        latency=latency,
    )


# ---------------------------------------------------------------- endpoints


@app.get("/", include_in_schema=False)
def ui() -> FileResponse:
    return FileResponse(ROOT / "web" / "index.html")


@app.get("/api/me")
def me(identity: Identity = Depends(current_identity)) -> dict:
    return {
        "user": identity.user_id[:8],
        "kind": identity.kind,
        "name": identity.name,
        "email": identity.email,
        "provider": identity.provider,
        "documents": len(library.list(identity.user_id)),
        "providers": [{"id": p, "label": auth.PROVIDERS[p]["label"]} for p in auth.configured()],
    }


# ---------------------------------------------------------------- sign-in


def _client(provider: str):
    client = auth.oauth.create_client(provider) if provider in auth.configured() else None
    if client is None:
        raise HTTPException(status_code=404, detail="That sign-in option isn't set up on this server.")
    return client


@app.get("/auth/{provider}/login", include_in_schema=False)
async def login(provider: str, request: Request):
    client = _client(provider)
    callback = f"{PUBLIC_URL}/auth/{provider}/callback" if PUBLIC_URL else str(request.url_for("auth_callback", provider=provider))
    return await client.authorize_redirect(request, callback)


@app.get("/auth/{provider}/callback", name="auth_callback", include_in_schema=False)
async def auth_callback(provider: str, request: Request):
    client = _client(provider)
    try:
        token = await client.authorize_access_token(request, claims_options=auth.claims_options(provider))
    except OAuthError as e:  # cancelled, expired, replayed, or a token that failed validation
        audit.record(request.state.identity.user_id, "sign_in", None, allowed=False, detail=f"{provider}: {e.error}")
        return RedirectResponse("/?signin=failed", status_code=303)
    info = token.get("userinfo") or {}
    if not info.get("sub"):
        return RedirectResponse("/?signin=failed", status_code=303)

    before = request.state.identity
    account = Identity(
        user_id=account_id(provider, info["sub"]),
        kind="account",
        provider=provider,
        name=(info.get("name") or "")[:80],
        email=(info.get("email") or "")[:120],
        issued_at=int(time.time()),
    )
    moved = library.transfer(before.user_id, account.user_id) if before.kind == "guest" else 0
    audit.record(account.user_id, "sign_in", None, detail=f"{provider}; brought {moved} guest PDF(s)")
    request.state.set_identity = account
    return RedirectResponse(f"/?signin=ok&moved={moved}", status_code=303)


@app.post("/auth/logout")
def logout(request: Request, identity: Identity = Depends(current_identity)) -> dict:
    audit.record(identity.user_id, "sign_out", None)
    request.state.set_identity = new_guest()  # a fresh, empty guest library; the account's PDFs stay in the account
    return {"signed_out": True}


@app.post("/api/documents", response_model=DocumentInfo)
async def upload(file: UploadFile, user: str = Depends(current_user)) -> DocumentInfo:
    data = await file.read()
    try:
        info = library.add(user, file.filename or "document.pdf", data)
    except (PDFError, ValueError) as e:
        raise HTTPException(status_code=422, detail=str(e))
    audit.record(user, "upload", info.doc_id, detail=info.filename)
    return info


@app.post("/api/sample", response_model=DocumentInfo)
def sample(user: str = Depends(current_user)) -> DocumentInfo:
    """Add the made-up Helios H2 manual to YOUR library, so there is something to try right away."""
    from make_sample_pdf import build

    path = DATA / "sample_manual.pdf"
    if not path.exists():
        build(path)
    info = library.add(user, "Helios H2 manual (sample).pdf", path.read_bytes())
    audit.record(user, "upload", info.doc_id, detail=info.filename)
    return info


@app.get("/api/documents", response_model=list[DocumentInfo])
def documents(user: str = Depends(current_user)) -> list[DocumentInfo]:
    return library.list(user)


@app.get("/api/documents/{doc_id}/file", include_in_schema=False)
def pdf_file(doc_id: str, user: str = Depends(current_user)) -> FileResponse:
    _doc(user, doc_id, "view")
    return FileResponse(
        library.pdf_path(user, doc_id),
        media_type="application/pdf",
        headers={"Cache-Control": "private, no-store"},  # don't keep private PDFs in shared caches
    )


@app.delete("/api/documents/{doc_id}")
def delete(doc_id: str, user: str = Depends(current_user)) -> dict:
    _doc(user, doc_id, "delete")
    library.delete(user, doc_id)
    audit.record(user, "delete", doc_id)
    return {"deleted": doc_id}


@app.post("/api/documents/{doc_id}/ask", response_model=Answer)
def ask(doc_id: str, body: AskRequest, request: Request, user: str = Depends(current_user)) -> Answer:
    doc = _doc(user, doc_id, "ask")
    question = body.question.strip()
    if not question:
        raise HTTPException(status_code=422, detail="Type a question first.")
    if len(question) > 500:
        raise HTTPException(status_code=422, detail="Keep questions under 500 characters.")
    return _answer(user, doc, question, {}, _ip(request), "ask")


@app.post("/api/documents/{doc_id}/voice", response_model=Answer)
async def voice(doc_id: str, request: Request, user: str = Depends(current_user)) -> Answer:
    doc = _doc(user, doc_id, "voice")
    body = await request.body()
    if len(body) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="That recording is too long. Keep questions under a minute.")
    audio = np.frombuffer(body[: len(body) // 2 * 2], dtype=np.int16).astype(np.float32) / 32768
    t = time.perf_counter()
    question = transcribe(audio, hint=doc.info.filename.rsplit(".", 1)[0].replace("_", " "))
    latency = {"speech-to-text": time.perf_counter() - t}
    if not question:
        raise HTTPException(status_code=422, detail="No speech detected. Hold the mic a little longer and speak clearly.")
    return _answer(user, doc, question, latency, _ip(request), "voice")


# ---------------------------------------------------------------- one chat box for everything


class ChatRequest(BaseModel):
    message: str
    doc_id: str | None = None   # the PDF that's open in the UI, if any


def _chat(user: str, message: str, doc_id: str | None, latency: dict[str, float], ip: str, action: str) -> Answer:
    """Route a message: small talk / help / picking a PDF, or a question answered from a PDF."""
    current = _doc(user, doc_id, action).info if doc_id else None
    r = route(message, library.list(user), current)
    if r.ask_doc:
        answer = _answer(user, library.get(user, r.ask_doc.doc_id), message, latency, ip, action)
        answer.doc_id = r.ask_doc.doc_id
        answer.open_doc = r.open_doc
        return answer
    audit.record(user, f"{action}_chat", r.open_doc.doc_id if r.open_doc else None, detail=message[:200])
    return Answer(
        question=message,
        answer=r.reply,
        citations=[],
        kind="chat",
        doc_id=r.open_doc.doc_id if r.open_doc else (current.doc_id if current else ""),
        open_doc=r.open_doc,
        choices=r.choices,
        pending=r.pending,
        spoken=clean_for_speech(r.reply.replace("\n", " ")),
        latency=latency,
    )


@app.post("/api/chat", response_model=Answer)
def chat(body: ChatRequest, request: Request, user: str = Depends(current_user)) -> Answer:
    message = body.message.strip()
    if not message:
        raise HTTPException(status_code=422, detail="Type a message first.")
    if len(message) > 500:
        raise HTTPException(status_code=422, detail="Keep messages under 500 characters.")
    return _chat(user, message, body.doc_id, {}, _ip(request), "ask")


@app.post("/api/chat/voice", response_model=Answer)
async def chat_voice(request: Request, doc_id: str | None = None, user: str = Depends(current_user)) -> Answer:
    if doc_id:
        _doc(user, doc_id, "voice")
    body = await request.body()
    if len(body) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="That recording is too long. Keep questions under a minute.")
    audio = np.frombuffer(body[: len(body) // 2 * 2], dtype=np.int16).astype(np.float32) / 32768
    # PDF names help Whisper spell them, so "open the Helios manual" is heard right
    names = ", ".join(d.filename.rsplit(".", 1)[0].replace("_", " ") for d in library.list(user)[-10:])
    t = time.perf_counter()
    message = transcribe(audio, hint=names)
    latency = {"speech-to-text": time.perf_counter() - t}
    if not message:
        raise HTTPException(status_code=422, detail="No speech detected. Hold the mic a little longer and speak clearly.")
    return _chat(user, message[:500], doc_id, latency, _ip(request), "voice")


@app.get("/api/activity")
def activity(user: str = Depends(current_user)) -> list[dict]:
    return audit.for_user(user)


@app.get("/api/engines")
def engines() -> dict:
    """Tells the UI which engine will answer, so it can show it before the first question."""
    if os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        primary = "claude"
    elif os.environ.get("GROQ_API_KEY"):
        primary = "groq"
    else:
        primary = "local"
    return {"primary": primary, "groq_model": GROQ_MODEL, "cloud_daily_limit": CLOUD_DAILY_LIMIT,
            "upload_ttl_hours": UPLOAD_TTL_HOURS}
