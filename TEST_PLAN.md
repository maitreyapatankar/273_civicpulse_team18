# CivicPulse — Test Plan

**Project**: CivicPulse — AI-first urban infrastructure reporting platform
**Course**: 273 — Team 18
**Document version**: 1.0

---

## 1. Overview

This test plan exercises CivicPulse end-to-end across all five backend services plus the scheduler. Each test case is uniquely identified, classified as **success** or **failure**, and includes preconditions, executable steps, expected results, and pass criteria so a grader (or CI run) can record a definitive pass/fail.

### Scope

| In scope | Out of scope |
|----------|--------------|
| S1 API Gateway (FastAPI) | Frontend visual / pixel-perfect tests |
| S2 AI Core (LangGraph pipeline, Gemini) | Load / performance benchmarking |
| S3 Worker (Celery orchestration) | Penetration / security testing |
| S5 Notifications (Twilio SMS pub-sub) | Cloudflare R2 / AWS S3 connectivity |
| Scheduler (Gmail SMTP fan-out) | Mobile-app-specific behaviour |
| End-to-end happy paths | LLM accuracy benchmarking |

### Definitions

- **Success test**: Verifies the system behaves correctly when given valid inputs.
- **Failure test**: Verifies the system fails gracefully (correct error code, no crash, no data loss) under invalid inputs, missing dependencies, or external-service errors.
- **Pass criterion**: A single boolean condition that, if true, marks the test passed.

---

## 2. Test environment setup

All tests assume a clean environment built from this repo at the current `main` branch.

### One-time setup

```bash
# 1. Bring the stack up
docker compose up -d

# 2. Apply migrations (only on first run or after pulling new migrations)
docker compose run --rm api alembic upgrade head

# 3. Seed the database with deterministic demo data
docker compose run --rm \
    --volume "$(pwd)/scripts:/app/scripts" \
    api python /app/scripts/seed.py --reset

# 4. Install dev dependencies for any pytest-based tests
pip install -r tests/requirements-dev.txt
```

### Resetting between tests that mutate state

Tests in section 4 that issue PATCH or DELETE-equivalent calls leave residue. Re-run the seed with `--reset` between manual passes. The seed is idempotent and produces stable UUIDs.

### Tools

| Tool | Used for |
|------|----------|
| `curl` / Postman / Insomnia | HTTP requests to S1 |
| `docker compose logs <service>` | Verifying log entries |
| `docker compose exec postgres psql -U civic civicpulse` | DB inspection |
| `docker compose exec redis redis-cli` | Queue / pub-sub inspection |
| `pytest` | Automated tests under `tests/ai_core/` |

---

## 3. Test data reference

After running `scripts/seed.py --reset`, the following entities are available with deterministic IDs (derived via `uuid.uuid5`).

### Login credentials

| Role | Email / username | Password |
|------|------------------|----------|
| Admin | `admin` (username, no email) | `${ADMIN_PASSWORD}` from `.env` |
| Admin via officer login | `admin@civicpulse.gov` | `Officer123!` |
| Officer (roads) | `roads.lead@civicpulse.gov` | `Officer123!` |
| Officer (traffic) | `traffic.lead@civicpulse.gov` | `Officer123!` |
| Officer (drainage) | `drainage.lead@civicpulse.gov` | `Officer123!` |
| Officer (structures) | `structures.lead@civicpulse.gov` | `Officer123!` |
| Officer (operations) | `ops.lead@civicpulse.gov` | `Officer123!` |
| Citizens (5) | `alice@example.com`, `bob@example.com`, `carmen@example.com`, `david@example.com`, `esha@example.com` | `Citizen123!` |

### Notable seeded tickets

| Seed key | Subcategory | Urgency | Assigned to | State |
|----------|-------------|---------|-------------|-------|
| `report-rd006-sinkhole` | RD-006 (sinkhole, P1) | 5.0 | Diana Reed | open |
| `report-tf002-dark-signal` | TF-002 (dark signal, P1) | 4.8 | Marcus Chen | open |
| `report-dr003-missing-drain` | DR-003 (P1) | 4.6 | Priya Nair | open |
| `report-rd001-pothole-master` | RD-001 (cluster master) | 3.8 | Diana Reed | open, cluster_count=2 |
| `report-rd001-pothole-dup` | RD-001 (duplicate) | 3.8 | (master) | duplicate_of master |
| `report-rd001-resolved` | RD-001 | 2.4 | Diana Reed | resolved |
| `report-st004-manhole` | ST-004 (P1) | 4.9 | Aaron Webb | resolved |
| `report-conflict-needs-review` | RD-001 | 3.0 | unassigned | needs_review, image_text_conflict |
| `report-failed-pipeline` | (none) | n/a | n/a | raw_report.status=failed |
| `report-queued-1`, `report-queued-2` | (none) | n/a | n/a | raw_report.status=queued |

To get the exact UUID for any seed key:

```python
import uuid
NAMESPACE = uuid.UUID("c1c1c1c1-2b2b-3c3c-4d4d-5e5e5e5e5e5e")
print(uuid.uuid5(NAMESPACE, "ticket:report-rd006-sinkhole"))
```

---

## 4. Test cases

Each test case follows this format:

> **TC-ID — Title**
> **Service**: which service is under test
> **Type**: success or failure
> **Preconditions**: required state before the test runs
> **Steps**: numbered, executable steps
> **Expected Result**: full description of correct behaviour
> **Pass Criteria**: one boolean condition that determines pass/fail
> **Status**: Not Run | Pass | Fail | Blocked

---

### 4.1 Service 1 — API Gateway

#### Authentication

##### TC-S1-01 — Admin login (bootstrap) success

- **Service**: S1 / `services/api/routers/auth.py`
- **Type**: success
- **Preconditions**: Stack running; `.env` has `ADMIN_USERNAME=admin`, `ADMIN_PASSWORD=adminP`.
- **Steps**:
  1. `POST http://localhost:8000/auth/login` with JSON `{"username": "admin", "password": "adminP"}`.
- **Expected Result**: HTTP 200 with body `{"access_token": "<jwt>", "role": "admin", "officer_id": null, "email": null, "name": "admin"}`.
- **Pass Criteria**: status code is 200 AND `access_token` decodes (HS256, `OFFICER_JWT_SECRET`) to a payload with `role == "admin"`.
- **Status**: Not Run

##### TC-S1-02 — Admin login wrong password

- **Service**: S1 / `services/api/routers/auth.py`
- **Type**: failure
- **Preconditions**: Same as TC-S1-01.
- **Steps**:
  1. `POST /auth/login` with `{"username": "admin", "password": "wrong"}`.
- **Expected Result**: HTTP 401, body `{"detail": "Invalid credentials"}`.
- **Pass Criteria**: status code is 401 AND no token returned.
- **Status**: Not Run

##### TC-S1-03 — Officer login success

- **Service**: S1 / `services/api/routers/auth.py`
- **Type**: success
- **Preconditions**: Seed applied so `roads.lead@civicpulse.gov` exists.
- **Steps**:
  1. `POST /auth/officer/login` with `{"email": "roads.lead@civicpulse.gov", "password": "Officer123!"}`.
- **Expected Result**: HTTP 200 with `access_token`, `role="officer"`, `email`, `officer_id` matches the seeded UUID.
- **Pass Criteria**: status 200 AND `role == "officer"` AND `email == "roads.lead@civicpulse.gov"`.
- **Status**: Not Run

##### TC-S1-04 — Officer login wrong password

- **Service**: S1 / `services/api/routers/auth.py`
- **Type**: failure
- **Preconditions**: Seed applied.
- **Steps**:
  1. `POST /auth/officer/login` with `{"email": "roads.lead@civicpulse.gov", "password": "WRONG"}`.
- **Expected Result**: HTTP 401, body `{"detail": "Invalid credentials"}`.
- **Pass Criteria**: status code is 401.
- **Status**: Not Run

##### TC-S1-05 — Protected endpoint missing JWT

- **Service**: S1 / `services/api/routers/tickets.py`
- **Type**: failure
- **Preconditions**: Stack running.
- **Steps**:
  1. `GET /tickets` with no `Authorization` header.
- **Expected Result**: HTTP 401 or 403.
- **Pass Criteria**: status code is in {401, 403}.
- **Status**: Not Run

##### TC-S1-06 — Protected endpoint expired JWT

- **Service**: S1 / `services/api/routers/auth.py`
- **Type**: failure
- **Preconditions**: A JWT signed with the same secret but `exp` in the past.
- **Steps**:
  1. `GET /tickets` with `Authorization: Bearer <expired-jwt>`.
- **Expected Result**: HTTP 401 with detail "Invalid or expired token".
- **Pass Criteria**: status code is 401.
- **Status**: Not Run

##### TC-S1-07 — Admin provisions new officer

- **Service**: S1 / `POST /auth/officer/provision`
- **Type**: success
- **Preconditions**: Admin JWT obtained from TC-S1-01 or TC-S1-03 (admin role).
- **Steps**:
  1. `POST /auth/officer/provision` with admin JWT and body `{"name": "Test Officer", "email": "test.officer@civicpulse.gov", "password": "Officer123!", "role": "officer", "department": "roads"}`.
- **Expected Result**: HTTP 200 with `officer_id`, `role="officer"`, `email`, `name`. New row appears in `officers` table.
- **Pass Criteria**: status 200 AND `SELECT 1 FROM officers WHERE email='test.officer@civicpulse.gov'` returns 1 row.
- **Status**: Not Run

##### TC-S1-08 — Non-admin attempts to provision

- **Service**: S1 / `POST /auth/officer/provision`
- **Type**: failure
- **Preconditions**: Officer (non-admin) JWT obtained from TC-S1-03.
- **Steps**:
  1. `POST /auth/officer/provision` with officer JWT and any valid body.
- **Expected Result**: HTTP 403 with detail "Admin role required".
- **Pass Criteria**: status code is 403 AND `officers` row count unchanged.
- **Status**: Not Run

#### Reports

##### TC-S1-09 — POST /reports happy path (text only)

- **Service**: S1 / `services/api/routers/reports.py`
- **Type**: success
- **Preconditions**: Stack running.
- **Steps**:
  1. `POST /reports` as multipart form with `text="Pothole on the corner"`, `lat=37.3382`, `lng=-121.8863`, `address="1 N 1st St"`, `reporter_phone=+14085550100`, `source="app"`.
- **Expected Result**: HTTP 202 with `{"ticket_id": "<uuid>", "status": "processing"}`. A row appears in `raw_reports` with that UUID and `status="queued"` (then `processing` once the worker picks it up). The Redis list `reports:process` receives a task.
- **Pass Criteria**: status 202 AND `raw_reports` row exists for `ticket_id`.
- **Status**: Not Run

##### TC-S1-10 — POST /reports missing both text and image

- **Service**: S1 / `services/api/routers/reports.py`
- **Type**: failure
- **Preconditions**: Stack running.
- **Steps**:
  1. `POST /reports` as multipart form with only `lat=37.3382` and `lng=-121.8863` (no text, no image).
- **Expected Result**: HTTP 422 with detail "At least one of 'text' or 'image' is required."
- **Pass Criteria**: status code is 422.
- **Status**: Not Run

##### TC-S1-11 — POST /reports missing required lat/lng

- **Service**: S1 / `services/api/routers/reports.py`
- **Type**: failure
- **Preconditions**: Stack running.
- **Steps**:
  1. `POST /reports` as multipart form with only `text="Pothole"` (no lat/lng).
- **Expected Result**: HTTP 422 (FastAPI form validation).
- **Pass Criteria**: status code is 422.
- **Status**: Not Run

##### TC-S1-12 — POST /reports/batch-csv with valid file

- **Service**: S1 / `services/api/routers/reports.py`
- **Type**: success
- **Preconditions**: Stack running. CSV file `sample.csv` with header `lat,lng,text,address,reporter_phone` and 3 valid rows.
- **Steps**:
  1. `POST /reports/batch-csv` with `file=@sample.csv` multipart.
- **Expected Result**: HTTP 202 with `{"enqueued": 3, "errors": []}`. 3 new rows in `raw_reports` with `source="csv"`.
- **Pass Criteria**: status 202 AND `enqueued == 3` AND `errors` is empty.
- **Status**: Not Run

##### TC-S1-13 — POST /reports/batch-csv with non-CSV file

- **Service**: S1 / `services/api/routers/reports.py`
- **Type**: failure
- **Preconditions**: Stack running.
- **Steps**:
  1. `POST /reports/batch-csv` with `file=@somefile.txt`.
- **Expected Result**: HTTP 415 with detail "File must be a .csv".
- **Pass Criteria**: status code is 415.
- **Status**: Not Run

##### TC-S1-14 — POST /reports/batch-csv missing required columns

- **Service**: S1 / `services/api/routers/reports.py`
- **Type**: failure
- **Preconditions**: Stack running. CSV file missing `lat` column.
- **Steps**:
  1. `POST /reports/batch-csv` with the malformed CSV.
- **Expected Result**: HTTP 422 with detail mentioning required columns.
- **Pass Criteria**: status code is 422.
- **Status**: Not Run

#### Tickets

##### TC-S1-15 — GET /tickets sorted by urgency desc

- **Service**: S1 / `services/api/routers/tickets.py`
- **Type**: success
- **Preconditions**: Seed applied; officer JWT available.
- **Steps**:
  1. `GET /tickets?sort=urgency_score&order=desc` with officer JWT.
- **Expected Result**: HTTP 200 with array of tickets, the first row is the seeded sinkhole (urgency 5.0) or manhole (4.9), rows are non-increasing by `urgency_score`.
- **Pass Criteria**: status 200 AND for every consecutive pair (a, b): `a.urgency_score >= b.urgency_score`.
- **Status**: Not Run

##### TC-S1-16 — GET /tickets/{id} happy path

- **Service**: S1 / `services/api/routers/tickets.py`
- **Type**: success
- **Preconditions**: Seed applied; officer JWT.
- **Steps**:
  1. Compute the seeded sinkhole UUID via `uuid.uuid5(NAMESPACE, "ticket:report-rd006-sinkhole")`.
  2. `GET /tickets/<that-uuid>` with officer JWT.
- **Expected Result**: HTTP 200 with full ticket detail including `subcategory_code="RD-006"`, `urgency_score=5.0`, `assigned_to="Diana Reed"`.
- **Pass Criteria**: status 200 AND `subcategory_code == "RD-006"`.
- **Status**: Not Run

##### TC-S1-17 — GET /tickets/{id}/status public (no auth)

- **Service**: S1 / `services/api/routers/tickets.py`
- **Type**: success
- **Preconditions**: Seed applied.
- **Steps**:
  1. `GET /tickets/<uuid>/status` with **no** `Authorization` header.
- **Expected Result**: HTTP 200 with public status payload (status, urgency_score, reporter_phone, etc.).
- **Pass Criteria**: status 200.
- **Status**: Not Run

##### TC-S1-18 — GET /tickets/{id} not found

- **Service**: S1 / `services/api/routers/tickets.py`
- **Type**: failure
- **Preconditions**: Officer JWT.
- **Steps**:
  1. `GET /tickets/00000000-0000-0000-0000-000000000000` with officer JWT.
- **Expected Result**: HTTP 404.
- **Pass Criteria**: status code is 404.
- **Status**: Not Run

##### TC-S1-19 — PATCH /tickets/{id} officer override

- **Service**: S1 / `services/api/routers/admin.py`
- **Type**: success
- **Preconditions**: Seed applied; officer JWT; pick a non-resolved seeded ticket (e.g. pothole master).
- **Steps**:
  1. `PATCH /tickets/<uuid>` with body `{"urgency_score": 4.5, "notes": "Bumping priority — school zone"}` and officer JWT.
- **Expected Result**: HTTP 200. DB row has `urgency_score=4.5`, `dispatcher_override=true`, `override_by` set, `override_at` recent. `work_order.dispatcher_notes` contains the note.
- **Pass Criteria**: status 200 AND `dispatcher_override` true in DB AND `urgency_score == 4.5`.
- **Status**: Not Run

##### TC-S1-20 — PATCH /tickets/{id} resolve

- **Service**: S1 / `services/api/routers/admin.py`
- **Type**: success
- **Preconditions**: Seed applied; officer JWT.
- **Steps**:
  1. `PATCH /tickets/<uuid>` with body `{"resolve": true, "comment": "Fixed in field"}`.
- **Expected Result**: HTTP 200. `tickets.resolved_at` is set; a `notify:ticket_resolved` event is published on Redis. New `ticket_comments` row.
- **Pass Criteria**: status 200 AND `resolved_at IS NOT NULL` in DB.
- **Status**: Not Run

##### TC-S1-21 — PATCH /tickets/{id} no JWT

- **Service**: S1 / `services/api/routers/admin.py`
- **Type**: failure
- **Preconditions**: Stack running.
- **Steps**:
  1. `PATCH /tickets/<any-uuid>` with body `{"urgency_score": 5}` and **no** Authorization header.
- **Expected Result**: HTTP 401 or 403.
- **Pass Criteria**: status code is in {401, 403}.
- **Status**: Not Run

#### Crews & Schedule

##### TC-S1-22 — GET /crews returns seeded crews

- **Service**: S1 / `services/api/routers/crews.py`
- **Type**: success
- **Preconditions**: Seed applied; officer JWT.
- **Steps**:
  1. `GET /crews` with officer JWT.
- **Expected Result**: HTTP 200 with array of 5 crews (Roads Alpha, Traffic Bravo, Drainage Charlie, Structures Delta, Operations Echo).
- **Pass Criteria**: status 200 AND length >= 5 AND every seeded crew is present.
- **Status**: Not Run

##### TC-S1-23 — GET /schedule returns today's schedule

- **Service**: S1 / `services/api/routers/schedule.py`
- **Type**: success
- **Preconditions**: Seed applied; officer JWT.
- **Steps**:
  1. `GET /schedule` with officer JWT.
- **Expected Result**: HTTP 200 with at least 1 schedule for today (drainage zone) plus possibly yesterday's roads zone.
- **Pass Criteria**: status 200 AND at least one schedule for `date == today`.
- **Status**: Not Run

##### TC-S1-24 — GET /events SSE stream connects

- **Service**: S1 / `services/api/routers/events.py`
- **Type**: success
- **Preconditions**: Stack running.
- **Steps**:
  1. `curl -N http://localhost:8000/events` (or browser EventSource).
  2. In another shell, publish a Redis message: `redis-cli PUBLISH notify:ticket_ready '{"ticket_id":"abc","report_id":"def"}'`.
- **Expected Result**: SSE stream stays open; the published event arrives as an SSE `data:` frame within 5 seconds.
- **Pass Criteria**: client receives the published event payload.
- **Status**: Not Run

---

### 4.2 Service 2 — AI Core (LangGraph pipeline)

The fixtures in `tests/conftest.py` and the existing tests in `tests/ai_core/test_classify.py` and `tests/ai_core/test_image_description.py` cover most of these. Each test below describes an automatable scenario; existing pytest tests are noted in **Existing test**.

#### Image description node

##### TC-S2-01 — No image URL → graceful skip

- **Service**: S2 / `services/ai_core/pipeline/nodes/image_description.py`
- **Type**: success
- **Preconditions**: AI Core importable.
- **Existing test**: `tests/ai_core/test_image_description.py::test_no_image_skips_gracefully`
- **Steps**:
  1. Build a state with `image_url=None`.
  2. Call `image_description_node(state)`.
- **Expected Result**: state's `image_desc` is None, `image_fetch_failed` is False, `image_description` is in `completed_nodes`.
- **Pass Criteria**: returned dict matches expected fields.
- **Status**: Existing test passes.

##### TC-S2-02 — Image URL valid → description set

- **Service**: S2
- **Type**: success
- **Existing test**: `tests/ai_core/test_image_description.py::test_successful_description`
- **Pass Criteria**: `image_desc` populated AND `image_fetch_failed` is False.
- **Status**: Existing test passes.

##### TC-S2-03 — Image fetch timeout → fail-open

- **Service**: S2
- **Type**: failure
- **Existing test**: `tests/ai_core/test_image_description.py::test_image_fetch_failure_handled`
- **Pass Criteria**: `image_fetch_failed` is True AND no exception bubbles up.
- **Status**: Existing test passes.

##### TC-S2-04 — Gemini API error → fail-open

- **Service**: S2
- **Type**: failure
- **Existing test**: `tests/ai_core/test_image_description.py::test_gemini_api_error_handled`
- **Pass Criteria**: pipeline state is still a dict with `image_description` in `completed_nodes`.
- **Status**: Existing test passes.

#### Classify node

##### TC-S2-05 — Pothole classified RD-001

- **Service**: S2 / `services/ai_core/pipeline/nodes/classify.py`
- **Type**: success
- **Existing test**: `tests/ai_core/test_classify.py::test_pothole_classified_correctly`
- **Pass Criteria**: `subcategory_code == "RD-001"` AND `needs_review is False`.
- **Status**: Existing test passes.

##### TC-S2-06 — Confidence < 0.70 → needs_review

- **Service**: S2
- **Type**: success (gating logic correct)
- **Existing test**: `tests/ai_core/test_classify.py::test_low_confidence_sets_needs_review`
- **Pass Criteria**: `needs_review is True`.
- **Status**: Existing test passes.

##### TC-S2-07 — image_text_conflict → needs_review

- **Service**: S2
- **Type**: success
- **Existing test**: `tests/ai_core/test_classify.py::test_image_text_conflict_sets_needs_review`
- **Pass Criteria**: `needs_review is True` AND `image_classification_hint` set.
- **Status**: Existing test passes.

##### TC-S2-08 — Invalid taxonomy code → fallback OT-005

- **Service**: S2
- **Type**: failure (recovery)
- **Existing test**: `tests/ai_core/test_classify.py::test_invalid_code_falls_back_to_OT005`
- **Pass Criteria**: `subcategory_code == "OT-005"` AND `fallback_used is True`.
- **Status**: Existing test passes.

##### TC-S2-09 — Malformed JSON from Gemini

- **Service**: S2
- **Type**: failure (recovery)
- **Existing test**: `tests/ai_core/test_classify.py::test_malformed_json_handled`
- **Pass Criteria**: `subcategory_code == "OT-005"` AND `pipeline_error is not None` AND `confidence == 0.0`.
- **Status**: Existing test passes.

##### TC-S2-10 — Sinkhole → severity 5

- **Service**: S2
- **Type**: success
- **Existing test**: `tests/ai_core/test_classify.py::test_sinkhole_severity_5`
- **Pass Criteria**: `subcategory_code == "RD-006"` AND `severity == 5`.
- **Status**: Existing test passes.

#### Dedup node

##### TC-S2-11 — Same subcategory + 50 m → duplicate

- **Service**: S2 / `services/ai_core/pipeline/nodes/dedup.py`
- **Type**: success
- **Preconditions**: Test Postgres database with seed applied. Master pothole at `(37.3402, -121.8841)` exists.
- **Steps**:
  1. Build state with `subcategory_code="RD-001"`, `lat=37.3404`, `lng=-121.8843` (~ 25 m offset).
  2. Run `dedup_node(state)` with read-only DB session.
- **Expected Result**: `is_duplicate=True`, `master_ticket_id` matches the seeded master pothole UUID, `cluster_count` incremented.
- **Pass Criteria**: `is_duplicate is True`.
- **Status**: Not Run (manual)

##### TC-S2-12 — Same subcategory + 200 m → not duplicate

- **Service**: S2
- **Type**: success
- **Preconditions**: Same as above.
- **Steps**:
  1. State with `subcategory_code="RD-001"`, lat/lng > 0.0009° away (~ 100 m+).
  2. Run dedup.
- **Expected Result**: `is_duplicate=False`.
- **Pass Criteria**: `is_duplicate is False`.
- **Status**: Not Run (manual)

##### TC-S2-13 — Different subcategory same location → not duplicate

- **Service**: S2
- **Type**: success
- **Steps**:
  1. State with `subcategory_code="DR-001"`, lat/lng of seeded pothole master.
- **Expected Result**: `is_duplicate=False`.
- **Pass Criteria**: `is_duplicate is False`.
- **Status**: Not Run (manual)

##### TC-S2-14 — Master ticket already resolved → not duplicate

- **Service**: S2
- **Type**: success
- **Steps**:
  1. Pre-resolve the master pothole ticket (`UPDATE tickets SET resolved_at=NOW() WHERE id=...`).
  2. State with `subcategory_code="RD-001"` near master location.
  3. Run dedup.
- **Expected Result**: `is_duplicate=False` because master is resolved.
- **Pass Criteria**: `is_duplicate is False`.
- **Status**: Not Run (manual)

##### TC-S2-15 — DB query error → fail-open

- **Service**: S2
- **Type**: failure (recovery)
- **Steps**:
  1. Mock `db.execute` to raise `OperationalError`.
  2. Run dedup.
- **Expected Result**: `is_duplicate=False` (fail-open), warning logged, no exception bubbles.
- **Pass Criteria**: `is_duplicate is False` AND no unhandled exception.
- **Status**: Not Run (manual)

#### Urgency node

##### TC-S2-16 — RD-006 sinkhole → P1 override (no LLM call)

- **Service**: S2 / `services/ai_core/pipeline/nodes/urgency.py`
- **Type**: success
- **Preconditions**: AI Core importable.
- **Steps**:
  1. State with `subcategory_code="RD-006"`, `severity=5`.
  2. Patch `genai.GenerativeModel` to fail if called (assert it isn't).
  3. Run urgency node.
- **Expected Result**: `urgency_score >= 4.5`, factors dominated by safety/traffic, LLM not called.
- **Pass Criteria**: `urgency_score >= 4.5` AND `genai.GenerativeModel.generate_content` was NOT called.
- **Status**: Not Run (manual)

##### TC-S2-17 — Keyword "fatal accident" → P1 override

- **Service**: S2
- **Type**: success
- **Steps**:
  1. State with `text="Fatal accident, road blocked"`.
- **Expected Result**: `urgency_score >= 4.5`, factor `safety_risk` near 1.0, LLM not called.
- **Pass Criteria**: same as TC-S2-16.
- **Status**: Not Run (manual)

##### TC-S2-18 — Cluster rate ≥ 3/hr → P1 override

- **Service**: S2
- **Type**: success
- **Steps**:
  1. State with `cluster_rate_per_hour=3.5`.
- **Expected Result**: P1 override fires; `urgency_score >= 4.5`.
- **Pass Criteria**: same as TC-S2-16.
- **Status**: Not Run (manual)

##### TC-S2-19 — Normal report → LLM scoring path

- **Service**: S2
- **Type**: success
- **Steps**:
  1. State with `subcategory_code="MK-001"`, `severity=2`, no P1 keywords.
  2. Mock Gemini to return `{"safety_risk": 0.3, "traffic_impact": 0.2, "cluster_volume": 0.1, "low_confidence": 0.1, "reasoning": "Routine"}`.
- **Expected Result**: urgency computed via weighted sum of factors; LLM was called once.
- **Pass Criteria**: `genai.GenerativeModel.generate_content` called exactly once AND `urgency_score < 4.0`.
- **Status**: Not Run (manual)

##### TC-S2-20 — severity=5 floors urgency to ≥ 4

- **Service**: S2
- **Type**: success
- **Steps**:
  1. State with `severity=5` and an LLM response that would normally yield score < 4.
- **Expected Result**: post-processing floor lifts `urgency_score` to ≥ 4.0.
- **Pass Criteria**: `urgency_score >= 4.0`.
- **Status**: Not Run (manual)

##### TC-S2-21 — needs_review caps urgency at ≤ 4 unless P1

- **Service**: S2
- **Type**: success
- **Steps**:
  1. State with `needs_review=True`, no P1 trigger; LLM returns high score.
- **Expected Result**: post-processing caps `urgency_score` at 4.0.
- **Pass Criteria**: `urgency_score <= 4.0`.
- **Status**: Not Run (manual)

#### Graph end-to-end

##### TC-S2-22 — Full pipeline happy path

- **Service**: S2 / `services/ai_core/pipeline/graph.py`
- **Type**: success
- **Steps**:
  1. Build initial state from a seeded pothole payload.
  2. Mock Gemini for image_description, classify, urgency.
  3. Run `graph.run(payload)`.
- **Expected Result**: Result dict has `category_code`, `subcategory_code`, `severity`, `confidence`, `urgency_score`, `urgency_factors`, `is_duplicate`. All four nodes are in `completed_nodes`.
- **Pass Criteria**: `len(completed_nodes) == 4`.
- **Status**: Not Run (manual)

##### TC-S2-23 — Classify failure → urgency still runs with fallback

- **Service**: S2
- **Type**: failure (recovery)
- **Steps**:
  1. Mock classify Gemini call to raise.
  2. Run pipeline.
- **Expected Result**: classify falls back to OT-005, urgency node still executes, final state has `pipeline_error` set but `urgency_score` populated.
- **Pass Criteria**: `urgency_score is not None` AND `pipeline_error is not None`.
- **Status**: Not Run (manual)

---

### 4.3 Service 3 — Worker

#### TC-S3-01 — process_report happy path

- **Service**: S3 / `services/worker/tasks.py::process_report`
- **Type**: success
- **Preconditions**: Stack running with worker, AI core, postgres, redis. A raw_report row in `status="queued"`.
- **Steps**:
  1. Insert a fresh `raw_reports` row with `status="queued"` (or use the seeded `report-queued-1`).
  2. `LPUSH reports:process '<report_id>'` (or trigger via `POST /reports`).
- **Expected Result**: Within 5 s, `raw_reports.status` flips to `"processing"`. A task with name `ai_core.consumer.run_pipeline` appears on `ai_core:process` queue. Within 30 s a ticket row is created and `raw_reports.status="done"`.
- **Pass Criteria**: `raw_reports.status == "done"` AND a matching `tickets` row exists with `urgency_score IS NOT NULL`.
- **Status**: Not Run (manual)

#### TC-S3-02 — handle_ai_result inserts ticket and auto-assigns

- **Service**: S3 / `services/worker/tasks.py::handle_ai_result`
- **Type**: success
- **Preconditions**: Officers seeded; AI Core publishes a result for an unknown report.
- **Steps**:
  1. Manually `LPUSH ai_core:results` (or `celery_app.send_task("worker.tasks.handle_ai_result", args=[report_id, enriched])`) with a category_code that maps to roads (e.g. RD-001).
- **Expected Result**: `tickets.assigned_to == "Diana Reed"` (the officer in `roads` department with the fewest open tickets at that moment).
- **Pass Criteria**: `assigned_to` equals an officer name belonging to the `roads` department.
- **Status**: Not Run (manual)

#### TC-S3-03 — handle_ai_failure attempt 0 → re-queue with countdown 1s

- **Service**: S3 / `services/worker/tasks.py::handle_ai_failure`
- **Type**: success (retry path)
- **Steps**:
  1. Trigger `handle_ai_failure(report_id, "boom", attempt=0)`.
- **Expected Result**: A new task `ai_core.consumer.run_pipeline` is sent to `ai_core:process` with countdown `2**0 == 1` second and `payload["attempt"] == 1`.
- **Pass Criteria**: Re-queue observed within 2 s; new payload has `attempt == 1`.
- **Status**: Not Run (manual)

#### TC-S3-04 — handle_ai_failure attempt 3 → DLQ + status=failed

- **Service**: S3
- **Type**: success (terminal failure path)
- **Steps**:
  1. Trigger `handle_ai_failure(report_id, "boom", attempt=3)`.
- **Expected Result**: `raw_reports.status` set to `"failed"`. A task lands on `reports:dlq`. Redis publishes `notify:ticket_updated`. No new task on `ai_core:process`.
- **Pass Criteria**: `raw_reports.status == "failed"` AND a DLQ task is observed.
- **Status**: Not Run (manual)

#### TC-S3-05 — Auto-assign picks officer with fewest open tickets

- **Service**: S3 / `services/worker/tasks.py::_auto_assign`
- **Type**: success
- **Preconditions**: Add a second `roads` officer with 0 open tickets while Diana has 3 open.
- **Steps**:
  1. Trigger `handle_ai_result` for an RD-001 report.
- **Expected Result**: Ticket is assigned to the new officer (fewer open tickets).
- **Pass Criteria**: `assigned_to == "<new officer name>"`.
- **Status**: Not Run (manual)

#### TC-S3-06 — Duplicate result updates master ticket

- **Service**: S3
- **Type**: success
- **Steps**:
  1. Send a `handle_ai_result` payload with `is_duplicate=True`, `master_ticket_id=<seeded master pothole>`, `cluster_count=3`, higher `urgency_score`.
- **Expected Result**: A shadow ticket is created with `duplicate_of=<master>`. The master ticket's `cluster_count=3` and `urgency_score` is updated. `notify:ticket_updated` published with master id.
- **Pass Criteria**: `master.cluster_count == 3` AND `master.urgency_score` reflects the new value.
- **Status**: Not Run (manual)

#### TC-S3-07 — Edit path preserves manual assignment

- **Service**: S3
- **Type**: success
- **Steps**:
  1. Pre-assign a ticket manually (`tickets.assigned_to="Diana Reed"`).
  2. Edit the underlying report (`PATCH /reports/{id}`).
  3. Wait for the AI re-run.
- **Expected Result**: The ticket row is updated in place but `assigned_to` is preserved.
- **Pass Criteria**: post-edit `assigned_to == "Diana Reed"`.
- **Status**: Not Run (manual)

#### TC-S3-08 — Idempotency on duplicate retry delivery

- **Service**: S3 / `services/worker/tasks.py::handle_ai_failure` (retry lock)
- **Type**: success
- **Steps**:
  1. Call `handle_ai_failure(report_id, "boom", attempt=0)` twice with the same `report_id` within 2 minutes.
- **Expected Result**: First call enqueues a retry; second call short-circuits (logs "duplicate delivery skipped") without enqueueing a second retry.
- **Pass Criteria**: Exactly one retry task observed on `ai_core:process`.
- **Status**: Not Run (manual)

---

### 4.4 Service 5 — Notifications

#### TC-S5-01 — notify:ticket_ready → SMS sent

- **Service**: S5 / `services/notifications/listener.py`
- **Type**: success
- **Preconditions**: Twilio creds configured. A seeded ticket with non-null `reporter_phone` (e.g. sinkhole, +14085550101).
- **Steps**:
  1. `redis-cli PUBLISH notify:ticket_ready '{"ticket_id":"<sinkhole-uuid>","report_id":"<rid>"}'`.
- **Expected Result**: Notifications service logs the SMS send. Twilio dashboard shows an outgoing message to `+14085550101` with body containing "Priority: 5/5".
- **Pass Criteria**: Twilio API call succeeds (HTTP 201 from Twilio).
- **Status**: Not Run (manual)

#### TC-S5-02 — notify:ticket_resolved → SMS sent

- **Service**: S5
- **Type**: success
- **Steps**:
  1. `redis-cli PUBLISH notify:ticket_resolved '{"ticket_id":"<sinkhole-uuid>","report_id":"<rid>"}'`.
- **Expected Result**: Twilio receives a "has been resolved" message.
- **Pass Criteria**: Twilio API call succeeds.
- **Status**: Not Run (manual)

#### TC-S5-03 — Missing reporter_phone → skipped silently

- **Service**: S5
- **Type**: success
- **Preconditions**: A ticket whose underlying raw_report has `reporter_phone=NULL` (e.g. CSV-imported `report-mk001-faded`).
- **Steps**:
  1. `redis-cli PUBLISH notify:ticket_ready '{"ticket_id":"<csv-ticket-uuid>","report_id":"..."}'`.
- **Expected Result**: Listener logs the channel + ticket but does NOT call Twilio. No exception.
- **Pass Criteria**: Twilio NOT invoked AND service still running.
- **Status**: Not Run (manual)

#### TC-S5-04 — Unknown channel → ignored

- **Service**: S5
- **Type**: failure (recovery)
- **Steps**:
  1. `redis-cli PUBLISH notify:something_else '{"ticket_id":"<uuid>"}'`.
- **Expected Result**: Listener receives but skips (no template match), Twilio not called.
- **Pass Criteria**: no Twilio call AND no crash.
- **Status**: Not Run (manual)

---

### 4.5 Scheduler service

#### TC-S8-01 — build_schedule with assigned tickets writes schedule rows

- **Service**: Scheduler / `services/scheduler/scheduler.py::build_schedule`
- **Type**: success
- **Preconditions**: Seed applied; at least one approved, unassigned ticket with `crew_id IS NULL`.
- **Steps**:
  1. Trigger `build_schedule` directly: `docker compose exec scheduler celery -A scheduler call scheduler.build_schedule`.
- **Expected Result**: New rows in `schedules` for today, grouped by zone+crew_type. Tickets get `crew_id` and `assigned_to` set. Email sent to each crew lead (if `EMAIL_APP_PASSWORD` set).
- **Pass Criteria**: `SELECT COUNT(*) FROM schedules WHERE date = CURRENT_DATE` > 0 after task completes.
- **Status**: Not Run (manual)

#### TC-S8-02 — No tickets in window → no email

- **Service**: Scheduler
- **Type**: success
- **Preconditions**: Database has only resolved/duplicate tickets.
- **Steps**:
  1. Resolve every open ticket (`UPDATE tickets SET resolved_at = NOW() WHERE resolved_at IS NULL`).
  2. Run `build_schedule`.
- **Expected Result**: Logs "No open tickets — nothing to schedule". No email sent. No schedule rows added.
- **Pass Criteria**: `schedules` row count unchanged AND `EMAIL` API not invoked.
- **Status**: Not Run (manual)

#### TC-S8-03 — Email send fails → logged, no crash

- **Service**: Scheduler
- **Type**: failure (recovery)
- **Preconditions**: Set `EMAIL_APP_PASSWORD` to an invalid value.
- **Steps**:
  1. Trigger `build_schedule`.
- **Expected Result**: `_send_email` catches `smtplib.SMTPAuthenticationError`, logs `Failed to send email`, and the rest of the task continues. Schedule rows still written.
- **Pass Criteria**: `schedules` populated AND error log present AND no unhandled exception.
- **Status**: Not Run (manual)

#### TC-S8-04 — Schedule honors zone-based round-robin to crews

- **Service**: Scheduler
- **Type**: success
- **Preconditions**: Multiple drainage tickets in 2 different zones; 2 drainage crews exist.
- **Steps**:
  1. Run `build_schedule`.
- **Expected Result**: Each zone is assigned to a different crew (round-robin sorted alphabetically by team_name).
- **Pass Criteria**: 2 distinct `crew_id` values across the 2 zones.
- **Status**: Not Run (manual)

---

### 4.6 End-to-end scenarios (full stack)

These require all services running (`docker compose up`) and a valid `GEMINI_API_KEY` in `.env`. They exercise the real pipeline against the real Gemini API.

#### TC-E2E-01 — Submit report, see ticket appear with urgency

- **Type**: success
- **Preconditions**: Stack up; seed reset.
- **Steps**:
  1. `POST /reports` with `text="Pothole on the corner of 1st and Santa Clara"`, `lat=37.3382`, `lng=-121.8863`, `reporter_phone=+14085551234`.
  2. Capture returned `ticket_id`.
  3. Poll `GET /tickets/<ticket_id>/status` every 2 s for up to 60 s.
- **Expected Result**: Initial status `processing`. Within ~60 s, status becomes `open` (or `done`). Final ticket has `subcategory_code starts with "RD"`, `urgency_score` between 2.0 and 5.0, `confidence > 0.5`.
- **Pass Criteria**: `urgency_score IS NOT NULL` AND `category_code == "RD"`.
- **Status**: Not Run

#### TC-E2E-02 — Two near-duplicate reports → cluster of 2

- **Type**: success
- **Steps**:
  1. `POST /reports` with `text="Big pothole"`, `lat=37.3500`, `lng=-121.8800`.
  2. Wait 30 s for AI to complete.
  3. `POST /reports` with `text="Pothole here please fix"`, `lat=37.3501`, `lng=-121.8800` (~ 11 m away).
  4. Wait 30 s.
  5. Inspect both tickets.
- **Expected Result**: Second ticket has `duplicate_of` set to the first ticket's id. Master ticket's `cluster_count == 2` and urgency reflects the cluster.
- **Pass Criteria**: `master.cluster_count == 2` AND `duplicate.duplicate_of == master.id`.
- **Status**: Not Run

#### TC-E2E-03 — P1 keyword bypasses LLM

- **Type**: success
- **Steps**:
  1. `POST /reports` with `text="Fatal accident, road completely blocked"`, `lat=37.3382`, `lng=-121.8863`.
  2. Wait 30 s.
  3. `GET /tickets/<id>`.
- **Expected Result**: `urgency_score >= 4.5`, `urgency_factors.safety_risk >= 0.8`, `ai_reasoning` mentions safety risk.
- **Pass Criteria**: `urgency_score >= 4.5`.
- **Status**: Not Run

#### TC-E2E-04 — Officer dashboard reflects seeded urgency order

- **Type**: success
- **Preconditions**: Seed reset, officer JWT.
- **Steps**:
  1. `GET /tickets?status=open&sort=urgency_score&order=desc` with officer JWT.
- **Expected Result**: First non-resolved ticket is the sinkhole (5.0) or manhole (4.9) or signal (4.8); entire response is sorted desc by `urgency_score`.
- **Pass Criteria**: First row has `urgency_score >= 4.5` AND list is sorted desc.
- **Status**: Not Run

#### TC-E2E-05 — Resolve a ticket end-to-end

- **Type**: success
- **Preconditions**: Seed reset; officer JWT; Twilio configured (or watch logs only).
- **Steps**:
  1. `PATCH /tickets/<sinkhole-uuid>` with `{"resolve": true, "comment": "Repaired and re-paved"}`.
  2. Inspect DB and notification logs.
- **Expected Result**: `tickets.resolved_at IS NOT NULL`. `notify:ticket_resolved` published. SMS sent to `+14085550101` (Alice).
- **Pass Criteria**: `resolved_at IS NOT NULL` AND notifications log shows SMS attempt.
- **Status**: Not Run

---

## 5. Pass / fail summary

Fill this in as you execute the plan.

### Section 4.1 — S1 API Gateway (24 cases)

| TC-ID | Status | Notes |
|-------|--------|-------|
| TC-S1-01 |   |   |
| TC-S1-02 |   |   |
| TC-S1-03 |   |   |
| TC-S1-04 |   |   |
| TC-S1-05 |   |   |
| TC-S1-06 |   |   |
| TC-S1-07 |   |   |
| TC-S1-08 |   |   |
| TC-S1-09 |   |   |
| TC-S1-10 |   |   |
| TC-S1-11 |   |   |
| TC-S1-12 |   |   |
| TC-S1-13 |   |   |
| TC-S1-14 |   |   |
| TC-S1-15 |   |   |
| TC-S1-16 |   |   |
| TC-S1-17 |   |   |
| TC-S1-18 |   |   |
| TC-S1-19 |   |   |
| TC-S1-20 |   |   |
| TC-S1-21 |   |   |
| TC-S1-22 |   |   |
| TC-S1-23 |   |   |
| TC-S1-24 |   |   |

### Section 4.2 — S2 AI Core (23 cases)

| TC-ID | Status | Notes |
|-------|--------|-------|
| TC-S2-01 |   |   |
| TC-S2-02 |   |   |
| TC-S2-03 |   |   |
| TC-S2-04 |   |   |
| TC-S2-05 |   |   |
| TC-S2-06 |   |   |
| TC-S2-07 |   |   |
| TC-S2-08 |   |   |
| TC-S2-09 |   |   |
| TC-S2-10 |   |   |
| TC-S2-11 |   |   |
| TC-S2-12 |   |   |
| TC-S2-13 |   |   |
| TC-S2-14 |   |   |
| TC-S2-15 |   |   |
| TC-S2-16 |   |   |
| TC-S2-17 |   |   |
| TC-S2-18 |   |   |
| TC-S2-19 |   |   |
| TC-S2-20 |   |   |
| TC-S2-21 |   |   |
| TC-S2-22 |   |   |
| TC-S2-23 |   |   |

### Section 4.3 — S3 Worker (8 cases)

| TC-ID | Status | Notes |
|-------|--------|-------|
| TC-S3-01 |   |   |
| TC-S3-02 |   |   |
| TC-S3-03 |   |   |
| TC-S3-04 |   |   |
| TC-S3-05 |   |   |
| TC-S3-06 |   |   |
| TC-S3-07 |   |   |
| TC-S3-08 |   |   |

### Section 4.4 — S5 Notifications (4 cases)

| TC-ID | Status | Notes |
|-------|--------|-------|
| TC-S5-01 |   |   |
| TC-S5-02 |   |   |
| TC-S5-03 |   |   |
| TC-S5-04 |   |   |

### Section 4.5 — Scheduler (4 cases)

| TC-ID | Status | Notes |
|-------|--------|-------|
| TC-S8-01 |   |   |
| TC-S8-02 |   |   |
| TC-S8-03 |   |   |
| TC-S8-04 |   |   |

### Section 4.6 — End-to-end (5 cases)

| TC-ID | Status | Notes |
|-------|--------|-------|
| TC-E2E-01 |   |   |
| TC-E2E-02 |   |   |
| TC-E2E-03 |   |   |
| TC-E2E-04 |   |   |
| TC-E2E-05 |   |   |

### Totals

| Service | Cases | Pass | Fail | Blocked | Not Run |
|---------|-------|------|------|---------|---------|
| S1 — API Gateway | 24 |   |   |   |   |
| S2 — AI Core | 23 |   |   |   |   |
| S3 — Worker | 8 |   |   |   |   |
| S5 — Notifications | 4 |   |   |   |   |
| Scheduler | 4 |   |   |   |   |
| End-to-end | 5 |   |   |   |   |
| **Total** | **68** |   |   |   |   |

---

## 6. Appendix — How the existing pytest tests relate to this plan

The repository already contains automated pytest coverage of the AI Core classify and image-description nodes. They map directly to the test cases below:

| pytest test | Test case |
|-------------|-----------|
| `tests/ai_core/test_image_description.py::test_no_image_skips_gracefully` | TC-S2-01 |
| `tests/ai_core/test_image_description.py::test_successful_description` | TC-S2-02 |
| `tests/ai_core/test_image_description.py::test_image_fetch_failure_handled` | TC-S2-03 |
| `tests/ai_core/test_image_description.py::test_gemini_api_error_handled` | TC-S2-04 |
| `tests/ai_core/test_classify.py::test_pothole_classified_correctly` | TC-S2-05 |
| `tests/ai_core/test_classify.py::test_low_confidence_sets_needs_review` | TC-S2-06 |
| `tests/ai_core/test_classify.py::test_image_text_conflict_sets_needs_review` | TC-S2-07 |
| `tests/ai_core/test_classify.py::test_invalid_code_falls_back_to_OT005` | TC-S2-08 |
| `tests/ai_core/test_classify.py::test_malformed_json_handled` | TC-S2-09 |
| `tests/ai_core/test_classify.py::test_sinkhole_severity_5` | TC-S2-10 |

Run them with:

```bash
pip install -r tests/requirements-dev.txt
pytest tests/ai_core -v
```

Other test cases in this plan are written for manual execution against the live stack. They can be lifted into pytest using the fixtures in `tests/conftest.py` when needed.

---

## 7. Appendix — Known limitations

- Dedup, urgency, and graph end-to-end tests (TC-S2-11 through TC-S2-23) need a live Postgres instance; they are not yet automated.
- TC-E2E-01 through TC-E2E-05 consume real Gemini API quota — keep the test set tight.
- TC-S5-* hit Twilio's real API by default. Disable Twilio creds in `.env` to dry-run; the listener will skip the actual SMS call but the rest of the flow still exercises.
- Scheduler tests assume Gmail SMTP is reachable; behind restricted networks, set `EMAIL_APP_PASSWORD=""` to log-only mode.
