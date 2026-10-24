---
title: Talk to your PDF
emoji: 📄
colorFrom: purple
colorTo: pink
sdk: docker
app_port: 7860
pinned: false
short_description: Ask your PDFs by voice or text; every answer shows its page
---

# Project 2: Talk to your PDF (text + voice)

Upload a PDF and ask questions about it by typing or speaking. Answers come only from the document, cite their pages, and can be read aloud. Click a page citation and the preview jumps to that page so you can check the source.

## Run it

```bash
cd project2-pdf-assistant   # this folder
../.venv/bin/uvicorn api:app --port 8766   # then open http://127.0.0.1:8766
../.venv/bin/pytest -q                     # 81 tests
../.venv/bin/python make_sample_pdf.py     # rebuild the sample manual
```

## Try it online: the browser edition (free, no server)

**Live:** https://dharshinikalaiyan.github.io/talk-to-your-pdf/

The same app, running entirely in the visitor's browser and hosted free on GitHub Pages.
**PDFs never leave the device**: they're read with PDF.js and searched with the same three
open-source models (embeddings, re-ranker, reader), run by Transformers.js. Library and saved
chats live in the browser (IndexedDB). The first visit downloads ~120 MB of models once.

| | Server edition (`api.py`) | Browser edition (`docs/`) |
|---|---|---|
| Where it runs | Python server | The visitor's browser |
| Privacy | Each user's library is private on the server | Nothing leaves the device |
| Sign-in | Google (optional) | Not needed |
| Voice in | Whisper on the server | The browser's speech recognition |
| Answers | Local, or Groq / Claude | Local |
| Hosting | Any Docker host | Any static host, free |

Build it: `../.venv/bin/python build_pages.py` (copies `web/` + `web/local/` into `docs/`).
Preview: `python3 -m http.server 8790 --directory docs`.

## Deploy the server edition

Step-by-step: **[DEPLOY.md](DEPLOY.md)** (Hugging Face Spaces, Docker). The `Dockerfile` bakes the models in,
`download_models.py` fetches them, and public-demo settings delete uploads after 24 hours
(`UPLOAD_TTL_HOURS`) and cap each user at 20 PDFs (`MAX_DOCS_PER_USER`). PDF pages are drawn with
PDF.js, so they show and jump to a page on iPhone and Android too.

## Answer engines: free by default, Groq or Claude optional

| Engine | Turn it on | Cost | What answers look like |
|---|---|---|---|
| **Local** (default) | Always on | Free, runs on your machine | A bold short answer (e.g. **10-year**) plus the sentence it came from. Copies text only, so it can't make things up, but it can't summarize either. |
| **Groq** (optional) | `export GROQ_API_KEY=...` before starting | Free tier with daily limits | Written sentences with page citations, by Llama 3.3 70B (change with `GROQ_MODEL`) |
| **Claude** (optional) | `export ANTHROPIC_API_KEY=...` | Paid per question | Best-written answers with page citations |

The app tries **Claude → Groq → Local** and falls back to the next one if a key is missing, a limit is hit, or a service is down, so it always answers. Each answer shows which engine wrote it.

**Protecting your free tier or credit:** each visitor gets `CLOUD_DAILY_LIMIT` (default 20) AI-written answers per day; after that they get free local answers. Questions are capped at 500 characters, Groq answers at 400 tokens, and "not in this document" questions never call a cloud engine.

To get a Groq key: sign up at console.groq.com, create an API key, then:
```bash
export GROQ_API_KEY="your-key-here"
../.venv/bin/uvicorn api:app --port 8766
```
Keep the key out of your code and out of Git.

Use Chrome or Safari for voice. The browser asks for microphone permission the first time.

## Multi-tenant: every user has a private library

Every user gets a private library. Other users can't list, open, search, ask about or delete your PDFs, and they can't even tell whether a document ID exists.

- **Guest** (default): the library belongs to this browser.
- **Signed in with Google or Microsoft** (optional): the library belongs to your account and follows you to any browser. Guest PDFs move into the account when you sign in. Setup: **[SIGN_IN_SETUP.md](SIGN_IN_SETUP.md)**.

**Try it:** open the app in a normal window and in a private/incognito window. Upload in one; the other sees an empty library.

| Layer | Where | What it stops |
|---|---|---|
| **Signed session cookie** | `tenancy.py` | Pretending to be someone else. Edit the cookie and the signature breaks, so you get a new empty guest library. Sessions expire after 30 days. |
| **OpenID Connect sign-in** | `auth.py` | Passwords never touch the app. Tokens are checked for signature, audience, issuer, expiry and a one-time nonce. Accounts are keyed by the provider's permanent user ID, never by email. |
| **Ownership check on every lookup** | `library.get(owner, doc_id)` | Opening someone else's document by guessing or reusing its ID. |
| **Same "not found" for "not yours" and "doesn't exist"** | `api._doc` | Probing which document IDs exist. |
| **Random document IDs** | `library.add` | Learning that another user uploaded the same file (IDs used to come from the file's contents). |
| **One folder per user** | `data/uploads/<user>/` | One mistake exposing every file on disk. |
| **One search index per document, no shared caches** | `library.Document` | Answers mixing in other users' text, or timing tricks revealing shared files. |
| **Audit log** | `audit.py`, `data/audit.db` | Silent misuse: every upload, question, view and delete is logged, including **denied** attempts. |

Users can delete their PDFs (the bin icon), and `GET /api/activity` shows a user their own history only.

Same idea as Project 1, with a different "tenant": Project 1 isolates **companies and roles** inside one shared knowledge base; Project 2 isolates **each user's own uploads**.

## The two modules

**Module 1: text chat with a PDF**
```
upload → pdf_loader: text per page → chunks (each remembers its page)
       → library: one embedding per chunk, one index per document
question → library.search: embeddings pick 8 candidates → re-ranker keeps the best 4
         → answering: Claude / Groq / local reader, citing [p. N]
```

**Module 2: voice chat with the same PDF**
```
🎤 browser mic → 16 kHz audio → voice.transcribe (Whisper, local)
              → same search + answer as Module 1
              → voice.clean_for_speech (page numbers dropped; they're on screen) → browser reads it aloud
```

## What each file teaches

| File | Concept |
|------|---------|
| `pdf_assistant/pdf_loader.py` | PDF text extraction, chunking with overlap, keeping page numbers, friendly errors (not a PDF, encrypted, scanned) |
| `pdf_assistant/library.py` | One vector index per document, **two-stage retrieval** (embeddings → re-ranker), de-duplicating uploads by content hash |
| `pdf_assistant/reader.py` | **Re-ranker** (cross-encoder) and **extractive QA reader**: free local models that find the exact answer phrase |
| `pdf_assistant/conversation.py` | A rule-based NLP router in front of RAG: greetings and small talk ("hi, what's up?"), a how-to-use guide, picking a PDF by name ("open the lease", "warranty in the helios manual?"), or "which PDF?" with the question remembered. No AI model needed |
| `web/local/engine.js` | The browser edition's pipeline: PDF.js text → chunks → embeddings + re-ranker + reader (Transformers.js), and the chat router, ported from Python |
| `web/local/backend.js` | Answers the app's `/api/...` requests inside the page, storing PDFs and chats in IndexedDB |
| `pdf_assistant/history.py` | Saved chats like ChatGPT ("+ New chat", a sidebar of earlier chats), private per user, stored without document text |
| `pdf_assistant/library.py` (search) | Hybrid retrieval: codes in the question (`PO-2026-0062`, `E07`) must match exactly, so only those pages are searched; then embeddings + re-ranker by meaning. Fixes look-alike pages in templated documents |
| `Document.summarize` (library.py) | Extractive summaries without a language model: the "centre of meaning" of all passages, Maximal Marginal Relevance for variety, then each passage's most central sentence, in page order |
| `pdf_assistant/answering.py` | Engine chain Claude → Groq → local, grounded prompting with page citations, graceful fallback |
| `pdf_assistant/voice.py` | Speech-to-text, and making text sound natural when spoken |
| `api.py` | Upload, ask, voice and file-preview endpoints |
| `web/` | Simple dreamy UI: an animated welcome page, then one conversation under the glitter "L's" logo, centred. Say hi, ask how it works, or pick/name a PDF; it then opens on the left and the conversation glides to the right (phones: full-width chat, PDF on demand). Small suggestion pills above the ask bar, "My PDFs" library with search for big libraries (up to 100), drop PDFs anywhere, a settings bubble (music, read aloud, night sky, motion). Type: Plus Jakarta Sans |
| `web/sound.js` | Ambient music and interface sounds generated live with the Web Audio API (no audio files): a dreamy C-major-pentatonic pad, glass-bell notes and a soft pulse that the logo beats to; hover shimmer, click pop, bubble pop, page-change whoosh. Silent while the mic listens, ducked while answers are read aloud |
| `web/scene3d.js` | The 3D particle world (Three.js shader, ~16,000 glitter points): the "L's" logo above the conversation, big at first and small once you're talking. It beats with your voice, each spoken word and the music, splashes away from the cursor, swirls while thinking, and is reflected in the lake |
| `tests/test_pdf_assistant.py` | Page-accurate retrieval, "not in this document" cases, the full API including a spoken question |

## How it relates to Project 1

| | Project 1: Clearance Desk | Project 2: PDF Assistant |
|---|---|---|
| Data | Fixed fictional company docs | Any PDF you upload |
| Main lesson | Who may see what (permissions) | Grounded answers with page citations |
| Reused | — | Embeddings, Whisper voice, design system |

## Limits to know

- **Scanned PDFs** (images of text) are rejected; they need OCR.
- **Tables and multi-column layouts** may extract in a jumbled order.
- **Follow-up questions** like "and what about E12?" are treated on their own; the assistant doesn't remember earlier turns.
- **Guests** are tied to one browser: clearing cookies means a new, empty guest library. Sign in to avoid this.
- **A stolen session cookie** gives access to that library until it expires (30 days) or the user signs out. Deployed, the cookie is HTTPS-only.
- **Secrets**: `data/session_secret` signs the cookies. Keep it private (it's in `.gitignore`), and set `SESSION_SECRET` when you deploy.
- **No automatic clean-up**: uploads stay until their owner deletes them. A public demo should delete old uploads after a few hours.
- `RERANK_MIN` (−9) and `READER_MIN` (6) in `reader.py` were tuned on the sample manual. Check them against your own documents.
- The per-visitor limit is kept in memory and keyed by IP address: it resets when the server restarts, and people sharing one network share one limit.

## Exercises

1. **Conversation memory:** pass the last 2 questions and answers to Claude so follow-up questions work.
2. **OCR:** add `ocrmypdf` or Tesseract so scanned PDFs work.
3. **Highlight the passage:** use PDF.js instead of the built-in viewer and highlight the cited sentence.
4. **Ask across several PDFs:** search all uploaded documents and cite `filename p. N`.
5. **Teams:** let a user share a PDF with a named team, using Project 1's tenant + role check (`access.py`).
6. **Auto-expiry:** delete uploads older than 24 hours on startup and once an hour.
