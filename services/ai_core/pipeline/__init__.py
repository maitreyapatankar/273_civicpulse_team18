"""
AI pipeline — orchestrates the 5 sequential steps for a single report.

Input payload  (dict from S3 Worker via ai_core:process queue):
    report_id   str
    text        str | None
    image_url   str | None   — S3/R2 object URL; absent when no photo
    lat         float
    lng         float
    address     str | None
    attempt     int          — retry counter (0 = first attempt)

Output (EnrichedTicket dict forwarded to ai_core:results queue):
    issue_type          str             — pothole|flooding|sinkhole|crack|sign_damage|other
    severity            int             — 1-5
    urgency_score       float           — 1.0-5.0
    urgency_factors     dict            — {safety_risk, traffic_impact, cluster_volume, days_unresolved}
    ai_reasoning        str             — one sentence shown to dispatcher
    confidence          float           — 0.0-1.0
    duplicate_of        str | None      — tickets.id UUID string of master ticket
    cluster_count       int             — 1 for new ticket, 2 for duplicate (S3 Worker holds true count)
    work_order          dict            — {crew_type, materials[], est_hours, notes}

Step execution order
--------------------
1. classify.describe_image  (vision model   — skipped if no image_url)
2. classify.classify        (language model — returns ClassificationResult dataclass)
3. dedup.deduplicate        (text-embedding-3-small → Pinecone ANN, returns DedupResult dataclass)
4. urgency.score            (P1 keyword rule → LLM if no keyword match, returns dict)
5. workorder.generate       (language model — returns dict)

cluster_count note
------------------
S2 has no Postgres access so it cannot read the true cluster size from DB.
cluster_count is derived from the dedup result: 1 for a new ticket, 2 for a
duplicate (conservative floor). S3 Worker can update the real count after
writing the ticket.
"""

from pipeline import classify, dedup, urgency, workorder


def run(payload: dict) -> dict:
    """Run all 5 pipeline steps in sequence and return an EnrichedTicket dict.

    Raises on any step failure — caller (consumer.run_pipeline) catches and
    routes to ai_core:failed without re-raising.
    """
    # Step 1 — image description (skipped if no image)
    image_desc = None
    if payload.get("image_url"):
        image_desc = classify.describe_image(payload["image_url"])

    # Step 2 — classification → ClassificationResult dataclass
    clf = classify.classify(
        text=payload.get("text"),
        image_desc=image_desc,
        address=payload.get("address"),
    )

    # Step 3 — deduplication → DedupResult dataclass
    exclude_ids: set[str] = set()
    if payload.get("is_edit"):
        exclude_ids.add(payload.get("report_id", ""))
        existing_ticket_id = payload.get("existing_ticket_id")
        if existing_ticket_id:
            exclude_ids.add(existing_ticket_id)

    dedup_result = dedup.deduplicate(
        report_id=payload["report_id"],
        text=payload.get("text") or (image_desc or ""),
        lat=payload["lat"],
        lng=payload["lng"],
        issue_type=clf.issue_type,
        exclude_ids=exclude_ids,
    )

    # S2 has no DB access — derive cluster_count from dedup outcome
    cluster_count = 2 if dedup_result.is_duplicate else 1

    # Step 4 — urgency scoring → dict
    urgency_result = urgency.score(
        issue_type=clf.issue_type,
        severity=clf.severity,
        cluster_count=cluster_count,
        days_open=0,    # 0 on first insert; S3 Worker backfills from created_at on retries
        text=payload.get("text") or "",
    )

    # Step 5 — work order generation → dict
    work_order = workorder.generate(
        issue_type=clf.issue_type,
        severity=clf.severity,
        urgency_score=urgency_result["score"],
        text=payload.get("text") or "",
    )

    return {
        "issue_type":      clf.issue_type,
        "severity":        clf.severity,
        "confidence":      clf.confidence,
        "ai_reasoning":    clf.reasoning,
        "urgency_score":   float(urgency_result["score"]),
        "urgency_factors": urgency_result["factors"],
        "duplicate_of":    dedup_result.master_ticket_id,
        "cluster_count":   cluster_count,
        "work_order":      work_order,
    }
