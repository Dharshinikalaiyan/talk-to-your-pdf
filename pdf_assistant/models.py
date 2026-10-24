from pydantic import BaseModel


class Chunk(BaseModel):
    chunk_id: str
    page: int        # 1-based page number, used for citations
    text: str


class Citation(BaseModel):
    page: int
    snippet: str     # the passage the answer is based on
    score: float     # re-ranker score: higher = answers the question better


class DocumentInfo(BaseModel):
    """What the browser may see about a document. Deliberately has no owner field."""

    doc_id: str
    filename: str
    pages: int
    chunks: int
    uploaded_at: str = ""


class Answer(BaseModel):
    question: str
    answer: str
    citations: list[Citation]
    engine: str = "local"                # who wrote the answer: "local", "groq" or "claude"
    highlight: str = ""                  # short answer phrase from the local reader, if any
    note: str = ""                       # why a fallback engine answered, if one did
    spoken: str = ""                     # answer cleaned up for text-to-speech
    latency: dict[str, float] = {}       # seconds per step
    kind: str = "doc"                    # "doc" = answered from a PDF, "chat" = small talk / help / "which PDF?"
    doc_id: str = ""                     # the PDF this answer came from
    open_doc: DocumentInfo | None = None # the conversation moved to this PDF (the UI opens it)
    choices: list[DocumentInfo] = []     # PDFs to pick from
    pending: str = ""                    # question to answer once a PDF is picked
