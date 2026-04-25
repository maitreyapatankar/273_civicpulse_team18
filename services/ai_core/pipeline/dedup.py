"""
Step 3 — Deduplication  (text-embedding-3-small → Pinecone ANN)

Checks whether the incoming report is a duplicate of an existing nearby ticket.

Algorithm — copied verbatim from ARCHITECTURE.md, do not modify thresholds:
1. Embed report text with OpenAI text-embedding-3-small (1536-dim).
2. Query Pinecone with a geo bbox + 30-day epoch filter, top_k=5.
3. cosine score > 0.88 on the top match → duplicate.
   Return DedupResult(is_duplicate=True, master_ticket_id=<existing tickets.id>).
4. No match → upsert new vector with metadata, return DedupResult(is_duplicate=False).

Upsert is intentionally skipped when the report IS a duplicate — the master
ticket's vector already represents the cluster.

Environment
-----------
    OPENAI_API_KEY    — embeddings only, no chat
    PINECONE_API_KEY
    PINECONE_INDEX    — e.g. "civicpulse-reports"
"""

import os
import time
from dataclasses import dataclass, field

import openai
from pinecone import Pinecone

_EMBED_MODEL = "text-embedding-3-small"
_GEO_RADIUS  = 0.005        # ≈ 500 m bounding box in degrees
_DAYS_WINDOW = 30
_COSINE_THRESHOLD = 0.88


# ── Result type ───────────────────────────────────────────────────────────────

@dataclass
class DedupResult:
    is_duplicate:     bool
    master_ticket_id: str | None = field(default=None)


# ── Internal helpers — not cached, keeps mocking simple in tests ──────────────

def _make_openai_client() -> openai.OpenAI:
    return openai.OpenAI(api_key=os.environ["OPENAI_API_KEY"])


def _get_pinecone_index():
    pc = Pinecone(api_key=os.environ["PINECONE_API_KEY"])
    return pc.Index(os.environ["PINECONE_INDEX"])


def _embed(text: str) -> list[float]:
    return (
        _make_openai_client()
        .embeddings.create(input=text, model=_EMBED_MODEL)
        .data[0]
        .embedding
    )


# ── Public API ────────────────────────────────────────────────────────────────

def deduplicate(
    report_id: str,
    text: str,
    lat: float,
    lng: float,
    issue_type: str,
) -> DedupResult:
    """Embed text, query Pinecone, and determine whether this report is a duplicate.

    Returns:
        DedupResult(is_duplicate=True,  master_ticket_id=<str>)  — duplicate found
        DedupResult(is_duplicate=False, master_ticket_id=None)   — new; vector upserted

    Raises:
        openai.APIError          on embedding failure.
        pinecone.PineconeException on index query or upsert failure.
    """
    vec   = _embed(text)
    index = _get_pinecone_index()

    thirty_days_ago_epoch = int(time.time()) - _DAYS_WINDOW * 24 * 60 * 60

    # ── exact query from ARCHITECTURE.md ──────────────────────────────────────
    results = index.query(
        vector=vec,
        filter={
            "lat":           {"$gte": lat - _GEO_RADIUS, "$lte": lat + _GEO_RADIUS},
            "lng":           {"$gte": lng - _GEO_RADIUS, "$lte": lng + _GEO_RADIUS},
            "created_epoch": {"$gte": thirty_days_ago_epoch},
        },
        top_k=5,
        include_metadata=True,
    )

    if results.matches and results.matches[0].score > _COSINE_THRESHOLD:
        return DedupResult(
            is_duplicate=True,
            master_ticket_id=results.matches[0].id,
        )

    # ── exact upsert from ARCHITECTURE.md ─────────────────────────────────────
    index.upsert(vectors=[(
        report_id,
        vec,
        {
            "lat":           lat,
            "lng":           lng,
            "created_epoch": int(time.time()),
            "issue_type":    issue_type,
        },
    )])

    return DedupResult(is_duplicate=False)
