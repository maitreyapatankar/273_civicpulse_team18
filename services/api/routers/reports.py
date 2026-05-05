import csv
import io
import logging
import os
import uuid
from functools import lru_cache
from typing import Optional
from uuid import UUID

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from celery import Celery
from fastapi import APIRouter, File, Form, HTTPException, UploadFile, status, Depends

from shared.db import get_db
from shared.models import RawReport
from routers.auth import optional_citizen_jwt, require_citizen_jwt
from schemas.report import ReportSubmitted

router = APIRouter(prefix="/reports", tags=["reports"])
log = logging.getLogger(__name__)


@lru_cache(maxsize=1)
def _s3():
    if os.environ.get("R2_ENDPOINT"):
        return boto3.client(
            "s3",
            endpoint_url=os.environ["R2_ENDPOINT"],
            region_name=os.environ.get("R2_REGION", "auto"),
            aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
            config=Config(signature_version="s3v4"),
        )
    return boto3.client(
        "s3",
        region_name=os.environ["S3_REGION"],
        aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
    )


@lru_cache(maxsize=1)
def _celery():
    return Celery(broker=os.environ["REDIS_URL"])


def _bucket_name() -> str:
    return os.environ["R2_BUCKET"] if os.environ.get("R2_ENDPOINT") else os.environ["S3_BUCKET"]


def _presign_expires() -> int:
    return int(os.environ.get("R2_PRESIGN_EXPIRES", "604800"))


def _image_url(bucket: str, key: str) -> str:
    if os.environ.get("R2_ENDPOINT"):
        return _s3().generate_presigned_url(
            "get_object",
            Params={"Bucket": bucket, "Key": key},
            ExpiresIn=_presign_expires(),
        )
    return f"https://{bucket}.s3.{os.environ['S3_REGION']}.amazonaws.com/{key}"


def _upload_image(report_id: str, filename: str, content: bytes, content_type: str) -> str:
    key = f"reports/{report_id}/{filename}"
    bucket = _bucket_name()
    _s3().put_object(
        Bucket=bucket,
        Key=key,
        Body=content,
        ContentType=content_type,
    )
    storage = "r2" if os.environ.get("R2_ENDPOINT") else "s3"
    log.info("image_uploaded report_id=%s bucket=%s key=%s storage=%s", report_id, bucket, key, storage)
    return _image_url(bucket, key)


def _enqueue(report_id: str) -> None:
    """Enqueue a report for processing.
    The worker listens on the `reports:process` queue, so we must route the task there.
    """
    _celery().send_task(
        "worker.tasks.process_report",
        args=[report_id],
        queue="reports:process",
    )
    log.info("report_enqueued report_id=%s queue=reports:process", report_id)


# ── POST /reports ─────────────────────────────────────────────────────────────

@router.post("", status_code=202, response_model=ReportSubmitted)
async def create_report(
    text:           Optional[str]        = Form(None),
    lat:            float                = Form(...),
    lng:            float                = Form(...),
    address:        Optional[str]        = Form(None),
    reporter_phone: Optional[str]        = Form(None),
    source:         str                  = Form("app"),
    image:          Optional[UploadFile] = File(None),
    citizen:        Optional[dict]       = Depends(optional_citizen_jwt),
):
    if not text and not image:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="At least one of 'text' or 'image' is required.",
        )

    report_id = str(uuid.uuid4())
    image_url = None
    log.info(
        "report_create_start report_id=%s source=%s has_image=%s text_len=%s",
        report_id,
        source,
        bool(image),
        len(text) if text else 0,
    )

    if image:
        content = await image.read()
        try:
            image_url = _upload_image(
                report_id,
                image.filename or "upload",
                content,
                image.content_type or "application/octet-stream",
            )
        except (BotoCoreError, ClientError) as exc:
            raise HTTPException(status_code=502, detail=f"Image upload failed: {exc}")

    with get_db() as db:
        citizen_id = None
        if citizen:
            try:
                citizen_id = uuid.UUID(citizen.get("sub"))
            except Exception:
                citizen_id = None

        report = RawReport(
            id=uuid.UUID(report_id),
            citizen_id=citizen_id,
            source=source,
            text=text,
            image_url=image_url,
            lat=lat,
            lng=lng,
            address=address,
            reporter_phone=reporter_phone,
            status="queued",
        )
        db.add(report)
        db.commit()

    _enqueue(report_id)
    log.info("report_create_done report_id=%s status=processing", report_id)
    return ReportSubmitted(ticket_id=report_id, status="processing")


# ── PATCH /reports/:id ───────────────────────────────────────────────────────

@router.patch("/{report_id}", status_code=202, response_model=ReportSubmitted)
async def update_report(
    report_id: UUID,
    text:           Optional[str]        = Form(None),
    lat:            Optional[float]      = Form(None),
    lng:            Optional[float]      = Form(None),
    address:        Optional[str]        = Form(None),
    image:          Optional[UploadFile] = File(None),
    citizen:        dict                 = Depends(require_citizen_jwt),
):
    if not any([text, lat, lng, address, image]):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="At least one field must be provided for update.",
        )

    with get_db() as db:
        report = db.get(RawReport, report_id)
        if not report or str(report.citizen_id) != citizen.get("sub"):
            raise HTTPException(status_code=404, detail="Report not found")
        log.info(
            "report_update_start report_id=%s fields=text:%s lat:%s lng:%s address:%s image:%s",
            report_id,
            text is not None,
            lat is not None,
            lng is not None,
            address is not None,
            bool(image),
        )

        if text is not None:
            report.text = text
        if lat is not None:
            report.lat = lat
        if lng is not None:
            report.lng = lng
        if address is not None:
            report.address = address

        if image:
            content = await image.read()
            try:
                report.image_url = _upload_image(
                    str(report.id),
                    image.filename or "upload",
                    content,
                    image.content_type or "application/octet-stream",
                )
            except (BotoCoreError, ClientError) as exc:
                raise HTTPException(status_code=502, detail=f"Image upload failed: {exc}")

        report.status = "queued"
        db.commit()

    _enqueue(str(report_id))
    log.info("report_update_done report_id=%s status=processing", report_id)
    return ReportSubmitted(ticket_id=str(report_id), status="processing")


# ── POST /reports/batch-csv ───────────────────────────────────────────────────

@router.post("/batch-csv", status_code=202)
async def batch_csv(file: UploadFile = File(...)):
    if not (file.filename or "").endswith(".csv"):
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="File must be a .csv",
        )

    content = (await file.read()).decode("utf-8")
    reader = csv.DictReader(io.StringIO(content))

    required_cols = {"lat", "lng"}
    if not required_cols.issubset(set(reader.fieldnames or [])):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"CSV must include columns: {required_cols}",
        )

    enqueued: list[str] = []
    errors:   list[dict] = []
    log.info("batch_csv_start filename=%s", file.filename)

    with get_db() as db:
        for i, row in enumerate(reader, start=1):
            try:
                lat = float(row["lat"])
                lng = float(row["lng"])
            except (ValueError, KeyError) as exc:
                errors.append({"row": i, "error": str(exc)})
                continue

            report = RawReport(
                source="csv",
                text=row.get("text") or None,
                lat=lat,
                lng=lng,
                address=row.get("address") or None,
                reporter_phone=row.get("reporter_phone") or None,
                status="queued",
            )
            db.add(report)
            db.flush()
            enqueued.append(str(report.id))

        db.commit()

    for report_id in enqueued:
        _enqueue(report_id)

    log.info("batch_csv_done enqueued=%s errors=%s", len(enqueued), len(errors))
    return {"enqueued": len(enqueued), "errors": errors}
