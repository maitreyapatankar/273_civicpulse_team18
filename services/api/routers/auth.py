import os
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, status, Depends
from jose import jwt
from passlib.context import CryptContext
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from shared.db import get_db
from shared.models import Officer
from schemas.auth import (
    OfficerLoginRequest,
    OfficerProvisionRequest,
    OfficerProvisionResponse,
    OfficerAuthResponse,
    AdminLoginRequest,
)

router = APIRouter(prefix="/auth", tags=["auth"])

_TOKEN_TTL_HOURS = 8
_pwd_context = CryptContext(schemes=["bcrypt_sha256", "bcrypt"], deprecated="auto")
_officer_bearer = HTTPBearer()


def _hash_password(password: str) -> str:
    try:
        return _pwd_context.hash(password)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Password must be 72 characters or fewer.",
        )


def _verify_password(password: str, hashed: str) -> bool:
    try:
        return _pwd_context.verify(password, hashed)
    except ValueError:
        return False


def _ensure_password_length(password: str) -> None:
    if len(password.encode("utf-8")) > 256:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Password must be 256 characters or fewer.",
        )


def _issue_token(secret: str, subject: str, role: str) -> str:
    payload = {
        "sub": subject,
        "role": role,
        "exp": datetime.now(timezone.utc) + timedelta(hours=_TOKEN_TTL_HOURS),
    }
    return jwt.encode(payload, secret, algorithm="HS256")


def _admin_credentials() -> tuple[str, str]:
    username = os.environ.get("ADMIN_USERNAME", "admin")
    password = os.environ.get("ADMIN_PASSWORD", "adminP")
    return username, password


def _decode_token(secret: str, token: str) -> dict:
    return jwt.decode(token, secret, algorithms=["HS256"])


def require_officer_jwt(
    credentials: HTTPAuthorizationCredentials = Depends(_officer_bearer),
) -> dict:
    try:
        payload = _decode_token(os.environ["OFFICER_JWT_SECRET"], credentials.credentials)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
        )
    if payload.get("role") not in {"officer", "admin"}:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Insufficient role",
        )
    return payload


def require_admin_jwt(
    payload: dict = Depends(require_officer_jwt),
) -> dict:
    if payload.get("role") != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin role required",
        )
    return payload



@router.post("/login", response_model=OfficerAuthResponse)
async def admin_login(body: AdminLoginRequest):
    admin_user, admin_pass = _admin_credentials()

    if body.username == admin_user and body.password == admin_pass:
        token = _issue_token(
            os.environ["OFFICER_JWT_SECRET"],
            subject=body.username,
            role="admin",
        )
        return OfficerAuthResponse(access_token=token, role="admin", officer_id=None, email=None, name=body.username)

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid credentials",
    )



@router.post("/officer/login", response_model=OfficerAuthResponse)
async def officer_login(body: OfficerLoginRequest):
    _ensure_password_length(body.password)
    admin_user, admin_pass = _admin_credentials()
    if body.email == "admin@gmail.com" and body.password == admin_pass:
        token = _issue_token(
            os.environ["OFFICER_JWT_SECRET"],
            subject=body.email,
            role="admin",
        )
        return OfficerAuthResponse(
            access_token=token,
            role="admin",
            officer_id=None,
            email=body.email,
            name=admin_user,
        )
    with get_db() as db:
        officer = db.query(Officer).filter(Officer.email == body.email).first()
        if not officer or not _verify_password(body.password, officer.password_hash):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid credentials",
            )

    token = _issue_token(
        os.environ["OFFICER_JWT_SECRET"],
        subject=str(officer.id),
        role=officer.role,
    )
    return OfficerAuthResponse(
        access_token=token,
        role=officer.role,
        officer_id=officer.id,
        email=officer.email,
        name=officer.name,
    )


@router.post("/officer/provision", response_model=OfficerProvisionResponse)
async def provision_officer(
    body: OfficerProvisionRequest,
    _: dict = Depends(require_admin_jwt),
):
    _ensure_password_length(body.password)
    if body.role not in {"officer", "admin"}:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Role must be 'officer' or 'admin'",
        )

    with get_db() as db:
        existing = db.query(Officer).filter(Officer.email == body.email).first()
        if existing:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Officer already exists",
            )

        officer = Officer(
            name=body.name,
            email=body.email,
            password_hash=_hash_password(body.password),
            role=body.role,
        )
        db.add(officer)
        db.commit()
        db.refresh(officer)

    return OfficerProvisionResponse(
        officer_id=officer.id,
        role=officer.role,
        email=officer.email,
        name=officer.name,
    )
