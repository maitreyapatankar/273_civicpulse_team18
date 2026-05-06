# CivicPulse — MVP Architecture
## Overview

CivicPulse is an AI-first urban infrastructure reporting platform. It ingests road issue
reports from citizens and legacy 311 systems, classifies them, deduplicates them,
scores urgency, generates work orders, and surfaces a prioritized queue to municipal
dispatchers.

---

## Service Map

| # | Name | Role | Owner | Port |
|---|------|------|-------|------|
| S1 | API Gateway | Public REST API, auth, ingestion, serve results | Eng 1 | 8000 |
| S2 | AI Core | Pure queue consumer — classify, dedup, score, work order gen | Eng 2 | **none** |
| S3 | Worker | Async job orchestrator — forwards to AI Core, writes DB, retries | Eng 3 | **none** |
| S4 | Frontend | React dispatcher dashboard + citizen status tracker | Eng 4 | 5173 (dev) |
| S5 | Notifications | Redis pub-sub listener, fires Twilio SMS + email | Eng 4 | **none** |
| S6 | Scheduler | Recurring crew assignment daemon (every 15 sec demo, 15 min prod) | Eng 3 | **none** |

**Shared infrastructure:** Postgres 15, Redis 7, AWS S3 / Cloudflare R2.

> **Key design rule:** S1 never calls S2 directly. S2 never exposes HTTP.
> All S1 → S2 → S3 communication is exclusively through Redis queues.
> S3 owns all DB writes. S6 runs independently on a schedule.

---

## Monorepo Structure

```
civicpulse/
├── services/
│   ├── api/                    # Service 1 — FastAPI public gateway
│   │   ├── main.py
│   │   ├── routers/
│   │   │   ├── reports.py      # POST /reports, PATCH /reports/:id
│   │   │   ├── tickets.py      # GET /tickets, GET /tickets/:id/status, GET /citizens/tickets
│   │   │   ├── auth.py         # /auth/* (citizen + officer + admin)
│   │   │   ├── admin.py        # PATCH /tickets/:id (override + crew assign + email notify)
│   │   │   ├── crews.py        # GET /crews, POST /crews, crew management
│   │   │   └── schedule.py     # GET /schedule, view assigned tickets (crew/officer)
│   │   ├── models/             # SQLAlchemy ORM models
│   │   └── schemas/            # Pydantic request/response schemas
│   ├── ai_core/                # Service 2 — pure Celery consumer, NO HTTP server
│   │   ├── consumer.py         # Celery app + run_pipeline task
│   │   ├── taxonomy.json       # 9 categories, 59 subcategory codes
│   │   └── pipeline/
│   │       ├── graph.py        # LangGraph graph — 4 nodes wired together
│   │       ├── state.py        # PipelineState TypedDict + initial_state()
│   │       └── nodes/
│   │           ├── image_description.py
│   │           ├── classify.py
│   │           ├── dedup.py
│   │           └── urgency.py  # P1 detection + LLM scoring node
│   ├── worker/                 # Service 3 — Celery job orchestrator
│   │   ├── celery_app.py
│   │   └── tasks.py            # process_report, handle_ai_result, handle_ai_failure
│   ├── scheduler/              # Service 6 — Recurring crew assignment daemon
│   │   └── scheduler.py        # Poll approved tickets without crew, auto-assign + email notify
│   └── notifications/          # Service 5 — Redis subscriber + Twilio + Email
│       └── listener.py
├── frontend/                   # Service 4 — React + Vite + TypeScript
│   └── src/
│       ├── pages/
│       │   ├── DispatcherDashboard.tsx
│       │   ├── CitizenTracker.tsx
│       │   └── StaffDashboard.tsx    # Assigned tickets + resolved tab + crew suggestion
│       ├── components/
│       └── api/                # typed API client (axios + TanStack Query)
├── shared/                     # shared Python DB connection + models
│   ├── db.py
│   └── models.py
├── alembic/                    # DB migrations (0001–0009)
│   └── versions/
│       ├── ...
│       ├── 0008_add_schedules.py
│       └── 0009_add_crews.py
├── docker-compose.yml          # all 6 services + postgres + redis
└── .env.example
```

---

## Tech Stack

| Layer | Technology | Service | Reason |
|-------|-----------|---------|--------|
| Web framework | FastAPI 0.110 | S1 only | Auto OpenAPI, async, Pydantic built-in |
| Language | Python 3.11 | S1, S2, S3, S5 | One language across backend |
| Async job queue | Celery 5 + Redis | S2, S3 | Both services are pure Celery consumers |
| LLM — all steps | gemini-2.5-flash-lite | S2 | Single model for image description, classification, and urgency scoring |
| ORM | SQLAlchemy 2 + Alembic | S1, S3 | Version-controlled migrations |
| Primary DB | Postgres 15 | infra | JSONB for AI outputs, PostGIS-ready for Phase 2 |
| Cache + broker | Redis 7 | infra | Celery broker + all inter-service queues + pub-sub |
| File storage | Cloudflare R2 / AWS S3 | infra | Pre-signed URLs, R2 = no egress cost |
| Frontend | React 18 + Vite + TypeScript | S4 | Fast dev, TanStack Query for polling |
| Maps | React-Leaflet | S4 | Open source, no API key needed |
| SMS | Twilio SMS API | S5 | Pay-per-SMS, no infra |
| Containers | Docker + docker-compose | all | One command local setup |
| Deployment | Railway or Render | all | Git-push deploy, managed Postgres + Redis |
| Error tracking | Sentry (free tier) | all | 5-minute setup |

---

## Redis Queue Map

All inter-service communication flows through these named queues.

| Queue / Channel | Producer | Consumer | Payload | Purpose |
|-------|----------|----------|---------|---------|
| `reports:process` | S1 API Gateway | S3 Worker | `{report_id}` | New report submitted |
| `ai_core:process` | S3 Worker | S2 AI Core | `{report_id, payload, attempt}` | Forward to AI pipeline |
| `ai_core:results` | S2 AI Core | S3 Worker | `{report_id, enriched_ticket}` | Successful pipeline result |
| `ai_core:failed` | S2 AI Core | S3 Worker | `{report_id, error, attempt}` | Pipeline failure with context |
| `reports:dlq` | S3 Worker | manual / alert | `{report_id, error}` | Exhausted all retries |
| `notify:ticket_ready` | S3 Worker | S5 Notifications (pub-sub) | `{ticket_id, report_id}` | SMS citizen on ticket create |
| `notify:ticket_updated` | S1 API (admin override) | S4 Frontend (SSE) | `{ticket_id, report_id}` | Real-time dashboard refresh on override |
| `notify:ticket_resolved` | S3 Worker OR S1 API | S5 Notifications (pub-sub) | `{ticket_id, report_id}` | SMS citizen on ticket resolve |

---

## Full Data Flow — End to End

```
1. Citizen submits report (text + optional photo + GPS)
        │
        ▼
2. S1 API Gateway
   - Pydantic validation
   - Upload image to S3/R2 (if present), store image_url
   - INSERT raw_reports (status = "queued")
   - LPUSH reports:process {report_id}
   - Return {ticket_id, status: "processing"} immediately
        │
        ▼  (async from here — API is done)
3. S3 Worker — consumes reports:process
   - Fetch raw_report from Postgres
   - UPDATE raw_reports SET status = "processing"
   - LPUSH ai_core:process {report_id, payload, attempt: 0}
        │
        ▼
4. S2 AI Core — consumes ai_core:process
   - Step 1: Image description  (gemini-2.5-flash-lite, skip if no image)
   - Step 2: Classification     (gemini-2.5-flash-lite → category, subcategory, severity, confidence,
                                  image_text_conflict, image_classification_hint)
   - Step 3: Deduplication      (direct Postgres read — subcategory + 100 m geo bbox)
   - Step 4: Urgency scoring    (P1 subcodes/keywords/rate override first, then gemini-2.5-flash-lite)

   On success → LPUSH ai_core:results {report_id, enriched_ticket}
   On failure → LPUSH ai_core:failed  {report_id, error, attempt}
        │
        ▼
5. S3 Worker — consumes ai_core:results
   - INSERT tickets (new) with approved=false, crew_id=null
   - UPDATE raw_reports SET status = "done"
   - PUBLISH notify:ticket_ready {ticket_id} → S5 Notifications
        │
        ▼ (async → dispatcher dashboard)
6. Officer dispatch workflow
   ┌─────────────────────────────────────────────────┐
   │ Officer sees "open" tab: unapproved tickets      │
   │ Clicks ticket → sees detail card + AI reasoning  │
   │ Clicks "Approve" → suggests crew via load balance│
   │ Selects crew from suggestion modal               │
   └─────────────────────────────────────────────────┘
        │
        ▼
7. S1 API — consumes PATCH /tickets/:id
   - UPDATE tickets SET approved=true, crew_id=<selected>, assigned_to=<crew.team_name>, assigned_at=now
   - PUBLISH notify:ticket_updated {ticket_id} → S4 Frontend (SSE)
   - If crew assigned: SEND email to crew.lead_email with issue type, priority, location
        │
        ▼
8. S6 Scheduler — runs every 15 sec (demo) or 900 sec (prod)
   - Query approved tickets without crew: WHERE approved=true AND crew_id IS NULL
   - For each ticket:
     * Load-balance: pick crew with fewest open tickets by department
     * UPDATE tickets SET crew_id=<crew.id>, assigned_to=<crew.team_name>
     * UPDATE tickets SET lifecycle_status='forwarded_to_maintenance'
     * SEND email to crew.lead_email with same template as manual assign
        │
        ▼
9. Officer marks resolved
   - Click "Mark Resolved" on ticket detail → PATCH /tickets/:id {resolve: true}
   - UPDATE tickets SET resolved_at=now
   - PUBLISH notify:ticket_resolved {ticket_id} → S5 Notifications
        │
        ▼
10. S5 Notifications — pub-sub subscriber
    - Receives notify:ticket_ready | notify:ticket_resolved
    - GET /tickets/:id/status from S1 to fetch reporter_phone
    - Twilio SMS → citizen (customized by channel)

11. S4 Frontend — real-time + polling
    - SSE listener: receives notify:ticket_updated → forces refetch /tickets
    - Officer: GET /tickets every 30s; GET /tickets/:id for detail
    - Citizen: GET /citizens/tickets + /citizens/tickets/:id
    - StaffDashboard: filters by assigned crew/officer + shows 4 tabs:
      * "Open" — unapproved tickets
      * "Needs Review" — confidence < 0.70
      * "Pending" — approved AND crew assigned (forwarded_to_maintenance)
      * "Resolved" — resolved_at != null
```

---

## Postgres Schema

```sql
-- Raw incoming reports (written by S1, read/updated by S3)
CREATE TABLE raw_reports (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  citizen_id     UUID REFERENCES citizens(id),
  source         TEXT NOT NULL,          -- 'app' | 'csv' | 'api'
  text           TEXT,
  image_url      TEXT,                   -- S3/R2 object URL
  lat            FLOAT NOT NULL,
  lng            FLOAT NOT NULL,
  address        TEXT,
  reporter_phone TEXT,
  submitted_at   TIMESTAMPTZ DEFAULT NOW(),
  status         TEXT DEFAULT 'queued'   -- queued | processing | done | failed
);

-- AI-enriched tickets (written by S3 after AI pipeline completes)
CREATE TABLE tickets (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_report_id             UUID REFERENCES raw_reports(id),
  issue_type                TEXT,             -- legacy field; category/subcategory preferred
  category_code             TEXT,             -- e.g. RD, DR, TF
  category_name             TEXT,
  subcategory_code          TEXT,             -- e.g. RD-001
  subcategory_name          TEXT,
  severity                  INT,              -- 1-5
  urgency_score             FLOAT,            -- 1.0-5.0
  urgency_factors           JSONB,            -- {safety_risk, traffic_impact, cluster_volume, low_confidence}
  ai_reasoning              TEXT,             -- urgency reasoning sentence shown to dispatcher
  confidence                FLOAT,            -- 0.0-1.0; below 0.70 flags for human review
  image_text_conflict       BOOLEAN DEFAULT FALSE,
  image_classification_hint TEXT,             -- what the image suggests when conflict detected
  needs_review              BOOLEAN DEFAULT FALSE,
  duplicate_of              UUID REFERENCES tickets(id),
  cluster_count             INT DEFAULT 1,
  work_order                JSONB,            -- {crew_type, materials[], est_hours, notes}
  dispatcher_override       BOOLEAN DEFAULT FALSE,
  override_by               TEXT,
  override_at               TIMESTAMPTZ,
  approved                  BOOLEAN DEFAULT FALSE,  -- dispatcher approved this ticket for crew assignment
  crew_id                   UUID REFERENCES crews(id),  -- assigned crew (not officer)
  assigned_to               TEXT,             -- crew team_name; set by crew assignment
  assigned_at               TIMESTAMPTZ,
  resolved_at               TIMESTAMPTZ,
  created_at                TIMESTAMPTZ DEFAULT NOW()
);

-- Work crews for field maintenance (replaces officer-based assignment)
CREATE TABLE crews (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_name      TEXT NOT NULL UNIQUE,   -- "Roads Crew 1", "Drainage Team A"
  crew_type      TEXT NOT NULL,          -- roads | traffic | drainage | structures | operations
  lead_name      TEXT NOT NULL,
  lead_email     TEXT NOT NULL,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE citizens (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL,
  email          TEXT UNIQUE NOT NULL,
  password_hash  TEXT NOT NULL,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE officers (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL,
  email          TEXT UNIQUE NOT NULL,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'officer',  -- officer | admin
  department     TEXT,   -- roads | traffic | drainage | structures | operations
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE ticket_comments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id     UUID REFERENCES tickets(id),
  author_type   TEXT NOT NULL,              -- officer | citizen
  author_id     UUID,
  message       TEXT NOT NULL,
  is_public     BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_tickets_urgency    ON tickets(urgency_score DESC);
CREATE INDEX idx_raw_reports_status ON raw_reports(status);
CREATE INDEX idx_tickets_created    ON tickets(created_at DESC);
```

---

## Service 1 — API Gateway

**Entry point:** `services/api/main.py`
**Framework:** FastAPI
**Responsibilities:** Single public entry point. Validate, persist, enqueue, and serve results.
No AI logic. Never waits for AI to complete — returns immediately after enqueue.

### Endpoints

```
POST   /auth/citizen/signup    Citizen signup (email + password)
POST   /auth/citizen/login     Citizen login → JWT
POST   /auth/officer/login     Officer login → JWT
POST   /auth/officer/provision Admin-only officer provisioning
POST   /auth/login             Bootstrap admin login (env-based)

POST   /reports                Submit report (text + optional image + GPS)
PATCH  /reports/:id            Edit report (re-queues pipeline)
POST   /reports/batch-csv      Bulk import from 311 CSV

GET    /tickets                Paginated list (officer/admin)
GET    /tickets/:id            Ticket detail (officer/admin)
GET    /tickets/:id/status     Public status check (citizen tracker + S5)
PATCH  /tickets/:id            Officer override + department update

GET    /citizens/tickets        List citizen reports
GET    /citizens/tickets/:id    Citizen report detail + department updates

GET    /health
```

### POST /reports — request flow

```
Client
  → Pydantic validation (text or image required, lat/lng required)
  → If image: upload to S3/R2 via pre-signed PUT, store image_url
  → INSERT raw_reports (status = "queued")
  → LPUSH reports:process {report_id}
  → return HTTP 202 {ticket_id, status: "processing"}  ← never blocks on AI
```

### Auth

JWT (`HS256`). Required on:
- `POST /auth/officer/provision` (admin)
- `GET /tickets`, `GET /tickets/:id`, `PATCH /tickets/:id` (officer/admin)

Public (no auth):
- `POST /reports`
- `GET /tickets/:id/status`

### Environment variables

```env
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
S3_BUCKET=civicpulse-reports
S3_REGION=us-east-1
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
OFFICER_JWT_SECRET=...
ADMIN_USERNAME=admin
ADMIN_PASSWORD=adminP
```

---

## Service 2 — AI Core

**Entry point:** `services/ai_core/consumer.py`
**Framework:** Celery only. NO FastAPI. NO HTTP server. NO exposed port.
**Responsibilities:** Consume from `ai_core:process`, run the 5-step pipeline,
publish to `ai_core:results` on success or `ai_core:failed` on failure.
Reads Postgres (read-only) for deduplication. Never writes to Postgres — S3 owns all writes.

### Celery consumer

```python
# services/ai_core/consumer.py

@celery_app.task(
    bind=True,
    queue="ai_core:process",
    max_retries=0        # retry logic is owned by S3 Worker, not here
)
def run_pipeline(self, report_id: str, payload: dict):
    try:
        result = pipeline.run(payload)   # all 5 steps

        celery_app.send_task(
            "worker.tasks.handle_ai_result",
            args=[report_id, result],
            queue="ai_core:results"
        )

    except Exception as exc:
        attempt = payload.get("attempt", 0)
        celery_app.send_task(
            "worker.tasks.handle_ai_failure",
            args=[report_id, str(exc), attempt],
            queue="ai_core:failed"
        )
        # do NOT re-raise — retry decision belongs to S3 Worker
```

### Pipeline — 4 nodes in sequence (LangGraph)

```
payload: {report_id, text, image_url, lat, lng, address, attempt}
   │
   ▼
Node 1 — image_description          (skip if no image_url)
  Model  : gemini-2.5-flash-lite (multimodal)
  Output : image_desc string → appended to context for Node 2
   │
   ▼
Node 2 — classify
  Model  : gemini-2.5-flash-lite
  Output : {category_code, subcategory_code, severity 1-5, confidence 0-1,
            reasoning, image_text_conflict, image_classification_hint}
  Gate   : confidence < 0.70 OR image_text_conflict → needs_review = true
   │
   ▼  (conditional: needs_review → flag_review node → back to main path)
Node 3 — dedup
  Method : direct Postgres read-only SELECT — subcategory_code + ±0.0009° geo bbox (~100 m)
  Match  : open, non-duplicate ticket found → is_duplicate=true, master_ticket_id set,
           cluster_rate_per_hour computed from master ticket created_at
  No match → is_duplicate=false, cluster_rate_per_hour=0.0
   │
   ▼
Node 4 — urgency_score              (runs for ALL tickets including duplicates)
  Tier 1 : P1 override (zero tokens) — checked in order:
             a. subcategory code in P1 set (RD-006, TF-002, ST-004, DR-003, …)
             b. keyword scan across text + image_desc
             c. cluster_rate_per_hour ≥ 3 reports/hour
  Tier 2 : gemini-2.5-flash-lite (only if no P1 trigger fires)
  Context: subcategory, severity, confidence, cluster_count, cluster_rate_per_hour,
           address, text, image_desc, classifier reasoning, conflict hint
  Factors: safety_risk (0.45), traffic_impact (0.30),
           cluster_volume (0.20), low_confidence (0.05)
  Output : {urgency_score 1-5, urgency_factors{…}, urgency_reasoning}
  Post   : severity=5 floor (score≥4); needs_review cap (score≤4 unless P1)
   │
   ▼
EnrichedTicket dict → LPUSH ai_core:results
```

### Classification prompt

See `services/ai_core/pipeline/nodes/classify.py` — `CLASSIFIER_SYSTEM_PROMPT`.
Outputs: `category_code`, `subcategory_code`, `severity`, `confidence`, `reasoning`,
`image_text_conflict`, `image_classification_hint`.

### Urgency scoring prompt

See `services/ai_core/pipeline/nodes/urgency.py` — `_SYSTEM` and `_build_user_msg()`.
Factors: `safety_risk` (0.45), `traffic_impact` (0.30), `cluster_volume` (0.20), `low_confidence` (0.05).
Inputs include `cluster_rate_per_hour` so the LLM can weight a fast-growing cluster more heavily.

### Deduplication logic

Direct Postgres read — no embeddings, no vector DB.

```python
# services/ai_core/pipeline/nodes/dedup.py
#
# Match criteria (all must hold):
#   1. Same subcategory_code  (set by classify node)
#   2. Ticket is open         (resolved_at IS NULL)
#   3. Ticket is not itself a duplicate (duplicate_of IS NULL)
#   4. Raw report lat/lng within ~100 m (±0.0009°)
#
# Fails open: if the query errors, the report continues as non-duplicate.

SELECT t.id, t.cluster_count
FROM   tickets t
JOIN   raw_reports r ON r.id = t.raw_report_id
WHERE  t.subcategory_code = %s
  AND  t.resolved_at   IS NULL
  AND  t.duplicate_of  IS NULL
  AND  r.id            != %s          -- exclude current report (retry safety)
  AND  ABS(r.lat - %s) < 0.0009
  AND  ABS(r.lng - %s) < 0.0009
ORDER  BY t.created_at DESC
LIMIT  1

# Match found  → is_duplicate=True,  master_ticket_id=<id>, cluster_count += 1
# No match     → is_duplicate=False, proceed to urgency scoring
# Query error  → is_duplicate=False  (fail open, log warning)
```

Graph routing: all tickets (including duplicates) proceed to urgency_score.
For duplicates, the re-scored urgency is propagated back to the master ticket
so the dispatcher queue reflects the updated cluster weight.

### Environment variables

```env
GEMINI_API_KEY=...
REDIS_URL=redis://...
DATABASE_URL=postgresql://...   # read-only for dedup; S3 still owns all writes
```

---

## Service 3 — Worker

**Entry point:** `services/worker/tasks.py`
**Framework:** Celery 5
**Responsibilities:** Full async lifecycle orchestration. Owns all DB writes.
Owns all retry decisions. Consumes three queues. Auto-assigns tickets to officers.

### Three Celery tasks

```python
# services/worker/tasks.py

# ── Task 1 ──────────────────────────────────────────────────────────────────
# Queue: reports:process  |  Producer: S1

@celery_app.task(bind=True, queue="reports:process")
def process_report(self, report_id: str):
    with get_db() as db:
        report = db.get(RawReport, report_id)
        report.status = "processing"
        db.commit()
        payload = report.to_dict()

    payload["attempt"] = 0
    celery_app.send_task(
        "ai_core.consumer.run_pipeline",
        args=[report_id, payload],
        queue="ai_core:process"
    )


# ── Task 2 ──────────────────────────────────────────────────────────────────
# Queue: ai_core:results  |  Producer: S2 (success path)

@celery_app.task(queue="ai_core:results")
def handle_ai_result(report_id: str, enriched: dict):
    with get_db() as db:
        ticket = Ticket(**enriched, raw_report_id=report_id)
        db.add(ticket)
        db.query(RawReport).filter_by(id=report_id) \
            .update({"status": "done"})
        db.commit()
        ticket_id = str(ticket.id)

    redis_client.publish("notify:ticket_ready", ticket_id)


# ── Task 3 ──────────────────────────────────────────────────────────────────
# Queue: ai_core:failed  |  Producer: S2 (failure path)

@celery_app.task(queue="ai_core:failed")
def handle_ai_failure(report_id: str, error: str, attempt: int):
    if attempt < 3:
        payload = fetch_raw_payload(report_id)
        payload["attempt"] = attempt + 1

        celery_app.send_task(
            "ai_core.consumer.run_pipeline",
            args=[report_id, payload],
            queue="ai_core:process",
            countdown=2 ** attempt          # 1s → 2s → 4s
        )
    else:
        with get_db() as db:
            db.query(RawReport).filter_by(id=report_id) \
                .update({"status": "failed"})
            db.commit()

        celery_app.send_task(
            "worker.tasks.dlq_alert",
            args=[report_id, error],
            queue="reports:dlq"
        )
```

### Retry strategy

| Attempt | Countdown | Cumulative wait |
|---------|-----------|-----------------|
| 0 → 1 | 1s | 1s |
| 1 → 2 | 2s | 3s |
| 2 → 3 | 4s | 7s |
| 3 | → DLQ | — |

### Environment variables

```env
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
```

---

## Service 4 — Frontend

**Entry point:** `frontend/src/main.tsx`
**Framework:** React 18 + Vite + TypeScript
**Libraries:** TanStack Query, React-Leaflet, Tailwind CSS

### Routes

| Path | Page | Auth | Purpose |
|------|------|------|---------|
| `/` | Landing | public | Home page + entry points |
| `/report` | CitizenDashboard | public | Anonymous report submission with map picker |
| `/report/:ticketId` | CitizenDashboard | public | Post-submission confirmation + status |
| `/track/:ticketId` | CitizenTracker | public | Ticket status tracker |
| `/officer/login` | OfficerLogin | public | Officer / admin login |
| `/officer/signup` | OfficerSignup | public | Officer self-registration |
| `/officer/dashboard` | DispatcherDashboard | JWT | Full dispatcher queue + map + overrides |
| `/staff` | StaffDashboard | JWT | Assigned-ticket review panel for field staff |

**DispatcherDashboard** (`/officer/dashboard`)
- Priority queue sorted by `urgency_score DESC`
- Per-ticket detail panel: customer submission (text + photo), AI urgency reasoning, urgency factor bars, map pin
- Tabs:
  * "Open" — unapproved tickets (approved=false)
  * "Needs Review" — confidence < 0.70 or image_text_conflict
  * "Pending" — approved AND crew assigned (forwarded_to_maintenance state)
  * "Resolved" — resolved_at IS NOT NULL
- Actions: approve / suggest crew / override priority / mark resolved
- Crew suggestion modal: load-balances and proposes crew by department (same algorithm as Scheduler)
- SSE realtime updates via Redis pub-sub (`notify:ticket_updated` channel)

**StaffDashboard** (`/staff`) — for assigned crew members
- Shows only tickets assigned to the logged-in crew
- Filters by crew_type and assigned crew (load from `/schedule` endpoint)
- Tabs:
  * "Open" — unapproved tickets (approved=false)
  * "Needs Review" — confidence < 0.70
  * "Pending" — approved AND crew assigned (forwarded_to_maintenance)
  * "Resolved" — resolved_at IS NOT NULL
- Per-ticket detail card: vertical layout with sections:
  1. AI Reasoning + factors (top)
  2. Officer Approval button (blue, prominent) → triggers crew suggestion modal
  3. Crew Assignment (shows selected crew after approval)
  4. Customer Report (text + photo)
  5. Work Order (materials, estimated hours)
  6. Activity Log (comments)
  7. Metadata footer (category, severity, confidence)
- Resolution button (Mark Resolved) only visible for pending tickets

**CitizenDashboard** (`/report`)
- Anonymous report form: title, description, address search, map click to pin location (geolocation on load), optional photo
- Post-submission: confirmation with ticket ID and live status polling

**CitizenTracker** (`/track/:ticketId`)
- Public status page: derived lifecycle status (queued → processing → open → approved → forwarded_to_maintenance → resolved)
- Department updates visible to citizen

### Data fetching

```typescript
// Dispatcher — polls every 30s
const { data: tickets } = useQuery({
  queryKey: ['tickets', filters],
  queryFn: () => api.get('/tickets?status=open&sort=urgency_score'),
  refetchInterval: 30_000
})

// Citizen — polls until done
const { data: ticket } = useQuery({
  queryKey: ['ticket', ticketId],
  queryFn: () => api.get(`/tickets/${ticketId}/status`),
  refetchInterval: (data) => data?.status === 'resolved' ? false : 10_000
})

// Dispatcher override
const override = useMutation({
  mutationFn: (data) => api.patch(`/tickets/${id}`, data),
  onSuccess: () => queryClient.invalidateQueries(['tickets'])
})
```

### Environment variables

```env
VITE_API_BASE_URL=https://api.civicpulse.city
```

---

## Service 5 — Notifications

**Entry point:** `services/notifications/listener.py`
**Framework:** none — plain Python Redis pub-sub loop
**Responsibilities:** Subscribe to events, fire Twilio SMS. Stateless.

```python
r = redis.Redis.from_url(REDIS_URL)
pubsub = r.pubsub()
pubsub.subscribe("notify:ticket_ready", "notify:ticket_resolved")

for message in pubsub.listen():
    if message["type"] != "message":
        continue

    ticket_id = message["data"].decode()
    ticket = httpx.get(f"{API_BASE_URL}/tickets/{ticket_id}/status").json()

    if not ticket.get("reporter_phone"):
        continue

    templates = {
        "notify:ticket_ready":
            f"CivicPulse: Report #{ticket_id[:8]} received. "
            f"Priority: {ticket['urgency_score']:.0f}/5. We'll keep you updated.",
        "notify:ticket_resolved":
            f"CivicPulse: Report #{ticket_id[:8]} has been resolved. Thank you."
    }

    twilio_client.messages.create(
        to=ticket["reporter_phone"],
        from_=TWILIO_FROM_NUMBER,
        body=templates[message["channel"].decode()]
    )
```

### Email notifications (crew lead assignment alerts)

When a crew is assigned to a ticket (manually via dispatcher or auto by scheduler), the crew lead receives an email:

```
Subject: CivicPulse: New ticket assigned to {team_name}

Hi {lead_name},

A ticket has been assigned to your crew ({team_name}).

  Issue   : {subcategory_name or issue_type}
  Priority: P{urgency_score}/5
  Location: {address}

Log in to CivicPulse to view the full schedule:
http://localhost:5173/officer/schedule
```

### Environment variables

```env
REDIS_URL=redis://...
API_BASE_URL=http://api:8000
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM_NUMBER=+1...
EMAIL_ADDRESS=noreply@civicpulse.gov
EMAIL_APP_PASSWORD=<Gmail App Password>
```

---

## Service 6 — Scheduler

**Entry point:** `services/scheduler/scheduler.py`
**Framework:** Pure Python polling loop with SQLAlchemy
**Responsibilities:** Recurring crew assignment for approved tickets. Runs on a schedule (15 sec demo, 900 sec = 15 min production).
Reads Postgres (approved tickets without crew), assigns to best crew by load balance, sends email to crew lead.

### Main loop

```python
# services/scheduler/scheduler.py

import os
import time
from datetime import datetime, timezone
from shared.db import get_db
from shared.models import Ticket, Crew
from services.api.routers.admin import _email_crew_lead, _suggest_crew

SCHEDULER_INTERVAL = int(os.environ.get("SCHEDULER_INTERVAL", 900))

while True:
    try:
        with get_db() as db:
            # Find approved tickets without crew assignment
            pending = db.query(Ticket)\
                .filter(Ticket.approved == True)\
                .filter(Ticket.crew_id.is_(None))\
                .all()

            for ticket in pending:
                # Suggest best crew by department + load balance
                suggested = _suggest_crew(db, ticket)
                if not suggested:
                    continue

                # Assign crew
                ticket.crew_id = suggested.id
                ticket.assigned_to = suggested.team_name
                ticket.assigned_at = datetime.now(timezone.utc)
                db.commit()

                # Send email to crew lead in background
                raw = db.get(RawReport, ticket.raw_report_id)
                address = raw.address if raw else None

                try:
                    _email_crew_lead(suggested, ticket, address)
                except Exception as exc:
                    log.warning("Failed to notify crew lead: %s", exc)

    except Exception as exc:
        log.error("Scheduler error: %s", exc)

    time.sleep(SCHEDULER_INTERVAL)
```

### Load-balancing algorithm

Same as Worker and Admin API (line 78-97 in `services/api/routers/admin.py`):

1. Map ticket `category_code` prefix to department (RD → roads, TF → traffic, etc.)
2. Query all crews of that department type
3. For each crew, count open unresolved tickets: `WHERE assigned_to=crew.team_name AND resolved_at IS NULL`
4. Pick crew with **fewest open tickets**

Ensures tickets are distributed evenly across crews in a department.

### Environment variables

```env
SCHEDULER_INTERVAL=15       # seconds (demo); 900 for 15-min production schedule
LOG_LEVEL=INFO              # DEBUG | INFO | WARNING | ERROR
DATABASE_URL=postgresql://...
EMAIL_ADDRESS=noreply@civicpulse.gov
EMAIL_APP_PASSWORD=<Gmail App Password>
```

---

## Docker Compose

```yaml
version: "3.9"

services:
  postgres:
    image: postgres:15
    environment:
      POSTGRES_DB: civicpulse
      POSTGRES_USER: civic
      POSTGRES_PASSWORD: civic
    ports: ["5432:5432"]
    volumes: ["pgdata:/var/lib/postgresql/data"]

  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]

  api:
    build: ./services/api
    ports: ["8000:8000"]
    depends_on: [postgres, redis]
    env_file: .env

  ai_core:
    build: ./services/ai_core
    command: celery -A consumer worker --concurrency=4 -Q ai_core:process
    depends_on: [redis, postgres]
    env_file: .env
    # No ports — pure queue consumer, no HTTP server

  worker:
    build: ./services/worker
    command: >
      celery -A tasks worker --concurrency=4
      -Q reports:process,ai_core:results,ai_core:failed
    depends_on: [redis, postgres]
    env_file: .env
    # No ports — pure queue consumer

  notifications:
    build: ./services/notifications
    depends_on: [redis]
    env_file: .env
    # No ports — pure pub-sub listener

  scheduler:
    build:
      context: .
      dockerfile: services/scheduler/Dockerfile
    command: python -u scheduler.py
    depends_on: [postgres, redis]
    env_file: .env
    # No ports — pure daemon, no HTTP server

  frontend:
    build: ./frontend
    ports: ["5173:5173"]
    environment:
      VITE_API_BASE_URL: http://localhost:8000

volumes:
  pgdata:
```

---

## Inter-Service Communication — Complete Map

```
External clients (browser, mobile app, 311 CSV)
  │
  │  REST HTTP (public, port 8000)
  ▼
S1 API Gateway
  │
  ├─ POST /reports → LPUSH reports:process ──────────────────────┐
  │                                                               │
  └─ PATCH /tickets/:id → PUBLISH notify:ticket_updated ─┐      │
                                                          │      │
                                                          ▼      ▼
                                                       S3 Worker
                                                          │
                                                          │  LPUSH ai_core:process
                                                          ▼
                                                       S2 AI Core
                                                       (read-only DB for dedup)
                                                          │
                                                ┌─────────┴──────────┐
                                                │                    │
                              on success        │      on failure    │
                              LPUSH ai_core:    │      LPUSH ai_core:│
                              results           │      failed        │
                                                │                    │
                                                ▼                    ▼
                                           S3 Worker consumes both channels
                                                │
                              ┌─────────────────┴──────────────────┐
                              │                                    │
                         success path                         failure path
                         INSERT tickets                       attempt < 3?
                         UPDATE status=done                   → re-enqueue backoff
                         PUBLISH notify:ticket_ready          attempt >= 3?
                              │                               → DLQ + status=failed
                              ▼
                         S5 Notifications (pub-sub)
                         ├─ notify:ticket_ready
                         ├─ notify:ticket_updated (from S1 override)
                         └─ notify:ticket_resolved
                              │
                         Twilio SMS → Citizen
                              

S6 Scheduler (every 15s/900s)
  │
  └─ Query approved tickets without crew
     UPDATE crew_id + email crew lead
     (runs independently on schedule)
       │
       └─ SEND email to crew leads


S4 Frontend
  ├─ SSE listener → notify:ticket_updated → forces refetch
  ├─ REST polling → GET /tickets every 30s
  └─ REST API → S1 only (all reads & writes)
```

---

## Ticket Lifecycle Status — Computed, Not Stored

**Key principle:** Ticket status is **derived on-read**, not stored in the database. This eliminates state machine bugs and keeps the source of truth in three Boolean fields.

### Status computation

```python
def derive_status(raw_status: str, ticket: Ticket) -> str:
    """Citizen-facing lifecycle status from raw_report + ticket fields.
    
    Order of checks matters: failed beats everything; resolved beats in_progress;
    forwarded_to_maintenance requires BOTH approved=true AND crew assigned;
    pre-AI states (queued/processing) win when no ticket has been created yet.
    """
    if raw_status == "failed":
        return "failed"
    if raw_status in ("queued", "processing") and not ticket:
        return raw_status or "queued"
    if ticket and ticket.resolved_at:
        return "resolved"
    # Only forwarded_to_maintenance if BOTH approved AND crew_id set
    if ticket and ticket.approved and ticket.crew_id:
        return "forwarded_to_maintenance"
    if ticket and ticket.approved:
        return "approved"
    if ticket:
        return "open"
    return raw_status or "queued"
```

### State transition matrix

| From | To | Trigger | Who | Precondition |
|------|-----|---------|-----|--------------|
| queued | processing | AI pipeline starts | Worker | raw_reports.status = "processing" |
| processing | open | Ticket created | Worker (S3) | INSERT tickets; S2 success |
| open | needs_review | CI<0.70 or conflict | S2 AI Core | confidence < 0.70 or image_text_conflict |
| open/needs_review | approved | Officer approves | S1 API (PATCH) | Dispatcher clicks "Approve" |
| approved | forwarded_to_maintenance | Crew assigned | Scheduler OR S1 API | crew_id set AND approved=true |
| forwarded_to_maintenance | resolved | Officer marks done | S1 API (PATCH) | Dispatcher clicks "Mark Resolved" |
| any | failed | Exhausted retries | Worker | attempt >= 3 in ai_core:failed |

### Backend filtering

**GET /tickets** (S1 API) supports these status filters:

- `status=open`: `resolved_at IS NULL AND crew_id IS NULL` → dispatcher sees unassigned open queue
- `status=all`: all tickets (both resolved and unresolved) → frontend does client-side tab filtering
- `status=resolved`: `resolved_at IS NOT NULL` → resolved tickets tab

**Frontend filtering** (StaffDashboard) from `/tickets?status=all`:

- "Open" tab: `!t.resolved_at && !t.approved` → unapproved tickets
- "Needs Review" tab: `!t.resolved_at && t.needs_review` → confidence < 0.70
- "Pending" tab: `!t.resolved_at && t.approved && t.crew_id` → forwarded_to_maintenance
- "Resolved" tab: `t.resolved_at` → resolved tickets

---

## Decisions Log

| Decision | Choice | Reason |
|----------|--------|--------|
| S2 has no HTTP server | Pure Celery consumer | Eliminates 30s synchronous wait; S2 scales independently of S3 |
| Retry logic owned by S3, not S2 | Worker decides retries | S2 stays stateless; single place to change retry policy |
| S2 reads Postgres for dedup only | Read-only SELECT in dedup node | Subcategory + geo bbox match is deterministic and needs no external service; S3 still owns all writes |
| S2 never writes Postgres | Results go via queue to S3 | Single-writer pattern avoids concurrent write conflicts; S2 stays independently scalable |
| S1 returns 202 immediately | Never waits for AI | API p99 latency under 200ms regardless of LLM latency |
| Confidence gate at 0.70 | Human review below threshold | Safe starting point; tune down as accuracy data accumulates |
| P1 keyword override before LLM | Deterministic safety net | Zero latency, zero tokens, zero hallucination on safety-critical cases |
| Dedup via subcategory + 100 m geo bbox | Direct Postgres JOIN | Subcategory from classify node + required lat/lng fields make a reliable signal without any ML; fail-open on query error |
| Urgency scored for duplicates too | Unconditional edge dedup → urgency | Master ticket urgency is updated as the cluster grows; dispatcher sees live priority |
| gemini-2.5-flash-lite for all LLM steps | Single lightweight model | Handles vision + classification + urgency — one key, one client, lower cost per call |
| Ticket status lifecycle not stored | Derived from resolved_at, approved, crew_id | Eliminates state machine bugs; truth is in 3 boolean fields; status computed on-read |
| Crew-based assignment, not officer-based | Crews table with team_name, lead_email | Separates dispatch (officer) from execution (crew); enables email to crew lead on assignment |
| Approval separate from crew assignment | tickets.approved Boolean field | Officer approves ticket first, then scheduler/dispatcher assigns crew; two independent decisions |
| Recurring crew assignment via S6 Scheduler | Separate daemon polling every 15s (demo) | Better than event-driven for this pattern; avoids race conditions; decouples from dispatcher UI |
| Load-balancing algorithm in 3 places | Worker + Admin API + Scheduler all use same logic | Consistency across auto-assign, manual override suggest, and scheduler; always routes by department + fewest open |
| Email to crew on assignment | SMTP via Gmail App Password | Notifies crew lead immediately when dispatcher or scheduler assigns work; crew lead knows before checking system |
| notify:ticket_updated pub-sub channel | S1 publishes on override, S4 frontend SSE listens | Enables real-time dashboard refresh without polling /tickets; officer sees updates from other dispatchers instantly |
| Monorepo | Single repo, multiple service folders | Shared models + one docker-compose + simpler CI for a 4-person team |

---
