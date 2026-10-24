"""
CONCEPT: turning a PDF into searchable chunks that remember their page.

1. Extract text page by page (pypdf). Page numbers are what make citations
   possible, so every chunk keeps the page it came from.
2. Split each page into overlapping chunks of roughly CHUNK_CHARS characters.
   Overlap means a sentence cut at a chunk border still appears whole in one
   of the two neighbouring chunks.

Limits: scanned PDFs are images with no text layer, so extraction returns
nothing. Those would need OCR (an exercise in the README).
"""

import io
import re

from pypdf import PdfReader

from .models import Chunk

CHUNK_CHARS = 700
OVERLAP_CHARS = 150
MAX_PAGES = 100


class PDFError(ValueError):
    """A problem the user can fix: wrong file type, encrypted, no text, too long."""


def extract_pages(data: bytes) -> list[str]:
    if not data.startswith(b"%PDF"):
        raise PDFError("That file isn't a PDF. Choose a file that ends in .pdf.")
    try:
        reader = PdfReader(io.BytesIO(data))
    except Exception:
        raise PDFError("This PDF couldn't be opened. It may be damaged; try exporting it again.")
    if reader.is_encrypted:
        raise PDFError("This PDF is password-protected. Remove the password and upload it again.")
    if len(reader.pages) > MAX_PAGES:
        raise PDFError(f"This PDF has {len(reader.pages)} pages. The limit is {MAX_PAGES}.")
    pages = [_clean(text) for text in strip_repeated_lines([page.extract_text() or "" for page in reader.pages])]
    if not any(pages):
        raise PDFError("No selectable text found. This looks like a scanned PDF, which needs OCR (not supported yet).")
    return pages


def strip_repeated_lines(pages: list[str]) -> list[str]:
    """Remove running headers and footers ("ACME CONFIDENTIAL", "Page 16 of 100").

    Only the first and last few lines of each page are considered (that's where page
    furniture lives). One of those is dropped when the same line sits at the edge of at least
    half the pages, or when it's a page number ("Page 16 of 100", "16/100"). Repeated lines in
    the body, like table labels in a templated document, are real content and stay.
    """
    if len(pages) < 3:
        return pages
    EDGE = 3
    norm = lambda line: re.sub(r"\d+", "#", line.strip().lower())
    page_no = re.compile(r"^(page\s*)?#(\s*(of|/)\s*#)?$")

    def edges(text: str) -> list[str]:
        lines = [l for l in text.split("\n") if l.strip()]
        return lines[:EDGE] + lines[-EDGE:]

    numbered = re.compile(r"\bpage\b|# of #|#\s*/\s*#")   # "... Page 16 of 100" once numbers are masked
    counts: dict[str, int] = {}
    for text in pages:
        for line in {l.strip().lower() for l in edges(text)} | {norm(l) for l in edges(text)}:
            counts[line] = counts.get(line, 0) + 1
    enough = max(3, len(pages) // 2)

    def furniture(line: str) -> bool:
        n = norm(line)
        return (counts.get(line.strip().lower(), 0) >= enough            # identical on many pages
                or bool(page_no.match(n))                                 # just a page number
                or (counts.get(n, 0) >= enough and bool(numbered.search(n))))   # header + page number

    def keep(text: str) -> str:
        edge = set(edges(text))
        return "\n".join(l for l in text.split("\n") if not (l in edge and furniture(l)))

    return [keep(text) for text in pages]


def _clean(text: str) -> str:
    text = re.sub(r"-\n(\w)", r"\1", text)      # re-join words hyphenated across lines
    # Join lines that were wrapped mid-sentence, but keep headings on their own line:
    # a short line with no closing punctuation (like "Warranty and support") is a heading.
    lines = text.split("\n")
    joined = lines[:1]
    for line in lines[1:]:
        prev = joined[-1].strip()
        is_heading = 0 < len(prev) < 60 and not prev.endswith((".", ",", ";", ":", "!", "?")) and prev[:1].isupper()
        if prev and line.strip() and not is_heading:
            joined[-1] = f"{joined[-1]} {line}"
        else:
            joined.append(line)
    text = "\n".join(joined)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{2,}", "\n\n", text)
    return text.strip()


def _split(text: str) -> list[str]:
    """Split on sentence boundaries into ~CHUNK_CHARS pieces, with overlap."""
    sentences = re.split(r"(?<=[.!?])\s+", text)
    chunks, current = [], ""
    for sentence in sentences:
        if current and len(current) + len(sentence) > CHUNK_CHARS:
            chunks.append(current.strip())
            current = current[-OVERLAP_CHARS:]  # carry the tail into the next chunk
            current = current[current.find(" ") + 1:] if " " in current else current
        current += " " + sentence
    if current.strip():
        chunks.append(current.strip())
    return chunks


def chunk_pdf(doc_id: str, data: bytes) -> tuple[list[Chunk], int]:
    pages = extract_pages(data)
    chunks = [
        Chunk(chunk_id=f"{doc_id}#p{page_no}-{i}", page=page_no, text=piece)
        for page_no, text in enumerate(pages, start=1)
        for i, piece in enumerate(_split(text))
    ]
    return chunks, len(pages)
