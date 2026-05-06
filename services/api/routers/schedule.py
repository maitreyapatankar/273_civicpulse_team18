from datetime import date

from fastapi import APIRouter, Depends, HTTPException, status

from routers.auth import require_officer_jwt
from shared.db import get_db

router = APIRouter(prefix="/schedule", tags=["schedule"])


@router.get("/today")
def get_today_schedule(_: dict = Depends(require_officer_jwt)):
    today = date.today()
    with get_db() as db:
        from sqlalchemy import text
        rows = db.execute(text("""
            SELECT id, date, zone_lat, zone_lng, crew_type, ticket_ids, est_hours, created_at
            FROM schedules
            WHERE date = :today
            ORDER BY crew_type, zone_lat, zone_lng
        """), {"today": today}).fetchall()

    return [
        {
            "id": str(r.id),
            "date": str(r.date),
            "zone_lat": r.zone_lat,
            "zone_lng": r.zone_lng,
            "crew_type": r.crew_type,
            "ticket_ids": r.ticket_ids,
            "est_hours": r.est_hours,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]


@router.get("/zone")
def get_zone_schedule(lat: float, lng: float, _: dict = Depends(require_officer_jwt)):
    zone_lat = round(lat, 2)
    zone_lng = round(lng, 2)
    today = date.today()
    with get_db() as db:
        from sqlalchemy import text
        rows = db.execute(text("""
            SELECT id, date, zone_lat, zone_lng, crew_type, ticket_ids, est_hours, created_at
            FROM schedules
            WHERE date = :today
              AND zone_lat = :zone_lat
              AND zone_lng = :zone_lng
            ORDER BY crew_type
        """), {"today": today, "zone_lat": zone_lat, "zone_lng": zone_lng}).fetchall()

    if not rows:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No schedule for this zone today")

    return [
        {
            "id": str(r.id),
            "date": str(r.date),
            "zone_lat": r.zone_lat,
            "zone_lng": r.zone_lng,
            "crew_type": r.crew_type,
            "ticket_ids": r.ticket_ids,
            "est_hours": r.est_hours,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]
