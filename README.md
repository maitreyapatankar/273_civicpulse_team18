# CivicPulse
Urban Infrastructure Reporting at Scale — AI triage, smart deduplication, and a dispatcher-ready queue.

---

## Running End to End (Beginner Guide)

### Prerequisites
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running
- A free Gemini API key — get one at [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)

---

### Step 1 — Copy the environment file

```bash
cp .env.example .env
```

Open `.env` and fill in the two required values. Everything else can stay blank for a local run:

```env
GEMINI_API_KEY=your-key-here
OFFICER_JWT_SECRET=any-long-random-string
```

> Generate random secrets quickly: `openssl rand -hex 32`

---

### Step 2 — Build and start all services

```bash
docker compose up --build
```

First build takes 2–4 minutes. You will see interleaved logs from Postgres, Redis, the API, AI Core, Worker, and the frontend. Wait until you see lines like:

```
api       | INFO:     Application startup complete.
frontend  | Local:   http://localhost:5173/
```

> **No Twilio?** Start without the notifications service to avoid the crash:
> ```bash
> docker compose up --build postgres redis api ai_core worker frontend
> ```

---

### Step 3 — Run database migrations

Open a **second terminal** in the same directory and run:

```bash
docker compose run --rm api alembic upgrade head
```

You should see `Running upgrade ... -> 0007` lines. This creates all tables.

---

### Step 4 — 
Current staff login - admin@gmail.com Pass: adminP

---

### Step 5 — Open the app and test the full flow

| What | URL |
|------|-----|
| Landing page | [http://localhost:5173](http://localhost:5173) |
| Submit a report | [http://localhost:5173/report](http://localhost:5173/report) |
| Officer login | [http://localhost:5173/officer/login](http://localhost:5173/officer/login) |
| Dispatcher dashboard | [http://localhost:5173/officer/dashboard](http://localhost:5173/officer/dashboard) |
| Staff (assigned tickets) | [http://localhost:5173/staff](http://localhost:5173/staff) |
| Track a ticket (public) | `http://localhost:5173/track/{ticket_id}` |
| API docs (Swagger) | [http://localhost:8000/docs](http://localhost:8000/docs) |

**Full flow walkthrough:**

1. Go to `/report` — allow location access so the map centers on you
2. Fill in a title, description, click the map or search an address, attach a photo (optional)
3. Hit **Submit complaint** — you get a ticket ID immediately
4. Log in as your officer at `/officer/login`
5. Open the **Dispatcher Dashboard** — the ticket appears within ~30 seconds once the AI pipeline finishes
6. Click the ticket to see the customer submission, AI classification, urgency reasoning, and factor bars
7. The **Staff Dashboard** shows the same ticket already assigned to your account

---

## Required Credentials

## Required Credentials

**All API keys go in `.env` — never in `.env.example`.**
`.env` is git-ignored. `.env.example` is the committed template.

```bash
cp .env.example .env
# then open .env and fill in every REQUIRED value below
```

The internal connection strings (Postgres, Redis, API base URL) are already pre-filled in `.env.example`. Only the external keys below need your input. `LOG_LEVEL` controls verbosity (`DEBUG`, `INFO`, `WARNING`, `ERROR`).

### Service 1 — API Gateway

| Variable | What it's used for |
|----------|--------------------|
| `OFFICER_JWT_SECRET` | JWT secret for officer/admin tokens (HS256). |
| `ADMIN_USERNAME` | Bootstrap admin username (default: `admin`). |
| `ADMIN_PASSWORD` | Bootstrap admin password (default: `adminP`). |
| `S3_BUCKET` | AWS S3 bucket where citizen-uploaded report photos are stored. |
| `S3_REGION` | AWS region for the bucket. Default `us-east-1`. |
| `AWS_ACCESS_KEY_ID` | AWS IAM credential with `s3:PutObject` on the bucket. |
| `AWS_SECRET_ACCESS_KEY` | Paired secret for the IAM key above. |
| `R2_ENDPOINT` | Cloudflare R2 endpoint (when set, R2 is used instead of S3). |
| `R2_BUCKET` | R2 bucket name for uploads. |
| `R2_REGION` | R2 region (use `auto`). |
| `R2_ACCESS_KEY_ID` | R2 access key. |
| `R2_SECRET_ACCESS_KEY` | R2 secret key. |
| `R2_PRESIGN_EXPIRES` | Presigned URL TTL in seconds (max 604800). |

**Creating officer accounts:** Use `POST /officer/signup` from the UI, or insert directly into the `officers` table and set `department` (`roads` | `traffic` | `drainage` | `structures` | `operations`) so the auto-assignment logic routes tickets correctly.

> **Skipping image uploads?** Leave the S3 or R2 variables blank — reports without images still process. The API only uploads when a photo is attached. For private R2 buckets, the stored image URL is a presigned GET that expires.

### Service 2 — AI Core

| Variable | What it's used for |
|----------|--------------------|
| `GEMINI_API_KEY` | All LLM calls: image description, classification, urgency scoring. Get one free at [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey). |
| `LANGCHAIN_TRACING_V2` | Enable LangSmith tracing (`true`/`false`). Optional. |
| `LANGCHAIN_API_KEY` | LangSmith API key for tracing runs. Optional. |
| `LANGCHAIN_PROJECT` | Project name shown in LangSmith. Optional. |
| `LANGCHAIN_ENDPOINT` | LangSmith API endpoint (default `https://api.smith.langchain.com`). Optional. |

> Deduplication uses a direct Postgres query (subcategory code + 100 m geo bbox) — no vector DB or embedding API required.

### Service 5 — Notifications

| Variable | What it's used for |
|----------|--------------------|
| `TWILIO_ACCOUNT_SID` | Twilio account identifier — found in the Twilio Console dashboard. |
| `TWILIO_AUTH_TOKEN` | Auth token paired with the account SID. |
| `TWILIO_FROM_NUMBER` | Your Twilio phone number SMS messages are sent from (e.g. `+12025551234`). |

> **Skipping SMS?** Leave all three Twilio variables blank — every other service still runs. S5 Notifications will crash on startup without them, but that doesn't affect S1/S2/S3/S4.

---

## Known Gaps

### 1. `frontend/package-lock.json` is not committed
Run `npm install` inside `frontend/` once locally to generate it, then commit the lock file. Without it Docker builds are not reproducible.

### 2. S5 Notifications crashes without Twilio credentials
Start everything except notifications if you haven't set up Twilio yet:
```bash
docker compose up postgres redis api ai_core worker frontend
```

---
