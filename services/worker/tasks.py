"""
Service 3 — Worker entry point.

Start command (from docker-compose):
    celery -A tasks worker --concurrency=4 \
           -Q reports:process,ai_core:results,ai_core:failed

Responsibilities
----------------
- Sole owner of all Postgres writes (S2 AI Core never touches the DB)
- Sole owner of all retry decisions
- Bridges S1 API Gateway ↔ S2 AI Core via Redis queues
- Publishes Redis pub/sub events for S5 Notifications

Queue contract
--------------
Consumes : reports:process   payload = {report_id}
           ai_core:results   payload = {report_id, enriched_ticket}
           ai_core:failed    payload = {report_id, error, attempt}
Produces : ai_core:process   payload = {report_id, payload, attempt}
           reports:dlq       payload = {report_id, error}
Publishes: notify:ticket_ready  {ticket_id}   (Redis pub/sub → S5)

Retry countdown (2^attempt seconds)
------------------------------------
  attempt 0 → 1 :  1 s
  attempt 1 → 2 :  2 s
  attempt 2 → 3 :  4 s
  attempt 3     :  → DLQ, status = failed
"""

import json
import logging
import os

import redis
from celery import Celery

from shared.db import get_db
from shared.models import RawReport, Ticket

REDIS_URL = os.environ["REDIS_URL"]

celery_app = Celery("worker", broker=REDIS_URL, backend=None)
celery_app.conf.task_serializer = "json"
celery_app.conf.accept_content  = ["json"]

_redis = redis.Redis.from_url(REDIS_URL)
log = logging.getLogger(__name__)


def _publish_event(channel: str, ticket_id: str, report_id: str | None) -> None:
    """Publish a JSON event for SSE listeners. Best-effort, never raises."""
    try:
        _redis.publish(
            channel,
            json.dumps({"ticket_id": ticket_id, "report_id": report_id}),
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("publish %s failed: %s", channel, exc)


# ── Internal helper ───────────────────────────────────────────────────────────

def _fetch_raw_payload(report_id: str) -> dict:
    """Re-fetch the raw report from Postgres and return it as a pipeline payload dict."""
    with get_db() as db:
        report = db.get(RawReport, report_id)
        return report.to_dict()


# ── Task 1 ────────────────────────────────────────────────────────────────────
# Queue: reports:process  |  Producer: S1 API Gateway

@celery_app.task(bind=True, name="worker.tasks.process_report", queue="reports:process")
def process_report(self, report_id: str):
    """Fetch the raw report, mark it processing, forward payload to AI Core."""
    with get_db() as db:
        report = db.get(RawReport, report_id)
        existing_ticket = (
            db.query(Ticket)
              .filter(Ticket.raw_report_id == report_id)
              .first()
        )
        report.status = "processing"
        db.commit()
        payload = report.to_dict()

    payload["attempt"] = 0
    payload["is_edit"] = existing_ticket is not None
    if existing_ticket:
        payload["existing_ticket_id"] = str(existing_ticket.id)
    celery_app.send_task(
        "ai_core.consumer.run_pipeline",
        args=[report_id, payload],
        queue="ai_core:process",
    )


# ── Task 2 ────────────────────────────────────────────────────────────────────
# Queue: ai_core:results  |  Producer: S2 AI Core (success path)

@celery_app.task(name="worker.tasks.handle_ai_result", queue="ai_core:results")
def handle_ai_result(report_id: str, enriched: dict):
    """Write enriched ticket to DB, mark report done, publish SMS notification."""
    with get_db() as db:
        existing = (
            db.query(Ticket)
              .filter(Ticket.raw_report_id == report_id)
              .first()
        )

        duplicate_of = enriched.get("duplicate_of")
        if duplicate_of and str(duplicate_of) in {str(report_id), str(existing.id) if existing else ""}:
            duplicate_of = None

        if existing:
            existing.issue_type = enriched.get("issue_type")
            existing.severity = enriched.get("severity")
            existing.confidence = enriched.get("confidence")
            existing.ai_reasoning = enriched.get("ai_reasoning")
            existing.urgency_score = enriched.get("urgency_score")
            existing.urgency_factors = enriched.get("urgency_factors")
            existing.duplicate_of = duplicate_of
            existing.work_order = enriched.get("work_order")
            enriched_cluster = enriched.get("cluster_count") or 1
            existing.cluster_count = max(existing.cluster_count or 1, enriched_cluster)
            ticket_id = str(existing.id)
        else:
            enriched_copy = dict(enriched)
            enriched_copy["duplicate_of"] = duplicate_of
            ticket = Ticket(**enriched_copy, raw_report_id=report_id)
            db.add(ticket)
            ticket_id = str(ticket.id)

        db.query(RawReport).filter_by(id=report_id) \
            .update({"status": "done"})
        db.commit()

    channel = "notify:ticket_ready" if not existing else "notify:ticket_updated"
    _publish_event(channel, ticket_id, str(report_id))


# ── Task 3 ────────────────────────────────────────────────────────────────────
# Queue: ai_core:failed  |  Producer: S2 AI Core (failure path)

@celery_app.task(name="worker.tasks.handle_ai_failure", queue="ai_core:failed")
def handle_ai_failure(report_id: str, error: str, attempt: int):
    """Retry the pipeline with exponential backoff, or send to DLQ after 3 attempts."""
    if attempt < 3:
        payload = _fetch_raw_payload(report_id)
        payload["attempt"] = attempt + 1

        celery_app.send_task(
            "ai_core.consumer.run_pipeline",
            args=[report_id, payload],
            queue="ai_core:process",
            countdown=2 ** attempt,         # 1s → 2s → 4s
        )
    else:
        with get_db() as db:
            db.query(RawReport).filter_by(id=report_id) \
                .update({"status": "failed"})
            db.commit()

        # Push citizens off the polling state so they see the failure right away.
        _publish_event("notify:ticket_updated", report_id, str(report_id))

        celery_app.send_task(
            "worker.tasks.dlq_alert",
            args=[report_id, error],
            queue="reports:dlq",
        )


# ── Task 4 ────────────────────────────────────────────────────────────────────
# Queue: reports:dlq  |  Producer: handle_ai_failure when retries exhausted

@celery_app.task(name="worker.tasks.dlq_alert", queue="reports:dlq")
def dlq_alert(report_id: str, error: str):
    """Terminal failure handler. For now: log loudly; real alerting wires here later."""
    log.error("DLQ report_id=%s error=%s", report_id, error)
