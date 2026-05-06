FROM python:3.11-slim

WORKDIR /app

COPY services/ai_core/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY services/ai_core/ .

HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=20s \
    CMD python healthcheck.py

CMD ["celery", "-A", "consumer", "worker", "--concurrency=1", "-Q", "ai_core:process"]