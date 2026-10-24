"""
CONCEPT: free, local answers with two small models (no API key, no cost).

1. RE-RANKER (cross-encoder, ms-marco-MiniLM, ~80 MB)
   Embedding search compares the question and each passage separately, so it's
   fast but fuzzy. A cross-encoder reads the question and a passage TOGETHER and
   scores how well the passage answers it. Too slow to run on every chunk, so we
   use the classic two-stage pattern:
       embeddings: top 8 candidates (fast, rough)  ->  re-ranker: best 4 (slow, precise)
   Its scores also separate "relevant" from "unrelated" much more clearly, so
   it decides when to say "I couldn't find that".

2. READER (extractive question answering, DistilBERT fine-tuned on SQuAD, ~65 MB)
   Given a question and a passage, it predicts where the answer STARTS and ENDS
   in the passage, e.g. "How long is the warranty?" -> "10-year".
   It can only copy text from the document, never invent any, so it can't
   hallucinate. The trade-off: it can't summarize or combine facts.
"""

import re
from dataclasses import dataclass

import numpy as np

RERANKER_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2"
READER_REPO = "Xenova/distilbert-base-cased-distilled-squad"

# Re-ranker scores measured on data/sample_manual.pdf: on-topic passages -7.1 to 7.8,
# unrelated ones -10.5 to -11.2. -9 sits in the gap.
RERANK_MIN = -9.0
# Reader confidence (start + end logits). Clean answers scored 10-20 on the sample;
# below this we show whole sentences instead of a short answer.
READER_MIN = 6.0
MAX_ANSWER_TOKENS = 30

_reranker = None
_reader = None


def _get_reranker():
    global _reranker
    if _reranker is None:
        from fastembed.rerank.cross_encoder import TextCrossEncoder

        _reranker = TextCrossEncoder(RERANKER_MODEL)
    return _reranker


def rerank(question: str, passages: list[str]) -> list[float]:
    return [float(s) for s in _get_reranker().rerank(question, passages)]


def _get_reader():
    global _reader
    if _reader is None:
        import onnxruntime as ort
        from huggingface_hub import hf_hub_download
        from tokenizers import Tokenizer

        tokenizer = Tokenizer.from_file(hf_hub_download(READER_REPO, "tokenizer.json"))
        tokenizer.enable_truncation(max_length=384, strategy="only_second")  # trim the passage, never the question
        session = ort.InferenceSession(hf_hub_download(READER_REPO, "onnx/model_quantized.onnx"))
        _reader = (tokenizer, session)
    return _reader


@dataclass
class Span:
    text: str        # the short answer, copied from the passage
    sentence: str    # the full sentence around it, for context
    score: float


def extract(question: str, passage: str) -> Span | None:
    """Find the answer span inside one passage, or None if the model isn't confident."""
    tokenizer, session = _get_reader()
    enc = tokenizer.encode(question, passage)
    start, end = session.run(
        None,
        {"input_ids": np.array([enc.ids], dtype=np.int64), "attention_mask": np.array([enc.attention_mask], dtype=np.int64)},
    )
    start, end, seq = start[0], end[0], enc.sequence_ids

    # Best (start, end) pair inside the passage (sequence 1), end after start, at most 30 tokens long.
    best, best_i, best_j = -np.inf, 0, 0
    for i in (k for k in range(len(seq)) if seq[k] == 1):
        for j in range(i, min(i + MAX_ANSWER_TOKENS, len(seq))):
            if seq[j] != 1:
                break
            if start[i] + end[j] > best:
                best, best_i, best_j = start[i] + end[j], i, j
    if best < READER_MIN:
        return None

    a, b = enc.offsets[best_i][0], enc.offsets[best_j][1]
    return Span(text=passage[a:b].strip(" ,;:"), sentence=_sentence_around(passage, a, b), score=float(best))


def _sentence_around(text: str, a: int, b: int) -> str:
    left = max(text.rfind(". ", 0, a), text.rfind("\n", 0, a))
    right_candidates = [i for i in (text.find(". ", b), text.find("\n", b)) if i != -1]
    right = min(right_candidates) + 1 if right_candidates else len(text)
    return text[left + 1 : right].strip()


def warm_up() -> None:
    """Load both models (downloads them on first run) so the first question is fast."""
    rerank("warm up", ["warm up"])
    extract("warm up?", "warm up.")
