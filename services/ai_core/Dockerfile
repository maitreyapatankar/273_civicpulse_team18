FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=20s \
    CMD python healthcheck.py

CMD ["celery", "-A", "consumer", "worker", "--concurrency=1", "-Q", "ai_core:process", "--pool=solo"]