FROM python:3.11-slim

WORKDIR /app

COPY shared/ ./shared/
COPY services/worker/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY services/worker/ ./

ENV PYTHONPATH=/app

HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=20s \
    CMD python healthcheck.py

CMD ["celery", "-A", "tasks", "worker", "--concurrency=1", \
    "-Q", "reports:process,ai_core:results,ai_core:failed", \
    "--pool=solo", "--loglevel=INFO", "-E"]