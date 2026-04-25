FROM python:3.11-slim

WORKDIR /app

# shared/ and alembic/ live at repo root — build context must be repo root
COPY shared/ ./shared/
COPY alembic/ ./alembic/
COPY alembic.ini ./

COPY services/api/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt alembic==1.13.1

COPY services/api/ ./

ENV PYTHONPATH=/app

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
