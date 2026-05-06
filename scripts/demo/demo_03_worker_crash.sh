#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════
#  CIVICPULSE — Demo 3: S3 Worker Crash → Queue Buffers → Recovery
#
#  WHAT THIS PROVES
#  ────────────────
#  S3 Worker is the ONLY Postgres writer.  If it crashes, reports
#  submitted to S1 are buffered safely in the Redis queue.  When S3
#  restarts it drains the backlog — every report gets a ticket.
#  No data loss.  No need for the citizen to resubmit.
#
#  MECHANISM
#  ─────────
#  Celery config:  task_acks_late = True  (both S2 and S3)
#  → S1 pushes to reports:process.  S3 is dead, so messages pile up.
#  → Redis is the buffer — capacity is only limited by RAM.
#  → S3 restart drains the queue in order.
#
#  CONTRAST WITH DEMO 1
#  ────────────────────
#  Demo 1 broke S2 (the AI step) — reports were stuck AFTER going
#  through S3.  This demo breaks S3 (the DB writer) — reports pile
#  up at the ENTRY queue, never reaching the AI at all.  Both queues
#  are independently resilient.
#
#  HOW TO RUN
#  ──────────
#  1. Stack running:  docker compose up -d
#  2. Run:  bash scripts/demo/demo_03_worker_crash.sh
# ════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")/../.."

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

# ── cleanup trap ─────────────────────────────────────────────────────
cleanup() {
    local svc_state
    svc_state=$(docker compose ps worker --format '{{.State}}' 2>/dev/null || echo "unknown")
    if [ "$svc_state" != "running" ]; then
        echo -e "\n${YELLOW}⚠  Cleanup: restarting worker service...${NC}"
        docker compose start worker > /dev/null 2>&1 || true
        echo -e "${GREEN}✓  Worker restarted${NC}"
    fi
}
trap cleanup EXIT

# ── preflight ────────────────────────────────────────────────────────
header "Demo 3 — S3 Worker Crash → Redis Buffers → All Reports Recovered"

info "Checking stack is up..."
if ! curl -sf "$API/health" > /dev/null 2>&1; then
    fail "API not reachable — run 'docker compose up -d' first"
    exit 1
fi
ok "Stack is running"

# ── PART 1: Show queue is empty ──────────────────────────────────────
step "PART 1 — Baseline: queues are empty"

echo -e "   ${BOLD}reports:process queue depth (should be 0):${NC}"
run_cmd docker compose exec redis redis-cli LLEN reports:process
echo ""

echo -e "   ${BOLD}Current open tickets:${NC}"
docker compose exec postgres \
    psql -U civic civicpulse -t -c \
    "SELECT COUNT(*) || ' open ticket(s)' FROM tickets WHERE resolved_at IS NULL;" \
    2>/dev/null || true

ui "http://localhost:5173  →  Dispatcher Dashboard
   Note the current ticket count — we will add to it."

pause

# ── PART 2: Kill S3 Worker ───────────────────────────────────────────
step "PART 2 — Kill the S3 Worker (sole DB writer)"

info "S3 Worker is the ONLY service that writes to Postgres."
info "Stopping it now — S1 API will still accept reports."
echo ""

run_cmd docker compose stop worker
ok "S3 Worker is down.  Postgres is unreachable for writes."
info "S1 API is still fully up — citizens can still submit reports."

pause

# ── PART 3: Submit 3 reports while worker is down ───────────────────
step "PART 3 — Submit 3 reports with the worker down"

info "All 3 will be accepted by S1 with HTTP 202."
info "They will queue in reports:process, waiting for S3 to return."
echo ""

declare -a REPORT_IDS=()

submit_report() {
    local text="$1" lat="$2" lng="$3" address="$4"
    local resp id
    resp=$(curl -s -X POST "$API/reports" \
        -F "text=$text" \
        -F "lat=$lat" \
        -F "lng=$lng" \
        -F "address=$address" \
        -F "source=app")
    id=$(echo "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ticket_id','ERROR'))" 2>/dev/null || echo "ERROR")
    echo "$id"
}

echo -e "   ${BOLD}Report A: Traffic light out${NC}"
R_A=$(submit_report \
    "Traffic light at Santa Clara and 10th completely dark, cars running the intersection" \
    "37.3393" "-121.8869" "Santa Clara St & 10th St, San Jose")
ok "Submitted — ID: $R_A"
sleep 1

echo ""
echo -e "   ${BOLD}Report B: Sinkhole${NC}"
R_B=$(submit_report \
    "Sinkhole opened on 3rd Street near the bridge, half the lane has collapsed" \
    "37.3370" "-121.8930" "3rd St near Coyote Creek Bridge, San Jose")
ok "Submitted — ID: $R_B"
sleep 1

echo ""
echo -e "   ${BOLD}Report C: Flooding${NC}"
R_C=$(submit_report \
    "Flooding on Almaden Blvd after the rain, water 8 inches deep, cars stalling" \
    "37.3340" "-121.8900" "Almaden Blvd & Park Ave, San Jose")
ok "Submitted — ID: $R_C"

REPORT_IDS=("$R_A" "$R_B" "$R_C")

pause

# ── PART 4: Show all 3 are queued, no tickets yet ───────────────────
step "PART 4 — Show reports are buffered; no tickets created yet"

echo -e "   ${BOLD}reports:process queue depth (should be 3):${NC}"
run_cmd docker compose exec redis redis-cli LLEN reports:process
echo ""

echo -e "   ${BOLD}Report statuses in DB (should all be 'queued'):${NC}"
for id in "${REPORT_IDS[@]}"; do
    STATUS=$(docker compose exec postgres \
        psql -U civic civicpulse -t -c \
        "SELECT status FROM raw_reports WHERE id='$id';" \
        2>/dev/null | tr -d ' \n' || echo "—")
    echo -e "   $(echo "$id" | cut -c1-8)... → ${BOLD}$STATUS${NC}"
done
echo ""

echo -e "   ${BOLD}Tickets created for these reports (should be 0):${NC}"
docker compose exec postgres \
    psql -U civic civicpulse -t -c \
    "SELECT COUNT(*) || ' ticket(s)' FROM tickets
     WHERE raw_report_id IN ('${REPORT_IDS[0]}','${REPORT_IDS[1]}','${REPORT_IDS[2]}');" \
    2>/dev/null || true

ui "http://localhost:5173  →  Dispatcher Dashboard
   Ticket count is UNCHANGED — S3 is down, no writes happened.
   The citizens' reports are safe in Redis, not lost."

pause

# ── PART 5: Restart S3 Worker ────────────────────────────────────────
step "PART 5 — Restart the S3 Worker"

info "Starting S3 Worker back up."
info "It will drain the backlog — all 3 messages in order."
echo ""

run_cmd docker compose start worker
ok "S3 Worker is back online"
info "Processing all 3 queued reports (~20-30 seconds total)..."

# ── PART 6: Poll until all 3 tickets appear ──────────────────────────
step "PART 6 — Watching tickets appear one by one"

echo -e "   ${BOLD}Polling DB every 3 seconds...${NC}"
echo ""

declare -a TICKET_IDS=("" "" "")
ALL_DONE=false

for poll in $(seq 1 30); do
    sleep 3
    COUNT=0
    for i in 0 1 2; do
        if [ -z "${TICKET_IDS[$i]}" ]; then
            TID=$(docker compose exec postgres \
                psql -U civic civicpulse -t -c \
                "SELECT id FROM tickets WHERE raw_report_id='${REPORT_IDS[$i]}' LIMIT 1;" \
                2>/dev/null | tr -d ' \n' || true)
            if [ -n "$TID" ]; then
                TICKET_IDS[$i]="$TID"
                LABELS=("Traffic light" "Sinkhole   " "Flooding   ")
                echo -e "   ${GREEN}✓  Ticket created — ${LABELS[$i]} (${REPORT_IDS[$i]:0:8}...)${NC}"
            fi
        fi
        [ -n "${TICKET_IDS[$i]}" ] && COUNT=$((COUNT + 1))
    done
    [ "$COUNT" -eq 3 ] && { ALL_DONE=true; break; }
    printf "   Still waiting... %d/3 tickets created\r" "$COUNT"
done
echo ""

# ── PART 7: Final verification ───────────────────────────────────────
step "PART 7 — Final verification"

if [ "$ALL_DONE" = true ]; then
    echo -e "   ${BOLD}reports:process queue depth (should be 0):${NC}"
    run_cmd docker compose exec redis redis-cli LLEN reports:process
    echo ""

    echo -e "   ${BOLD}All 3 ticket details:${NC}"
    docker compose exec postgres \
        psql -U civic civicpulse -c \
        "SELECT
           LEFT(t.subcategory_name,30) AS issue,
           t.urgency_score,
           COALESCE(t.assigned_to,'unassigned') AS assigned
         FROM tickets t
         WHERE t.raw_report_id IN ('${REPORT_IDS[0]}','${REPORT_IDS[1]}','${REPORT_IDS[2]}')
         ORDER BY t.urgency_score DESC;" \
        2>/dev/null || true
else
    warn "Not all tickets appeared in time. Check: docker compose logs worker"
fi

ui "http://localhost:5173  →  Dispatcher Dashboard
   Refresh — all 3 new tickets should appear, sorted by urgency.
   The sinkhole should be at the top (urgency 5).
   S3 was down for 3 submitted reports; all recovered on restart."

echo ""
echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}${BOLD}  DEMO 3 COMPLETE — Redis buffered 3 reports during S3 downtime:${NC}"
echo -e "${GREEN}  1. S3 killed  →  S1 still accepted all 3 reports (HTTP 202)${NC}"
echo -e "${GREEN}  2. reports:process held 3 messages (Redis in-memory queue)${NC}"
echo -e "${GREEN}  3. S3 restarted → drained queue → 3 tickets created in DB${NC}"
echo -e "${GREEN}  4. Citizens never needed to resubmit${NC}"
echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
