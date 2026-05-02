from typing import Optional
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field


class CitizenSignupRequest(BaseModel):
    name: str
    email: EmailStr
    password: str = Field(min_length=8, max_length=256)


class CitizenLoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=256)


class CitizenAuthResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    role: str = "citizen"
    citizen_id: UUID
    email: EmailStr
    name: str


class OfficerLoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=256)


class OfficerProvisionRequest(BaseModel):
    name: str
    email: EmailStr
    password: str = Field(min_length=10, max_length=256)
    role: str = "officer"  # officer | admin


class OfficerAuthResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    role: str
    officer_id: Optional[UUID]
    email: Optional[EmailStr]
    name: Optional[str]


class OfficerProvisionResponse(BaseModel):
    officer_id: UUID
    role: str
    email: EmailStr
    name: str


class AdminAuthResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    role: str = "admin"
    username: str


class AdminLoginRequest(BaseModel):
    username: str
    password: str
