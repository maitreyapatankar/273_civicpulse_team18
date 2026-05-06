"""
Service 2 — AI Core entry point.

Pure Celery consumer. No FastAPI. No HTTP server. No exposed port.

Queue contract
--------------
Consumes : ai_core:process   payload={report_id, text, image_url, lat, lng, address, attempt}
Produces : ai_core:results   payload={report_id, enriched_ticket}  (success)
           ai_core:failed    payload={report_id, error, attempt}   (failure)

Retry policy
------------
max_retries=0 — S3 Worker owns all retry and backoff decisions.
"""

import logging
import os
import time

from celery import Celery
from celery.exceptions import SoftTimeLimitExceeded
from langchain_core.tracers.langchain import LangChainTracer
from langgraph.checkpoint.memory import MemorySaver

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=LOG_LEVEL,
    format="%(asctime)s %(levelname)s %(name)s - %(message)s",
)
log = logging.getLogger(__name__)

from pipeline.graph import build_graph
from pipeline.state import initial_state

REDIS_URL    = os.environ["REDIS_URL"]
DATABASE_URL = os.environ["DATABASE_URL"]

celery_app = Celery(
    "ai_core",
    broker=REDIS_URL,
    backend=None,
)
celery_app.conf.task_serializer            = "json"
celery_app.conf.accept_content             = ["json"]
celery_app.conf.task_track_started         = True
# Acknowledge only after the task completes so a worker crash re-queues it.
celery_app.conf.task_acks_late             = True
celery_app.conf.task_reject_on_worker_lost = True

# ── Checkpointer + graph — built once at worker startup ───────────────────────
# Uses ConnectionPool (B1: auto-reconnects on dropped connections).
# Retries until Postgres is ready (B2: handles slow DB startup in Docker).

def _build_graph(url: str, max_attempts: int = 10, delay: float = 3.0):
    checkpointer = MemorySaver()
    graph = build_graph(checkpointer)
    log.info("db_connected using MemorySaver")
    return graph


_graph = _build_graph(DATABASE_URL)


def _send_failure(report_id: str, error_msg: str, attempt: int) -> None:
    """Route a failed pipeline run to S3 for retry/DLQ.
    Nested try/except so a simultaneous Redis outage is logged, not silently swallowed (#9).
    """
    try:
        celery_app.send_task(
            "worker.tasks.handle_ai_failure",
            args=[report_id, error_msg, attempt],
            queue="ai_core:failed",
        )
        log.info("pipeline_failure_sent report_id=%s queue=ai_core:failed", report_id)
    except Exception as broker_exc:
        log.error(
            "pipeline_failure_send_failed report_id=%s broker_error=%s original_error=%s",
            report_id, broker_exc, error_msg,
        )


def _langsmith_tracer() -> LangChainTracer | None:
    enabled = os.environ.get("LANGCHAIN_TRACING_V2", "").lower() in {"1", "true", "yes"}
    if not enabled:
        return None
    project = os.environ.get("LANGCHAIN_PROJECT") or "civicpulse-ai-core"
    return LangChainTracer(project_name=project)


@celery_app.task(
    bind=True,
    name="ai_core.consumer.run_pipeline",
    queue="ai_core:process",
    max_retries=0,
    soft_time_limit=180,   # raises SoftTimeLimitExceeded → caught below → ai_core:failed
    time_limit=240,        # hard kill if the soft handler itself hangs
)
def run_pipeline(self, report_id: str, payload: dict) -> None:
    """Consume one report from ai_core:process, run the LangGraph pipeline.

    thread_id = report_id so LangGraph resumes from last checkpoint on retry.
    On success → ai_core:results. On failure → ai_core:failed. Never re-raises.
    """
    config = {"configurable": {"thread_id": report_id}}
    tracer = _langsmith_tracer()
    if tracer:
        config["callbacks"] = [tracer]

    try:
        log.info(
            "pipeline_start report_id=%s attempt=%s has_image=%s",
            report_id,
            payload.get("attempt", 0),
            bool(payload.get("image_url")),
        )
        state = initial_state(
            report_id=report_id,
            text=payload["text"],
            image_url=payload.get("image_url"),
            lat=payload.get("lat"),
            lng=payload.get("lng"),
            address=payload.get("address"),
            attempt=payload.get("attempt", 0),
        )

        result = _graph.invoke(state, config=config)

        log.info(
            "pipeline_done report_id=%s completed_nodes=%s is_duplicate=%s needs_review=%s urgency_score=%s",
            report_id,
            result.get("completed_nodes"),
            result.get("is_duplicate"),
            result.get("needs_review"),
            result.get("urgency_score"),
        )
        celery_app.send_task(
            "worker.tasks.handle_ai_result",
            args=[report_id, dict(result)],
            queue="ai_core:results",
        )
        log.info("pipeline_result_sent report_id=%s queue=ai_core:results", report_id)

    except SoftTimeLimitExceeded:
        log.error("pipeline_timeout report_id=%s", report_id)
        _send_failure(report_id, "pipeline exceeded 180 s soft time limit", payload.get("attempt", 0))
    except Exception as exc:
        log.exception("pipeline_failed report_id=%s error=%s", report_id, exc)
        _send_failure(report_id, str(exc), payload.get("attempt", 0))
