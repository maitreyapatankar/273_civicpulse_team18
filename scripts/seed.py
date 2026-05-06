"""
CivicPulse — Postgres seed script.

Populates the database with realistic demo data for testing, demos, and the
TEST_PLAN.md test cases. Idempotent: re-running the script does not duplicate
rows. Pass --reset to truncate every table first.

Usage (from repo root, with the stack running):

    # Populate (skips entities that already exist)
    docker compose run --rm \\
        --volume "$(pwd)/scripts:/app/scripts" \\
        api python /app/scripts/seed.py

    # Truncate every seeded table first, then populate
    docker compose run --rm \\
        --volume "$(pwd)/scripts:/app/scripts" \\
        api python /app/scripts/seed.py --reset

The api container already has SQLAlchemy, passlib, and access to Postgres on
the docker network, so no extra setup is needed.

Design
------
Every seeded entity uses a deterministic UUID derived from a stable label via
``uuid.uuid5(NAMESPACE, label)``. This means TEST_PLAN.md can reference
exact IDs and they will match across machines and re-runs.
"""

from __future__ import annotations

import argparse
import logging
import sys
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any

from passlib.context import CryptContext
from sqlalchemy import text

from shared.db import SessionLocal
from shared.models import (
    Citizen,
    Crew,
    Officer,
    RawReport,
    Schedule,
    Ticket,
    TicketComment,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s - %(message)s")
log = logging.getLogger("seed")

NAMESPACE = uuid.UUID("c1c1c1c1-2b2b-3c3c-4d4d-5e5e5e5e5e5e")

CITIZEN_PASSWORD = "Citizen123!"
OFFICER_PASSWORD = "Officer123!"

_pwd = CryptContext(schemes=["bcrypt_sha256", "bcrypt"], deprecated="auto")


def _id(label: str) -> uuid.UUID:
    return uuid.uuid5(NAMESPACE, label)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _hours_ago(h: int) -> datetime:
    return _now() - timedelta(hours=h)


def _days_ago(d: int) -> datetime:
    return _now() - timedelta(days=d)


# ── Seed data ─────────────────────────────────────────────────────────────────

CITIZENS: list[dict[str, Any]] = [
    {"name": "Alice Johnson",  "email": "alice@example.com"},
    {"name": "Bob Martinez",   "email": "bob@example.com"},
    {"name": "Carmen Lopez",   "email": "carmen@example.com"},
    {"name": "David Kim",      "email": "david@example.com"},
    {"name": "Esha Patel",     "email": "esha@example.com"},
]

OFFICERS: list[dict[str, Any]] = [
    {"name": "Admin User",     "email": "admin@civicpulse.gov",
     "role": "admin",   "department": None},
    {"name": "Diana Reed",     "email": "roads.lead@civicpulse.gov",
     "role": "officer", "department": "roads"},
    {"name": "Marcus Chen",    "email": "traffic.lead@civicpulse.gov",
     "role": "officer", "department": "traffic"},
    {"name": "Priya Nair",     "email": "drainage.lead@civicpulse.gov",
     "role": "officer", "department": "drainage"},
    {"name": "Aaron Webb",     "email": "structures.lead@civicpulse.gov",
     "role": "officer", "department": "structures"},
    {"name": "Sara Okafor",    "email": "ops.lead@civicpulse.gov",
     "role": "officer", "department": "operations"},
]

CREWS: list[dict[str, Any]] = [
    {"team_name": "Roads Alpha",       "crew_type": "roads",
     "lead_name": "Diana Reed",        "lead_email": "roads.lead@civicpulse.gov"},
    {"team_name": "Traffic Bravo",     "crew_type": "traffic",
     "lead_name": "Marcus Chen",       "lead_email": "traffic.lead@civicpulse.gov"},
    {"team_name": "Drainage Charlie",  "crew_type": "drainage",
     "lead_name": "Priya Nair",        "lead_email": "drainage.lead@civicpulse.gov"},
    {"team_name": "Structures Delta",  "crew_type": "structures",
     "lead_name": "Aaron Webb",        "lead_email": "structures.lead@civicpulse.gov"},
    {"team_name": "Operations Echo",   "crew_type": "operations",
     "lead_name": "Sara Okafor",       "lead_email": "ops.lead@civicpulse.gov"},
]

# Reports + matching tickets are defined together so urgency, severity, and
# duplicate links stay coherent.  fields:
#   key                stable label for deterministic UUID
#   citizen            email of seeded citizen (or None for csv source)
#   text               report text
#   image_url          optional image URL
#   lat, lng           San Jose-area coordinates
#   address            human-readable address
#   reporter_phone     E.164 phone for SMS testing
#   source             "app" | "csv" | "api"
#   status             raw_report status — "queued"|"processing"|"done"|"failed"
#   ticket             None to skip ticket creation, else a dict of ticket fields

REPORTS: list[dict[str, Any]] = [
    # ── P1 sinkhole — gets urgency 5.0 ────────────────────────────────────────
    {
        "key": "report-rd006-sinkhole",
        "citizen": "alice@example.com",
        "text": "Massive sinkhole opened up on 1st Street — half the lane is gone, very dangerous",
        "lat": 37.3382, "lng": -121.8863, "address": "1 N 1st St, San Jose, CA",
        "reporter_phone": "+14085550101", "source": "app", "status": "done",
        "ticket": {
            "category_code": "RD", "category_name": "Road Surface",
            "subcategory_code": "RD-006", "subcategory_name": "Subsidence / sinkhole",
            "severity": 5, "confidence": 0.97,
            "urgency_score": 5.0,
            "urgency_factors": {"safety_risk": 0.95, "traffic_impact": 0.85,
                                 "cluster_volume": 0.10, "low_confidence": 0.0},
            "ai_reasoning": "P1 override: sinkhole with collapse risk and major traffic impact.",
            "needs_review": False, "approved": True,
            "assigned_to": "Diana Reed", "assigned_offset_hours": 4,
            "created_offset_hours": 5,
            "resolved_offset_hours": None,
        },
    },
    # ── P1 traffic signal fully dark — high urgency, in progress ─────────────
    {
        "key": "report-tf002-dark-signal",
        "citizen": "bob@example.com",
        "text": "Traffic light at Santa Clara & 4th is completely off, cars confused",
        "lat": 37.3393, "lng": -121.8869, "address": "Santa Clara St & N 4th St",
        "reporter_phone": "+14085550102", "source": "app", "status": "done",
        "ticket": {
            "category_code": "TF", "category_name": "Traffic Signal",
            "subcategory_code": "TF-002", "subcategory_name": "Signal fully dark",
            "severity": 5, "confidence": 0.95,
            "urgency_score": 4.8,
            "urgency_factors": {"safety_risk": 0.90, "traffic_impact": 0.95,
                                 "cluster_volume": 0.05, "low_confidence": 0.0},
            "ai_reasoning": "P1 override: fully-dark signal at major intersection.",
            "needs_review": False, "approved": True,
            "assigned_to": "Marcus Chen", "assigned_offset_hours": 2,
            "created_offset_hours": 3,
        },
    },
    # ── P1 missing drain cover ────────────────────────────────────────────────
    {
        "key": "report-dr003-missing-drain",
        "citizen": "carmen@example.com",
        "text": "Open drain hole, no cover, kids walk past on the way to school",
        "lat": 37.3375, "lng": -121.8855, "address": "200 S 2nd St, San Jose, CA",
        "reporter_phone": "+14085550103", "source": "app", "status": "done",
        "ticket": {
            "category_code": "DR", "category_name": "Drainage",
            "subcategory_code": "DR-003", "subcategory_name": "Missing drain cover",
            "severity": 5, "confidence": 0.93,
            "urgency_score": 4.6,
            "urgency_factors": {"safety_risk": 0.95, "traffic_impact": 0.40,
                                 "cluster_volume": 0.05, "low_confidence": 0.05},
            "ai_reasoning": "P1 override: open drain is a fall hazard for pedestrians.",
            "needs_review": False, "approved": True,
            "assigned_to": "Priya Nair", "assigned_offset_hours": 1,
            "created_offset_hours": 2,
        },
    },
    # ── Pothole #1 (master of a 2-report cluster) ────────────────────────────
    {
        "key": "report-rd001-pothole-master",
        "citizen": "david@example.com",
        "text": "Deep pothole in the right lane, hit it hard, damaged my tire",
        "lat": 37.3402, "lng": -121.8841, "address": "300 The Alameda, San Jose, CA",
        "reporter_phone": "+14085550104", "source": "app", "status": "done",
        "ticket": {
            "category_code": "RD", "category_name": "Road Surface",
            "subcategory_code": "RD-001", "subcategory_name": "Pothole",
            "severity": 4, "confidence": 0.91,
            "urgency_score": 3.8,
            "urgency_factors": {"safety_risk": 0.55, "traffic_impact": 0.50,
                                 "cluster_volume": 0.30, "low_confidence": 0.05},
            "ai_reasoning": "Cluster of 2 nearby pothole reports — moderate-high urgency.",
            "needs_review": False, "approved": True,
            "cluster_count": 2,
            "assigned_to": "Diana Reed", "assigned_offset_hours": 12,
            "created_offset_hours": 14,
        },
    },
    # ── Pothole #2 — duplicate of #1 ─────────────────────────────────────────
    {
        "key": "report-rd001-pothole-dup",
        "citizen": "esha@example.com",
        "text": "Big pothole near the Alameda, lots of cars are swerving around it",
        "lat": 37.3402, "lng": -121.8841, "address": "300 The Alameda, San Jose, CA",
        "reporter_phone": "+14085550105", "source": "app", "status": "done",
        "ticket": {
            "category_code": "RD", "category_name": "Road Surface",
            "subcategory_code": "RD-001", "subcategory_name": "Pothole",
            "severity": 4, "confidence": 0.92,
            "urgency_score": 3.8,
            "urgency_factors": {"safety_risk": 0.55, "traffic_impact": 0.50,
                                 "cluster_volume": 0.30, "low_confidence": 0.05},
            "ai_reasoning": "Duplicate of master pothole ticket — propagated cluster urgency.",
            "needs_review": False, "approved": True,
            "duplicate_of_key": "report-rd001-pothole-master",
            "cluster_count": 2,
            "created_offset_hours": 8,
        },
    },
    # ── Resolved pothole (history) ───────────────────────────────────────────
    {
        "key": "report-rd001-resolved",
        "citizen": "alice@example.com",
        "text": "Small pothole near the corner, please fix",
        "lat": 37.3360, "lng": -121.8870, "address": "50 W San Carlos St",
        "reporter_phone": "+14085550101", "source": "app", "status": "done",
        "ticket": {
            "category_code": "RD", "category_name": "Road Surface",
            "subcategory_code": "RD-001", "subcategory_name": "Pothole",
            "severity": 2, "confidence": 0.88,
            "urgency_score": 2.4,
            "urgency_factors": {"safety_risk": 0.30, "traffic_impact": 0.30,
                                 "cluster_volume": 0.05, "low_confidence": 0.05},
            "ai_reasoning": "Minor surface defect — routine maintenance.",
            "needs_review": False, "approved": True,
            "assigned_to": "Diana Reed", "assigned_offset_hours": 96,
            "created_offset_hours": 120,
            "resolved_offset_hours": 24,
        },
    },
    # ── Stop sign damaged — needs review (low confidence) ────────────────────
    {
        "key": "report-sg006-stopsign",
        "citizen": "bob@example.com",
        "text": "Stop sign is bent or maybe knocked down, hard to tell",
        "lat": 37.3415, "lng": -121.8830, "address": "10th St & Reed St",
        "reporter_phone": "+14085550102", "source": "app", "status": "done",
        "ticket": {
            "category_code": "SG", "category_name": "Signage",
            "subcategory_code": "SG-006", "subcategory_name": "Stop sign damage",
            "severity": 3, "confidence": 0.62,
            "urgency_score": 3.0,
            "urgency_factors": {"safety_risk": 0.55, "traffic_impact": 0.30,
                                 "cluster_volume": 0.05, "low_confidence": 0.40},
            "ai_reasoning": "Low confidence — flagged for human review.",
            "needs_review": True, "approved": False,
            "created_offset_hours": 6,
        },
    },
    # ── Drainage: road flooding (heavy LLM scoring path) ─────────────────────
    {
        "key": "report-dr005-flooding",
        "citizen": "carmen@example.com",
        "text": "Road is flooded after the rain, water 6 inches deep blocking lane",
        "lat": 37.3340, "lng": -121.8900, "address": "Park Ave & Almaden Blvd",
        "reporter_phone": "+14085550103", "source": "app", "status": "done",
        "ticket": {
            "category_code": "DR", "category_name": "Drainage",
            "subcategory_code": "DR-005", "subcategory_name": "Road flooding (drainage failure)",
            "severity": 4, "confidence": 0.89,
            "urgency_score": 4.2,
            "urgency_factors": {"safety_risk": 0.70, "traffic_impact": 0.80,
                                 "cluster_volume": 0.10, "low_confidence": 0.05},
            "ai_reasoning": "Active flooding blocking traffic — high urgency.",
            "needs_review": False, "approved": True,
            "assigned_to": "Priya Nair", "assigned_offset_hours": 1,
            "created_offset_hours": 2,
        },
    },
    # ── Manhole cover missing (P1 ST-004) — recently resolved ────────────────
    {
        "key": "report-st004-manhole",
        "citizen": "david@example.com",
        "text": "Manhole cover missing on Market St, big hole in the road",
        "lat": 37.3370, "lng": -121.8930, "address": "200 Market St, San Jose, CA",
        "reporter_phone": "+14085550104", "source": "app", "status": "done",
        "ticket": {
            "category_code": "ST", "category_name": "Structures",
            "subcategory_code": "ST-004", "subcategory_name": "Manhole cover missing",
            "severity": 5, "confidence": 0.96,
            "urgency_score": 4.9,
            "urgency_factors": {"safety_risk": 0.95, "traffic_impact": 0.70,
                                 "cluster_volume": 0.0, "low_confidence": 0.0},
            "ai_reasoning": "P1 override: missing manhole cover poses critical hazard.",
            "needs_review": False, "approved": True,
            "assigned_to": "Aaron Webb", "assigned_offset_hours": 50,
            "created_offset_hours": 52,
            "resolved_offset_hours": 2,
        },
    },
    # ── Light out — single ────────────────────────────────────────────────────
    {
        "key": "report-sl001-light-out",
        "citizen": "esha@example.com",
        "text": "Streetlight out on the corner, very dark at night",
        "lat": 37.3450, "lng": -121.8800, "address": "13th St & Empire St",
        "reporter_phone": "+14085550105", "source": "app", "status": "done",
        "ticket": {
            "category_code": "SL", "category_name": "Street Lighting",
            "subcategory_code": "SL-001", "subcategory_name": "Light out (single)",
            "severity": 2, "confidence": 0.86,
            "urgency_score": 2.1,
            "urgency_factors": {"safety_risk": 0.30, "traffic_impact": 0.10,
                                 "cluster_volume": 0.05, "low_confidence": 0.05},
            "ai_reasoning": "Single light out — routine repair.",
            "needs_review": False, "approved": True,
            "created_offset_hours": 18,
        },
    },
    # ── Faded lane markings (CSV import) ─────────────────────────────────────
    {
        "key": "report-mk001-faded",
        "citizen": None,
        "text": "Lane lines almost invisible at night",
        "lat": 37.3320, "lng": -121.8910, "address": "S 1st St near 280",
        "reporter_phone": None, "source": "csv", "status": "done",
        "ticket": {
            "category_code": "MK", "category_name": "Road Markings",
            "subcategory_code": "MK-001", "subcategory_name": "Faded lane markings",
            "severity": 2, "confidence": 0.84,
            "urgency_score": 1.9,
            "urgency_factors": {"safety_risk": 0.25, "traffic_impact": 0.15,
                                 "cluster_volume": 0.05, "low_confidence": 0.05},
            "ai_reasoning": "Faded markings — schedule for repaint.",
            "needs_review": False, "approved": True,
            "created_offset_hours": 30,
        },
    },
    # ── Sidewalk trip hazard ─────────────────────────────────────────────────
    {
        "key": "report-sw002-trip",
        "citizen": "alice@example.com",
        "text": "Raised sidewalk slab, my mom tripped on it yesterday",
        "lat": 37.3398, "lng": -121.8891, "address": "100 W Santa Clara St",
        "reporter_phone": "+14085550101", "source": "app", "status": "done",
        "ticket": {
            "category_code": "SW", "category_name": "Sidewalk / Footpath",
            "subcategory_code": "SW-002", "subcategory_name": "Trip hazard (raised slab)",
            "severity": 3, "confidence": 0.88,
            "urgency_score": 3.1,
            "urgency_factors": {"safety_risk": 0.60, "traffic_impact": 0.10,
                                 "cluster_volume": 0.05, "low_confidence": 0.05},
            "ai_reasoning": "Confirmed trip hazard with reported injury.",
            "needs_review": False, "approved": True,
            "assigned_to": "Sara Okafor", "assigned_offset_hours": 6,
            "created_offset_hours": 8,
        },
    },
    # ── Debris on road ───────────────────────────────────────────────────────
    {
        "key": "report-ot001-debris",
        "citizen": "bob@example.com",
        "text": "Big tree branch in the middle of the road",
        "lat": 37.3360, "lng": -121.8842, "address": "5th St & San Fernando",
        "reporter_phone": "+14085550102", "source": "app", "status": "done",
        "ticket": {
            "category_code": "OT", "category_name": "Other",
            "subcategory_code": "OT-001", "subcategory_name": "Debris on road",
            "severity": 3, "confidence": 0.90,
            "urgency_score": 3.2,
            "urgency_factors": {"safety_risk": 0.50, "traffic_impact": 0.45,
                                 "cluster_volume": 0.0, "low_confidence": 0.05},
            "ai_reasoning": "Obstruction in travel lane — clear promptly.",
            "needs_review": False, "approved": True,
            "assigned_to": "Sara Okafor", "assigned_offset_hours": 1,
            "created_offset_hours": 2,
        },
    },
    # ── Alligator cracking ───────────────────────────────────────────────────
    {
        "key": "report-rd002-alligator",
        "citizen": "carmen@example.com",
        "text": "Cracked road surface, looks like alligator skin pattern",
        "lat": 37.3450, "lng": -121.8890, "address": "Coleman Ave near Taylor",
        "reporter_phone": "+14085550103", "source": "app", "status": "done",
        "ticket": {
            "category_code": "RD", "category_name": "Road Surface",
            "subcategory_code": "RD-002", "subcategory_name": "Alligator cracking",
            "severity": 3, "confidence": 0.85,
            "urgency_score": 2.8,
            "urgency_factors": {"safety_risk": 0.40, "traffic_impact": 0.30,
                                 "cluster_volume": 0.05, "low_confidence": 0.10},
            "ai_reasoning": "Surface fatigue — schedule resurfacing.",
            "needs_review": False, "approved": True,
            "created_offset_hours": 36,
        },
    },
    # ── Damaged signal arm — assigned, in progress ───────────────────────────
    {
        "key": "report-tf004-arm",
        "citizen": "david@example.com",
        "text": "Signal arm is bent, must have been hit by a truck",
        "lat": 37.3387, "lng": -121.8865, "address": "Santa Clara St & 1st St",
        "reporter_phone": "+14085550104", "source": "app", "status": "done",
        "ticket": {
            "category_code": "TF", "category_name": "Traffic Signal",
            "subcategory_code": "TF-004", "subcategory_name": "Signal arm bent / damaged",
            "severity": 3, "confidence": 0.89,
            "urgency_score": 3.5,
            "urgency_factors": {"safety_risk": 0.50, "traffic_impact": 0.45,
                                 "cluster_volume": 0.05, "low_confidence": 0.05},
            "ai_reasoning": "Damaged signal infrastructure — schedule repair.",
            "needs_review": False, "approved": True,
            "assigned_to": "Marcus Chen", "assigned_offset_hours": 5,
            "created_offset_hours": 7,
        },
    },
    # ── Blocked drain ────────────────────────────────────────────────────────
    {
        "key": "report-dr001-blocked",
        "citizen": "esha@example.com",
        "text": "Storm drain is full of leaves, water pools when it rains",
        "lat": 37.3345, "lng": -121.8870, "address": "San Salvador St & 2nd St",
        "reporter_phone": "+14085550105", "source": "app", "status": "done",
        "ticket": {
            "category_code": "DR", "category_name": "Drainage",
            "subcategory_code": "DR-001", "subcategory_name": "Blocked drain / gully",
            "severity": 2, "confidence": 0.83,
            "urgency_score": 2.5,
            "urgency_factors": {"safety_risk": 0.30, "traffic_impact": 0.25,
                                 "cluster_volume": 0.05, "low_confidence": 0.10},
            "ai_reasoning": "Routine drain cleaning required.",
            "needs_review": False, "approved": True,
            "created_offset_hours": 22,
        },
    },
    # ── Bridge surface damage ────────────────────────────────────────────────
    {
        "key": "report-st001-bridge",
        "citizen": "alice@example.com",
        "text": "The bridge deck has chunks of concrete coming off",
        "lat": 37.3300, "lng": -121.8950, "address": "Coyote Creek Bridge",
        "reporter_phone": "+14085550101", "source": "app", "status": "done",
        "ticket": {
            "category_code": "ST", "category_name": "Structures",
            "subcategory_code": "ST-001", "subcategory_name": "Bridge surface damage",
            "severity": 4, "confidence": 0.91,
            "urgency_score": 4.0,
            "urgency_factors": {"safety_risk": 0.70, "traffic_impact": 0.50,
                                 "cluster_volume": 0.0, "low_confidence": 0.05},
            "ai_reasoning": "Structural concern — needs prompt inspection.",
            "needs_review": False, "approved": True,
            "assigned_to": "Aaron Webb", "assigned_offset_hours": 4,
            "created_offset_hours": 5,
        },
    },
    # ── Multiple lights out ──────────────────────────────────────────────────
    {
        "key": "report-sl002-multi-out",
        "citizen": "bob@example.com",
        "text": "Three streetlights in a row are out, whole block is dark",
        "lat": 37.3460, "lng": -121.8780, "address": "Empire St & 17th",
        "reporter_phone": "+14085550102", "source": "app", "status": "done",
        "ticket": {
            "category_code": "SL", "category_name": "Street Lighting",
            "subcategory_code": "SL-002", "subcategory_name": "Multiple lights out",
            "severity": 3, "confidence": 0.87,
            "urgency_score": 3.3,
            "urgency_factors": {"safety_risk": 0.45, "traffic_impact": 0.20,
                                 "cluster_volume": 0.10, "low_confidence": 0.05},
            "ai_reasoning": "Multiple-light outage — prioritize over single.",
            "needs_review": False, "approved": True,
            "assigned_to": "Marcus Chen", "assigned_offset_hours": 3,
            "created_offset_hours": 4,
        },
    },
    # ── Faded crosswalk ──────────────────────────────────────────────────────
    {
        "key": "report-mk002-crosswalk",
        "citizen": "carmen@example.com",
        "text": "Crosswalk paint is gone, drivers don't stop for kids",
        "lat": 37.3380, "lng": -121.8800, "address": "10th St & San Salvador",
        "reporter_phone": "+14085550103", "source": "app", "status": "done",
        "ticket": {
            "category_code": "MK", "category_name": "Road Markings",
            "subcategory_code": "MK-002", "subcategory_name": "Missing pedestrian crossing",
            "severity": 3, "confidence": 0.86,
            "urgency_score": 3.4,
            "urgency_factors": {"safety_risk": 0.65, "traffic_impact": 0.20,
                                 "cluster_volume": 0.05, "low_confidence": 0.10},
            "ai_reasoning": "Pedestrian-safety marking — schedule repaint soon.",
            "needs_review": False, "approved": True,
            "created_offset_hours": 40,
        },
    },
    # ── Image-text conflict — needs review ───────────────────────────────────
    {
        "key": "report-conflict-needs-review",
        "citizen": "david@example.com",
        "text": "Big pothole here, please fix it",
        "image_url": "https://example.com/fake-drain.jpg",
        "lat": 37.3415, "lng": -121.8875, "address": "5th St & Julian",
        "reporter_phone": "+14085550104", "source": "app", "status": "done",
        "ticket": {
            "category_code": "RD", "category_name": "Road Surface",
            "subcategory_code": "RD-001", "subcategory_name": "Pothole",
            "severity": 3, "confidence": 0.78,
            "urgency_score": 3.0,
            "urgency_factors": {"safety_risk": 0.40, "traffic_impact": 0.30,
                                 "cluster_volume": 0.0, "low_confidence": 0.30},
            "ai_reasoning": "Image suggests drainage issue, not pothole — flagged for review.",
            "needs_review": True, "approved": False,
            "image_text_conflict": True,
            "image_classification_hint": "blocked drain / gully",
            "created_offset_hours": 16,
        },
    },
    # ── Resolved drainage (history) ──────────────────────────────────────────
    {
        "key": "report-dr001-resolved",
        "citizen": "esha@example.com",
        "text": "Drain backed up after the storm",
        "lat": 37.3348, "lng": -121.8868, "address": "San Salvador St & 3rd",
        "reporter_phone": "+14085550105", "source": "app", "status": "done",
        "ticket": {
            "category_code": "DR", "category_name": "Drainage",
            "subcategory_code": "DR-001", "subcategory_name": "Blocked drain / gully",
            "severity": 2, "confidence": 0.85,
            "urgency_score": 2.3,
            "urgency_factors": {"safety_risk": 0.30, "traffic_impact": 0.20,
                                 "cluster_volume": 0.05, "low_confidence": 0.05},
            "ai_reasoning": "Drainage flow restored after cleaning.",
            "needs_review": False, "approved": True,
            "assigned_to": "Priya Nair", "assigned_offset_hours": 144,
            "created_offset_hours": 168,
            "resolved_offset_hours": 48,
        },
    },
    # ── Pipeline failure — left as failed for retry/DLQ visibility ──────────
    {
        "key": "report-failed-pipeline",
        "citizen": "alice@example.com",
        "text": "Something on the road, hard to describe",
        "lat": 37.3405, "lng": -121.8870, "address": "near 1st & Saint James",
        "reporter_phone": "+14085550101", "source": "app", "status": "failed",
        "ticket": None,
    },
    # ── Two reports waiting in the queue (no ticket yet) ─────────────────────
    {
        "key": "report-queued-1",
        "citizen": "bob@example.com",
        "text": "Curb is broken on the corner",
        "lat": 37.3395, "lng": -121.8842, "address": "5th & Santa Clara",
        "reporter_phone": "+14085550102", "source": "app", "status": "queued",
        "ticket": None,
    },
    {
        "key": "report-queued-2",
        "citizen": None,
        "text": "Sign post leaning over",
        "lat": 37.3372, "lng": -121.8850, "address": "3rd St near San Carlos",
        "reporter_phone": None, "source": "csv", "status": "queued",
        "ticket": None,
    },
]

COMMENTS: list[dict[str, Any]] = [
    {
        "ticket_key": "report-rd006-sinkhole", "author": "Diana Reed",
        "message": "Crew dispatched, perimeter cones placed, repair starts at 7am.",
        "is_public": True,
    },
    {
        "ticket_key": "report-tf002-dark-signal", "author": "Marcus Chen",
        "message": "Power restored, replacing controller module.",
        "is_public": True,
    },
    {
        "ticket_key": "report-st004-manhole", "author": "Aaron Webb",
        "message": "Replacement cover installed at 11am, area inspected.",
        "is_public": True,
    },
    {
        "ticket_key": "report-rd001-pothole-master", "author": "Diana Reed",
        "message": "Patch material on order — expected within 2 days.",
        "is_public": False,
    },
    {
        "ticket_key": "report-dr005-flooding", "author": "Priya Nair",
        "message": "Pump deployed, monitoring water level.",
        "is_public": False,
    },
    {
        "ticket_key": "report-sg006-stopsign", "author": "Sara Okafor",
        "message": "Awaiting field officer confirmation of damage extent.",
        "is_public": False,
    },
]


# ── Database operations ───────────────────────────────────────────────────────

# Tables in dependency order (children first) so TRUNCATE CASCADE is unambiguous.
SEEDED_TABLES = [
    "ticket_comments",
    "schedules",
    "tickets",
    "raw_reports",
    "crews",
    "officers",
    "citizens",
]


def reset_database(db) -> None:
    log.warning("--reset: truncating %s", ", ".join(SEEDED_TABLES))
    db.execute(text(f"TRUNCATE TABLE {', '.join(SEEDED_TABLES)} RESTART IDENTITY CASCADE"))
    db.commit()


def seed_citizens(db) -> dict[str, Citizen]:
    out: dict[str, Citizen] = {}
    n_new = 0
    pwd_hash = _pwd.hash(CITIZEN_PASSWORD)
    for c in CITIZENS:
        cid = _id(f"citizen:{c['email']}")
        existing = db.get(Citizen, cid)
        if existing:
            out[c["email"]] = existing
            continue
        row = Citizen(id=cid, name=c["name"], email=c["email"], password_hash=pwd_hash)
        db.add(row)
        out[c["email"]] = row
        n_new += 1
    db.flush()
    log.info("citizens: %d total (%d new)", len(CITIZENS), n_new)
    return out


def seed_officers(db) -> dict[str, Officer]:
    out: dict[str, Officer] = {}
    n_new = 0
    pwd_hash = _pwd.hash(OFFICER_PASSWORD)
    for o in OFFICERS:
        oid = _id(f"officer:{o['email']}")
        existing = db.get(Officer, oid)
        if existing:
            out[o["email"]] = existing
            continue
        row = Officer(
            id=oid, name=o["name"], email=o["email"],
            password_hash=pwd_hash, role=o["role"], department=o["department"],
        )
        db.add(row)
        out[o["email"]] = row
        n_new += 1
    db.flush()
    log.info("officers: %d total (%d new)", len(OFFICERS), n_new)
    return out


def seed_crews(db) -> dict[str, Crew]:
    out: dict[str, Crew] = {}
    n_new = 0
    for c in CREWS:
        cid = _id(f"crew:{c['team_name']}")
        existing = db.get(Crew, cid)
        if existing:
            out[c["team_name"]] = existing
            continue
        row = Crew(
            id=cid, team_name=c["team_name"], crew_type=c["crew_type"],
            lead_name=c["lead_name"], lead_email=c["lead_email"],
        )
        db.add(row)
        out[c["team_name"]] = row
        n_new += 1
    db.flush()
    log.info("crews: %d total (%d new)", len(CREWS), n_new)
    return out


def seed_reports_and_tickets(db, citizens: dict[str, Citizen]) -> dict[str, Ticket]:
    """Seed raw_reports and matching tickets in one pass so duplicate links
    can resolve to already-created master tickets."""
    tickets_by_key: dict[str, Ticket] = {}

    for r in REPORTS:
        rid = _id(f"raw_report:{r['key']}")
        existing_report = db.get(RawReport, rid)
        if not existing_report:
            citizen_id = citizens[r["citizen"]].id if r.get("citizen") else None
            ticket_data = r.get("ticket")
            created_offset = ticket_data["created_offset_hours"] if ticket_data else 1
            report = RawReport(
                id=rid,
                citizen_id=citizen_id,
                source=r["source"],
                text=r["text"],
                image_url=r.get("image_url"),
                lat=r["lat"],
                lng=r["lng"],
                address=r["address"],
                reporter_phone=r.get("reporter_phone"),
                submitted_at=_hours_ago(created_offset),
                status=r["status"],
            )
            db.add(report)

        td = r.get("ticket")
        if not td:
            continue

        tid = _id(f"ticket:{r['key']}")
        existing_ticket = db.get(Ticket, tid)
        if existing_ticket:
            tickets_by_key[r["key"]] = existing_ticket
            continue

        duplicate_of = None
        if "duplicate_of_key" in td:
            duplicate_of = _id(f"ticket:{td['duplicate_of_key']}")

        created_at = _hours_ago(td["created_offset_hours"])
        assigned_at = (
            _hours_ago(td["assigned_offset_hours"])
            if td.get("assigned_offset_hours") is not None else None
        )
        resolved_at = (
            _hours_ago(td["resolved_offset_hours"])
            if td.get("resolved_offset_hours") is not None else None
        )

        ticket = Ticket(
            id=tid,
            raw_report_id=rid,
            issue_type=td.get("subcategory_name"),
            category_code=td["category_code"],
            category_name=td["category_name"],
            subcategory_code=td["subcategory_code"],
            subcategory_name=td["subcategory_name"],
            severity=td["severity"],
            urgency_score=td["urgency_score"],
            urgency_factors=td["urgency_factors"],
            ai_reasoning=td["ai_reasoning"],
            confidence=td["confidence"],
            image_text_conflict=td.get("image_text_conflict", False),
            image_classification_hint=td.get("image_classification_hint"),
            needs_review=td["needs_review"],
            duplicate_of=duplicate_of,
            cluster_count=td.get("cluster_count", 1),
            approved=td.get("approved", False),
            assigned_to=td.get("assigned_to"),
            assigned_at=assigned_at,
            resolved_at=resolved_at,
            created_at=created_at,
        )
        db.add(ticket)
        tickets_by_key[r["key"]] = ticket

    db.flush()
    n_tickets_total = sum(1 for r in REPORTS if r.get("ticket"))
    log.info("raw_reports: %d total | tickets: %d total", len(REPORTS), n_tickets_total)
    return tickets_by_key


def seed_comments(db, tickets: dict[str, Ticket], officers: dict[str, Officer]) -> None:
    by_name = {o.name: o for o in officers.values()}
    n_new = 0
    for c in COMMENTS:
        ticket = tickets.get(c["ticket_key"])
        if not ticket:
            log.warning("comment skipped — ticket %s not found", c["ticket_key"])
            continue
        cid = _id(f"comment:{c['ticket_key']}:{c['author']}:{c['message'][:24]}")
        if db.get(TicketComment, cid):
            continue
        author = by_name.get(c["author"])
        comment = TicketComment(
            id=cid,
            ticket_id=ticket.id,
            author_type="officer",
            author_id=author.id if author else None,
            message=c["message"],
            is_public=c["is_public"],
            created_at=_hours_ago(2),
        )
        db.add(comment)
        n_new += 1
    db.flush()
    log.info("ticket_comments: %d total (%d new)", len(COMMENTS), n_new)


def seed_schedules(db, tickets: dict[str, Ticket]) -> None:
    today = date.today()
    yesterday = today - timedelta(days=1)

    schedules_data = [
        {
            "key": "schedule-roads-yesterday",
            "date": yesterday,
            "zone_lat": 37.34, "zone_lng": -121.88,
            "crew_type": "roads",
            "ticket_keys": ["report-rd001-pothole-master", "report-rd002-alligator"],
            "est_hours": 4.5,
        },
        {
            "key": "schedule-drainage-today",
            "date": today,
            "zone_lat": 37.33, "zone_lng": -121.89,
            "crew_type": "drainage",
            "ticket_keys": ["report-dr005-flooding", "report-dr001-blocked"],
            "est_hours": 3.0,
        },
    ]

    n_new = 0
    for s in schedules_data:
        sid = _id(f"schedule:{s['key']}")
        if db.get(Schedule, sid):
            continue
        ticket_ids = [
            str(tickets[k].id) for k in s["ticket_keys"] if k in tickets
        ]
        row = Schedule(
            id=sid,
            date=s["date"],
            zone_lat=s["zone_lat"],
            zone_lng=s["zone_lng"],
            crew_type=s["crew_type"],
            ticket_ids=ticket_ids,
            est_hours=s["est_hours"],
            created_at=_now(),
        )
        db.add(row)
        n_new += 1
    db.flush()
    log.info("schedules: %d total (%d new)", len(schedules_data), n_new)


def main() -> int:
    parser = argparse.ArgumentParser(description="Seed CivicPulse demo data.")
    parser.add_argument(
        "--reset", action="store_true",
        help="TRUNCATE every seeded table before populating (destructive).",
    )
    args = parser.parse_args()

    log.info("CivicPulse seeder starting (reset=%s)", args.reset)

    db = SessionLocal()
    try:
        if args.reset:
            reset_database(db)

        citizens = seed_citizens(db)
        officers = seed_officers(db)
        seed_crews(db)
        tickets = seed_reports_and_tickets(db, citizens)
        seed_comments(db, tickets, officers)
        seed_schedules(db, tickets)

        db.commit()
    except Exception:
        db.rollback()
        log.exception("Seed failed — rolled back")
        return 1
    finally:
        db.close()

    log.info("Seed complete.")
    log.info("")
    log.info("Login credentials:")
    log.info("  Admin    | username=%s | password=%s",
             "admin", "(see ADMIN_PASSWORD in .env)")
    log.info("  Admin    | email=admin@civicpulse.gov | password=%s", OFFICER_PASSWORD)
    log.info("  Officer  | email=roads.lead@civicpulse.gov | password=%s", OFFICER_PASSWORD)
    log.info("           | (also: traffic.lead, drainage.lead, structures.lead, ops.lead)")
    log.info("  Citizens | password=%s (5 emails: alice/bob/carmen/david/esha @example.com)",
             CITIZEN_PASSWORD)
    return 0


if __name__ == "__main__":
    sys.exit(main())
