FROM python:3.11-slim

WORKDIR /app

COPY shared/ ./shared/
COPY services/scheduler/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY services/scheduler/ ./

ENV PYTHONPATH=/app

CMD ["python", "scheduler.py"]