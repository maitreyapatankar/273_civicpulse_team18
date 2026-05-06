FROM python:3.11-slim

WORKDIR /app

COPY shared/ ./shared/
COPY alembic/ ./alembic/
COPY alembic.ini ./
COPY scripts/ ./scripts/

COPY services/api/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt alembic==1.13.1

COPY services/api/ ./

ENV PYTHONPATH=/app

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=15s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

CMD ["sh", "-c", "alembic upgrade head && python /app/scripts/seed.py && uvicorn main:app --host 0.0.0.0 --port 8000"]