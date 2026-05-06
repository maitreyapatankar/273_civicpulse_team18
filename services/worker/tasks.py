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
from datetime import datetime, timezone
from typing import Optional

import redis
from celery import Celery
from sqlalchemy import func

from shared.db import get_db
from shared.models import Crew, RawReport, Ticket

# ── Category-code prefix → department ────────────────────────────────────────
# Matches taxonomy.json categories to the five officer departments.

_CATEGORY_DEPT: dict[str, str] = {
    "RD": "roads",       # Road Surface
    "SG": "roads",       # Signage
    "MK": "roads",       # Road Markings
    "SW": "roads",       # Sidewalk / Footpath
    "TF": "traffic",     # Traffic Signal
    "SL": "traffic",     # Street Lighting
    "DR": "drainage",    # Drainage
    "ST": "structures",  # Structures & Bridges
    "OT": "operations",  # Other / catch-all
}

REDIS_URL = os.environ["REDIS_URL"]
LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()

logging.basicConfig(
    level=LOG_LEVEL,
    format="%(asctime)s %(levelname)s %(name)s - %(message)s",
)

celery_app = Celery("worker", broker=REDIS_URL, backend=None)
celery_app.conf.task_serializer            = "json"
celery_app.conf.accept_content             = ["json"]
# Acknowledge only after the task completes so a worker crash re-queues it.
celery_app.conf.task_acks_late             = True
celery_app.conf.task_reject_on_worker_lost = True

# socket_timeout=2 ensures publish() fails fast on a hung Redis rather than
# blocking the task indefinitely. _publish_event already swallows the exception.
_redis = redis.Redis.from_url(REDIS_URL, socket_timeout=2, socket_connect_timeout=2)
log = logging.getLogger(__name__)


def _auto_assign(db, ticket: Ticket, category_code: Optional[str]) -> None:
    """Assign the ticket to the crew lead in the matching crew_type with the
    fewest currently open (unresolved) tickets. Silently no-ops when no crews
    are available for that crew_type.
    """
    crew_type = _CATEGORY_DEPT.get((category_code or "")[:2], "operations")

    candidates = (
        db.query(Crew)
          .filter(Crew.crew_type == crew_type)
          .all()
    )

    if not candidates:
        log.warning("auto_assign no crews found crew_type=%s ticket_id=%s", crew_type, ticket.id)
        return

    # Count open tickets per crew, keyed by crew ID
    open_counts: dict[str, int] = {
        str(c.id): (
            db.query(func.count(Ticket.id))
              .filter(Ticket.assigned_to == c.team_name)
              .filter(Ticket.resolved_at.is_(None))
              .scalar() or 0
        )
        for c in candidates
    }

    chosen = min(candidates, key=lambda c: open_counts.get(str(c.id), 0))
    ticket.assigned_to = chosen.team_name
    ticket.crew_id = chosen.id
    ticket.assigned_at = datetime.now(timezone.utc)
    ticket.lifecycle_status = 'forwarded_to_maintenance'
    log.info(
        "auto_assign ticket_id=%s crew_type=%s crew=%s open_tickets=%s",
        ticket.id, crew_type, chosen.team_name, open_counts.get(str(chosen.id), 0),
    )


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
        if not report:
            raise LookupError(f"RawReport {report_id} not found — cannot retry")
        return report.to_dict()


# ── Task 1 ────────────────────────────────────────────────────────────────────
# Queue: reports:process  |  Producer: S1 API Gateway

@celery_app.task(bind=True, name="worker.tasks.process_report", queue="reports:process",
                 soft_time_limit=30, time_limit=60)
def process_report(self, report_id: str):
    """Fetch the raw report, mark it processing, forward payload to AI Core."""
    log.info("process_report_start report_id=%s", report_id)
    with get_db() as db:
        report = db.get(RawReport, report_id)
        if not report:
            log.error("process_report_not_found report_id=%s — discarding task", report_id)
            return
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
    log.info("process_report_loaded report_id=%s is_edit=%s", report_id, payload["is_edit"])
    if existing_ticket:
        payload["existing_ticket_id"] = str(existing_ticket.id)
    celery_app.send_task(
        "ai_core.consumer.run_pipeline",
        args=[report_id, payload],
        queue="ai_core:process",
    )
    log.info("process_report_forwarded report_id=%s queue=ai_core:process", report_id)


# ── Task 2 ────────────────────────────────────────────────────────────────────
# Queue: ai_core:results  |  Producer: S2 AI Core (success path)

@celery_app.task(name="worker.tasks.handle_ai_result", queue="ai_core:results",
                 soft_time_limit=60, time_limit=120)
def handle_ai_result(report_id: str, enriched: dict):
    """Write enriched ticket to DB, mark report done, publish SSE notification.

    Duplicate path: creates a shadow ticket (duplicate_of = master) AND updates
    the master ticket's urgency_score / cluster_count with the new cluster state.
    """
    is_dup    = bool(enriched.get("is_duplicate"))
    master_id = enriched.get("master_ticket_id")
    log.info(
        "ai_result_start report_id=%s is_duplicate=%s master_id=%s",
        report_id,
        is_dup,
        master_id,
    )
    with get_db() as db:
        # Edit path: a ticket already exists for this raw_report_id (report was re-queued).
        existing = (
            db.query(Ticket)
              .filter(Ticket.raw_report_id == report_id)
              .first()
        )

        if existing:
            existing.category_code             = enriched.get("category_code")
            existing.category_name             = enriched.get("category_name")
            existing.subcategory_code          = enriched.get("subcategory_code")
            existing.subcategory_name          = enriched.get("subcategory_name")
            existing.severity                  = enriched.get("severity")
            existing.confidence                = enriched.get("confidence")
            existing.ai_reasoning              = enriched.get("urgency_reasoning")
            existing.image_text_conflict       = enriched.get("image_text_conflict", False)
            existing.image_classification_hint = enriched.get("image_classification_hint") or None
            existing.needs_review              = enriched.get("needs_review", False)
            existing.urgency_score             = enriched.get("urgency_score")
            existing.urgency_factors           = dict(enriched.get("urgency_factors") or {})
            existing.duplicate_of              = master_id
            enriched_cluster                   = enriched.get("cluster_count") or 1
            existing.cluster_count             = max(existing.cluster_count or 1, enriched_cluster)
            # Auto-assign to crew if not yet assigned
            if not existing.crew_id:
                _auto_assign(db, existing, enriched.get("category_code"))
            ticket_id = str(existing.id)
        else:
            ticket = Ticket(
                raw_report_id             = report_id,
                category_code             = enriched.get("category_code"),
                category_name             = enriched.get("category_name"),
                subcategory_code          = enriched.get("subcategory_code"),
                subcategory_name          = enriched.get("subcategory_name"),
                severity                  = enriched.get("severity"),
                confidence                = enriched.get("confidence"),
                ai_reasoning              = enriched.get("urgency_reasoning"),
                image_text_conflict       = enriched.get("image_text_conflict", False),
                image_classification_hint = enriched.get("image_classification_hint") or None,
                needs_review              = enriched.get("needs_review", False),
                urgency_score             = enriched.get("urgency_score"),
                urgency_factors           = dict(enriched.get("urgency_factors") or {}),
                cluster_count             = enriched.get("cluster_count", 1),
                duplicate_of              = master_id,
            )
            db.add(ticket)
            db.flush()  # populate ticket.id before response
            ticket_id = str(ticket.id)

        # For duplicates, propagate the re-scored urgency back to the master ticket
        # so dispatchers see the updated priority as the cluster grows.
        if is_dup and master_id:
            master = db.get(Ticket, master_id)
            if master:
                master.urgency_score   = enriched.get("urgency_score")
                master.urgency_factors = dict(enriched.get("urgency_factors") or {})
                master.cluster_count   = enriched.get("cluster_count", (master.cluster_count or 1) + 1)

        db.query(RawReport).filter_by(id=report_id).update({"status": "done"})
        db.commit()

    # Notify on the master ticket ID when a duplicate comes in so the dashboard
    # refreshes the right row.
    notify_id = master_id if (is_dup and master_id) else ticket_id
    channel   = "notify:ticket_ready" if not existing and not is_dup else "notify:ticket_updated"
    _publish_event(channel, notify_id, str(report_id))
    log.info(
        "ai_result_done report_id=%s ticket_id=%s notify_id=%s channel=%s cluster_count=%s",
        report_id,
        ticket_id,
        notify_id,
        channel,
        enriched.get("cluster_count") or 1,
    )


# ── Task 3 ────────────────────────────────────────────────────────────────────
# Queue: ai_core:failed  |  Producer: S2 AI Core (failure path)

@celery_app.task(name="worker.tasks.handle_ai_failure", queue="ai_core:failed",
                 soft_time_limit=30, time_limit=60)
def handle_ai_failure(report_id: str, error: str, attempt: int):
    """Retry the pipeline with exponential backoff, or send to DLQ after 3 attempts."""
    if attempt < 3:
        # Idempotency guard: with task_acks_late a worker crash after send_task but
        # before ack re-delivers this task. The NX key prevents a second retry from
        # being enqueued for the same (report, attempt) pair.
        lock_key = f"retry_lock:{report_id}:{attempt}"
        if not _redis.set(lock_key, "1", nx=True, ex=120):
            log.warning(
                "handle_ai_failure duplicate delivery skipped report_id=%s attempt=%s",
                report_id, attempt,
            )
            return
        log.warning(
            "ai_failure_retry report_id=%s attempt=%s next_attempt=%s error=%s",
            report_id,
            attempt,
            attempt + 1,
            error,
        )
        try:
            payload = _fetch_raw_payload(report_id)
        except LookupError as exc:
            log.error(
                "retry_fetch_failed report_id=%s error=%s — sending to DLQ",
                report_id, exc,
            )
            celery_app.send_task(
                "worker.tasks.dlq_alert",
                args=[report_id, str(exc)],
                queue="reports:dlq",
            )
            return
        payload["attempt"] = attempt + 1

        celery_app.send_task(
            "ai_core.consumer.run_pipeline",
            args=[report_id, payload],
            queue="ai_core:process",
            countdown=2 ** attempt,         # 1s → 2s → 4s
        )
    else:
        log.error("ai_failure_dlq report_id=%s attempt=%s error=%s", report_id, attempt, error)
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

@celery_app.task(name="worker.tasks.dlq_alert", queue="reports:dlq",
                 soft_time_limit=10, time_limit=30)
def dlq_alert(report_id: str, error: str):
    """Terminal failure handler. For now: log loudly; real alerting wires here later."""
    log.error("DLQ report_id=%s error=%s", report_id, error)
