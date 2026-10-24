"""
Download every model the app uses, so a fresh server answers its first question fast.
The Dockerfile runs this once while building the image (about 450 MB in total):

    embeddings  BAAI/bge-small-en-v1.5           (search)
    re-ranker   Xenova/ms-marco-MiniLM-L-6-v2    (picks the best passages)
    reader      distilbert-base-cased-squad      (short exact answers)
    speech      Whisper base.en                  (voice questions)
"""

import numpy as np

from pdf_assistant.embeddings import embed
from pdf_assistant.reader import warm_up
from pdf_assistant.voice import SAMPLE_RATE, transcribe

if __name__ == "__main__":
    embed(["warm up"])
    warm_up()
    transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32))
    print("All models downloaded.")
