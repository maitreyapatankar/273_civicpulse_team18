# CivicPulse Architecture Diagram

Urban Infrastructure Reporting at Scale — AI triage, smart deduplication, and dispatcher-ready queue.

---

## System Overview

```
┌────────────────────────────────────────────────────────────────────────────────┐
│                          CivicPulse Architecture                               │
│                                                                                │
│  Citizens (Mobile/Web)    Officers (Web)         External Services            │
│         │                        │                                            │
│         └────────────┬───────────┘                                            │
│                      ▼                                                        │
│        ┌─────────────────────────┐                                           │
│        │  S4: Frontend (React)   │                                           │
│        │  Port 5173              │                                           │
│        │  - Report submission    │                                           │
│        │  - Ticket tracking      │                                           │
│        │  - Officer dashboard    │                                           │
│        │  - Staff management     │                                           │
│        └──────────────┬──────────┘                                           │
│                       │ HTTP/REST                                            │
│                       ▼                                                      │
│        ┌─────────────────────────┐         ┌──────────────────┐            │
│        │   S1: API Gateway       │◄───────►│  Postgres (DB)   │            │
│        │   FastAPI Port 8000     │         │  - Reports       │            │
│        │ - Report ingestion      │         │  - Tickets       │            │
│        │ - Ticket CRUD           │         │  - Officers      │            │
│        │ - Officer auth/mgmt     │         │  - Crews         │            │
│        │ - Crew management       │         │  - Schedules     │            │
│        │ - SSE real-time updates │         │  - Comments      │            │
│        └────────┬────────────────┘         └──────────────────┘            │
│                 │                                                           │
│    ┌────────────┼────────────┬──────────────────────┐                      │
│    │            │            │                      │                      │
│    ▼ Queue:     ▼ Pub/Sub:   ▼ Queue:   ┌─────────────────────┐           │
│  reports:    notify:       ai_core:     │  Redis (Queue+     │           │
│  process     ticket_*      process      │  Cache+Pub/Sub)    │           │
│    │            │            │         │  Port 6379         │           │
│    │            │            │         └────────┬──────────┘            │
│    │            │            │                  │                       │
│    │            │            └──────────┬──────────────────┐           │
│    │            │                       ▼                 │           │
│    │            │            ┌──────────────────────┐    │           │
│    │            │            │ S2: AI Core          │    │           │
│    │            │            │ (LangGraph + Celery) │    │           │
│    │            │            │ - Image description  │    │           │
│    │            │            │ - Classification     │    │           │
│    │            │            │ - Deduplication      │    │           │
│    │            │            │ - Urgency scoring    │    │           │
│    │            │            │ (No Postgres writes) │    │           │
│    │            │            └──────────┬───────────┘    │           │
│    │            │                       │                │           │
│    │            │                       ▼ Queue:         │           │
│    │            │                  ai_core:results       │           │
│    │            │                       │                │           │
│    │            │   ┌───────────────────┘                │           │
│    │            │   │                                    │           │
│    │            │   ▼ Queue: ai_core:failed             │           │
│    │            │                                        │           │
│    └────────────┼────────┬────────────────────────────────┤          │
│                 │        │                               │           │
│                 │        ▼                               │           │
│                 │    ┌──────────────────────┐            │           │
│                 │    │ S3: Worker (Celery)  │            │           │
│                 │    │ - DB writes (sole)   │            │           │
│                 │    │ - Retry logic        │            │           │
│                 │    │ - Auto-assign crews  │            │           │
│                 │    │ - DLQ handling       │            │           │
│                 │    └──────────┬───────────┘            │           │
│                 │               │                        │           │
│                 │               ▼ Queue:                 │           │
│                 │          reports:dlq                   │           │
│                 │          (Dead Letter)                 │           │
│                 │                                        │           │
│                 │                                        │           │
│                 ├────────────────────────────────────────┤           │
│                 │                                        │           │
│                 ▼                                        │           │
│        ┌──────────────────────────┐                     │           │
│        │ S5: Notifications        │                     │           │
│        │ (Redis Pub/Sub Listener) │                     │           │
│        │ - SMS via Twilio         │                     │           │
│        │ - Email to crew leads    │                     │           │
│        │ - SSE to frontend        │                     │           │
│        └──────────────────────────┘                     │           │
│                                                         │           │
│        ┌──────────────────────────┐                     │           │
│        │ S6: Scheduler            │                     │           │
│        │ (Python Loop)            │                     │           │
│        │ - Query approved tickets │                     │           │
│        │ - Load-balance crews     │◄────────────────────┤           │
│        │ - Send email alerts      │                     │           │
│        │ - Every 15s (demo mode)  │                     │           │
│        └──────────────────────────┘                     │           │
│                                                         ▼           │
│                                            Twilio, Gmail SMTP       │
│                                                                      │
└────────────────────────────────────────────────────────────────────┘
```

---

## Data Flow: End-to-End Ticket Lifecycle

### 1. **Report Submission** (Citizen → API)
```
Citizen submits report via /report
         │
         ▼
    S1 API (POST /reports)
         │
    ├─ Validate submission
    ├─ Store RawReport in Postgres
    ├─ Generate report UUID
    ├─ Return ticket_id immediately
    │
    └─► Publish to Queue: reports:process
         [payload: {report_id, ...}]
```

### 2. **Report Processing** (S3 Worker)
```
Queue: reports:process
         │
         ▼
    S3 Worker receives task
         │
    ├─ Fetch RawReport from Postgres
    ├─ Mark status = "processing"
    ├─ Build AI pipeline payload
    │  [existing_ticket_id, is_edit, attempt]
    │
    └─► Publish to Queue: ai_core:process
         [payload: {report_id, enriched_data, attempt}]
```

### 3. **AI Classification** (S2 AI Core)
```
Queue: ai_core:process
         │
         ▼
    S2 AI Core (LangGraph Pipeline - 4 Nodes)
         │
    ├─ Node 1: Image Description
    │  [Gemini vision → image text]
    │
    ├─ Node 2: Classification
    │  [Gemini → category, severity, confidence]
    │  Detects text/image conflicts
    │
    ├─ Node 3: Deduplication
    │  [Postgres read-only query]
    │  Matches: subcategory_code + 100m geo bbox
    │  → Returns master_ticket_id if duplicate
    │
    ├─ Node 4: Urgency Scoring
    │  [P1 override logic + LLM scoring]
    │  Returns: urgency_score (1-5)
    │
    └─► (Success) Publish to Queue: ai_core:results
        (Failure) Publish to Queue: ai_core:failed
         [payload: {report_id, enriched_ticket}]
```

### 4. **Ticket Creation/Update** (S3 Worker)
```
Queue: ai_core:results
         │
         ▼
    S3 Worker writes to Postgres
         │
    ├─ Check: is this a duplicate?
    │  ├─ YES: Create shadow Ticket
    │  │   [duplicate_of = master_id]
    │  │   Update master urgency_score & cluster_count
    │  │
    │  └─ NO: Create/update main Ticket
    │      [category, severity, urgency_score, etc.]
    │
    ├─ Mark RawReport.status = "done"
    ├─ Commit transaction
    │
    └─► Publish to Pub/Sub: notify:ticket_ready
        [payload: {ticket_id, report_id}]
```

### 5. **Officer Approval & Crew Assignment**
```
Officer opens /officer/staff → GET /tickets?status=all
         │
         ▼
    S1 API filters data:
    ├─ Open: !approved && !crew_assigned && unresolved
    ├─ Needs Review: !approved && needs_review && unresolved
    ├─ Pending: approved && crew_assigned
    ├─ Resolved: resolved_at IS NOT NULL

    Officer clicks "Approve"
         │
         ▼
    GET /tickets/{id}/suggest-crew
    └─► S1 API load-balances:
        ├─ Find crew type by category code
        ├─ Count open tickets per crew
        └─ Return crew with fewest open
         │
         ▼
    Officer selects crew, confirms
         │
         ▼
    PATCH /tickets/{id}
    {approve: true, crew_id: UUID}
         │
         ▼
    S1 API writes:
    ├─ ticket.approved = true
    ├─ ticket.crew_id = UUID
    ├─ ticket.assigned_to = crew.team_name
    ├─ Derive: lifecycle_status = "forwarded_to_maintenance"
    │  (ONLY when BOTH approved AND crew_id set)
    │
    └─► Publish to Pub/Sub: notify:ticket_updated
```

### 6. **Automated Crew Assignment (Scheduler)**
```
Every 15 seconds:
    │
    ▼
S6 Scheduler queries Postgres:
SELECT * FROM tickets
WHERE approved = true
  AND crew_id IS NULL
  AND resolved_at IS NULL
    │
    ▼
Load-balance assignment:
├─ Get category_code → crew_type mapping
├─ Find crews with matching crew_type
├─ Count open tickets per crew
├─ Assign to crew with FEWEST open tickets
│
├─ UPDATE tickets SET:
│   crew_id = chosen_crew.id
│   assigned_to = chosen_crew.team_name
│   assigned_at = NOW()
│   lifecycle_status = 'forwarded_to_maintenance'
│
└─► Send Email (Gmail)
    To crew lead with issue, priority, location
```

### 7. **Resolution**
```
Officer clicks "Mark Resolved"
         │
         ▼
    PATCH /tickets/{id}
    {resolve: true}
         │
         ▼
    S1 API writes:
    ticket.resolved_at = NOW()
    Derive: lifecycle_status = "resolved"
         │
         ├─► Postgres UPDATE
         │
         └─► Publish to Pub/Sub: notify:ticket_resolved
```

---

## Queue & Pub/Sub Architecture

### Celery Queues (Redis-backed)

| Queue | Producer | Consumer | Purpose | Retries |
|-------|----------|----------|---------|---------|
| `reports:process` | S1 API | S3 Worker | New report | — |
| `ai_core:process` | S3 Worker | S2 AI Core | AI pipeline | 0 (S2 never retries) |
| `ai_core:results` | S2 AI Core | S3 Worker | Success path | — |
| `ai_core:failed` | S2 AI Core | S3 Worker | Failure path | 3 attempts (2^n backoff) |
| `reports:dlq` | S3 Worker | Manual | Dead letter | — |

**S3 Retry Backoff:**
- Attempt 0→1: 1s delay
- Attempt 1→2: 2s delay
- Attempt 2→3: 4s delay
- Attempt 3: DLQ, mark as failed

### Pub/Sub Channels (Real-time)

| Channel | Producer | Consumer | Payload |
|---------|----------|----------|---------|
| `notify:ticket_ready` | S3 | S5, Frontend SSE | `{ticket_id, report_id}` |
| `notify:ticket_updated` | S1, S3 | S5, Frontend SSE | `{ticket_id, report_id}` |
| `notify:ticket_resolved` | S1 | S5 | `{ticket_id, report_id}` |

---

## Key Architectural Principles

### ✓ Principle 1: S2 Never Writes to Postgres
- AI Core is stateless and scalable
- Worker (S3) is sole DB writer
- Prevents race conditions and simplifies recovery

### ✓ Principle 2: S2 Doesn't Retry (max_retries=0)
- AI Core publishes failure to queue
- Worker (S3) retries with exponential backoff
- Simple, clear responsibility separation

### ✓ Principle 3: Ticket Status is Derived, Not Stored
- No `lifecycle_status` column in table
- Computed from: `resolved_at`, `approved`, `crew_id`, raw_report.status
- Single source of truth: ticket fields
- Prevents sync bugs

### ✓ Principle 4: Same Load-Balancing Logic Everywhere
- Implemented in: Worker, Scheduler, Admin API
- Count open tickets: `assigned_to == crew.team_name AND resolved_at IS NULL`
- Assign to crew with fewest open

### ✓ Principle 5: Email on Crew Assignment
- Triggered by Scheduler or Admin action
- Gmail App Password (2FA required)
- Optional: skip if EMAIL_ADDRESS blank

---

## Environment Configuration

```
SHARED:
├─ REDIS_URL=redis://redis:6379/0
├─ DB_URL=postgresql://civic:civic@postgres:5432/civicpulse
└─ LOG_LEVEL=INFO

S1 (API):
├─ OFFICER_JWT_SECRET=<long-random>
├─ S3_BUCKET= (optional)
├─ AWS_ACCESS_KEY_ID= (optional)
├─ AWS_SECRET_ACCESS_KEY= (optional)
└─ EMAIL_ADDRESS= (optional)

S2 (AI Core):
└─ GEMINI_API_KEY=<required>

S5 (Notifications):
├─ TWILIO_ACCOUNT_SID= (optional)
├─ TWILIO_AUTH_TOKEN= (optional)
├─ TWILIO_FROM_NUMBER= (optional)
├─ EMAIL_ADDRESS= (optional)
└─ EMAIL_APP_PASSWORD= (optional)

S6 (Scheduler):
└─ SCHEDULER_INTERVAL=15 (seconds, demo mode)
```

---

**Created:** May 2026 | Format: ASCII Diagram + Markdown
