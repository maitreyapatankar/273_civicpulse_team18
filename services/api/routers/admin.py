import json
import os
from datetime import datetime, timezone
from functools import lru_cache
from uuid import UUID

import redis
from fastapi import APIRouter, Depends, HTTPException
from fastapi import status as http_status

from routers.auth import require_officer_jwt
from routers.tickets import _ticket_to_response
from shared.db import get_db
from shared.models import RawReport, Ticket, TicketComment
from schemas.ticket import TicketOverride, TicketResponse

router = APIRouter(prefix="/tickets", tags=["admin"])


@lru_cache(maxsize=1)
def _redis_client() -> redis.Redis:
    return redis.Redis.from_url(os.environ["REDIS_URL"])


def _publish(channel: str, ticket_id: str, report_id: str | None) -> None:
    """Best-effort fan-out to Redis pub/sub. Never blocks the request."""
    try:
        _redis_client().publish(
            channel,
            json.dumps({"ticket_id": ticket_id, "report_id": report_id}),
        )
    except Exception:
        # SSE is a nice-to-have; don't fail an admin write because Redis is down
        pass


# ── PATCH /tickets/:id ────────────────────────────────────────────────────────

@router.patch("/{ticket_id}", response_model=TicketResponse)
async def override_ticket(
    ticket_id: UUID,
    override:  TicketOverride,
    payload:   dict = Depends(require_officer_jwt),
):
    with get_db() as db:
        ticket = db.get(Ticket, ticket_id)
        if not ticket:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND,
                detail="Ticket not found",
            )

        now = datetime.now(timezone.utc)
        # Track which kind of write we performed so we publish the right channel
        # and only flip dispatcher_override when an AI field was actually changed.
        ai_overridden = False
        assigned     = False
        resolved     = False

        if override.urgency_score is not None:
            ticket.urgency_score = override.urgency_score
            ai_overridden = True
        if override.issue_type is not None:
            ticket.issue_type = override.issue_type
            ai_overridden = True
        if override.notes is not None:
            work_order = dict(ticket.work_order or {})
            work_order["dispatcher_notes"] = override.notes
            ticket.work_order = work_order
            ai_overridden = True

        if override.assign_to is not None:
            ticket.assigned_to = override.assign_to or None
            ticket.assigned_at = now if override.assign_to else None
            assigned = True

        if override.resolve is True:
            ticket.resolved_at = now
            resolved = True
        elif override.resolve is False:
            # explicit re-open
            ticket.resolved_at = None

        if override.comment:
            author_id = None
            try:
                author_id = UUID(str(payload.get("sub")))
            except Exception:
                author_id = None

            comment = TicketComment(
                ticket_id=ticket.id,
                author_type="officer",
                author_id=author_id,
                message=override.comment,
                is_public=True if override.is_public is None else bool(override.is_public),
            )
            db.add(comment)

        if ai_overridden:
            ticket.dispatcher_override = True
            ticket.override_by = payload.get("sub") or payload.get("username")
            ticket.override_at = now

        db.commit()
        db.refresh(ticket)

        raw_report = (
            db.get(RawReport, ticket.raw_report_id) if ticket.raw_report_id else None
        )
        response = _ticket_to_response(ticket, raw_report)

    # Publish AFTER the DB commit + session close.
    # Resolved is a stronger signal than updated; pick one.
    channel = (
        "notify:ticket_resolved" if resolved
        else "notify:ticket_updated"
    )
    _publish(channel, str(ticket_id), str(response.raw_report_id) if response.raw_report_id else None)

    return response
