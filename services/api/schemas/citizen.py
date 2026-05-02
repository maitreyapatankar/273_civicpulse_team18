from datetime import datetime
from typing import List, Optional
from uuid import UUID

from pydantic import BaseModel


class DepartmentUpdate(BaseModel):
    id: UUID
    message: str
    created_at: datetime


class CitizenTicketSummary(BaseModel):
    report_id: UUID
    ticket_id: Optional[UUID]
    status: str
    issue_type: Optional[str]
    urgency_score: Optional[float]
    address: Optional[str]
    created_at: datetime
    updated_at: datetime


class CitizenTicketDetail(BaseModel):
    report_id: UUID
    ticket_id: Optional[UUID]
    status: str
    text: Optional[str]
    image_url: Optional[str]
    address: Optional[str]
    lat: float
    lng: float
    issue_type: Optional[str]
    urgency_score: Optional[float]
    department_updates: List[DepartmentUpdate]
