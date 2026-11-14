#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "verify: $*" >&2; exit 1; }
step() { echo; echo "== $* =="; }

CONTRACT_STATUS="skipped"
SCENARIO_STATUS="skipped"

step "TypeScript typecheck"
npm run typecheck

step "Unit and API tests (core, ledger, server, web, client)"
npm run test

step "Season runtime tests (model answer parsing, runtime limits, signature check)"
npm run test:season

step "Production web build"
npm run build

if command -v cargo >/dev/null 2>&1; then
  step "Contract tests"
  (cd contracts/queue && cargo test)
  step "Contract wasm build"
  (cd contracts/queue && cargo build --target wasm32-unknown-unknown --release)
  test -f contracts/queue/target/wasm32-unknown-unknown/release/queue.wasm || fail "missing queue.wasm"
  step "Contract v2 tests, lint and wasm build (--cfg near via contracts/queue-v2/.cargo)"
  (cd contracts/queue-v2 && cargo test && cargo clippy --all-targets -- -D warnings && cargo build --target wasm32-unknown-unknown --release)
  test -f contracts/queue-v2/.cargo/config.toml || fail "contracts/queue-v2/.cargo/config.toml missing: refusals would lose their text on chain"
  step "Contract v3 tests, lint and wasm build (stake, liability, timelock, refundable storage)"
  (cd contracts/queue-v3 && cargo test && cargo clippy --all-targets -- -D warnings && cargo build --target wasm32-unknown-unknown --release)
  test -f contracts/queue-v3/.cargo/config.toml || fail "contracts/queue-v3/.cargo/config.toml missing: refusals would lose their text on chain"
  test -f contracts/queue-v3/target/wasm32-unknown-unknown/release/queue.wasm || fail "missing queue-v3 wasm"
  CONTRACT_STATUS="passed"
else
  CONTRACT_STATUS="skipped"
  echo
  echo "################################################################"
  echo "# SKIP: contract tests and the wasm build were NOT run."
  echo "# SKIP: cargo is not installed, so contracts/queue is NOT verified."
  echo "# SKIP: install Rust (https://rustup.rs) for the full check."
  echo "################################################################"
fi

step "Public secret scan"
node scripts/secret-scan.mjs

step "On-chain artifact reproduction"
npm run verify:artifact

step "Live API smoke test"
PORT="${QUEUE_VERIFY_PORT:-8799}"
# Something already answering on this port would be tested instead of this tree (a stale build can pass or fail).
if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  fail "port $PORT is already in use by another server; stop it or set QUEUE_VERIFY_PORT"
fi
DB="/tmp/queue-verify-$$.db"
LOG="/tmp/queue-verify-$$.log"
QUEUE_PORT="$PORT" QUEUE_DB_PATH="$DB" npm -w @queue/server run start >"$LOG" 2>&1 &
SERVER_PID=$!
cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  rm -f "$DB" "$DB-shm" "$DB-wal" "$LOG"
}
trap cleanup EXIT

for _ in $(seq 1 50); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then break; fi
  sleep 0.2
done
curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null || fail "API did not start"
kill -0 "$SERVER_PID" 2>/dev/null || fail "the server this script started is not running (another process answered on port $PORT)"
STATE=$(curl -fsS "http://127.0.0.1:$PORT/api/state")
echo "$STATE" | grep -q '"queue"' || fail "state response missing queue"
JOB=$(echo "$STATE" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s).state.queue[3];process.stdout.write(j.id)})')
QUOTE=$(curl -fsS "http://127.0.0.1:$PORT/api/quote?jobId=$JOB&latestStartInSec=5")
echo "$QUOTE" | grep -q '"feasible":true' || fail "quote was not feasible"
echo "verify: OK (job $JOB quoted)"

if [[ "${QUEUE_VERIFY_FAST:-0}" != "1" ]]; then
  step "Full scenario (poll up to 30s)"
  curl -fsS -X POST "http://127.0.0.1:$PORT/api/demo/run" -H 'content-type: application/json' -d '{}' >/dev/null
  DONE=0
  for _ in $(seq 1 60); do
    STATE=$(curl -fsS "http://127.0.0.1:$PORT/api/state")
    if echo "$STATE" | grep -q '"status":"done"'; then DONE=1; break; fi
    sleep 0.5
  done
  [[ "$DONE" == "1" ]] || fail "scenario did not complete within 30s"
  echo "$STATE" | grep -q '"type":"audit.passed"' || fail "auditor did not pass"
  echo "verify: scenario delivered and audited"
  SCENARIO_STATUS="passed"

  step "Displaced jobs keep their promise"
  # The worker drains the four displaced jobs after the urgent one.
  STATS=""
  for _ in $(seq 1 70); do
    STATS=$(curl -fsS "http://127.0.0.1:$PORT/api/state" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s).state.stats;process.stdout.write(`${t.completed} ${t.missed} ${t.failed}`)})')
    [[ "$STATS" == "5 0 0" ]] && break
    sleep 1
  done
  [[ "$STATS" == "5 0 0" ]] || fail "expected 5 completed, 0 missed, 0 failed, got: $STATS"
  echo "verify: 5/5 jobs on time, 0 missed, 0 failed — every displaced deadline held"
else
  echo
  echo "verify: QUEUE_VERIFY_FAST=1 — full scenario skipped"
fi

echo
if [[ "$CONTRACT_STATUS" == "passed" && "$SCENARIO_STATUS" == "passed" ]]; then
  echo "verify: all checks passed (app, scenario, contract)"
elif [[ "$CONTRACT_STATUS" == "passed" ]]; then
  echo "verify: app and contract checks passed; SCENARIO SKIPPED (QUEUE_VERIFY_FAST=1)"
else
  echo "verify: application checks passed, but CONTRACT TESTS WERE NOT RUN."
  echo "verify: do not describe this run as a full verification."
fi
