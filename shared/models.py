import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean, Column, Date, Float, ForeignKey, Index, Integer, Text, TIMESTAMP
)
from sqlalchemy.dialects.postgresql import JSONB, UUID

from shared.db import Base


def _now():
    return datetime.now(timezone.utc)


class RawReport(Base):
    __tablename__ = "raw_reports"

    id             = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    citizen_id     = Column(UUID(as_uuid=True), ForeignKey("citizens.id"))
    source         = Column(Text, nullable=False)           # 'app' | 'csv' | 'api'
    text           = Column(Text)
    image_url      = Column(Text)                           # S3/R2 object URL
    lat            = Column(Float, nullable=False)
    lng            = Column(Float, nullable=False)
    address        = Column(Text)
    reporter_phone = Column(Text)
    submitted_at   = Column(TIMESTAMP(timezone=True), default=_now)
    status         = Column(Text, default="queued")         # queued|processing|done|failed

    def to_dict(self):
        return {
            "report_id":      str(self.id),
            "source":         self.source,
            "text":           self.text,
            "image_url":      self.image_url,
            "lat":            self.lat,
            "lng":            self.lng,
            "address":        self.address,
            "reporter_phone": self.reporter_phone,
            "submitted_at":   self.submitted_at.isoformat() if self.submitted_at else None,
            "status":         self.status,
        }


class Ticket(Base):
    __tablename__ = "tickets"

    id                  = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    raw_report_id       = Column(UUID(as_uuid=True), ForeignKey("raw_reports.id"))
    issue_type          = Column(Text)              # pothole|flooding|sinkhole|crack|sign_damage|other
    category_code       = Column(Text)
    category_name       = Column(Text)
    subcategory_code    = Column(Text)
    subcategory_name    = Column(Text)
    severity            = Column(Integer)           # 1-5
    urgency_score       = Column(Float)             # 1.0-5.0
    urgency_factors     = Column(JSONB)             # {safety_risk, traffic_impact, cluster_volume, days_open}
    ai_reasoning        = Column(Text)
    confidence          = Column(Float)             # 0.0-1.0; below 0.70 flags for human review
    image_text_conflict       = Column(Boolean, default=False)
    image_classification_hint = Column(Text)
    needs_review              = Column(Boolean, default=False)
    duplicate_of        = Column(UUID(as_uuid=True), ForeignKey("tickets.id"))
    cluster_count       = Column(Integer, default=1)
    work_order          = Column(JSONB)             # {crew_type, materials[], est_hours, notes}
    approved            = Column(Boolean, default=False)
    dispatcher_override = Column(Boolean, default=False)
    override_by         = Column(Text)
    override_at         = Column(TIMESTAMP(timezone=True))
    assigned_at         = Column(TIMESTAMP(timezone=True))
    assigned_to         = Column(Text)
    crew_id             = Column(UUID(as_uuid=True), ForeignKey("crews.id"), nullable=True)
    resolved_at         = Column(TIMESTAMP(timezone=True))
    created_at          = Column(TIMESTAMP(timezone=True), default=_now)


class Citizen(Base):
    __tablename__ = "citizens"

    id            = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name          = Column(Text, nullable=False)
    email         = Column(Text, nullable=False, unique=True)
    password_hash = Column(Text, nullable=False)
    created_at    = Column(TIMESTAMP(timezone=True), default=_now)


class Officer(Base):
    __tablename__ = "officers"

    id            = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name          = Column(Text, nullable=False)
    email         = Column(Text, nullable=False, unique=True)
    password_hash = Column(Text, nullable=False)
    role          = Column(Text, nullable=False, default="officer")
    department    = Column(Text)   # roads | traffic | drainage | structures | operations
    created_at    = Column(TIMESTAMP(timezone=True), default=_now)


class Crew(Base):
    __tablename__ = "crews"

    id         = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    team_name  = Column(Text, nullable=False, unique=True)
    crew_type  = Column(Text, nullable=False)  # roads|traffic|drainage|structures|operations
    lead_name  = Column(Text, nullable=False)
    lead_email = Column(Text, nullable=False)
    created_at = Column(TIMESTAMP(timezone=True), default=_now)


class TicketComment(Base):
    __tablename__ = "ticket_comments"

    id          = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    ticket_id   = Column(UUID(as_uuid=True), ForeignKey("tickets.id"), nullable=False)
    author_type = Column(Text, nullable=False)  # citizen | officer
    author_id   = Column(UUID(as_uuid=True))
    message     = Column(Text, nullable=False)
    is_public   = Column(Boolean, default=False)
    created_at  = Column(TIMESTAMP(timezone=True), default=_now)


class Schedule(Base):
    __tablename__ = "schedules"

    id         = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    date       = Column(Date, nullable=False)
    zone_lat   = Column(Float, nullable=False)   # rounded to 2 decimal places
    zone_lng   = Column(Float, nullable=False)
    crew_type  = Column(Text, nullable=False)    # roads|traffic|drainage|structures|operations
    ticket_ids = Column(JSONB, nullable=False)   # ordered list of ticket UUIDs by urgency
    est_hours  = Column(Float)
    created_at = Column(TIMESTAMP(timezone=True), default=_now)


# Indexes defined after classes so column references resolve correctly
Index("idx_raw_reports_status", RawReport.status)
Index("idx_tickets_urgency",    Ticket.urgency_score.desc())
Index("idx_tickets_created",    Ticket.created_at.desc())
Index("idx_ticket_comments_ticket", TicketComment.ticket_id)
Index("idx_schedules_date",     Schedule.date.desc())
