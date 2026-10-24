# Talk to your PDF: container for Hugging Face Spaces (or any Docker host).
# Spaces runs the app as user 1000 and sends traffic to port 7860.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/app/models/hf \
    FASTEMBED_CACHE_PATH=/app/models/fastembed \
    UPLOAD_TTL_HOURS=24 \
    MAX_DOCS_PER_USER=20

RUN useradd -m -u 1000 user
WORKDIR /app

# dependencies first, so code changes don't reinstall everything
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY --chown=user . .
RUN mkdir -p data models && chown -R user /app
USER user

# bake the models into the image (no download on every restart)
RUN python download_models.py

EXPOSE 7860
# --proxy-headers: behind Spaces' proxy, use the visitor's real IP for the daily AI-answer limit
CMD ["uvicorn", "api:app", "--host", "0.0.0.0", "--port", "7860", "--proxy-headers", "--forwarded-allow-ips", "*"]
