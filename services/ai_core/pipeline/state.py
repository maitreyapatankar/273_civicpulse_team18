from typing import TypedDict, Optional


class PipelineState(TypedDict):
    # ── Inputs (set at START, never mutated by nodes) ──────
    report_id:    str
    text:         str
    image_url:    Optional[str]
    lat:          Optional[float]
    lng:          Optional[float]
    address:      Optional[str]
    attempt:      int

    # ── Written by: image_description node ────────────────
    image_desc: Optional[str]

    # ── Written by: classify node ─────────────────────────
    category_code:             Optional[str]
    category_name:             Optional[str]
    subcategory_code:          Optional[str]
    subcategory_name:          Optional[str]
    severity:                  Optional[int]
    confidence:                Optional[float]
    reasoning:                 Optional[str]
    image_text_conflict:       bool
    image_classification_hint: str
    needs_review:              bool

    # ── Written by: dedup node ─────────────────────────────
    is_duplicate:          bool
    master_ticket_id:      Optional[str]
    cluster_count:         int
    cluster_rate_per_hour: float   # reports/hour since master ticket created; 0.0 for new tickets

    # ── Written by: urgency node ───────────────────────────
    urgency_score:     Optional[int]
    urgency_factors:   Optional[dict]
    urgency_reasoning: Optional[str]
    p1_override:       bool

    # ── Pipeline control ───────────────────────────────────
    pipeline_error:  Optional[str]
    completed_nodes: list[str]


def initial_state(
    report_id: str,
    text: str,
    image_url: Optional[str],
    lat: Optional[float] = None,
    lng: Optional[float] = None,
    address: Optional[str] = None,
    attempt: int = 0,
) -> PipelineState:
    """Return a PipelineState with all fields initialised to safe defaults."""
    return PipelineState(
        report_id=report_id,
        text=text,
        image_url=image_url,
        lat=lat,
        lng=lng,
        address=address,
        attempt=attempt,
        image_desc=None,
        category_code=None,
        category_name=None,
        subcategory_code=None,
        subcategory_name=None,
        severity=None,
        confidence=None,
        reasoning=None,
        image_text_conflict=False,
        image_classification_hint="",
        needs_review=False,
        is_duplicate=False,
        master_ticket_id=None,
        cluster_count=1,
        cluster_rate_per_hour=0.0,
        urgency_score=None,
        urgency_factors=None,
        urgency_reasoning=None,
        p1_override=False,
        pipeline_error=None,
        completed_nodes=[],
    )
