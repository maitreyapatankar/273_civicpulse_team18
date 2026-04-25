import csv
import io
import os
import uuid
from functools import lru_cache
from typing import Optional

import boto3
from botocore.exceptions import BotoCoreError, ClientError
from celery import Celery
from fastapi import APIRouter, File, Form, HTTPException, UploadFile, status

from shared.db import get_db
from shared.models import RawReport
from schemas.report import ReportSubmitted

router = APIRouter(prefix="/reports", tags=["reports"])


@lru_cache(maxsize=1)
def _s3():
    return boto3.client(
        "s3",
        region_name=os.environ["S3_REGION"],
        aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
    )


@lru_cache(maxsize=1)
def _celery():
    return Celery(broker=os.environ["REDIS_URL"])


def _upload_to_s3(report_id: str, filename: str, content: bytes, content_type: str) -> str:
    key = f"reports/{report_id}/{filename}"
    _s3().put_object(
        Bucket=os.environ["S3_BUCKET"],
        Key=key,
        Body=content,
        ContentType=content_type,
    )
    return (
        f"https://{os.environ['S3_BUCKET']}"
        f".s3.{os.environ['S3_REGION']}.amazonaws.com/{key}"
    )


def _enqueue(report_id: str) -> None:
    _celery().send_task(
        "worker.tasks.process_report",
        args=[report_id],
        queue="reports:process",
    )


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
):
    if not text and not image:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="At least one of 'text' or 'image' is required.",
        )

    report_id = str(uuid.uuid4())
    image_url = None

    if image:
        content = await image.read()
        try:
            image_url = _upload_to_s3(
                report_id,
                image.filename or "upload",
                content,
                image.content_type or "application/octet-stream",
            )
        except (BotoCoreError, ClientError) as exc:
            raise HTTPException(status_code=502, detail=f"S3 upload failed: {exc}")

    with get_db() as db:
        report = RawReport(
            id=uuid.UUID(report_id),
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
    return ReportSubmitted(ticket_id=report_id, status="processing")


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

    return {"enqueued": len(enqueued), "errors": errors}
