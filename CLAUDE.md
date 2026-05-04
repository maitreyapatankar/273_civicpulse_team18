# CivicPulse — Agent Instructions

## Ground Rules
- **Ask before creating any file the user hasn't explicitly requested.**
- Work on one service at a time. Do not touch other services unless asked.
- Follow ARCHITECTURE.md exactly. Do not invent abstractions beyond what is specified.
- Show code and ask for approval before writing files when the user asks for it.

## Architecture Invariants (never violate these)

| Rule | Detail |
|------|--------|
| S1 never calls S2 directly | All S1 → S2 communication goes through Redis queues only |
| S2 never touches Postgres | S2 is a pure Celery consumer — no DB reads or writes |
| S3 is the sole DB writer | Only `services/worker/tasks.py` writes to Postgres |
| S2 `max_retries=0` | S2 does not retry — it sends failures to S3 via `ai_core:failed` |
| S3 owns retries | Exponential backoff (1 s → 2 s → 4 s), max 3 attempts, then DLQ |
| S2 has no HTTP server | No FastAPI, no uvicorn in `services/ai_core/` |
| JSONB mutation | Always assign a new dict object to JSONB columns — SQLAlchemy won't detect in-place mutations |

## Redis Queue Map

| Queue | Producer | Consumer | Purpose |
|-------|----------|----------|---------|
| `reports:process` | S1 | S3 | New report submitted |
| `ai_core:process` | S3 | S2 | Forward to AI pipeline |
| `ai_core:results` | S2 | S3 | Successful pipeline result |
| `ai_core:failed` | S2 | S3 | Pipeline failure |
| `reports:dlq` | S3 | manual | Exhausted all retries |
| `notify:ticket_ready` | S3 | S5 | pub-sub: SMS on ticket create |
| `notify:ticket_resolved` | S3 | S5 | pub-sub: SMS on ticket resolve |

## API Keys — Where to Put Them

All credentials go in **`.env`** (git-ignored, never committed).
`.env.example` is the committed template — team members run `cp .env.example .env` then fill in their values.
See `README.md → Required Credentials` for what each key does.

## Service Commands

```bash
# Start everything
docker compose up

# Individual services
docker compose up api          # S1 — http://localhost:8000
docker compose up ai_core      # S2 — no port, Celery consumer only
docker compose up worker       # S3 — no port, Celery consumer only
docker compose up frontend     # S4 — http://localhost:5173
docker compose up notifications # S5 — no port, pub-sub listener

# Run Alembic migrations
docker compose run --rm api alembic upgrade head

# Frontend dev (outside Docker)
cd frontend && npm install && npm run dev
```

## Key File Locations

```
shared/db.py                        SQLAlchemy engine, SessionLocal, get_db()
shared/models.py                    RawReport + Ticket ORM models
alembic/versions/0001_initial_schema.py   DB migration

services/api/main.py                FastAPI app + CORS
services/api/routers/reports.py     POST /reports, POST /reports/batch-csv
services/api/routers/tickets.py     GET /tickets, GET /tickets/:id/status (+ JWT guard)
services/api/routers/admin.py       PATCH /tickets/:id (JWT guarded)

services/ai_core/consumer.py        run_pipeline Celery task (max_retries=0)
services/ai_core/pipeline/__init__.py  pipeline.run(payload) → enriched dict
services/ai_core/pipeline/classify.py  Gemini 2.5 Flash vision + classification
services/ai_core/pipeline/dedup.py     Local sentence-transformers embeddings + Pinecone ANN
services/ai_core/pipeline/urgency.py   P1 keyword shortcut + LLM scoring
services/ai_core/pipeline/workorder.py LLM work order generation

services/worker/tasks.py            process_report, handle_ai_result, handle_ai_failure
services/notifications/listener.py  Redis pub-sub → Twilio SMS

frontend/src/main.tsx               Routes: /dashboard, /track/:ticketId
frontend/src/api/client.ts          Axios instance + JWT interceptor
frontend/src/api/types.ts           Shared TypeScript types
frontend/src/pages/DispatcherDashboard.tsx
frontend/src/pages/CitizenTracker.tsx
```

## TS Diagnostics Note

"Cannot find module" errors in the frontend are expected until `npm install` has been run
in the `frontend/` directory. They are not code errors.
