import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean, Column, Float, ForeignKey, Index, Integer, Text, TIMESTAMP, text
)
from sqlalchemy.dialects.postgresql import JSONB, UUID

from shared.db import Base


def _now():
    return datetime.now(timezone.utc)


class RawReport(Base):
    __tablename__ = "raw_reports"

    id             = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
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
    severity            = Column(Integer)           # 1-5
    urgency_score       = Column(Float)             # 1.0-5.0
    urgency_factors     = Column(JSONB)             # {safety_risk, traffic_impact, cluster_volume, days_open}
    ai_reasoning        = Column(Text)
    confidence          = Column(Float)             # 0.0-1.0; below 0.70 flags for human review
    duplicate_of        = Column(UUID(as_uuid=True), ForeignKey("tickets.id"))
    cluster_count       = Column(Integer, default=1)
    work_order          = Column(JSONB)             # {crew_type, materials[], est_hours, notes}
    dispatcher_override = Column(Boolean, default=False)
    override_by         = Column(Text)
    override_at         = Column(TIMESTAMP(timezone=True))
    resolved_at         = Column(TIMESTAMP(timezone=True))
    created_at          = Column(TIMESTAMP(timezone=True), default=_now)


# Indexes defined after classes so column references resolve correctly
Index("idx_raw_reports_status", RawReport.status)
Index("idx_tickets_urgency",    Ticket.urgency_score.desc())
Index("idx_tickets_created",    Ticket.created_at.desc())
