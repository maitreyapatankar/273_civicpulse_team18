from typing import List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from fastapi import status as http_status

from shared.db import get_db
from shared.models import RawReport, Ticket, TicketComment
from schemas.ticket import TicketResponse, TicketStatusResponse, TicketDetailResponse, TicketCommentResponse
from schemas.citizen import CitizenTicketSummary, CitizenTicketDetail, DepartmentUpdate
from routers.auth import require_officer_jwt, require_citizen_jwt

router = APIRouter(tags=["tickets"])


def derive_status(raw_status: Optional[str], ticket: Optional[Ticket]) -> str:
    """Compute the citizen-facing lifecycle status from raw_report + ticket fields.

    Order of checks matters: failed beats everything; resolved beats in_progress;
    pre-AI states (queued/processing) win when no ticket has been created yet.
    """
    if raw_status == "failed":
        return "failed"
    if raw_status in ("queued", "processing") and not ticket:
        return raw_status or "queued"
    if ticket and ticket.resolved_at:
        return "resolved"
    if ticket and ticket.assigned_at:
        return "in_progress"
    if ticket:
        return "open"
    return raw_status or "queued"


def _ticket_to_response(ticket: Ticket, raw_report: Optional[RawReport]) -> TicketResponse:
    base = TicketResponse.model_validate(ticket).model_dump()
    base["lifecycle_status"] = derive_status(
        raw_report.status if raw_report else None, ticket
    )
    if raw_report:
        base["lat"] = raw_report.lat
        base["lng"] = raw_report.lng
        base["address"] = raw_report.address
    return TicketResponse.model_validate(base)


def _public_updates(db, ticket_id: UUID) -> list[DepartmentUpdate]:
    rows = (
        db.query(TicketComment)
          .filter(TicketComment.ticket_id == ticket_id)
          .filter(TicketComment.is_public.is_(True))
          .order_by(TicketComment.created_at.asc())
          .all()
    )
    return [
        DepartmentUpdate(id=row.id, message=row.message, created_at=row.created_at)
        for row in rows
    ]


# ── GET /tickets ──────────────────────────────────────────────────────────────

@router.get("/tickets", response_model=List[TicketResponse])
async def list_tickets(
    status: str = "open",   # open | resolved | all
    page:   int = 1,
    limit:  int = 50,
    _:      dict = Depends(require_officer_jwt),
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

        report_ids = [t.raw_report_id for t in tickets if t.raw_report_id]
        raw_by_id = {}
        if report_ids:
            raw_by_id = {
                r.id: r
                for r in db.query(RawReport).filter(RawReport.id.in_(report_ids)).all()
            }

        return [_ticket_to_response(t, raw_by_id.get(t.raw_report_id)) for t in tickets]


# ── GET /tickets/:id/status ───────────────────────────────────────────────────

@router.get("/tickets/{ticket_id}/status", response_model=TicketStatusResponse)
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
            status=derive_status(raw_report.status, ticket),
            issue_type=ticket.issue_type if ticket else None,
            urgency_score=ticket.urgency_score if ticket else None,
            duplicate_of=ticket.duplicate_of if ticket else None,
            cluster_count=ticket.cluster_count if ticket else 1,
            reporter_phone=raw_report.reporter_phone,
            assigned_to=ticket.assigned_to if ticket else None,
            assigned_at=ticket.assigned_at if ticket else None,
            resolved_at=ticket.resolved_at if ticket else None,
            created_at=raw_report.submitted_at,
        )


@router.get("/tickets/{ticket_id}", response_model=TicketDetailResponse)
async def get_ticket_detail(
    ticket_id: UUID,
    _: dict = Depends(require_officer_jwt),
):
    with get_db() as db:
        ticket = db.get(Ticket, ticket_id)
        if not ticket:
            raise HTTPException(status_code=404, detail="Ticket not found")

        raw_report = (
            db.get(RawReport, ticket.raw_report_id) if ticket.raw_report_id else None
        )

        comments = (
            db.query(TicketComment)
              .filter(TicketComment.ticket_id == ticket_id)
              .order_by(TicketComment.created_at.asc())
              .all()
        )

        return TicketDetailResponse(
            **_ticket_to_response(ticket, raw_report).model_dump(),
            comments=[TicketCommentResponse.model_validate(c) for c in comments],
        )


@router.get("/citizens/tickets", response_model=List[CitizenTicketSummary], tags=["citizens"])
async def list_citizen_tickets(payload: dict = Depends(require_citizen_jwt)):
    citizen_id = payload.get("sub")
    if not citizen_id:
        raise HTTPException(status_code=401, detail="Invalid token subject")

    with get_db() as db:
        reports = (
            db.query(RawReport)
              .filter(RawReport.citizen_id == UUID(citizen_id))
              .order_by(RawReport.submitted_at.desc())
              .all()
        )

        summaries: list[CitizenTicketSummary] = []
        for report in reports:
            ticket = (
                db.query(Ticket)
                  .filter(Ticket.raw_report_id == report.id)
                  .first()
            )
            last_update = report.submitted_at
            if ticket:
                latest_comment = (
                    db.query(TicketComment)
                      .filter(TicketComment.ticket_id == ticket.id)
                      .filter(TicketComment.is_public.is_(True))
                      .order_by(TicketComment.created_at.desc())
                      .first()
                )
                if latest_comment:
                    last_update = latest_comment.created_at

            summaries.append(
                CitizenTicketSummary(
                    report_id=report.id,
                    ticket_id=ticket.id if ticket else None,
                    status=derive_status(report.status, ticket),
                    issue_type=ticket.issue_type if ticket else None,
                    urgency_score=ticket.urgency_score if ticket else None,
                    address=report.address,
                    created_at=report.submitted_at,
                    updated_at=last_update,
                )
            )

        return summaries


@router.get(
    "/citizens/tickets/{ticket_id}",
    response_model=CitizenTicketDetail,
    tags=["citizens"],
)
async def get_citizen_ticket_detail(
    ticket_id: UUID,
    payload: dict = Depends(require_citizen_jwt),
):
    citizen_id = payload.get("sub")
    if not citizen_id:
        raise HTTPException(status_code=401, detail="Invalid token subject")

    with get_db() as db:
        report = db.get(RawReport, ticket_id)
        if not report or str(report.citizen_id) != citizen_id:
            raise HTTPException(status_code=404, detail="Ticket not found")

        ticket = (
            db.query(Ticket)
              .filter(Ticket.raw_report_id == report.id)
              .first()
        )
        updates: list[DepartmentUpdate] = []
        if ticket:
            updates = _public_updates(db, ticket.id)

        return CitizenTicketDetail(
            report_id=report.id,
            ticket_id=ticket.id if ticket else None,
            status=derive_status(report.status, ticket),
            text=report.text,
            image_url=report.image_url,
            address=report.address,
            lat=report.lat,
            lng=report.lng,
            issue_type=ticket.issue_type if ticket else None,
            urgency_score=ticket.urgency_score if ticket else None,
            assigned_to=ticket.assigned_to if ticket else None,
            assigned_at=ticket.assigned_at if ticket else None,
            resolved_at=ticket.resolved_at if ticket else None,
            department_updates=updates,
        )
