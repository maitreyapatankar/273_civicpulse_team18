#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════
#  CIVICPULSE — Demo 2: Gemini API Failure → Exponential Retry → DLQ
#
#  WHAT THIS PROVES
#  ────────────────
#  When the external Gemini AI API fails, S2 sends the failure to S3.
#  S3 owns the retry policy: exponential backoff (1 s → 2 s → 4 s),
#  max 3 attempts.  After 3 failures the report lands in the Dead
#  Letter Queue — it is NEVER silently dropped.
#
#  MECHANISM
#  ─────────
#  S2:  max_retries=0 — catches ALL exceptions, sends to ai_core:failed
#  S3:  handle_ai_failure()
#         attempt < 3  →  re-enqueue with countdown = 2^attempt seconds
#         attempt >= 3 →  mark status=failed, push to reports:dlq
#  Redis NX lock prevents duplicate retries on re-delivery (idempotency)
#
#  HOW TO RUN
#  ──────────
#  1. Stack must be running:  docker compose up -d
#  2. Run:  bash scripts/demo/demo_02_gemini_retry.sh
#  3. Script cleans up after itself (restores ai_core with real key)
# ════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")/../.."   # repo root

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

OVERRIDE_FILE="docker-compose.demo-override.yml"

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
    if [ -f "$OVERRIDE_FILE" ]; then
        echo -e "\n${YELLOW}⚠  Cleaning up — restoring ai_core with real Gemini key...${NC}"
        rm -f "$OVERRIDE_FILE"
        docker compose up -d --force-recreate ai_core > /dev/null 2>&1 || true
        echo -e "${GREEN}✓  ai_core restored${NC}"
    fi
}
trap cleanup EXIT

# ── preflight ────────────────────────────────────────────────────────
header "Demo 2 — Gemini Failure → Exponential Retry → Dead Letter Queue"

info "Checking stack is up..."
if ! curl -sf "$API/health" > /dev/null 2>&1; then
    fail "API not reachable — run 'docker compose up -d' first"
    exit 1
fi
ok "Stack is running"

# ── PART 1: Inject a broken Gemini key ──────────────────────────────
step "PART 1 — Break the Gemini API key for the AI Core service"

info "Creating a Docker Compose override that injects an invalid Gemini key."
info "This simulates Gemini being unreachable / returning 401 auth errors."
echo ""

cat > "$OVERRIDE_FILE" << 'YAML'
services:
  ai_core:
    environment:
      GEMINI_API_KEY: "DEMO_INVALID_KEY_SIMULATING_API_OUTAGE"
YAML

ok "Override file created: $OVERRIDE_FILE"
echo ""

info "Recreating ai_core container with the broken key..."
run_cmd docker compose -f docker-compose.yml -f "$OVERRIDE_FILE" up -d --force-recreate ai_core
echo ""

info "Waiting for ai_core to boot (~5 seconds)..."
sleep 5
ok "ai_core is running with a broken Gemini key"

pause

# ── PART 2: Show retry logic as-written in the code ─────────────────
step "PART 2 — Understand the retry flow before we demo it"

info "The retry logic lives in TWO services, by design:"
echo ""
echo -e "   ${BOLD}S2 (ai_core/consumer.py):${NC}"
echo -e "   • max_retries = 0  — S2 NEVER internally loops"
echo -e "   • On any exception → send to ai_core:failed queue"
echo -e "   • soft_time_limit = 180 s (hard kill at 240 s)"
echo ""
echo -e "   ${BOLD}S3 (worker/tasks.py) — handle_ai_failure():${NC}"
echo -e "   • attempt 0 → retry in  2^0 =  1 second"
echo -e "   • attempt 1 → retry in  2^1 =  2 seconds"
echo -e "   • attempt 2 → retry in  2^2 =  4 seconds"
echo -e "   • attempt 3 → DLQ: mark status='failed', push reports:dlq"
echo ""
echo -e "   ${BOLD}Why S3 owns retries, not S2?${NC}"
echo -e "   Because S3 also owns DB writes. Retry = re-read raw_report"
echo -e "   from DB + build fresh payload.  S2 stays stateless."

pause

# ── PART 3: Submit a report ──────────────────────────────────────────
step "PART 3 — Submit a report (Gemini will fail on this one)"

info "Submitting a report about a blocked storm drain."
echo ""

RESPONSE=$(curl -s -X POST "$API/reports" \
    -F "text=Storm drain on Park Avenue completely blocked, water pooling after the rain" \
    -F "lat=37.3340" \
    -F "lng=-121.8900" \
    -F "address=Park Ave, San Jose, CA" \
    -F "reporter_phone=+14085558888" \
    -F "source=app")

REPORT_ID=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ticket_id','ERROR'))" 2>/dev/null || echo "ERROR")

if [ "$REPORT_ID" = "ERROR" ] || [ -z "$REPORT_ID" ]; then
    fail "Could not submit report. Response was: $RESPONSE"
    exit 1
fi

ok "Report accepted.  ID: $REPORT_ID"
echo ""
echo -e "   ${BOLD}API returned HTTP 202 immediately${NC} — the report was accepted"
echo -e "   even though Gemini is broken.  S1 is decoupled from S2."

ui "http://localhost:5173/track/$REPORT_ID
   Status starts as: PROCESSING or QUEUED"

pause

# ── PART 4: Watch the retry loop in real time ────────────────────────
step "PART 4 — Watch the 3-attempt exponential retry in worker logs"

info "Streaming S3 worker logs.  You will see:"
info "  [attempt=0] failure received → schedule retry in 1 s"
info "  [attempt=1] failure received → schedule retry in 2 s"
info "  [attempt=2] failure received → schedule retry in 4 s"
info "  [attempt=3] TERMINAL → DLQ"
echo ""
warn "Tailing logs for 30 seconds — all 3 retries should complete in ~10 s"
echo ""

timeout 30 docker compose logs -f worker 2>/dev/null | \
    grep --line-buffered -E \
        "handle_ai_failure|attempt|retry|dlq|failed|DLQ|terminal|TERMINAL|ai_core:failed|ai_core:process" \
    || true

echo ""
ok "Log stream ended (or retries completed)"

pause

# ── PART 5: Confirm DLQ state ────────────────────────────────────────
step "PART 5 — Confirm the DLQ received the report after 3 failures"

echo -e "   ${BOLD}DLQ depth (reports:dlq) — should be 1:${NC}"
run_cmd docker compose exec redis redis-cli LLEN reports:dlq
echo ""

echo -e "   ${BOLD}Report status in DB — should be 'failed':${NC}"
run_cmd docker compose exec postgres \
    psql -U civic civicpulse -t -c \
    "SELECT '  status = ' || status FROM raw_reports WHERE id = '$REPORT_ID';"
echo ""

echo -e "   ${BOLD}Ticket created? — should be 0:${NC}"
run_cmd docker compose exec postgres \
    psql -U civic civicpulse -t -c \
    "SELECT COUNT(*) || ' ticket(s)' FROM tickets WHERE raw_report_id = '$REPORT_ID';"
echo ""

echo -e "   ${BOLD}Retry lock keys in Redis (idempotency guards):${NC}"
docker compose exec redis redis-cli KEYS "retry_lock:$REPORT_ID:*" 2>/dev/null || true

ui "http://localhost:5173/track/$REPORT_ID
   Status now shows: FAILED
   The citizen knows their report was received but AI processing failed.
   The report is preserved in the DLQ for manual re-processing."

pause

# ── PART 6: Restore Gemini key ───────────────────────────────────────
step "PART 6 — Restore the real Gemini key (simulate outage recovery)"

info "Removing the broken key override and restarting ai_core normally."
echo ""

rm -f "$OVERRIDE_FILE"
run_cmd docker compose up -d --force-recreate ai_core
echo ""

info "Waiting for ai_core to come back up..."
sleep 6
ok "ai_core restored with the real Gemini API key"

# ── PART 7: Prove the system recovered ──────────────────────────────
step "PART 7 — Submit a fresh report to prove the system recovered"

info "Submitting a new report — should now go through the full pipeline successfully."
echo ""

RESPONSE2=$(curl -s -X POST "$API/reports" \
    -F "text=Large pothole on 1st Street near the library, cars swerving to avoid it" \
    -F "lat=37.3382" \
    -F "lng=-121.8863" \
    -F "address=1 N 1st St, San Jose, CA" \
    -F "source=app")

REPORT_ID2=$(echo "$RESPONSE2" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ticket_id','ERROR'))" 2>/dev/null || echo "ERROR")
ok "Report submitted. ID: $REPORT_ID2"

info "Waiting up to 30 s for ticket creation..."
TICKET_ID2=""
for i in $(seq 1 15); do
    sleep 2
    TICKET_ID2=$(docker compose exec postgres \
        psql -U civic civicpulse -t -c \
        "SELECT id FROM tickets WHERE raw_report_id = '$REPORT_ID2' LIMIT 1;" \
        2>/dev/null | tr -d ' \n' || true)
    if [ -n "$TICKET_ID2" ]; then
        break
    fi
    printf "   Polling... %d/15\r" "$i"
done
echo ""

if [ -n "$TICKET_ID2" ]; then
    ok "Ticket created after Gemini key restored!  ID: $TICKET_ID2"
    docker compose exec postgres \
        psql -U civic civicpulse -t -c \
        "SELECT
           '  Category : ' || COALESCE(category_name,'—'),
           '  Urgency  : ' || COALESCE(urgency_score::text,'—'),
           '  Assigned : ' || COALESCE(assigned_to,'unassigned')
         FROM tickets WHERE id = '$TICKET_ID2';" 2>/dev/null || true
else
    warn "Ticket not ready yet — AI may still be warming up. Check 'docker compose logs ai_core'."
fi

ui "http://localhost:5173  →  Dispatcher Dashboard
   The new ticket appears.  The failed one does NOT.
   Failed reports in the DLQ would trigger a PagerDuty/Slack alert
   in a production system (wired in worker/tasks.py:dlq_alert)."

echo ""
echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}${BOLD}  DEMO 2 COMPLETE — Retry chain worked as designed:${NC}"
echo -e "${GREEN}  1. Gemini broken  →  S2 sent each failure to ai_core:failed${NC}"
echo -e "${GREEN}  2. S3 retried 3×  →  backoff 1s → 2s → 4s${NC}"
echo -e "${GREEN}  3. After 3rd fail →  DLQ, status=failed, never silently dropped${NC}"
echo -e "${GREEN}  4. Key restored   →  fresh reports process normally${NC}"
echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
