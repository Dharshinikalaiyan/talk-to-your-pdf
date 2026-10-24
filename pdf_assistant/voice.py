"""
CONCEPT: voice is a wrapper around the same question-answer pipeline.

    🎤 browser mic -> 16 kHz audio -> transcribe() (Whisper, local) -> ask the PDF
    -> answer -> clean_for_speech() -> browser reads it aloud

Same approach as Project 1's voice layer; see project1-secure-rag/secure_rag/voice.py.
"""

import re

import numpy as np

SAMPLE_RATE = 16_000  # Whisper expects 16 kHz mono audio
_whisper = None


def _get_whisper():
    global _whisper
    if _whisper is None:
        from faster_whisper import WhisperModel

        # base.en: small English model (~140 MB, downloads once). int8 = faster on CPU.
        _whisper = WhisperModel("base.en", device="cpu", compute_type="int8")
    return _whisper


def transcribe(audio: np.ndarray, hint: str = "") -> str:
    """hint: words from the document (e.g. its title) that help Whisper spell domain terms."""
    if audio.size < SAMPLE_RATE // 4:  # under 0.25 s: nothing was said
        return ""
    segments, _ = _get_whisper().transcribe(audio, language="en", initial_prompt=hint or None)
    return "".join(s.text for s in segments).strip()


def clean_for_speech(text: str) -> str:
    """Turn [p. 3] into 'page 3' and drop notes and markdown, so it sounds natural."""
    text = re.sub(r"^\([^)]*\)\s*", "", text)
    text = re.sub(r"\[p\.\s*(\d+)\]", r"(page \1)", text)
    text = re.sub(r"[*_#`]", "", text)
    return re.sub(r"\s+", " ", text).strip()
