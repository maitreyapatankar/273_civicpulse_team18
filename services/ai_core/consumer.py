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
from langgraph.checkpoint.memory import MemorySaver
from celery.signals import after_setup_logger

@after_setup_logger.connect
def setup_loggers(logger, *args, **kwargs):
    logging.getLogger().setLevel(logging.INFO)
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter(
        "%(asctime)s %(levelname)s %(name)s - %(message)s"
    ))
    logging.getLogger().addHandler(handler)

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

celery_app = Celery("ai_core", broker=REDIS_URL, backend=None)
celery_app.conf.task_serializer            = "json"
celery_app.conf.accept_content             = ["json"]
celery_app.conf.task_track_started         = True
celery_app.conf.task_acks_late             = True
celery_app.conf.task_reject_on_worker_lost = True


def _build_graph(url: str, max_attempts: int = 10, delay: float = 3.0):
    checkpointer = MemorySaver()
    graph = build_graph(checkpointer)
    log.info("db_connected using MemorySaver")
    return graph


_graph = _build_graph(DATABASE_URL)


def _send_failure(report_id: str, error_msg: str, attempt: int) -> None:
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


@celery_app.task(
    bind=True,
    name="ai_core.consumer.run_pipeline",
    queue="ai_core:process",
    max_retries=0,
    soft_time_limit=180,
    time_limit=240,
)
def run_pipeline(self, report_id: str, payload: dict) -> None:
    config = {"configurable": {"thread_id": report_id}}
    # LangSmith auto-instruments via LANGCHAIN_TRACING_V2 env var

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