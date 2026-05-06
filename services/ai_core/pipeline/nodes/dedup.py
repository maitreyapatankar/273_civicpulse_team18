"""
Deduplication node — direct Postgres read-only lookup.

Checks whether an open, non-duplicate ticket already exists for the same
subcategory within ~100 m of the incoming report.  No embeddings, no vector
DB — just a two-table JOIN.

Also computes cluster_rate_per_hour from the master ticket's created_at so the
urgency node can distinguish a fast-growing cluster from a stale one.

S2 read-only exception: S3 owns all writes; this node only SELECTs so the
single-writer invariant is preserved.
"""

import os
import logging
from datetime import datetime, timezone

from psycopg_pool import ConnectionPool

from ..state import PipelineState

log = logging.getLogger(__name__)

# ~100 m bounding box (degrees).  Accurate enough for same-block dedup.
_TOLERANCE = 0.0009

# Minimum time window to avoid division-by-zero when two reports arrive almost
# simultaneously (floor at 30 minutes).
_MIN_HOURS = 0.5

_DATABASE_URL = os.environ["DATABASE_URL"]

# B6: module-level pool — reused across all dedup calls from the same worker
# process instead of opening a new connection per invocation.
_pool = ConnectionPool(_DATABASE_URL, min_size=1, max_size=2, open=True)

_DEDUP_SQL = """
    SELECT t.id, t.cluster_count, t.created_at
    FROM   tickets t
    JOIN   raw_reports r ON r.id = t.raw_report_id
    WHERE  t.subcategory_code = %s
      AND  t.resolved_at   IS NULL
      AND  t.duplicate_of  IS NULL
      AND  r.id            != %s
      AND  ABS(r.lat - %s) < %s
      AND  ABS(r.lng - %s) < %s
    ORDER  BY t.created_at DESC
    LIMIT  1
"""


def dedup_node(state: PipelineState) -> PipelineState:
    subcategory_code = state.get("subcategory_code")
    lat              = state.get("lat")
    lng              = state.get("lng")
    report_id        = state["report_id"]

    base = {
        **state,
        "is_duplicate":          False,
        "master_ticket_id":      None,
        "cluster_count":         1,
        "cluster_rate_per_hour": 0.0,
        "completed_nodes":       state["completed_nodes"] + ["dedup"],
    }

    if not subcategory_code or lat is None or lng is None:
        log.info("dedup_skip report_id=%s missing_inputs=true", report_id)
        return base

    try:
        with _pool.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    _DEDUP_SQL,
                    (subcategory_code, report_id, lat, _TOLERANCE, lng, _TOLERANCE),
                )
                row = cur.fetchone()

        if row:
            master_id, existing_cluster, master_created_at = row
            new_cluster = (existing_cluster or 1) + 1

            now = datetime.now(timezone.utc)
            if master_created_at.tzinfo is None:
                master_created_at = master_created_at.replace(tzinfo=timezone.utc)
            hours_elapsed = (now - master_created_at).total_seconds() / 3600
            rate = new_cluster / max(hours_elapsed, _MIN_HOURS)

            log.info(
                "dedup_match report_id=%s master_id=%s cluster_count=%s rate_per_hour=%s",
                report_id,
                master_id,
                new_cluster,
                round(rate, 2),
            )
            return {
                **state,
                "is_duplicate":          True,
                "master_ticket_id":      str(master_id),
                "cluster_count":         new_cluster,
                "cluster_rate_per_hour": round(rate, 2),
                "completed_nodes":       state["completed_nodes"] + ["dedup"],
            }

        log.info("dedup_no_match report_id=%s", report_id)
        return base

    except Exception as exc:
        log.warning("dedup query failed for report %s: %s", report_id, exc)
        # Fail open — treat as non-duplicate so the report isn't silently dropped.
        return {**base, "pipeline_error": str(exc)}
