"""
Root-level pytest fixtures for CivicPulse.

Lives at the repository root so it applies to every ``tests/`` subtree.
Service-specific fixtures still live next to their tests
(see ``tests/ai_core/conftest.py`` which adds the AI Core import path).

Available fixtures
------------------
DB — Postgres-only fixtures, opt-in.

    db_session            yields a SQLAlchemy session bound to a transactional
                          rollback. Requires TEST_DATABASE_URL pointing at a
                          throwaway Postgres database. Skips otherwise.

Factory fixtures — produce plain unsaved ORM instances. No DB touched.

    make_raw_report       (text='pothole', lat=37.33, lng=-121.88, ...) -> RawReport
    make_ticket           (subcategory_code='RD-001', urgency_score=3.5, ...) -> Ticket
    make_officer          (name='Diana Reed', department='roads', ...) -> Officer
    make_crew             (team_name='Roads Alpha', crew_type='roads', ...) -> Crew

Mocks

    mock_gemini_model     a MagicMock with .generate_content; helper sets the
                          response text to JSON-encoded dicts for the next call.
    mock_redis            fakeredis.FakeRedis covering LPUSH/RPOP/PUBLISH.
    mock_celery_send_task records the (name, args, queue) of every send_task
                          call made during the test.

Sample payloads — plain dicts, no DB.

    sample_pipeline_payload  matches the {report_id, text, image_url, lat, ...}
                             dict that S1 → S3 → S2 sends through Redis.
    sample_enriched_ticket   matches the dict S2 publishes to ai_core:results.
"""

from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from json import dumps
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import pytest


# ── Optional import shims ────────────────────────────────────────────────────
# We don't want this conftest to fail to load on a fresh checkout where the
# top-level repo deps aren't yet installed. So model imports happen inside
# fixture bodies, and fakeredis is a soft import.

try:
    import fakeredis  # type: ignore
    _HAS_FAKEREDIS = True
except ImportError:  # pragma: no cover - depends on dev requirements install
    _HAS_FAKEREDIS = False


# ── DB fixtures (opt-in Postgres) ────────────────────────────────────────────

@pytest.fixture
def db_session():
    """SQLAlchemy session against a real Postgres test database.

    Requires the env var ``TEST_DATABASE_URL`` (e.g.
    ``postgresql://civic:civic@localhost:5432/civicpulse_test``).
    SQLite is intentionally not supported — the schema uses Postgres-only
    types (UUID, JSONB) so a SQLite shim would be lossy.

    The session runs inside a SAVEPOINT and rolls back on teardown so tests
    don't leak data into each other.
    """
    test_db_url = os.environ.get("TEST_DATABASE_URL")
    if not test_db_url:
        pytest.skip("Set TEST_DATABASE_URL to run DB-backed tests")

    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    engine = create_engine(test_db_url)
    connection = engine.connect()
    transaction = connection.begin()
    Session = sessionmaker(bind=connection)
    session = Session()

    try:
        yield session
    finally:
        session.close()
        transaction.rollback()
        connection.close()


# ── Factory fixtures (no DB) ─────────────────────────────────────────────────

@pytest.fixture
def make_raw_report():
    """Build an unsaved RawReport with sensible defaults."""
    from shared.models import RawReport

    def _factory(
        text: str = "Pothole on the road",
        lat: float = 37.3382,
        lng: float = -121.8863,
        address: str | None = "1 N 1st St, San Jose, CA",
        reporter_phone: str | None = "+14085550100",
        source: str = "app",
        status: str = "queued",
        image_url: str | None = None,
        citizen_id: uuid.UUID | None = None,
        **overrides: Any,
    ) -> RawReport:
        return RawReport(
            id=overrides.pop("id", uuid.uuid4()),
            citizen_id=citizen_id,
            source=source,
            text=text,
            image_url=image_url,
            lat=lat, lng=lng,
            address=address,
            reporter_phone=reporter_phone,
            submitted_at=datetime.now(timezone.utc),
            status=status,
            **overrides,
        )

    return _factory


@pytest.fixture
def make_ticket():
    """Build an unsaved Ticket. Defaults to a typical pothole, urgency 3.5."""
    from shared.models import Ticket

    def _factory(
        category_code: str = "RD",
        category_name: str = "Road Surface",
        subcategory_code: str = "RD-001",
        subcategory_name: str = "Pothole",
        severity: int = 3,
        urgency_score: float = 3.5,
        confidence: float = 0.90,
        needs_review: bool = False,
        approved: bool = True,
        cluster_count: int = 1,
        raw_report_id: uuid.UUID | None = None,
        **overrides: Any,
    ) -> Ticket:
        defaults = {
            "id": overrides.pop("id", uuid.uuid4()),
            "raw_report_id": raw_report_id or uuid.uuid4(),
            "category_code": category_code,
            "category_name": category_name,
            "subcategory_code": subcategory_code,
            "subcategory_name": subcategory_name,
            "severity": severity,
            "urgency_score": urgency_score,
            "urgency_factors": {
                "safety_risk": 0.5,
                "traffic_impact": 0.4,
                "cluster_volume": 0.05,
                "low_confidence": 0.05,
            },
            "ai_reasoning": "Routine surface defect.",
            "confidence": confidence,
            "needs_review": needs_review,
            "approved": approved,
            "cluster_count": cluster_count,
            "created_at": datetime.now(timezone.utc),
        }
        defaults.update(overrides)
        return Ticket(**defaults)

    return _factory


@pytest.fixture
def make_officer():
    """Build an unsaved Officer. Defaults to a roads officer named Diana Reed."""
    from shared.models import Officer

    def _factory(
        name: str = "Diana Reed",
        email: str = "diana@example.com",
        password_hash: str = "$2b$12$abcdefghijklmnopqrstuv",
        role: str = "officer",
        department: str | None = "roads",
        **overrides: Any,
    ) -> Officer:
        return Officer(
            id=overrides.pop("id", uuid.uuid4()),
            name=name,
            email=email,
            password_hash=password_hash,
            role=role,
            department=department,
            **overrides,
        )

    return _factory


@pytest.fixture
def make_crew():
    """Build an unsaved Crew."""
    from shared.models import Crew

    def _factory(
        team_name: str = "Roads Alpha",
        crew_type: str = "roads",
        lead_name: str = "Diana Reed",
        lead_email: str = "diana@example.com",
        **overrides: Any,
    ) -> Crew:
        return Crew(
            id=overrides.pop("id", uuid.uuid4()),
            team_name=team_name,
            crew_type=crew_type,
            lead_name=lead_name,
            lead_email=lead_email,
            **overrides,
        )

    return _factory


# ── Mocks ─────────────────────────────────────────────────────────────────────

@pytest.fixture
def mock_gemini_model():
    """A MagicMock that mimics ``google.generativeai.GenerativeModel``.

    The default response is the canonical "valid pothole classification" JSON.
    Tests can override per-call by calling ``mock_gemini_model.set_response(d)``
    where ``d`` is the dict to be JSON-encoded as the next response, or
    ``set_response_text("not json {{{")`` to simulate malformed output.
    """
    model = MagicMock()
    response = MagicMock()
    response.text = dumps({
        "category_code": "RD",
        "category_name": "Road Surface",
        "subcategory_code": "RD-001",
        "subcategory_name": "Pothole",
        "severity": 3,
        "confidence": 0.92,
        "reasoning": "Report describes a hole in the road surface.",
        "image_text_conflict": False,
        "image_classification_hint": "",
    })
    model.generate_content.return_value = response

    def set_response(payload: dict) -> None:
        response.text = dumps(payload)
        model.generate_content.return_value = response

    def set_response_text(text: str) -> None:
        response.text = text
        model.generate_content.return_value = response

    def raise_on_next(exc: Exception) -> None:
        model.generate_content.side_effect = exc

    model.set_response = set_response
    model.set_response_text = set_response_text
    model.raise_on_next = raise_on_next
    return model


@pytest.fixture
def mock_redis():
    """In-memory Redis substitute via fakeredis. Skips when fakeredis isn't installed."""
    if not _HAS_FAKEREDIS:
        pytest.skip("fakeredis not installed — see tests/requirements-dev.txt")
    return fakeredis.FakeRedis()


@pytest.fixture
def mock_celery_send_task(monkeypatch):
    """Patch every Celery ``send_task`` call site we know about.

    Returns a list of call dicts so tests can assert on queue + args.
    Each entry: ``{"name": str, "args": list, "kwargs": dict, "queue": str | None,
    "countdown": int | None}``.
    """
    calls: list[dict[str, Any]] = []

    def _record(*args, **kwargs):
        calls.append({
            "name":      args[0] if args else kwargs.get("name"),
            "args":      list(kwargs.get("args") or []),
            "kwargs":    dict(kwargs.get("kwargs") or {}),
            "queue":     kwargs.get("queue"),
            "countdown": kwargs.get("countdown"),
        })
        return SimpleNamespace(id=str(uuid.uuid4()))

    targets = (
        "services.worker.tasks.celery_app.send_task",
        "services.api.routers.reports._celery",
    )
    for target in targets:
        try:
            monkeypatch.setattr(target, _record, raising=False)
        except (AttributeError, ModuleNotFoundError):
            continue

    calls.recorder = _record  # type: ignore[attr-defined]
    return calls


# ── Sample payloads ───────────────────────────────────────────────────────────

@pytest.fixture
def sample_pipeline_payload() -> dict[str, Any]:
    """Canonical payload S3 sends to S2 on ``ai_core:process``."""
    return {
        "report_id": str(uuid.uuid4()),
        "text": "Large pothole in the right lane",
        "image_url": None,
        "lat": 37.3382,
        "lng": -121.8863,
        "address": "1 N 1st St, San Jose, CA",
        "reporter_phone": "+14085550100",
        "source": "app",
        "submitted_at": datetime.now(timezone.utc).isoformat(),
        "status": "processing",
        "attempt": 0,
    }


@pytest.fixture
def sample_enriched_ticket() -> dict[str, Any]:
    """Canonical enriched dict S2 publishes to ``ai_core:results``."""
    return {
        "category_code": "RD",
        "category_name": "Road Surface",
        "subcategory_code": "RD-001",
        "subcategory_name": "Pothole",
        "severity": 3,
        "confidence": 0.92,
        "image_text_conflict": False,
        "image_classification_hint": None,
        "needs_review": False,
        "is_duplicate": False,
        "master_ticket_id": None,
        "cluster_count": 1,
        "urgency_score": 3.5,
        "urgency_factors": {
            "safety_risk": 0.50,
            "traffic_impact": 0.40,
            "cluster_volume": 0.05,
            "low_confidence": 0.05,
        },
        "urgency_reasoning": "Moderate-severity pothole on a primary road.",
    }
