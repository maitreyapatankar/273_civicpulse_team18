import os
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, status
from jose import jwt
from pydantic import BaseModel

router = APIRouter(prefix="/auth", tags=["auth"])

_TOKEN_TTL_HOURS = 8


class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


@router.post("/login", response_model=TokenResponse)
async def login(body: LoginRequest):
    expected_user = os.environ.get("DISPATCHER_USERNAME", "")
    expected_pass = os.environ.get("DISPATCHER_PASSWORD", "")

    if not expected_user or not expected_pass:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Auth not configured — set DISPATCHER_USERNAME and DISPATCHER_PASSWORD in .env",
        )

    if body.username != expected_user or body.password != expected_pass:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid credentials",
        )

    payload = {
        "sub": body.username,
        "exp": datetime.now(timezone.utc) + timedelta(hours=_TOKEN_TTL_HOURS),
    }
    token = jwt.encode(payload, os.environ["JWT_SECRET"], algorithm="HS256")
    return TokenResponse(access_token=token)
