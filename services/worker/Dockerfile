FROM python:3.11-slim

WORKDIR /app

# shared/ lives at repo root — build context must be repo root
COPY shared/ ./shared/
COPY services/worker/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY services/worker/ ./

ENV PYTHONPATH=/app

# CMD is supplied by docker-compose:
#   celery -A tasks worker --concurrency=4 -Q reports:process,ai_core:results,ai_core:failed
