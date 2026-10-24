"""
CONCEPT: a multi-tenant document library. Every PDF belongs to exactly one user.

Isolation is enforced in layers, so one mistake doesn't leak everything:

  1. OWNERSHIP CHECK   get(owner, doc_id) only returns documents that `owner` uploaded.
                       Someone else's id and an id that doesn't exist give the SAME
                       error, so nobody can probe which ids exist ("enumeration").
  2. RANDOM IDS        Document ids are random, not derived from the file. If ids came
                       from a hash of the content, two users uploading the same PDF would
                       get the same id, revealing who has which file.
  3. SEPARATE STORAGE  Files live in data/uploads/<owner>/, one folder per user.
  4. SEPARATE INDEXES  Each document has its own vectors; a search never looks outside
                       the one document the owner picked. Nothing is shared between
                       users, not even a cache of identical files: a shared cache would
                       let one user notice, from upload speed, that someone else already
                       uploaded the same file (a "timing side channel").

Two-stage search inside a document: embeddings pick 8 candidates, the re-ranker keeps the best 4.
"""

import hashlib
import json
import os
import re
import secrets
import shutil
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from .embeddings import embed
from .models import Chunk, Citation, DocumentInfo
from .pdf_loader import chunk_pdf
from .reader import RERANK_MIN, rerank
from .tenancy import USER_ID_RE

# Stage 1 (embeddings) only gathers candidates, so its cutoff is loose: it just drops
# chunks that are clearly unrelated. The re-ranker (stage 2) makes the real decision.
CANDIDATES = 8
MIN_SCORE = 0.3
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
MAX_DOCS_PER_USER = int(os.environ.get("MAX_DOCS_PER_USER", "100"))
DOC_ID_RE = re.compile(r"^[0-9a-f]{16}$")


# A code/ID: letters and digits together, or digits with dashes ("PO-2026-0062", "E07", "INV/881").
ID_RE = re.compile(r"\b(?=[\w/-]*\d)(?=[\w/-]*[A-Za-z-])[A-Za-z0-9]+(?:[-/][A-Za-z0-9]+)*\b")


def identifiers(question: str) -> list[str]:
    return [m.lower() for m in ID_RE.findall(question) if len(m) >= 3]


def without_identifiers(question: str) -> str:
    """'What payment terms apply to PO-2026-0062?' -> 'What payment terms apply to?'

    Once the code has picked the page, it's dropped from the question, so a passage that
    merely repeats the code doesn't beat the one that answers what was asked."""
    text = ID_RE.sub(lambda m: "" if len(m.group()) >= 6 else m.group(), question)   # long codes only; "E07" is part of the question
    text = re.sub(r"\b(for|of|on|in|to|about)\s+(purchase order|order|invoice|item|code|error)?\s*(?=[?.!]*$)", "", text, flags=re.I)
    return re.sub(r"\s+", " ", re.sub(r"\s+([?.!])", r"\1", text)).strip() or question


def _contains(text: str, ident: str) -> bool:
    return re.search(rf"(?<![\w-]){re.escape(ident)}(?![\w-])", text) is not None


def _prose(sentence: str) -> bool:
    """A real sentence rather than a table row: mostly words, not numbers and amounts."""
    tokens = sentence.split()
    numeric = sum(any(ch.isdigit() for ch in t) for t in tokens)
    return len(tokens) >= 6 and numeric / len(tokens) < 0.25 and sentence[:1].isupper()


class Document:
    def __init__(self, info: DocumentInfo, owner: str, sha256: str, chunks: list[Chunk]):
        self.info = info
        self.owner = owner      # never sent to the browser
        self.sha256 = sha256    # used to spot the same user uploading the same file twice
        self.chunks = chunks
        self.vectors = embed([c.text for c in chunks])
        self.page_text: dict[int, str] = {}
        for c in chunks:
            self.page_text[c.page] = self.page_text.get(c.page, "") + " " + c.text.lower()

    def search(self, question: str, top_k: int = 4) -> list[Citation]:
        """Two-stage retrieval: embeddings pick candidates, the re-ranker picks the best.

        Codes and IDs in the question ("PO-2026-0062", "E07") must match exactly: meaning-based
        search sees PO-2026-0062 and PO-2026-0058 as near-identical, so only pages that contain
        the exact code are searched. No such page -> nothing found (instead of a look-alike).
        """
        ids = identifiers(question)
        pool = np.arange(len(self.chunks))
        if ids:
            pages = {pg for pg, text in self.page_text.items() if all(_contains(text, i) for i in ids)}
            if not pages:
                return []
            pool = np.array([i for i, c in enumerate(self.chunks) if c.page in pages])
        if ids:
            question = without_identifiers(question)
        scores = self.vectors[pool] @ embed([question])[0]
        order = pool[np.argsort(-scores)][:CANDIDATES]
        candidates = [i for i, sc in zip(order, np.sort(scores)[::-1]) if ids or sc >= MIN_SCORE]
        if not candidates:
            return []
        rerank_scores = rerank(question, [self.chunks[i].text for i in candidates])
        ranked = sorted(zip(candidates, rerank_scores), key=lambda x: -x[1])
        # an exact code match is strong evidence: keep the best passage on that page even if
        # the re-ranker is unsure
        kept = [(i, s) for i, s in ranked[:top_k] if s >= RERANK_MIN] or (ranked[:1] if ids else [])
        return [Citation(page=self.chunks[i].page, snippet=self.chunks[i].text, score=s) for i, s in kept]


    def summarize(self, points: int = 5) -> list[Citation]:
        """An extractive summary: the document's most representative sentences, in page order.

        1. The mean of all passage vectors is the document's "centre of meaning".
        2. Pick passages close to that centre but different from each other (Maximal Marginal
           Relevance), so the summary covers the main topics instead of repeating one.
        3. From each, keep the sentence closest to the centre.
        No language model writes anything, so every line is the document's own words.
        """
        prose = np.array([any(_prose(x.strip().split("\n")[-1]) for x in re.split(r"(?<=[.!?])\s+", c.text)) for c in self.chunks])
        centre = self.vectors.mean(axis=0)
        centre /= np.linalg.norm(centre) or 1
        relevance = np.where(prose, self.vectors @ centre, -np.inf) if prose.any() else self.vectors @ centre
        chosen: list[int] = []
        while len(chosen) < min(points, len(self.chunks)):
            if chosen:
                overlap = (self.vectors @ self.vectors[chosen].T).max(axis=1)
                score = 0.65 * relevance - 0.35 * overlap
                score[chosen] = -np.inf
            else:
                score = relevance
            chosen.append(int(np.argmax(score)))
        out = []
        for i in sorted(chosen, key=lambda k: (self.chunks[k].page, k)):
            # whole sentences of prose: drop a heading glued to the front ("Safety\nOnly a ...") and
            # number-heavy table rows ("1 Packaging bundles 12 bundle $30.90 ...")
            sentences = [x.strip().split("\n")[-1] for x in re.split(r"(?<=[.!?])\s+", self.chunks[i].text)]
            sentences = [x for x in sentences if len(x) > 30 and _prose(x)]
            if not sentences:
                continue
            best = sentences[int(np.argmax(embed(sentences) @ centre))] if len(sentences) > 1 else sentences[0]
            if best not in (c.snippet for c in out):
                out.append(Citation(page=self.chunks[i].page, snippet=best, score=float(relevance[i])))
        return out


class Library:
    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self.docs: dict[str, Document] = {}
        for meta_path in sorted(root.glob("*/*.json")):
            meta = json.loads(meta_path.read_text())
            data = (meta_path.parent / f"{meta['doc_id']}.pdf").read_bytes()
            self._index(meta["owner"], meta["doc_id"], meta["filename"], meta["uploaded_at"], data)

    # ------------------------------------------------------------ reads (always scoped to an owner)

    def list(self, owner: str) -> list[DocumentInfo]:
        return sorted((d.info for d in self.docs.values() if d.owner == owner), key=lambda i: i.uploaded_at)

    def get(self, owner: str, doc_id: str) -> Document:
        """The ONLY way to reach a document. Wrong owner and unknown id raise the same KeyError."""
        doc = self.docs.get(doc_id) if DOC_ID_RE.match(doc_id) else None
        if doc is None or doc.owner != owner:
            raise KeyError(doc_id)
        return doc

    def pdf_path(self, owner: str, doc_id: str) -> Path:
        doc = self.get(owner, doc_id)
        return self._dir(doc.owner) / f"{doc_id}.pdf"

    # ------------------------------------------------------------ writes

    def add(self, owner: str, filename: str, data: bytes) -> DocumentInfo:
        if len(data) > MAX_UPLOAD_BYTES:
            raise ValueError(f"That PDF is over {MAX_UPLOAD_BYTES // (1024 * 1024)} MB. Upload a smaller file.")
        sha256 = hashlib.sha256(data).hexdigest()
        for doc in self.docs.values():  # same user, same file: reuse it (only ever compared within one owner)
            if doc.owner == owner and doc.sha256 == sha256:
                return doc.info
        if len(self.list(owner)) >= MAX_DOCS_PER_USER:
            raise ValueError(f"You can keep up to {MAX_DOCS_PER_USER} PDFs. Delete one to upload another.")

        doc_id = secrets.token_hex(8)
        uploaded_at = datetime.now(timezone.utc).isoformat()
        info = self._index(owner, doc_id, _safe_name(filename), uploaded_at, data)  # raises PDFError before saving
        folder = self._dir(owner)
        folder.mkdir(parents=True, exist_ok=True)
        (folder / f"{doc_id}.pdf").write_bytes(data)
        meta = {"doc_id": doc_id, "owner": owner, "filename": info.filename, "uploaded_at": uploaded_at}
        (folder / f"{doc_id}.json").write_text(json.dumps(meta))
        return info

    def delete(self, owner: str, doc_id: str) -> None:
        self.get(owner, doc_id)  # ownership check first
        folder = self._dir(owner)
        for suffix in (".pdf", ".json"):
            (folder / f"{doc_id}{suffix}").unlink(missing_ok=True)
        del self.docs[doc_id]
        if folder.exists() and not any(folder.iterdir()):
            shutil.rmtree(folder)

    def expire(self, older_than: datetime) -> list[tuple[str, str]]:
        """Delete every PDF uploaded before `older_than` (for public demos). Returns (owner, doc_id) pairs."""
        old = [(d.owner, d.info.doc_id) for d in self.docs.values() if datetime.fromisoformat(d.info.uploaded_at) < older_than]
        for owner, doc_id in old:
            self.delete(owner, doc_id)
        return old

    def transfer(self, from_owner: str, to_owner: str) -> int:
        """Move a guest's PDFs into the account they just signed in to. Returns how many moved.

        Only ever called with the guest id from the browser's own signed cookie, so a
        person can only bring along documents they uploaded themselves.
        """
        moved = 0
        src, dst = self._dir(from_owner), self._dir(to_owner)
        for doc in [d for d in self.docs.values() if d.owner == from_owner]:
            doc_id = doc.info.doc_id
            if any(d.owner == to_owner and d.sha256 == doc.sha256 for d in self.docs.values()):
                self.delete(from_owner, doc_id)  # the account already has this file
                continue
            dst.mkdir(parents=True, exist_ok=True)
            (src / f"{doc_id}.pdf").rename(dst / f"{doc_id}.pdf")
            meta = json.loads((src / f"{doc_id}.json").read_text()) | {"owner": to_owner}
            (dst / f"{doc_id}.json").write_text(json.dumps(meta))
            (src / f"{doc_id}.json").unlink()
            doc.owner = to_owner
            moved += 1
        if src.exists() and not any(src.iterdir()):
            shutil.rmtree(src)
        return moved

    # ------------------------------------------------------------ internals

    def _dir(self, owner: str) -> Path:
        if not USER_ID_RE.match(owner):  # owner ids become folder names, so they must be plain hex
            raise ValueError("invalid owner id")
        return self.root / owner

    def _index(self, owner: str, doc_id: str, filename: str, uploaded_at: str, data: bytes) -> DocumentInfo:
        chunks, pages = chunk_pdf(doc_id, data)
        info = DocumentInfo(doc_id=doc_id, filename=filename, pages=pages, chunks=len(chunks), uploaded_at=uploaded_at)
        self.docs[doc_id] = Document(info, owner, hashlib.sha256(data).hexdigest(), chunks)
        return info


def _safe_name(filename: str) -> str:
    """Display name only (files are stored by id), but keep it short and free of path parts."""
    name = Path(filename or "document.pdf").name
    return name[:120] or "document.pdf"
