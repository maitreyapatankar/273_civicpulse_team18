from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from fastapi import status as http_status

from routers.tickets import require_jwt
from shared.db import get_db
from shared.models import Ticket
from schemas.ticket import TicketOverride, TicketResponse

router = APIRouter(prefix="/tickets", tags=["admin"])


# ── PATCH /tickets/:id ────────────────────────────────────────────────────────

@router.patch("/{ticket_id}", response_model=TicketResponse)
async def override_ticket(
    ticket_id: UUID,
    override:  TicketOverride,
    payload:   dict = Depends(require_jwt),
):
    with get_db() as db:
        ticket = db.get(Ticket, ticket_id)
        if not ticket:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND,
                detail="Ticket not found",
            )

        if override.urgency_score is not None:
            ticket.urgency_score = override.urgency_score
        if override.issue_type is not None:
            ticket.issue_type = override.issue_type
        if override.notes is not None:
            # New dict assignment so SQLAlchemy detects the JSONB mutation
            work_order = dict(ticket.work_order or {})
            work_order["dispatcher_notes"] = override.notes
            ticket.work_order = work_order

        ticket.dispatcher_override = True
        ticket.override_by = payload.get("sub") or payload.get("username")
        ticket.override_at = datetime.now(timezone.utc)

        db.commit()
        db.refresh(ticket)
        return TicketResponse.model_validate(ticket)
