"""
Interactive PDF Assistant: upload a PDF, ask questions by text or voice,
get answers with page citations.

    upload -> pdf_loader (text per page -> chunks) -> library (embeddings index)
    question -> library.search (embeddings -> re-ranker) -> answering (Claude / Groq / local reader)
"""

from .library import Library

__all__ = ["Library"]
