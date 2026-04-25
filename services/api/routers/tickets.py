import os
from typing import List
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from fastapi import status as http_status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt

from shared.db import get_db
from shared.models import RawReport, Ticket
from schemas.ticket import TicketResponse, TicketStatusResponse

router = APIRouter(prefix="/tickets", tags=["tickets"])

_bearer = HTTPBearer()


def require_jwt(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer),
) -> dict:
    try:
        return jwt.decode(
            credentials.credentials,
            os.environ["JWT_SECRET"],
            algorithms=["HS256"],
        )
    except JWTError:
        raise HTTPException(
            status_code=http_status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )


# ── GET /tickets ──────────────────────────────────────────────────────────────

@router.get("", response_model=List[TicketResponse])
async def list_tickets(
    status: str = "open",   # open | resolved | all
    page:   int = 1,
    limit:  int = 50,
    _:      dict = Depends(require_jwt),
):
    with get_db() as db:
        q = db.query(Ticket)

        if status == "open":
            q = q.filter(Ticket.resolved_at.is_(None))
        elif status == "resolved":
            q = q.filter(Ticket.resolved_at.isnot(None))
        # "all" → no filter

        tickets = (
            q.order_by(Ticket.urgency_score.desc())
             .offset((page - 1) * limit)
             .limit(limit)
             .all()
        )
        return [TicketResponse.model_validate(t) for t in tickets]


# ── GET /tickets/:id/status ───────────────────────────────────────────────────

@router.get("/{ticket_id}/status", response_model=TicketStatusResponse)
async def get_ticket_status(ticket_id: UUID):
    with get_db() as db:
        # Citizen path: ticket_id is raw_report.id (returned by POST /reports)
        raw_report = db.get(RawReport, ticket_id)
        if raw_report:
            ticket = (
                db.query(Ticket)
                  .filter(Ticket.raw_report_id == raw_report.id)
                  .first()
            )
        else:
            # S5 path: ticket_id is tickets.id (published by S3 Worker)
            ticket = db.get(Ticket, ticket_id)
            if not ticket:
                raise HTTPException(status_code=404, detail="Ticket not found")
            raw_report = db.get(RawReport, ticket.raw_report_id)
            if not raw_report:
                raise HTTPException(status_code=404, detail="Ticket not found")

        return TicketStatusResponse(
            id=raw_report.id,
            status=raw_report.status,
            issue_type=ticket.issue_type if ticket else None,
            urgency_score=ticket.urgency_score if ticket else None,
            duplicate_of=ticket.duplicate_of if ticket else None,
            cluster_count=ticket.cluster_count if ticket else 1,
            reporter_phone=raw_report.reporter_phone,
            created_at=raw_report.submitted_at,
        )
