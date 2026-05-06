# scripts/

Operational scripts for CivicPulse — currently just the demo data seeder.

## seed.py — populate Postgres with demo data

Idempotent. Re-running the script never duplicates rows. Pass `--reset` to truncate every seeded table first.

### What it creates

| Table            | Count | Highlights                                                                      |
|------------------|-------|---------------------------------------------------------------------------------|
| `citizens`       | 5     | One per common reporter persona, with reachable phone numbers                   |
| `officers`       | 6     | 1 admin + 5 officers, one per department (roads, traffic, drainage, structures, operations) |
| `crews`          | 5     | One per crew type, lead matches the same-department officer                     |
| `raw_reports`    | 24    | Spread across 9 taxonomy categories; 2 stay queued; 1 stays failed              |
| `tickets`        | 21    | Mix of open, assigned, in-progress, resolved; 1 duplicate, 1 needs-review       |
| `ticket_comments`| 6     | 3 public, 3 internal                                                            |
| `schedules`      | 2     | Yesterday (roads zone) and today (drainage zone)                                |

Every entity uses a deterministic UUID (via `uuid.uuid5`) so the same IDs appear on every run — handy for citing specific tickets in `TEST_PLAN.md`.

### Prerequisites

1. Stack is up: `docker compose up -d postgres redis api`
2. Migrations applied: `docker compose run --rm api alembic upgrade head`

### Run it

The recommended path is to bind-mount this directory into the running `api` container so we reuse its Python environment, network, and `.env`:

```bash
# Default: insert anything missing, leave existing rows alone
docker compose run --rm \
    --volume "$(pwd)/scripts:/app/scripts" \
    api python /app/scripts/seed.py

# Destructive: truncate every seeded table first, then populate
docker compose run --rm \
    --volume "$(pwd)/scripts:/app/scripts" \
    api python /app/scripts/seed.py --reset
```

Alternatively, if you have Python 3.11 + the `services/api/requirements.txt` deps installed locally **and** Postgres is exposed on `localhost:5432`:

```bash
DATABASE_URL=postgresql://civic:civic@localhost:5432/civicpulse \
PYTHONPATH=. \
python scripts/seed.py
```

### Login credentials (after seeding)

| Role     | How to log in                                                  | Password           |
|----------|----------------------------------------------------------------|--------------------|
| Admin    | `POST /auth/login` with `{"username": "admin"}`                | from `ADMIN_PASSWORD` in `.env` |
| Admin    | `POST /auth/officer/login` with `email=admin@civicpulse.gov`   | `Officer123!`      |
| Officer  | `POST /auth/officer/login` with `roads.lead@civicpulse.gov` (or `traffic.lead`, `drainage.lead`, `structures.lead`, `ops.lead`) | `Officer123!` |
| Citizen  | (citizens currently report anonymously; passwords seeded for future flows) | `Citizen123!` |

### How the test plan uses this

Every test case in `TEST_PLAN.md` that says "preconditions: seed applied" assumes a fresh `--reset` run of this script. Tests that mutate state (override, resolve, comment) should be re-runnable by re-seeding with `--reset`.

### Resetting just the seed without touching other docker volumes

```bash
docker compose run --rm \
    --volume "$(pwd)/scripts:/app/scripts" \
    api python /app/scripts/seed.py --reset
```

This truncates only the seeded tables; it does not drop the database or affect Alembic migration state.

### Wiping everything (nuclear option)

```bash
docker compose down -v        # also deletes the pgdata volume
docker compose up -d postgres redis api
docker compose run --rm api alembic upgrade head
docker compose run --rm \
    --volume "$(pwd)/scripts:/app/scripts" \
    api python /app/scripts/seed.py
```
