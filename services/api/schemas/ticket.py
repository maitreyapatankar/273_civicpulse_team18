from datetime import datetime
from typing import Any, Dict, Optional, List
from uuid import UUID

from pydantic import BaseModel


class TicketResponse(BaseModel):
    """Full ticket record — returned by GET /tickets (dispatcher, auth required)."""
    id:                  UUID
    raw_report_id:       Optional[UUID]
    issue_type:          Optional[str]          # pothole|flooding|sinkhole|crack|sign_damage|other
    category_code:       Optional[str] = None
    category_name:       Optional[str] = None
    subcategory_code:    Optional[str] = None
    subcategory_name:    Optional[str] = None
    severity:            Optional[int]           # 1-5
    urgency_score:       Optional[float]         # 1.0-5.0
    urgency_factors:     Optional[Dict[str, Any]]
    ai_reasoning:        Optional[str]
    confidence:          Optional[float]         # 0.0-1.0; < 0.70 → needs human review
    image_text_conflict:       bool = False
    image_classification_hint: Optional[str] = None
    needs_review:              bool = False
    duplicate_of:        Optional[UUID]
    cluster_count:       int = 1
    work_order:          Optional[Dict[str, Any]]
    approved:            bool = False
    dispatcher_override: bool = False
    override_by:         Optional[str]
    override_at:         Optional[datetime]
    assigned_at:         Optional[datetime]
    assigned_to:         Optional[str]
    crew_id:             Optional[UUID] = None
    resolved_at:         Optional[datetime]
    created_at:          datetime
    # Derived lifecycle status — open|in_progress|resolved|failed (or pre-AI: queued|processing)
    lifecycle_status:    Optional[str]   = None
    # Pulled from raw_reports for the dispatcher map
    lat:                 Optional[float] = None
    lng:                 Optional[float] = None
    address:             Optional[str]   = None

    model_config = {"from_attributes": True}


class TicketStatusResponse(BaseModel):
    """Public status check — returned by GET /tickets/:id/status.

    Also consumed by S5 Notifications to obtain reporter_phone.

    `status` is the derived lifecycle state shown to the citizen:
        queued | processing | open | in_progress | resolved | failed
    """
    id:             UUID
    status:         str
    issue_type:     Optional[str]
    category_code:  Optional[str] = None
    category_name:  Optional[str] = None
    subcategory_code: Optional[str] = None
    subcategory_name: Optional[str] = None
    urgency_score:  Optional[float]
    duplicate_of:   Optional[UUID]
    cluster_count:  int = 1
    image_text_conflict: Optional[bool] = None
    needs_review:        Optional[bool] = None
    reporter_phone: Optional[str]
    assigned_to:    Optional[str] = None
    assigned_at:    Optional[datetime] = None
    resolved_at:    Optional[datetime] = None
    created_at:     datetime

    model_config = {"from_attributes": True}


class TicketOverride(BaseModel):
    """Request body for PATCH /tickets/:id (dispatcher override, JWT required)."""
    urgency_score: Optional[float] = None   # 1.0-5.0
    issue_type:    Optional[str]   = None
    notes:         Optional[str]   = None
    comment:       Optional[str]   = None
    is_public:     Optional[bool]  = None
    approve:       Optional[bool]  = None   # true → sets approved = True
    reject:        Optional[bool]  = None   # true → sets lifecycle_status = 'failed'
    assign_to:     Optional[str]   = None   # free-text fallback
    crew_id:       Optional[UUID]  = None   # assign to a real crew; sets assigned_to = team_name
    resolve:       Optional[bool]  = None   # true → sets resolved_at = now()


class TicketCommentResponse(BaseModel):
    id: UUID
    author_type: str
    author_id: Optional[UUID]
    message: str
    is_public: bool
    created_at: datetime

    model_config = {"from_attributes": True}


class TicketDetailResponse(TicketResponse):
    text: Optional[str] = None
    image_url: Optional[str] = None
    comments: List[TicketCommentResponse]
