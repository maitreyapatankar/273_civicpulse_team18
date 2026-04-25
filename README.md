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
| Dispatcher Dashboard | http://localhost:5173/dashboard |
| Citizen Tracker | http://localhost:5173/track/{ticket_id} |

---

## Known Gaps — Teammate Handoff Notes

These are deliberate incomplete pieces the next engineer needs to build or wire up:

### 1. AI Core model names are `"TODO"`
The pipeline won't run until these are filled in. See `CLAUDE.md → TODOs Still Requiring Input` for the exact file locations.

### 3. `frontend/package-lock.json` is not committed
Run `npm install` inside `frontend/` once locally to generate it, then commit the lock file. Without it Docker builds are not reproducible.

### 4. Pinecone index must be created manually
Before S2 AI Core can deduplicate, create a free-tier index named `civicpulse-reports` in the Pinecone console (dimensions: `1536`, metric: `cosine`). Then set `PINECONE_INDEX=civicpulse-reports` in `.env`.

### 5. S5 Notifications crashes without Twilio credentials
If you haven't set the three `TWILIO_*` variables, start everything except notifications:
```bash
docker compose up postgres redis api ai_core worker frontend
```

### 6. `services/ai_core/prompts/` directory is empty
The architecture mentions it as a home for prompt templates. Currently all prompts are inline in the Python files. Moving them there is optional cleanup.

---

## Required Credentials

**All API keys go in `.env` — never in `.env.example`.**

`.env` is git-ignored so your real keys are never committed.
`.env.example` is the committed template. To get started:

```bash
cp .env.example .env
# open .env and fill in every REQUIRED value below
```

The internal connection strings (Postgres, Redis) are already pre-filled in `.env.example`.
The following values are blank — **fill them in your `.env` before running the stack.**

### Service 1 — API Gateway

| Variable | Placeholder | What it's used for |
|----------|-------------|-------------------|
| `JWT_SECRET` | `REPLACE_WITH_ANY_RANDOM_SECRET_STRING` | Signs and verifies dispatcher login tokens (HS256). Use any long random string — e.g. `openssl rand -hex 32`. |
| `DISPATCHER_USERNAME` | *(your choice)* | Username for the dispatcher login page at `/login`. |
| `DISPATCHER_PASSWORD` | *(your choice)* | Password paired with the username above. |
| `S3_BUCKET` | `REPLACE_WITH_YOUR_S3_BUCKET_NAME` | S3/R2 bucket where citizen-uploaded report photos are stored. |
| `S3_REGION` | `us-east-1` (pre-filled) | AWS region for the bucket. Change if using a different region or Cloudflare R2. |
| `AWS_ACCESS_KEY_ID` | `REPLACE_WITH_YOUR_AWS_ACCESS_KEY_ID` | AWS IAM credential with `s3:PutObject` permission on the bucket. |
| `AWS_SECRET_ACCESS_KEY` | `REPLACE_WITH_YOUR_AWS_SECRET_ACCESS_KEY` | Paired secret for the IAM key above. |

> **Skipping image uploads?** Leave the four S3/AWS variables as placeholders — reports without images will still process. The API only calls S3 when a photo is attached.

### Service 2 — AI Core

| Variable | Placeholder | What it's used for |
|----------|-------------|-------------------|
| `ANTHROPIC_API_KEY` | `REPLACE_WITH_YOUR_ANTHROPIC_API_KEY` | All Claude calls: image description (Haiku), classification, urgency scoring, and work order generation (Sonnet). |
| `OPENAI_API_KEY` | `REPLACE_WITH_YOUR_OPENAI_API_KEY` | `text-embedding-3-small` embeddings used by the deduplication step. |
| `PINECONE_API_KEY` | `REPLACE_WITH_YOUR_PINECONE_API_KEY` | Reads and writes to the Pinecone vector index for deduplication ANN search. |
| `PINECONE_INDEX` | `civicpulse-reports` (pre-filled) | Name of the Pinecone index. Create a free-tier index with this name at pinecone.io before first run. |

> **AI Core model names** are also still set to `"TODO"` inside the pipeline files — see the TODO table in `CLAUDE.md` for the exact locations.

### Service 5 — Notifications

| Variable | Placeholder | What it's used for |
|----------|-------------|-------------------|
| `TWILIO_ACCOUNT_SID` | `REPLACE_WITH_YOUR_TWILIO_ACCOUNT_SID` | Twilio account identifier, found in the Twilio Console dashboard. |
| `TWILIO_AUTH_TOKEN` | `REPLACE_WITH_YOUR_TWILIO_AUTH_TOKEN` | Auth token paired with the account SID. |
| `TWILIO_FROM_NUMBER` | `REPLACE_WITH_YOUR_TWILIO_PHONE_NUMBER` | The Twilio phone number SMS messages are sent from (e.g. `+12025551234`). |

> **Skipping SMS?** Leave all three Twilio variables as placeholders — every other service will still run. S5 Notifications will crash on startup without them, but that doesn't affect S1/S2/S3/S4.

---
