FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# CMD is supplied by docker-compose:
#   celery -A consumer worker --concurrency=4 -Q ai_core:process
