"""
Service 2 — AI Core entry point.

This is a pure Celery consumer. There is NO FastAPI app, NO HTTP server,
and NO exposed port. The only way to trigger work is via the Redis queue.

Queue contract
--------------
Consumes : ai_core:process   payload={report_id, text, image_url, lat, lng,
                                       address, attempt}
Produces : ai_core:results   payload={report_id, enriched_ticket}  (success)
           ai_core:failed    payload={report_id, error, attempt}   (failure)

Retry policy
------------
max_retries=0 here — S3 Worker owns all retry and backoff decisions.
S2 must NEVER re-raise after catching an exception; it signals failure by
pushing to ai_core:failed and returning cleanly.
"""

import os

from celery import Celery

import pipeline

REDIS_URL = os.environ["REDIS_URL"]

celery_app = Celery(
    "ai_core",
    broker=REDIS_URL,
    backend=None,   # no result backend — results travel via queues, not Celery backend
)
celery_app.conf.task_serializer   = "json"
celery_app.conf.accept_content    = ["json"]
celery_app.conf.task_track_started = True


@celery_app.task(
    bind=True,
    name="ai_core.consumer.run_pipeline",
    queue="ai_core:process",
    max_retries=0,          # retry logic belongs to S3 Worker
)
def run_pipeline(self, report_id: str, payload: dict) -> None:
    """Consume one report from ai_core:process and run the full 5-step pipeline.

    On success  → send handle_ai_result  to ai_core:results
    On any error → send handle_ai_failure to ai_core:failed
                   (do NOT re-raise — S3 Worker decides whether to retry)
    """
    try:
        enriched_ticket = pipeline.run(payload)

        celery_app.send_task(
            "worker.tasks.handle_ai_result",
            args=[report_id, enriched_ticket],
            queue="ai_core:results",
        )

    except Exception as exc:  # noqa: BLE001
        attempt = payload.get("attempt", 0)
        celery_app.send_task(
            "worker.tasks.handle_ai_failure",
            args=[report_id, str(exc), attempt],
            queue="ai_core:failed",
        )
