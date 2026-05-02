from datetime import datetime
from typing import Any, Dict, Optional, List
from uuid import UUID

from pydantic import BaseModel


class TicketResponse(BaseModel):
    """Full ticket record — returned by GET /tickets (dispatcher, auth required)."""
    id:                  UUID
    raw_report_id:       Optional[UUID]
    issue_type:          Optional[str]          # pothole|flooding|sinkhole|crack|sign_damage|other
    severity:            Optional[int]           # 1-5
    urgency_score:       Optional[float]         # 1.0-5.0
    urgency_factors:     Optional[Dict[str, Any]]
    ai_reasoning:        Optional[str]
    confidence:          Optional[float]         # 0.0-1.0; < 0.70 → needs human review
    duplicate_of:        Optional[UUID]
    cluster_count:       int = 1
    work_order:          Optional[Dict[str, Any]]
    dispatcher_override: bool = False
    override_by:         Optional[str]
    override_at:         Optional[datetime]
    resolved_at:         Optional[datetime]
    created_at:          datetime

    model_config = {"from_attributes": True}


class TicketStatusResponse(BaseModel):
    """Public status check — returned by GET /tickets/:id/status.

    Also consumed by S5 Notifications to obtain reporter_phone.
    """
    id:            UUID
    status:        str                   # queued|processing|done|failed
    issue_type:    Optional[str]
    urgency_score: Optional[float]
    duplicate_of:  Optional[UUID]
    cluster_count: int = 1
    reporter_phone: Optional[str]        # needed by S5; omit in public docs
    created_at:    datetime

    model_config = {"from_attributes": True}


class TicketOverride(BaseModel):
    """Request body for PATCH /tickets/:id (dispatcher override, JWT required)."""
    urgency_score: Optional[float] = None   # 1.0-5.0
    issue_type:    Optional[str]   = None
    notes:         Optional[str]   = None
    comment:       Optional[str]   = None
    is_public:     Optional[bool]  = None


class TicketCommentResponse(BaseModel):
    id: UUID
    author_type: str
    author_id: Optional[UUID]
    message: str
    is_public: bool
    created_at: datetime

    model_config = {"from_attributes": True}


class TicketDetailResponse(TicketResponse):
    comments: List[TicketCommentResponse]
