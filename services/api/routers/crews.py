from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr

from routers.auth import require_admin_jwt, require_officer_jwt
from shared.db import get_db
from shared.models import Crew

router = APIRouter(prefix="/crews", tags=["crews"])


class CrewCreate(BaseModel):
    team_name:  str
    crew_type:  str
    lead_name:  str
    lead_email: EmailStr


class CrewResponse(BaseModel):
    id:         UUID
    team_name:  str
    crew_type:  str
    lead_name:  str
    lead_email: str

    model_config = {"from_attributes": True}


@router.get("", response_model=list[CrewResponse])
def list_crews(_: dict = Depends(require_officer_jwt)):
    with get_db() as db:
        return db.query(Crew).order_by(Crew.crew_type, Crew.team_name).all()


@router.post("", response_model=CrewResponse, status_code=status.HTTP_201_CREATED)
def create_crew(body: CrewCreate, _: dict = Depends(require_admin_jwt)):
    with get_db() as db:
        existing = db.query(Crew).filter(Crew.team_name == body.team_name).first()
        if existing:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Team name already exists")
        crew = Crew(**body.model_dump())
        db.add(crew)
        db.commit()
        db.refresh(crew)
        return crew


@router.delete("/{crew_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_crew(crew_id: UUID, _: dict = Depends(require_admin_jwt)):
    with get_db() as db:
        crew = db.get(Crew, crew_id)
        if not crew:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Crew not found")
        db.delete(crew)
        db.commit()
