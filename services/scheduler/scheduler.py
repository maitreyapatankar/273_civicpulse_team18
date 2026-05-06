import logging
import os
import smtplib
import time
import uuid
from collections import defaultdict
from datetime import date, datetime, timezone
from email.mime.text import MIMEText

import redis as redis_lib
from celery import Celery
from dotenv import load_dotenv
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s - %(message)s")
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Celery app
# ---------------------------------------------------------------------------

REDIS_URL = os.environ["REDIS_URL"]
DATABASE_URL = os.environ["DATABASE_URL"]

celery_app = Celery("scheduler", broker=REDIS_URL)
celery_app.conf.timezone = "UTC"

# ---------------------------------------------------------------------------
# DB
# ---------------------------------------------------------------------------

engine = create_engine(DATABASE_URL, pool_pre_ping=True)
Session = sessionmaker(bind=engine)

# ---------------------------------------------------------------------------
# Category → crew type mapping (mirrors worker tasks.py)
# ---------------------------------------------------------------------------

_CATEGORY_CREW = {
    "RD": "roads",
    "SG": "roads",
    "MK": "roads",
    "SW": "roads",
    "TF": "traffic",
    "SL": "traffic",
    "DR": "drainage",
    "ST": "structures",
    "OT": "operations",
}

# Estimated hours per ticket by urgency score (rough heuristic)
_HOURS_BY_URGENCY = {5: 3.0, 4: 2.0, 3: 1.5, 2: 1.0, 1: 0.5}


def _crew_type_for(category_code: str | None) -> str:
    if not category_code:
        return "operations"
    return _CATEGORY_CREW.get(category_code[:2].upper(), "operations")


def _zone_key(lat: float, lng: float) -> tuple[float, float]:
    return (round(lat, 2), round(lng, 2))




# ---------------------------------------------------------------------------
# Email helper
# ---------------------------------------------------------------------------

def _send_email(to_address: str, subject: str, body: str) -> None:
    email_from = os.environ.get("EMAIL_ADDRESS")
    app_password = os.environ.get("EMAIL_APP_PASSWORD")
    if not email_from or not app_password:
        log.warning("Email not configured — skipping notification to %s", to_address)
        return
    try:
        msg = MIMEText(body)
        msg["Subject"] = subject
        msg["From"] = f"CivicPulse <{email_from}>"
        msg["To"] = to_address
        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
            server.login(email_from, app_password)
            server.send_message(msg)
        log.info("Email sent to %s", to_address)
    except Exception as exc:
        log.error("Failed to send email to %s: %s", to_address, exc)


# ---------------------------------------------------------------------------
# Core task
# ---------------------------------------------------------------------------

def build_schedule() -> None:
    log.info("build_schedule started")
    today = date.today()

    with Session() as db:
        # Fetch all open, non-duplicate, non-resolved tickets with location
        rows = db.execute(text("""
            SELECT
                t.id,
                t.category_code,
                t.issue_type,
                t.subcategory_name,
                t.urgency_score,
                t.work_order,
                rr.lat,
                rr.lng,
                rr.address
            FROM tickets t
            JOIN raw_reports rr ON rr.id = t.raw_report_id
            WHERE t.resolved_at IS NULL
              AND t.duplicate_of IS NULL
              AND t.approved = TRUE
              AND t.crew_id IS NULL
              AND rr.lat != 0
              AND rr.lng != 0
            ORDER BY t.urgency_score DESC NULLS LAST
        """)).fetchall()

        if not rows:
            log.info("No open tickets — nothing to schedule")
            return

        # Group tickets into zones per crew type
        # zone_buckets[(zone_lat, zone_lng, crew_type)] = [ticket_row, ...]
        zone_buckets: dict[tuple, list] = defaultdict(list)
        for row in rows:
            crew = _crew_type_for(row.category_code)
            zone = _zone_key(row.lat, row.lng)
            zone_buckets[(*zone, crew)].append(row)

        # Delete today's existing schedules so we rebuild fresh
        db.execute(text("DELETE FROM schedules WHERE date = :d"), {"d": today})
        db.flush()

        # Write one schedule row per zone+crew bucket
        schedule_rows = []
        for (zone_lat, zone_lng, crew_type), tickets in zone_buckets.items():
            est_hours = sum(
                _HOURS_BY_URGENCY.get(int(t.urgency_score or 1), 1.0) for t in tickets
            )
            ticket_ids = [str(t.id) for t in tickets]
            db.execute(text("""
                INSERT INTO schedules (id, date, zone_lat, zone_lng, crew_type, ticket_ids, est_hours, created_at)
                VALUES (:id, :date, :zone_lat, :zone_lng, :crew_type, cast(:ticket_ids as jsonb), :est_hours, :created_at)
            """), {
                "id": str(uuid.uuid4()),
                "date": today,
                "zone_lat": zone_lat,
                "zone_lng": zone_lng,
                "crew_type": crew_type,
                "ticket_ids": __import__("json").dumps(ticket_ids),
                "est_hours": est_hours,
                "created_at": datetime.now(timezone.utc),
            })
            schedule_rows.append({
                "zone_lat": zone_lat,
                "zone_lng": zone_lng,
                "crew_type": crew_type,
                "tickets": [dict(r._mapping) for r in tickets],
                "est_hours": est_hours,
            })

        # Zone-based crew assignment:
        # Sort zones of each crew_type geographically, sort crews by name,
        # then assign Zone[i] → Crew[i % len(crews)] — stable and geographic.
        zones_by_type: dict[str, list[tuple]] = defaultdict(list)
        for (zone_lat, zone_lng, crew_type) in zone_buckets:
            zones_by_type[crew_type].append((zone_lat, zone_lng))

        # crew_assignments[(lead_name, lead_email, team_name)] = [ticket_rows]
        crew_assignments: dict[tuple, list] = defaultdict(list)

        for crew_type, zone_coords in zones_by_type.items():
            crews = db.execute(text("""
                SELECT id, team_name, lead_name, lead_email FROM crews
                WHERE crew_type = :crew_type
                ORDER BY team_name
            """), {"crew_type": crew_type}).fetchall()

            if not crews:
                log.info("No crews for type %s — tickets left unassigned", crew_type)
                continue

            sorted_zones = sorted(zone_coords, key=lambda z: (z[0], z[1]))

            for i, (zone_lat, zone_lng) in enumerate(sorted_zones):
                assigned_crew = crews[i % len(crews)]
                tickets_in_zone = zone_buckets[(zone_lat, zone_lng, crew_type)]
                ticket_ids_in_zone = [str(t.id) for t in tickets_in_zone]
                db.execute(text("""
                    UPDATE tickets
                    SET crew_id = :crew_id, assigned_to = :team_name, assigned_at = now(), lifecycle_status = 'forwarded_to_maintenance'
                    WHERE id = ANY(cast(:ids as uuid[]))
                      AND crew_id IS NULL
                """), {
                    "crew_id": str(assigned_crew.id),
                    "team_name": assigned_crew.team_name,
                    "ids": ticket_ids_in_zone,
                })
                crew_key = (assigned_crew.lead_name, assigned_crew.lead_email, assigned_crew.team_name)
                crew_assignments[crew_key].extend(tickets_in_zone)
                log.info("Zone (%.2f, %.2f) %s → crew %s (%d tickets)",
                         zone_lat, zone_lng, crew_type, assigned_crew.team_name,
                         len(ticket_ids_in_zone))

        db.commit()
        log.info("Wrote %d schedule zones for %s", len(schedule_rows), today)

        # Email each crew lead only their assigned tickets
        for (lead_name, lead_email, team_name), tickets in crew_assignments.items():
            subject = f"CivicPulse: {len(tickets)} ticket(s) assigned to {team_name} today"
            body_lines = [
                f"Hi {lead_name},",
                "",
                f"The following ticket(s) have been assigned to your crew ({team_name}):",
                "",
            ]
            for i, t in enumerate(tickets, 1):
                body_lines.append(
                    f"  {i}. [P{int(t.urgency_score or 0)}/5] "
                    f"{t.subcategory_name or t.issue_type or 'Issue'} — {t.address or 'No address'}"
                )
            body_lines += ["", "View the schedule: http://localhost:5173/officer/schedule"]
            _send_email(lead_email, subject, "\n".join(body_lines))

        # Publish Redis event so frontend can refresh
        try:
            r = redis_lib.from_url(REDIS_URL)
            r.publish("schedule:updated", __import__("json").dumps({"date": str(today)}))
        except Exception as exc:
            log.warning("Redis publish failed: %s", exc)

    log.info("build_schedule complete")


if __name__ == "__main__":
    log.info("Starting continuous scheduler — rebuilding every 15 seconds")
    while True:
        try:
            build_schedule()
            time.sleep(15)
        except Exception as exc:
            log.error("Error in scheduler: %s", exc)
            time.sleep(15)
