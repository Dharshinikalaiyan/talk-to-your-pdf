"""
Run me:  ../.venv/bin/pytest -q

Uses the made-up manual from make_sample_pdf.py, so we know which page holds each fact.
"""

import shutil
import subprocess
import wave

import numpy as np
import pytest
from fastapi.testclient import TestClient

from make_sample_pdf import build
from pdf_assistant import Library
from pdf_assistant.pdf_loader import PDFError, chunk_pdf
from pdf_assistant.voice import clean_for_speech

ALICE = "a" * 32  # user ids are 32 hex characters
BOB = "b" * 32


@pytest.fixture(scope="module")
def sample_pdf(tmp_path_factory):
    return build(tmp_path_factory.mktemp("pdf") / "manual.pdf").read_bytes()


@pytest.fixture(scope="module")
def doc(sample_pdf, tmp_path_factory):
    lib = Library(tmp_path_factory.mktemp("uploads"))
    info = lib.add(ALICE, "manual.pdf", sample_pdf)
    return lib.get(ALICE, info.doc_id)


def test_every_chunk_keeps_its_page(sample_pdf):
    chunks, pages = chunk_pdf("d", sample_pdf)
    assert pages == 5
    assert {c.page for c in chunks} == {1, 2, 3, 4, 5}


@pytest.mark.parametrize(
    "question, page",
    [
        ("How long is the warranty?", 5),
        ("What does error E07 mean?", 4),
        ("How much does the battery weigh?", 1),
        ("What does a blinking red light mean?", 4),
        ("Who can install it?", 2),
        ("How much clear space do I need around the battery?", 3),
        ("How much space do I need around it?", 3),
        ("Is it safe in a bathroom?", 2),
    ],
)
def test_top_citation_is_the_right_page(doc, question, page):
    assert doc.search(question)[0].page == page


@pytest.mark.parametrize(
    "question",
    ["What is the capital of France?", "Can I bake a cake?", "What is the salary of the CEO?", "How do I reset my password?"],
)
def test_unrelated_questions_find_nothing(doc, question):
    assert doc.search(question) == []


def test_rejects_non_pdf_and_scanned(tmp_path):
    with pytest.raises(PDFError, match="isn't a PDF"):
        chunk_pdf("x", b"hello")
    from fpdf import FPDF

    blank = FPDF()
    blank.add_page()  # a page with no text layer, like a scanned image
    with pytest.raises(PDFError, match="scanned"):
        chunk_pdf("x", bytes(blank.output()))


def test_same_file_twice_by_same_user_is_indexed_once(sample_pdf, tmp_path):
    lib = Library(tmp_path)
    assert lib.add(ALICE, "a.pdf", sample_pdf).doc_id == lib.add(ALICE, "b.pdf", sample_pdf).doc_id
    assert len(lib.docs) == 1


def test_clean_for_speech():
    assert clean_for_speech("(offline mode) It lasts **10 years** [p. 5].") == "It lasts 10 years."


def test_api_upload_ask_and_voice(sample_pdf, tmp_path, monkeypatch):
    import api

    _isolate_api(api, tmp_path, monkeypatch)
    client = TestClient(api.app)

    bad = client.post("/api/documents", files={"file": ("notes.txt", b"hello", "text/plain")})
    assert bad.status_code == 422

    info = client.post("/api/documents", files={"file": ("manual.pdf", sample_pdf, "application/pdf")}).json()
    assert info["pages"] == 5

    ans = client.post(f"/api/documents/{info['doc_id']}/ask", json={"question": "What does error E07 mean?"}).json()
    assert ans["citations"][0]["page"] == 4

    if shutil.which("say"):  # macOS: speak the question into a WAV, send it like the browser does
        wav = tmp_path / "q.wav"
        subprocess.run(["say", "-o", str(wav), "--data-format=LEI16@16000", "How long is the warranty?"], check=True)
        with wave.open(str(wav)) as w:
            pcm = w.readframes(w.getnframes())
        res = client.post(f"/api/documents/{info['doc_id']}/voice", content=pcm).json()
        assert "warranty" in res["question"].lower()
        assert res["citations"][0]["page"] == 5

    assert client.get("/api/documents/nope/file").status_code == 404


def test_local_answer_gives_short_answer_and_page(doc):
    from pdf_assistant.answering import local_answer

    result = local_answer("How long is the warranty?", doc.search("How long is the warranty?"))
    assert result.engine == "local"
    assert "10-year" in result.highlight
    assert result.text.endswith("[p. 5]")


def test_local_answer_for_error_code(doc):
    from pdf_assistant.answering import local_answer

    result = local_answer("What does error E07 mean?", doc.search("What does error E07 mean?"))
    assert "inverter connection was lost" in result.text and result.text.endswith("[p. 4]")


# ---------------------------------------------------------------- engine chain (Groq is simulated)

import httpx  # noqa: E402

from pdf_assistant import answering  # noqa: E402


@pytest.fixture
def no_keys(monkeypatch):
    for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "GROQ_API_KEY"):
        monkeypatch.delenv(k, raising=False)


def _fake_groq(monkeypatch, status: int, text: str = "It lasts 10 years [p. 5]."):
    def post(url, **kwargs):
        assert kwargs["headers"]["Authorization"] == "Bearer test-key"
        body = {"choices": [{"message": {"content": text}}]} if status == 200 else {"error": "x"}
        return httpx.Response(status, json=body, request=httpx.Request("POST", url))

    monkeypatch.setenv("GROQ_API_KEY", "test-key")
    monkeypatch.setattr(answering.httpx, "post", post)


def test_no_keys_answers_locally(doc, no_keys):
    result = answering.generate_answer("How long is the warranty?", doc.search("How long is the warranty?"))
    assert result.engine == "local" and result.note == ""


def test_groq_answers_when_key_is_set(doc, no_keys, monkeypatch):
    _fake_groq(monkeypatch, 200)
    result = answering.generate_answer("How long is the warranty?", doc.search("How long is the warranty?"))
    assert result.engine == "groq" and result.text == "It lasts 10 years [p. 5]."


def test_groq_rate_limit_falls_back_to_local(doc, no_keys, monkeypatch):
    _fake_groq(monkeypatch, 429)
    result = answering.generate_answer("How long is the warranty?", doc.search("How long is the warranty?"))
    assert result.engine == "local" and "limit" in result.note and "10-year" in result.highlight


def test_groq_outage_falls_back_to_local(doc, no_keys, monkeypatch):
    _fake_groq(monkeypatch, 503)
    result = answering.generate_answer("How long is the warranty?", doc.search("How long is the warranty?"))
    assert result.engine == "local" and "unavailable" in result.note


def test_not_found_never_calls_groq(doc, no_keys, monkeypatch):
    _fake_groq(monkeypatch, 500)  # would fail loudly if called
    result = answering.generate_answer("Can I bake a cake?", doc.search("Can I bake a cake?"))
    assert result.text == answering.NOT_FOUND


def test_visitor_daily_limit(sample_pdf, tmp_path, no_keys, monkeypatch):
    import api

    _fake_groq(monkeypatch, 200)
    _isolate_api(api, tmp_path, monkeypatch)
    monkeypatch.setattr(api, "CLOUD_DAILY_LIMIT", 2)
    api._cloud_uses.clear()
    client = TestClient(api.app)
    doc_id = client.post("/api/documents", files={"file": ("m.pdf", sample_pdf, "application/pdf")}).json()["doc_id"]

    engines = [
        client.post(f"/api/documents/{doc_id}/ask", json={"question": "How long is the warranty?"}).json()
        for _ in range(3)
    ]
    assert [e["engine"] for e in engines] == ["groq", "groq", "local"]
    assert "today's limit" in engines[2]["note"]
    assert client.get("/api/engines").json()["primary"] == "groq"


# ---------------------------------------------------------------- multi-tenant isolation


def _isolate_api(api, tmp_path, monkeypatch):
    """Point the app at an empty library and audit log for this test."""
    from pdf_assistant.audit import AuditLog

    monkeypatch.setattr(api, "library", Library(tmp_path / "uploads"))
    monkeypatch.setattr(api, "audit", AuditLog(tmp_path / "audit.db"))
    from pdf_assistant.history import ChatHistory

    monkeypatch.setattr(api, "history", ChatHistory(tmp_path / "conversations.db"))


@pytest.fixture
def two_users(sample_pdf, tmp_path, monkeypatch):
    """Alice and Bob: two browsers, each with its own cookie jar. Alice uploads the manual."""
    import api

    _isolate_api(api, tmp_path, monkeypatch)
    alice, bob = TestClient(api.app), TestClient(api.app)
    doc = alice.post("/api/documents", files={"file": ("alice-private.pdf", sample_pdf, "application/pdf")}).json()
    bob.get("/api/me")  # Bob visits and gets his own session
    return api, alice, bob, doc["doc_id"]


def test_each_browser_gets_its_own_signed_session(two_users):
    _, alice, bob, _ = two_users
    a, b = alice.cookies.get("pdfa_session"), bob.cookies.get("pdfa_session")
    assert a and b and a != b
    assert alice.get("/api/me").json()["documents"] == 1
    assert bob.get("/api/me").json()["documents"] == 0


def test_other_users_cannot_list_view_ask_or_delete(two_users):
    api, alice, bob, doc_id = two_users
    assert bob.get("/api/documents").json() == []
    assert bob.get(f"/api/documents/{doc_id}/file").status_code == 404
    assert bob.post(f"/api/documents/{doc_id}/ask", json={"question": "How long is the warranty?"}).status_code == 404
    assert bob.post(f"/api/documents/{doc_id}/voice", content=b"\x00" * 32000).status_code == 404
    assert bob.delete(f"/api/documents/{doc_id}").status_code == 404
    # Alice still has everything.
    assert alice.get(f"/api/documents/{doc_id}/file").status_code == 200
    assert alice.post(f"/api/documents/{doc_id}/ask", json={"question": "How long is the warranty?"}).json()["citations"]


def test_someone_elses_id_looks_exactly_like_a_missing_one(two_users):
    _, _, bob, doc_id = two_users
    theirs = bob.get(f"/api/documents/{doc_id}/file")
    missing = bob.get("/api/documents/0123456789abcdef/file")
    assert theirs.status_code == missing.status_code == 404
    assert theirs.json() == missing.json()  # nothing to tell "exists" from "doesn't exist"


def test_same_file_uploaded_by_two_users_gets_different_ids(two_users, sample_pdf):
    _, alice, bob, alice_id = two_users
    bob_id = bob.post("/api/documents", files={"file": ("m.pdf", sample_pdf, "application/pdf")}).json()["doc_id"]
    assert bob_id != alice_id
    bob.delete(f"/api/documents/{bob_id}")
    assert alice.get(f"/api/documents/{alice_id}/file").status_code == 200  # Bob deleting his copy doesn't touch Alice's


def test_forged_cookie_gets_a_fresh_empty_library(two_users):
    api, alice, _, doc_id = two_users
    user_id, signature = alice.cookies.get("pdfa_session").split(".")
    forged = TestClient(api.app)
    forged.cookies.set("pdfa_session", f"{user_id}.{'0' * len(signature)}")  # right id, fake signature
    assert forged.get("/api/documents").json() == []
    assert forged.get(f"/api/documents/{doc_id}/file").status_code == 404


def test_path_tricks_are_rejected(two_users):
    _, _, bob, _ = two_users
    for bad in ["..%2F..%2Fsession_secret", "%2e%2e", "abc", "0" * 17]:
        assert bob.get(f"/api/documents/{bad}/file").status_code == 404


def test_denied_attempts_are_audited_and_activity_is_private(two_users):
    api, alice, bob, doc_id = two_users
    bob.get(f"/api/documents/{doc_id}/file")
    denied = api.audit.denied()
    assert denied and denied[0]["doc_id"] == doc_id and denied[0]["action"] == "view"
    assert [r["action"] for r in alice.get("/api/activity").json()] == ["upload"]
    assert all(r["doc_id"] != doc_id or not r["allowed"] for r in bob.get("/api/activity").json())


def test_library_survives_restart_with_owners_intact(sample_pdf, tmp_path):
    lib = Library(tmp_path)
    info = lib.add(ALICE, "a.pdf", sample_pdf)
    reloaded = Library(tmp_path)
    assert reloaded.get(ALICE, info.doc_id).info.filename == "a.pdf"
    with pytest.raises(KeyError):
        reloaded.get(BOB, info.doc_id)


# ---------------------------------------------------------------- sign in with Google / Microsoft (provider simulated)


@pytest.fixture
def google(two_users, monkeypatch):
    """Turn Google sign-in on, with Google's side simulated: the test picks who 'signs in'."""
    from starlette.responses import RedirectResponse

    from pdf_assistant import auth

    api, alice, bob, doc_id = two_users
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "test-client")
    monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "test-secret")
    auth.register_configured()
    client = auth.oauth.create_client("google")
    who = {"sub": None}

    async def authorize_redirect(request, redirect_uri):
        assert redirect_uri.endswith("/auth/google/callback")
        return RedirectResponse(f"{redirect_uri}?code=fake&state=fake")

    async def authorize_access_token(request, **kwargs):
        if who["sub"] is None:
            from authlib.integrations.starlette_client import OAuthError

            raise OAuthError(error="access_denied")
        return {"userinfo": {"sub": who["sub"], "name": "Test Person", "email": "test@example.com"}}

    monkeypatch.setattr(client, "authorize_redirect", authorize_redirect)
    monkeypatch.setattr(client, "authorize_access_token", authorize_access_token)

    def sign_in(browser, sub):
        who["sub"] = sub
        return browser.get("/auth/google/login", follow_redirects=True)

    return api, alice, bob, doc_id, sign_in


def test_sign_in_options_only_show_when_configured(two_users, monkeypatch):
    _, alice, _, _ = two_users
    for k in ("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"):
        monkeypatch.delenv(k, raising=False)
    assert alice.get("/api/me").json()["providers"] == []
    assert alice.get("/auth/google/login", follow_redirects=False).status_code == 404


def test_guest_pdfs_move_into_the_account_on_sign_in(google):
    api, alice, _, doc_id, sign_in = google
    res = sign_in(alice, "google-user-1")
    assert res.url.path == "/" and "moved=1" in str(res.url)
    me = alice.get("/api/me").json()
    assert me["kind"] == "account" and me["name"] == "Test Person" and me["documents"] == 1
    assert alice.get(f"/api/documents/{doc_id}/file").status_code == 200


def test_account_library_follows_you_to_another_browser(google):
    api, alice, _, doc_id, sign_in = google
    sign_in(alice, "google-user-1")
    laptop = TestClient(api.app)
    sign_in(laptop, "google-user-1")
    assert [d["doc_id"] for d in laptop.get("/api/documents").json()] == [doc_id]


def test_different_accounts_stay_isolated(google):
    _, alice, bob, doc_id, sign_in = google
    sign_in(alice, "google-user-1")
    sign_in(bob, "google-user-2")
    assert bob.get("/api/documents").json() == []
    assert bob.get(f"/api/documents/{doc_id}/file").status_code == 404


def test_sign_out_then_back_in(google):
    _, alice, _, doc_id, sign_in = google
    sign_in(alice, "google-user-1")
    alice.post("/auth/logout")
    assert alice.get("/api/me").json()["kind"] == "guest"
    assert alice.get("/api/documents").json() == []  # signed out: the account's PDFs aren't visible
    sign_in(alice, "google-user-1")
    assert [d["doc_id"] for d in alice.get("/api/documents").json()] == [doc_id]


def test_failed_sign_in_stays_guest(google):
    api, alice, _, _, sign_in = google
    res = sign_in(alice, None)  # user pressed "Cancel" on Google's page
    assert "signin=failed" in str(res.url)
    assert alice.get("/api/me").json()["kind"] == "guest"
    assert any(r["action"] == "sign_in" for r in api.audit.denied())


def test_tampered_identity_is_rejected(google):
    import base64
    import json

    api, alice, _, _, sign_in = google
    sign_in(alice, "google-user-1")
    payload, signature = alice.cookies.get("pdfa_session").rsplit(".", 1)
    data = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    data["user_id"] = BOB  # try to become someone else, keep the old signature
    forged = base64.urlsafe_b64encode(json.dumps(data).encode()).decode().rstrip("=")
    attacker = TestClient(api.app)
    attacker.cookies.set("pdfa_session", f"{forged}.{signature}")
    assert attacker.get("/api/me").json()["kind"] == "guest"


def test_microsoft_issuer_must_match_the_token_tenant():
    from pdf_assistant.auth import _microsoft_issuer_ok

    tid = "72f988bf-86f1-41af-91ab-2d7cd011db47"
    assert _microsoft_issuer_ok({"tid": tid}, f"https://login.microsoftonline.com/{tid}/v2.0")
    assert not _microsoft_issuer_ok({"tid": tid}, "https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/v2.0")
    assert not _microsoft_issuer_ok({"tid": tid}, "https://evil.example.com/v2.0")
    assert not _microsoft_issuer_ok({}, "https://login.microsoftonline.com//v2.0")


# ---------------------------------------------------------------- the chat router (small talk, help, picking a PDF)

from pdf_assistant.conversation import route  # noqa: E402
from pdf_assistant.models import DocumentInfo  # noqa: E402

DOCS = [
    DocumentInfo(doc_id="1", filename="Helios H2 manual (sample).pdf", pages=5, chunks=9),
    DocumentInfo(doc_id="2", filename="Lease agreement 2025.pdf", pages=3, chunks=4),
    DocumentInfo(doc_id="3", filename="Warranty policy.pdf", pages=2, chunks=3),
]


@pytest.mark.parametrize("message", ["Hi", "hi whats up", "Hello there!", "how are you?", "good morning"])
def test_greetings_get_a_friendly_reply(message):
    r = route(message, DOCS, None)
    assert r.reply.startswith("Hi") and not r.ask_doc


@pytest.mark.parametrize("message", ["help", "How does this app work?", "what can you do", "how do I use this"])
def test_how_to_use_questions_get_the_guide(message):
    assert "how it works" in route(message, DOCS, None).reply


def test_app_how_to_vs_a_question_about_the_pdf():
    assert "Upload" in route("how do I upload a pdf?", DOCS, None).reply
    # same verbs, but about the manual's content -> goes to the open PDF
    assert route("how do i delete the error log", DOCS, DOCS[0]).ask_doc == DOCS[0]


def test_naming_a_pdf_opens_it():
    r = route("open the lease agreement", DOCS, None)
    assert r.open_doc == DOCS[1] and not r.ask_doc and "Opened" in r.reply


def test_naming_a_pdf_in_a_question_opens_it_and_answers():
    r = route("How long is the warranty in the helios manual?", DOCS, None)
    assert r.open_doc == DOCS[0] and r.ask_doc == DOCS[0]


def test_a_word_from_another_file_name_doesnt_switch_the_open_pdf():
    r = route("Is the warranty transferable?", DOCS, DOCS[0])
    assert r.ask_doc == DOCS[0] and r.open_doc is None


def test_explicit_switch_moves_to_the_other_pdf():
    assert route("switch to the lease", DOCS, DOCS[0]).open_doc == DOCS[1]


def test_no_pdf_chosen_asks_which_one_and_remembers_the_question():
    r = route("What are the key dates?", DOCS, None)
    assert r.choices and r.pending == "What are the key dates?" and not r.ask_doc


def test_only_one_pdf_is_used_automatically():
    r = route("What are the key dates?", DOCS[:1], None)
    assert r.open_doc == DOCS[0] and r.ask_doc == DOCS[0]


def test_chat_api_end_to_end(sample_pdf, tmp_path, monkeypatch):
    import api

    _isolate_api(api, tmp_path, monkeypatch)
    client = TestClient(api.app)
    hi = client.post("/api/chat", json={"message": "hi"}).json()
    assert hi["kind"] == "chat" and "Upload" in hi["answer"]
    info = client.post("/api/documents", files={"file": ("Helios manual.pdf", sample_pdf, "application/pdf")}).json()
    ans = client.post("/api/chat", json={"message": "How long is the warranty?"}).json()  # only one PDF -> it's used
    assert ans["kind"] == "doc" and ans["open_doc"]["doc_id"] == info["doc_id"] and ans["citations"][0]["page"] == 5
    # someone else's (or a made-up) doc id is refused, like every other document endpoint
    assert client.post("/api/chat", json={"message": "hi", "doc_id": "0" * 16}).status_code == 404


def test_old_uploads_expire(sample_pdf, tmp_path):
    from datetime import datetime, timedelta, timezone

    lib = Library(tmp_path)
    info = lib.add(ALICE, "a.pdf", sample_pdf)
    assert lib.expire(datetime.now(timezone.utc) - timedelta(hours=24)) == []  # still fresh
    assert lib.expire(datetime.now(timezone.utc) + timedelta(seconds=1)) == [(ALICE, info.doc_id)]
    assert lib.list(ALICE) == [] and not any(tmp_path.iterdir())


def test_saved_chats_work_like_a_sidebar(two_users):
    _, alice, bob, _ = two_users
    first = alice.post("/api/chat", json={"message": "hi"}).json()["conv_id"]
    same = alice.post("/api/chat", json={"message": "How long is the warranty?", "conv_id": first}).json()
    assert same["conv_id"] == first                                   # same chat
    second = alice.post("/api/chat", json={"message": "What does error E07 mean?"}).json()["conv_id"]
    assert second != first                                            # "+ New chat"
    chats = alice.get("/api/conversations").json()
    assert [c["title"] for c in chats] == ["What does error E07 mean?", "hi"] and chats[1]["messages"] == 2
    msgs = alice.get(f"/api/conversations/{first}").json()
    assert [m["message"] for m in msgs] == ["hi", "How long is the warranty?"]
    assert msgs[1]["reply"]["citations"][0]["snippet"] == ""         # no document text kept
    # private: Bob can't list, read, add to or delete Alice's chats
    assert bob.get("/api/conversations").json() == []
    assert bob.get(f"/api/conversations/{first}").status_code == 404
    assert bob.post("/api/chat", json={"message": "hi", "conv_id": first}).json()["conv_id"] != first
    assert bob.delete(f"/api/conversations/{first}").status_code == 404
    alice.delete(f"/api/conversations/{first}")
    assert [c["id"] for c in alice.get("/api/conversations").json()] == [second]
    alice.delete("/api/conversations")
    assert alice.get("/api/conversations").json() == []


def test_prefers_the_best_ranked_passage_on_a_near_tie(doc):
    """'30 days' (registration, p.3) and '10-year' (p.5) get near-identical reader scores."""
    from pdf_assistant.answering import local_answer

    result = local_answer("How long is the warranty?", doc.search("How long is the warranty?"))
    assert result.highlight == "10-year" and "[p. 5]" in result.text


@pytest.mark.parametrize("message, cleaned", [
    ("How long is the warranty in the helios manual?", "How long is the warranty?"),
    ("What does error E07 mean in the Helios H2 manual?", "What does error E07 mean?"),
    ("helios warranty", "warranty"),            # too short after stripping -> keep the original
])
def test_naming_the_pdf_is_taken_out_of_the_question(message, cleaned):
    from pdf_assistant.conversation import strip_name

    expected = cleaned if len(cleaned.split()) >= 2 else message
    assert strip_name(message, {"helios", "h2", "manual"}) == expected


def test_question_naming_the_pdf_gets_the_right_answer(sample_pdf, tmp_path, monkeypatch):
    import api

    _isolate_api(api, tmp_path, monkeypatch)
    client = TestClient(api.app)
    client.post("/api/documents", files={"file": ("Helios H2 manual.pdf", sample_pdf, "application/pdf")})
    client.post("/api/documents", files={"file": ("Other notes.pdf", sample_pdf[:-1] + b" ", "application/pdf")})
    ans = client.post("/api/chat", json={"message": "How long is the warranty in the helios manual?"}).json()
    assert ans["highlight"] == "10-year" and ans["citations"][0]["page"] == 5
    assert ans["question"] == "How long is the warranty in the helios manual?"   # shown as asked


def test_pdfs_over_100_pages_are_refused():
    from fpdf import FPDF

    pdf = FPDF()
    for n in range(101):
        pdf.add_page()
        pdf.set_font("Helvetica", size=12)
        pdf.cell(0, 10, f"Page {n + 1}")
    with pytest.raises(PDFError, match="101 pages. The limit is 100"):
        chunk_pdf("x", bytes(pdf.output()))
