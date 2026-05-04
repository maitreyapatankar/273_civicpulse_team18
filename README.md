# 273_civicpulse_team18
CivicPulse: Urban Infrastructure Support at Scale

---

## First-Run Checklist

Complete these in order before expecting anything to work:

```bash
# 1. Copy and fill in credentials
cp .env.example .env
# open .env — fill in every REQUIRED value (see "Required Credentials" below)

# 2. Start infrastructure + services
docker compose up --build

# 3. Run DB migrations (separate terminal, one-time)
docker compose run --rm api alembic upgrade head

# 4. Verify the API is up
curl http://localhost:8000/health
```

**URLs once running:**

| Service | URL |
|---------|-----|
| API Gateway | http://localhost:8000 |
| API Docs (Swagger) | http://localhost:8000/docs |
| Landing | http://localhost:5173 |
| Officer Login | http://localhost:5173/officer/login |
| Officer Dashboard | http://localhost:5173/officer/dashboard |
| Citizen Login | http://localhost:5173/citizen/login |
| Citizen Dashboard | http://localhost:5173/citizen/dashboard |
| Citizen Tracker | http://localhost:5173/track/{ticket_id} |

---

## Required Credentials

**All API keys go in `.env` — never in `.env.example`.**
`.env` is git-ignored. `.env.example` is the committed template.

```bash
cp .env.example .env
# then open .env and fill in every REQUIRED value below
```

The internal connection strings (Postgres, Redis, API base URL) are already pre-filled in `.env.example`. Only the external keys below need your input.

### Service 1 — API Gateway

| Variable | What it's used for |
|----------|--------------------|
| `OFFICER_JWT_SECRET` | JWT secret for officer/admin tokens (HS256). |
| `CITIZEN_JWT_SECRET` | JWT secret for citizen tokens (HS256). |
| `ADMIN_USERNAME` | Bootstrap admin username (default: `admin`). |
| `ADMIN_PASSWORD` | Bootstrap admin password (default: `adminP`). |
| `S3_BUCKET` | S3/R2 bucket where citizen-uploaded report photos are stored. |
| `S3_REGION` | AWS region for the bucket. Default `us-east-1`. Change for Cloudflare R2. |
| `AWS_ACCESS_KEY_ID` | AWS IAM credential with `s3:PutObject` on the bucket. |
| `AWS_SECRET_ACCESS_KEY` | Paired secret for the IAM key above. |

**Officer login shortcut:** `POST /auth/officer/login` accepts `admin@gmail.com` + `ADMIN_PASSWORD` and issues an admin-role token.

> **Skipping image uploads?** Leave the four S3/AWS variables blank — reports without images still process. The API only calls S3 when a photo is attached.

### Service 2 — AI Core

| Variable | What it's used for |
|----------|--------------------|
| `GEMINI_API_KEY` | All LLM calls: image description, classification, urgency scoring, work order generation. Get one free at [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey). |
| `PINECONE_API_KEY` | Reads and writes to the Pinecone vector index for dedup ANN search. |
| `PINECONE_INDEX` | Name of the Pinecone index. Default `civicpulse-reports` — create it in the Pinecone console (384 dims, cosine) before first run. |

> Embeddings for deduplication are computed locally with `sentence-transformers all-MiniLM-L6-v2` — no embedding API key required.

### Service 5 — Notifications

| Variable | What it's used for |
|----------|--------------------|
| `TWILIO_ACCOUNT_SID` | Twilio account identifier — found in the Twilio Console dashboard. |
| `TWILIO_AUTH_TOKEN` | Auth token paired with the account SID. |
| `TWILIO_FROM_NUMBER` | Your Twilio phone number SMS messages are sent from (e.g. `+12025551234`). |

> **Skipping SMS?** Leave all three Twilio variables blank — every other service still runs. S5 Notifications will crash on startup without them, but that doesn't affect S1/S2/S3/S4.

---

## Known Gaps — Teammate Handoff Notes

### 1. `frontend/package-lock.json` is not committed
Run `npm install` inside `frontend/` once locally to generate it, then commit the lock file. Without it Docker builds are not reproducible.

### 2. Pinecone index must be created manually
Before S2 AI Core can deduplicate, create a free-tier index named `civicpulse-reports` in the Pinecone console (dimensions: `384`, metric: `cosine`). Then set `PINECONE_INDEX=civicpulse-reports` in `.env`.

### 3. S5 Notifications crashes without Twilio credentials
Start everything except notifications if you haven't set up Twilio yet:
```bash
docker compose up postgres redis api ai_core worker frontend
```

### 4. `services/ai_core/prompts/` directory is empty
The architecture reserves it for prompt template files. Currently all prompts are inline in the Python files. Moving them there is optional cleanup.

---
