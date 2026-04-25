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
| S5 | Notifications | Redis pub-sub listener, fires Twilio SMS | Eng 4 (week 2) | **none** |

**Shared infrastructure:** Postgres 15, Redis 7, Pinecone (free tier), AWS S3 / Cloudflare R2.

> **Key design rule:** S1 never calls S2 directly. S2 never exposes HTTP.
> All S1 → S2 → S3 communication is exclusively through Redis queues.

---

## Monorepo Structure

```
civicpulse/
├── services/
│   ├── api/                    # Service 1 — FastAPI public gateway
│   │   ├── main.py
│   │   ├── routers/
│   │   │   ├── reports.py      # POST /reports, POST /reports/batch-csv
│   │   │   ├── tickets.py      # GET /tickets, GET /tickets/:id/status
│   │   │   └── admin.py        # PATCH /tickets/:id/override
│   │   ├── models/             # SQLAlchemy ORM models
│   │   └── schemas/            # Pydantic request/response schemas
│   ├── ai_core/                # Service 2 — pure Celery consumer, NO HTTP server
│   │   ├── consumer.py         # Celery app + run_pipeline task
│   │   ├── pipeline/
│   │   │   ├── classify.py
│   │   │   ├── dedup.py
│   │   │   ├── urgency.py
│   │   │   └── workorder.py
│   │   └── prompts/            # prompt templates as .txt files
│   ├── worker/                 # Service 3 — Celery job orchestrator
│   │   ├── celery_app.py
│   │   └── tasks.py            # process_report, handle_ai_result, handle_ai_failure
│   └── notifications/          # Service 5 — Redis subscriber + Twilio
│       └── listener.py
├── frontend/                   # Service 4 — React + Vite + TypeScript
│   └── src/
│       ├── pages/
│       │   ├── DispatcherDashboard.tsx
│       │   └── CitizenTracker.tsx
│       ├── components/
│       └── api/                # typed API client (axios + TanStack Query)
├── shared/                     # shared Python DB connection + models
│   ├── db.py
│   └── models.py
├── alembic/                    # DB migrations
├── docker-compose.yml          # all 5 services + postgres + redis
└── .env.example
```

---

## Tech Stack

| Layer | Technology | Service | Reason |
|-------|-----------|---------|--------|
| Web framework | FastAPI 0.110 | S1 only | Auto OpenAPI, async, Pydantic built-in |
| Language | Python 3.11 | S1, S2, S3, S5 | One language across backend |
| Async job queue | Celery 5 + Redis | S2, S3 | Both services are pure Celery consumers |
| LLM — reasoning | claude-sonnet-4-5 | S2 | Best structured output for classify + score |
| LLM — vision | claude-haiku-4-5 | S2 | 5x cheaper than Sonnet for image description |
| Embeddings | text-embedding-3-small | S2 | Fast, cheap, 1536-dim, sufficient for dedup |
| Vector DB | Pinecone (free tier) | S2 | Managed, geo-filter support, zero infra |
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

| Queue | Producer | Consumer | Payload | Purpose |
|-------|----------|----------|---------|---------|
| `reports:process` | S1 API Gateway | S3 Worker | `{report_id}` | New report submitted |
| `ai_core:process` | S3 Worker | S2 AI Core | `{report_id, payload, attempt}` | Forward to AI pipeline |
| `ai_core:results` | S2 AI Core | S3 Worker | `{report_id, enriched_ticket}` | Successful pipeline result |
| `ai_core:failed` | S2 AI Core | S3 Worker | `{report_id, error, attempt}` | Pipeline failure with context |
| `reports:dlq` | S3 Worker | manual / alert | `{report_id, error}` | Exhausted all retries |
| `notify:ticket_ready` | S3 Worker | S5 Notifications | `{ticket_id}` | pub-sub: SMS citizen on create |
| `notify:ticket_resolved` | S3 Worker | S5 Notifications | `{ticket_id}` | pub-sub: SMS citizen on resolve |

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
   - Step 1: Image description  (claude-haiku-4-5, skip if no image)
   - Step 2: Classification     (claude-sonnet-4-5 → structured JSON)
   - Step 3: Deduplication      (text-embedding-3-small → Pinecone ANN)
   - Step 4: Urgency scoring    (keyword rule first, then claude-sonnet-4-5)
   - Step 5: Work order gen     (claude-sonnet-4-5)

   On success → LPUSH ai_core:results {report_id, enriched_ticket}
   On failure → LPUSH ai_core:failed  {report_id, error, attempt}
        │
        ▼
5. S3 Worker — consumes ai_core:results
   - INSERT tickets (enriched data)
   - UPDATE raw_reports SET status = "done"
   - PUBLISH notify:ticket_ready {ticket_id}

   OR consumes ai_core:failed
   - attempt < 3 → re-LPUSH ai_core:process with exponential backoff
   - attempt >= 3 → UPDATE status = "failed", LPUSH reports:dlq
        │
        ▼
6. S5 Notifications — pub-sub subscriber
   - Receives notify:ticket_ready
   - GET /tickets/:id/status from S1 to fetch reporter_phone
   - Twilio SMS → citizen

7. S4 Frontend — polls S1 API
   - Dispatcher: GET /tickets every 30s
   - Citizen:    GET /tickets/:id/status every 10s until resolved
```

---

## Postgres Schema

```sql
-- Raw incoming reports (written by S1, read/updated by S3)
CREATE TABLE raw_reports (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_report_id        UUID REFERENCES raw_reports(id),
  issue_type           TEXT,             -- pothole | flooding | sinkhole | crack | sign_damage | other
  severity             INT,              -- 1-5
  urgency_score        FLOAT,            -- 1.0-5.0
  urgency_factors      JSONB,            -- {safety_risk, traffic_impact, cluster_volume, days_open}
  ai_reasoning         TEXT,             -- one sentence shown to dispatcher
  confidence           FLOAT,            -- 0.0-1.0; below 0.70 flags for human review
  duplicate_of         UUID REFERENCES tickets(id),
  cluster_count        INT DEFAULT 1,    -- reports merged into this ticket
  work_order           JSONB,            -- {crew_type, materials[], est_hours, notes}
  dispatcher_override  BOOLEAN DEFAULT FALSE,
  override_by          TEXT,             -- dispatcher user id
  override_at          TIMESTAMPTZ,
  resolved_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ DEFAULT NOW()
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
POST   /reports               Submit report (text + optional image + GPS)
POST   /reports/batch-csv     Bulk import from 311 CSV
GET    /tickets               Paginated list, sorted by urgency_score DESC
GET    /tickets/:id/status    Public status check (for citizen tracker + S5)
PATCH  /tickets/:id           Dispatcher override (JWT auth required)
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

JWT (`HS256`, shared secret). Required on:
- `PATCH /tickets/:id` (dispatcher override)
- `GET /tickets` (dispatcher dashboard)

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
JWT_SECRET=...
```

---

## Service 2 — AI Core

**Entry point:** `services/ai_core/consumer.py`
**Framework:** Celery only. NO FastAPI. NO HTTP server. NO exposed port.
**Responsibilities:** Consume from `ai_core:process`, run the 5-step pipeline,
publish to `ai_core:results` on success or `ai_core:failed` on failure.
Never reads or writes Postgres directly — fully stateless.

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

### Pipeline — 5 steps in sequence

```
payload: {report_id, text, image_url, lat, lng, address, attempt}
   │
   ▼
Step 1 — Image description          (skip if no image_url)
  Model  : claude-haiku-4-5 (vision)
  Prompt : "Describe visible road damage in this photo. One paragraph."
  Output : image_desc string → appended to text context for Step 2
   │
   ▼
Step 2 — Classification
  Model  : claude-sonnet-4-5
  Output : {issue_type, severity 1-5, confidence 0-1, reasoning}
  Gate   : confidence < 0.70 → flag ticket for human review
   │
   ▼
Step 3 — Deduplication
  Model  : text-embedding-3-small → Pinecone ANN
  Filter : 500m geo bbox (lat ±0.005, lng ±0.005), last 30 days
  Match  : cosine > 0.88 → is_duplicate = true, set duplicate_of
           no match → upsert new vector to Pinecone
   │
   ▼
Step 4 — Urgency scoring
  First  : P1 keyword rule override (zero tokens)
           keywords: sinkhole, collapse, flooding, live wire, gas leak,
                     bridge, guardrail, car fell, ambulance blocked
  Model  : claude-sonnet-4-5 (only if no keyword match)
  Output : {score 1-5, factors{safety_risk, traffic_impact,
            cluster_volume, days_open}, reasoning}
   │
   ▼
Step 5 — Work order generation
  Model  : claude-sonnet-4-5
  Output : {crew_type, materials[], est_hours, notes}
   │
   ▼
EnrichedTicket dict → LPUSH ai_core:results
```

### Classification prompt

```python
SYSTEM = """You are a municipal infrastructure classifier for a city maintenance department.
Classify the road issue report below. Respond ONLY with valid JSON — no explanation,
no markdown, no preamble. Match this exact schema:

{
  "issue_type": "pothole" | "flooding" | "sinkhole" | "crack" | "sign_damage" | "other",
  "severity": 1 | 2 | 3 | 4 | 5,
  "confidence": <float 0.0-1.0>,
  "reasoning": "<one sentence>"
}

Severity scale:
1 = cosmetic, no safety risk
2 = minor inconvenience
3 = moderate — affects traffic flow
4 = serious — safety risk to vehicles
5 = critical — immediate danger, possible injury"""

USER = """Location: {address}
Report text: "{text}"
{f'Image description: {image_desc}' if image_desc else ''}"""
```

### Urgency scoring prompt

```python
SYSTEM = """You score road issue urgency for a city maintenance department.
Respond ONLY with valid JSON matching this schema:

{
  "score": 1 | 2 | 3 | 4 | 5,
  "factors": {
    "safety_risk":    <float 0-1>,
    "traffic_impact": <float 0-1>,
    "cluster_volume": <float 0-1>,
    "days_unresolved":<float 0-1>
  },
  "reasoning": "<one sentence shown to dispatcher>"
}

Scoring weights: safety_risk 0.4, traffic_impact 0.3,
                 cluster_volume 0.2, days_unresolved 0.1"""

USER = """Issue type: {issue_type}
Severity: {severity}/5
Reports in cluster: {cluster_count}
Days since first report: {days_open}
Report text: "{text}" """
```

### Deduplication logic

```python
vec = openai_client.embeddings.create(
    input=report["text"], model="text-embedding-3-small"
).data[0].embedding

results = index.query(
    vector=vec,
    filter={
        "lat":           {"$gte": lat - 0.005, "$lte": lat + 0.005},
        "lng":           {"$gte": lng - 0.005, "$lte": lng + 0.005},
        "created_epoch": {"$gte": thirty_days_ago_epoch}
    },
    top_k=5, include_metadata=True
)

if results.matches and results.matches[0].score > 0.88:
    return DedupResult(is_duplicate=True,
                       master_ticket_id=results.matches[0].id)

index.upsert(vectors=[(
    report["report_id"], vec,
    {"lat": lat, "lng": lng,
     "created_epoch": int(time.time()), "issue_type": issue_type}
)])
return DedupResult(is_duplicate=False)
```

### Environment variables

```env
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...       # embeddings only
PINECONE_API_KEY=...
PINECONE_INDEX=civicpulse-reports
REDIS_URL=redis://...
# No DATABASE_URL — S2 never touches Postgres
```

---

## Service 3 — Worker

**Entry point:** `services/worker/tasks.py`
**Framework:** Celery 5
**Responsibilities:** Full async lifecycle orchestration. Owns all DB writes.
Owns all retry decisions. Consumes three queues.

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

### Views

**Dispatcher dashboard** (`/dashboard`) — JWT authenticated
- Priority queue sorted by `urgency_score DESC`
- Per-ticket: issue type, address, cluster count, confidence bar, AI reasoning
- `confidence < 0.70` tickets in a separate "needs review" tab
- Actions: confirm AI / override priority / assign crew
- Leaflet map with pin at report GPS location

**Citizen status tracker** (`/track/:ticketId`) — public
- Status: queued → processing → open → resolved
- If duplicate: "Your report was merged with {n} similar nearby reports"
- Polls every 10s until resolved

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

### Environment variables

```env
REDIS_URL=redis://...
API_BASE_URL=http://api:8000
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM_NUMBER=+1...
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
    depends_on: [redis]
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
  │  LPUSH reports:process
  ▼
S3 Worker  ──────────────────────────────────────────────┐
  │                                                      │
  │  LPUSH ai_core:process                    consumes ai_core:results
  ▼                                           consumes ai_core:failed
S2 AI Core (no HTTP, no DB access)
  │
  ├── on success → LPUSH ai_core:results ──► S3 Worker
  │                                              │
  └── on failure → LPUSH ai_core:failed ──► S3 Worker
                                               │
                              ┌────────────────┴───────────────────┐
                              │                                    │
                         success path                         failure path
                         INSERT tickets                       attempt < 3?
                         UPDATE status=done                   → re-enqueue backoff
                         PUBLISH notify:ticket_ready          attempt >= 3?
                              │                               → DLQ + status=failed
                              ▼
                         S5 Notifications (pub-sub)
                              │
                         Twilio SMS → Citizen

S4 Frontend ──REST HTTP──► S1 API Gateway (all reads, all writes via S1 only)
```

---

## Decisions Log

| Decision | Choice | Reason |
|----------|--------|--------|
| S2 has no HTTP server | Pure Celery consumer | Eliminates 30s synchronous wait; S2 scales independently of S3 |
| Retry logic owned by S3, not S2 | Worker decides retries | S2 stays stateless; single place to change retry policy |
| S2 never touches Postgres | Results go via queue to S3 | S2 is fully stateless — easier to scale, test, and replace |
| S1 returns 202 immediately | Never waits for AI | API p99 latency under 200ms regardless of LLM latency |
| Confidence gate at 0.70 | Human review below threshold | Safe starting point; tune down as accuracy data accumulates |
| P1 keyword override before LLM | Deterministic safety net | Zero latency, zero tokens, zero hallucination on safety-critical cases |
| Dedup cosine threshold 0.88 | Pinecone similarity cutoff | 0.85 produces too many false positives |
| Haiku for vision, Sonnet for reasoning | Task-appropriate models | Haiku is 5x cheaper for simple image-to-text; Sonnet for structured reasoning |
| Monorepo | Single repo, multiple service folders | Shared models + one docker-compose + simpler CI for a 4-person team |
| Pinecone free tier | Hosted vector DB for MVP | Zero infra; swap to self-hosted Qdrant in Phase 2 if cost grows |
| S3 is sole DB writer | Single writer pattern | Avoids concurrent write conflicts between S2 and S3 |

---