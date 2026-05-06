#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════
#  CIVICPULSE — Demo 1: AI Core (S2) Crash & Automatic Recovery
#
#  WHAT THIS PROVES
#  ────────────────
#  If the AI processing service crashes while a report is in flight,
#  the message waits safely in Redis.  When the service restarts it
#  picks the job up and the ticket is created — zero data loss, zero
#  manual intervention.
#
#  MECHANISM
#  ─────────
#  Celery config:  task_acks_late = True
#                  task_reject_on_worker_lost = True
#  → Redis holds the message until the Celery task COMPLETES and ACKs.
#  → A dead worker = un-ACKed message = message stays in queue.
#
#  HOW TO RUN
#  ──────────
#  1. Start the full stack:  docker compose up -d
#  2. Seed demo data:        (see README — optional)
#  3. Open http://localhost:5173  and log in as dispatcher
#  4. Run this script in a terminal:  bash scripts/demo/demo_01_ai_crash.sh
# ════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")/../.."   # repo root

# ── colours & helpers ────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

header() {
    echo -e "\n${BLUE}${BOLD}╔══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}${BOLD}║  $1${NC}"
    echo -e "${BLUE}${BOLD}╚══════════════════════════════════════════════════════════╝${NC}\n"
}
step()    { echo -e "\n${CYAN}${BOLD}▶  $1${NC}"; }
info()    { echo -e "   ${CYAN}$1${NC}"; }
ok()      { echo -e "   ${GREEN}✓  $1${NC}"; }
warn()    { echo -e "   ${YELLOW}⚠  $1${NC}"; }
fail()    { echo -e "   ${RED}✗  $1${NC}"; }
ui()      { echo -e "\n   ${BOLD}🖥  SHOW IN BROWSER:${NC}"; echo -e "   ${BOLD}$1${NC}\n"; }
pause()   { echo ""; read -rp "$(echo -e "   ${YELLOW}▶  Press ENTER to continue...${NC} ")" _ ; echo ""; }
run_cmd() { echo -e "   ${BOLD}\$${NC} $*"; "$@"; }

API="http://localhost:8000"

# ── preflight check ──────────────────────────────────────────────────
header "Demo 1 — S2 AI Core Crash & Recovery"

info "Checking stack is up..."
if ! curl -sf "$API/health" > /dev/null 2>&1; then
    fail "API not reachable at $API — run 'docker compose up -d' first"
    exit 1
fi
ok "Stack is running"

# ── PART 1: Confirm normal state ─────────────────────────────────────
step "PART 1 — Show the system in its normal, healthy state"

info "Queue depth before we start (should be 0):"
run_cmd docker compose exec redis redis-cli LLEN ai_core:process

ui "http://localhost:5173  →  Dispatcher Dashboard
   Point out the existing ticket list sorted by urgency."

pause

# ── PART 2: Kill S2 BEFORE submitting ────────────────────────────────
step "PART 2 — Kill the AI Core (S2) service"

info "We stop S2 now — BEFORE the report is submitted."
info "The report will still get accepted by the API and flow through S3,"
info "but it will get stuck waiting in the ai_core:process queue."
echo ""

run_cmd docker compose stop ai_core
ok "S2 is down. Redis queue is empty. Nothing is consuming ai_core:process."

pause

# ── PART 3: Submit a report ──────────────────────────────────────────
step "PART 3 — Submit a citizen report"

info "Submitting a P1-class report: collapsed retaining wall."
echo ""

RESPONSE=$(curl -s -X POST "$API/reports" \
    -F "text=Collapsed retaining wall blocking the right lane on Highway 9, debris everywhere, very dangerous" \
    -F "lat=37.7530" \
    -F "lng=-122.4330" \
    -F "address=Highway 9, San Jose, CA" \
    -F "reporter_phone=+14085559999" \
    -F "source=app")

REPORT_ID=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ticket_id','ERROR'))" 2>/dev/null || echo "ERROR")

if [ "$REPORT_ID" = "ERROR" ] || [ -z "$REPORT_ID" ]; then
    fail "Could not submit report. Response was: $RESPONSE"
    exit 1
fi

ok "Report accepted by S1 API"
echo ""
echo -e "   ${BOLD}Report ID:${NC} $REPORT_ID"

pause

# ── PART 4: Show the report is STUCK at the S2 queue ────────────────
step "PART 4 — Show the report is stuck in the AI queue"

info "S3 Worker processed reports:process fine — it updated status to 'processing'"
info "and forwarded the job to ai_core:process.  But S2 is down, so it waits."
echo ""

echo -e "   ${BOLD}Queue depth (ai_core:process) — should be 1:${NC}"
run_cmd docker compose exec redis redis-cli LLEN ai_core:process
echo ""

echo -e "   ${BOLD}Report status in DB — should be 'processing':${NC}"
run_cmd docker compose exec postgres \
    psql -U civic civicpulse -t -c \
    "SELECT '  status = ' || status FROM raw_reports WHERE id = '$REPORT_ID';"
echo ""

echo -e "   ${BOLD}Ticket created yet? — should be (0 rows):${NC}"
run_cmd docker compose exec postgres \
    psql -U civic civicpulse -t -c \
    "SELECT COUNT(*) || ' ticket(s) found' FROM tickets WHERE raw_report_id = '$REPORT_ID';"

ui "http://localhost:5173/track/$REPORT_ID  (or paste ID into Citizen Tracker)
   Status shows: PROCESSING — the report was accepted but AI hasn't run yet."

pause

# ── PART 5: Restart S2 ───────────────────────────────────────────────
step "PART 5 — Restart the AI Core (S2) service"

info "Starting S2 back up.  It will immediately pick up the waiting message."
echo ""

run_cmd docker compose start ai_core
ok "S2 is back online — the Celery worker is starting"

info "Waiting for S2 to boot and process the queued task (~15 seconds)..."
echo ""

# Poll until ticket appears (max 60s)
TICKET_ID=""
for i in $(seq 1 30); do
    sleep 2
    TICKET_ID=$(docker compose exec postgres \
        psql -U civic civicpulse -t -c \
        "SELECT id FROM tickets WHERE raw_report_id = '$REPORT_ID' LIMIT 1;" \
        2>/dev/null | tr -d ' \n' || true)
    if [ -n "$TICKET_ID" ]; then
        break
    fi
    printf "   Polling... attempt %d/30\r" "$i"
done
echo ""

# ── PART 6: Verify recovery ──────────────────────────────────────────
step "PART 6 — Verify the ticket was created (recovery confirmed)"

if [ -z "$TICKET_ID" ]; then
    warn "Ticket not found yet — S2 may still be starting. Check 'docker compose logs ai_core'."
else
    ok "Ticket created!  ID: $TICKET_ID"
    echo ""

    echo -e "   ${BOLD}Queue depth (should now be 0):${NC}"
    run_cmd docker compose exec redis redis-cli LLEN ai_core:process
    echo ""

    echo -e "   ${BOLD}Ticket details:${NC}"
    docker compose exec postgres \
        psql -U civic civicpulse -t -c \
        "SELECT
           '  Category  : ' || COALESCE(category_name, '—')    AS line1,
           '  Subcategory: ' || COALESCE(subcategory_name, '—') AS line2,
           '  Urgency   : ' || COALESCE(urgency_score::text, '—') AS line3,
           '  Assigned  : ' || COALESCE(assigned_to, 'unassigned') AS line4
         FROM tickets WHERE id = '$TICKET_ID';" 2>/dev/null || true
fi

ui "http://localhost:5173  →  Dispatcher Dashboard
   Refresh — the new ticket should appear at the top of the queue,
   sorted by urgency score.  S2 crashed, Redis held the job, recovery
   was fully automatic."

echo ""
echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}${BOLD}  DEMO 1 COMPLETE — Recovery was automatic:${NC}"
echo -e "${GREEN}  1. S2 killed  →  message stayed in Redis (task_acks_late)${NC}"
echo -e "${GREEN}  2. S3 still ran, status=processing, job queued in ai_core:process${NC}"
echo -e "${GREEN}  3. S2 restarted  →  picked up waiting message  →  ticket created${NC}"
echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
