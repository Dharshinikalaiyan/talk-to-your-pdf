"""
CONCEPT: embeddings turn text into a list of numbers (a vector) so that
texts with similar MEANING end up close together.

    "parental leave"  -> [0.12, -0.40, ...]   (384 numbers)
    "maternity break" -> [0.11, -0.38, ...]   close!
    "battery supplier"-> [-0.50, 0.22, ...]   far away

We use a small open-source model (BAAI/bge-small-en-v1.5) that runs on your
laptop through `fastembed`. No API key, and your text never leaves the machine.
The model (~130 MB) downloads once on first run.
"""

import numpy as np
from fastembed import TextEmbedding

_MODEL_NAME = "BAAI/bge-small-en-v1.5"
_model: TextEmbedding | None = None


def _get_model() -> TextEmbedding:
    global _model
    if _model is None:
        _model = TextEmbedding(_MODEL_NAME)
    return _model


def embed(texts: list[str]) -> np.ndarray:
    """Return one normalized vector per text, shape (len(texts), 384)."""
    vectors = np.array(list(_get_model().embed(texts)), dtype=np.float32)
    # Normalizing to length 1 means "dot product" == "cosine similarity".
    return vectors / np.linalg.norm(vectors, axis=1, keepdims=True)
