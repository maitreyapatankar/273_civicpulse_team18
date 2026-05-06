import json
import logging
import os
import smtplib
from datetime import datetime, timezone
from email.mime.text import MIMEText
from functools import lru_cache
from uuid import UUID

import redis
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from fastapi import status as http_status

from routers.auth import require_officer_jwt
from routers.tickets import _ticket_to_response
from shared.db import get_db
from shared.models import Crew, RawReport, Ticket, TicketComment
from schemas.ticket import TicketOverride, TicketResponse

log = logging.getLogger(__name__)

router = APIRouter(prefix="/tickets", tags=["admin"])


@lru_cache(maxsize=1)
def _redis_client() -> redis.Redis:
    return redis.Redis.from_url(os.environ["REDIS_URL"])


def _email_crew_lead(crew: Crew, ticket: Ticket, address: str | None) -> None:
    email_from = os.environ.get("EMAIL_ADDRESS")
    app_password = os.environ.get("EMAIL_APP_PASSWORD")
    if not email_from or not app_password:
        log.warning("Email not configured — skipping crew lead notification")
        return
    try:
        issue = ticket.subcategory_name or ticket.issue_type or "Issue"
        body = (
            f"Hi {crew.lead_name},\n\n"
            f"A ticket has been assigned to your crew ({crew.team_name}).\n\n"
            f"  Issue   : {issue}\n"
            f"  Priority: P{int(ticket.urgency_score or 0)}/5\n"
            f"  Location: {address or 'No address'}\n\n"
            f"Log in to CivicPulse to view the full schedule:\n"
            f"http://localhost:5173/officer/schedule\n"
        )
        msg = MIMEText(body)
        msg["Subject"] = f"CivicPulse: New ticket assigned to {crew.team_name}"
        msg["From"] = f"CivicPulse <{email_from}>"
        msg["To"] = crew.lead_email
        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
            server.login(email_from, app_password)
            server.send_message(msg)
        log.info("Crew lead email sent to %s", crew.lead_email)
    except Exception as exc:
        log.error("Failed to send crew lead email: %s", exc)


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
    ticket_id:  UUID,
    override:   TicketOverride,
    background: BackgroundTasks,
    payload:    dict = Depends(require_officer_jwt),
):
    crew_to_notify: Crew | None = None
    crew_address: str | None = None

    with get_db() as db:
        ticket = db.get(Ticket, ticket_id)
        if not ticket:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND,
                detail="Ticket not found",
            )

        now = datetime.now(timezone.utc)
        ai_overridden = False
        assigned     = False
        resolved     = False

        if override.approve is True:
            ticket.approved = True

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

        if override.crew_id is not None:
            crew = db.get(Crew, override.crew_id)
            if not crew:
                raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail="Crew not found")
            ticket.crew_id = crew.id
            ticket.assigned_to = crew.team_name
            ticket.assigned_at = now
            assigned = True
            # grab details before session closes
            crew_to_notify = Crew(
                team_name=crew.team_name, crew_type=crew.crew_type,
                lead_name=crew.lead_name, lead_email=crew.lead_email,
            )
            raw = db.get(RawReport, ticket.raw_report_id) if ticket.raw_report_id else None
            crew_address = raw.address if raw else None
        elif override.assign_to is not None:
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
        # Snapshot scalar fields needed for email before session closes
        ticket_snapshot = type('T', (), {
            'subcategory_name': ticket.subcategory_name,
            'issue_type': ticket.issue_type,
            'urgency_score': ticket.urgency_score,
        })()

    # Publish AFTER the DB commit + session close.
    channel = "notify:ticket_resolved" if resolved else "notify:ticket_updated"
    _publish(channel, str(ticket_id), str(response.raw_report_id) if response.raw_report_id else None)

    # Email crew lead in background so it doesn't block the response.
    if crew_to_notify:
        background.add_task(_email_crew_lead, crew_to_notify, ticket_snapshot, crew_address)

    return response
