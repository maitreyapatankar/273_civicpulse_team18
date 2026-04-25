from typing import Optional
from pydantic import BaseModel, model_validator


class ReportCreate(BaseModel):
    """Request body for POST /reports.

    Constraint: at least one of `text` or `image` (UploadFile, handled at the
    route level) must be present. Lat/lng are always required.
    """
    text:           Optional[str] = None
    lat:            float
    lng:            float
    address:        Optional[str] = None
    reporter_phone: Optional[str] = None
    source:         str = "app"             # 'app' | 'csv' | 'api'

    @model_validator(mode="after")
    def text_required_when_no_image(self) -> "ReportCreate":
        # Full text-or-image validation lives in the route handler because
        # UploadFile cannot appear inside a Pydantic model.
        return self


class ReportSubmitted(BaseModel):
    """202 response returned immediately after POST /reports enqueue."""
    ticket_id: str
    status:    str = "processing"
