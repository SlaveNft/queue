# Headless walkthrough

Six API moments, no browser, no wallet, no keys. This is the path for an agent that cannot click the console. All commands assume the local server is running:

```bash
npm install
npm run dev:server        # API on http://127.0.0.1:8789
```

If you previously ran the demo, start from standby:

```bash
curl -fsS -X POST http://127.0.0.1:8789/api/demo/reset \
  -H 'content-type: application/json' -d '{}' | jq -e '.ok == true'
```

`curl -f` exits `22` on HTTP 4xx/5xx; `jq -e` exits `1` if the filter returns `false` or `null`. Each command below ends with `echo "exit=$?"` so you can see the code. If `QUEUE_OPERATOR_TOKEN` is set, add `-H "x-operator-token: $QUEUE_OPERATOR_TOKEN"` to every `POST`.

## 1. Health

```bash
curl -fsS http://127.0.0.1:8789/api/health \
  | jq -e '.ok == true and .mode == "local" and .db == "ok"'; echo "exit=$?"
```

Expected: `true`, `exit=0`. The body looks like:

```json
{"ok":true,"version":"1.0.0","build":"dev","mode":"local","uptimeSec":3,"db":"ok"}
```

## 2. Quote four displacements

The quote needs a queued buyer. In standby the four seed jobs are `J-1001`…`J-1004`; create Kestrel's urgent job first, then quote it at a 5-second cutoff:

```bash
curl -fsS -X POST http://127.0.0.1:8789/api/jobs \
  -H 'content-type: application/json' \
  -d '{"ownerId":"kestrel","task":"incident-triage","title":"Board brief now","brief":"Deliver the incident brief before the board call.","input":"14:02 checkout 5xx 18.4%","durationSec":12,"deadlineInSec":34,"rewardNear":"0.02","bondNear":"0.015","askPerSecNear":"0.0006"}' \
  | jq -e '.ok == true and .job.id == "J-1005" and .job.status == "queued"'; echo "exit=$?"

curl -fsS 'http://127.0.0.1:8789/api/quote?jobId=J-1005&latestStartInSec=5' \
  | jq -e '.ok == true and .quote.feasible == true and (.quote.displaced | length) == 4 and .quote.totalYocto == "20240400000000000000000"'; echo "exit=$?"
```

Expected: both `true`, `exit=0`. Trimmed quote body:

```json
{
  "ok": true,
  "quote": {
    "jobId": "J-1005",
    "insertIndex": 0,
    "compensationYocto": "20040000000000000000000",
    "feeYocto": "200400000000000000000",
    "totalYocto": "20240400000000000000000",
    "displaced": [
      {"jobId":"J-1001","amountYocto":"5040000000000000000000"},
      {"jobId":"J-1002","amountYocto":"6960000000000000000000"},
      {"jobId":"J-1003","amountYocto":"4320000000000000000000"},
      {"jobId":"J-1004","amountYocto":"3720000000000000000000"}
    ],
    "feasible": true
  }
}
```

The four-displaced result is the 5-second start preference. At `latestStartInSec=18` the same quote returns 3 and `totalYocto = "15150000000000000000000"`; at `20` it returns 2 and `"8120400000000000000000"`. See `docs/RESULTS.md`.

## 3. Run the scenario

```bash
curl -fsS -o /tmp/queue-run.json -w '%{http_code}\n' \
  -X POST http://127.0.0.1:8789/api/demo/run \
  -H 'content-type: application/json' -d '{}'; echo "exit=$?"
jq -e '.ok == true and .scenario.status == "running"' /tmp/queue-run.json; echo "exit=$?"
```

Expected HTTP `202`, then `true`, `exit=0`:

```json
{"ok":true,"scenario":{"status":"running","phase":"arrival"},"state":{...}}
```

The run resets the queue and discards the manual `J-1005` from step 2. That is why the quote comes before the run.

## 4. State: wait for 5 of 5

The scenario spends ~17 seconds on the paid jump, then drains the four displaced jobs. Poll until the queue is empty and all five jobs are done (about 60 seconds; allow up to 90):

```bash
for i in $(seq 1 90); do
  curl -fsS http://127.0.0.1:8789/api/state \
    | jq -e '.state.stats.completed == 5 and .state.stats.missed == 0 and .state.scenario.phase == "settled"' \
    && { echo "exit=0 after ${i}s"; break; }
  sleep 1
done
```

Expected final fields:

```json
{
  "ok": true,
  "state": {
    "scenario": {"phase": "settled", "status": "done"},
    "stats": {"submitted": 5, "completed": 5, "missed": 0},
    "queue": [],
    "credits": {
      "mira": "5040000000000000000000",
      "atlas": "6960000000000000000000",
      "vale": "4320000000000000000000",
      "juno": "3720000000000000000000"
    }
  }
}
```

If the loop exits without printing `exit=0`, read `.state.scenario.phase` and `.state.stats`; the scenario stopped or a job missed. Do not substitute a local row for a testnet transaction.

## 5. Artifact

```bash
curl -fsS http://127.0.0.1:8789/api/jobs/J-1005/artifact \
  | jq -e '.ok == true and .artifact.jobId == "J-1005" and (.artifact.sha256 | length) == 64'; echo "exit=$?"
```

Expected: `true`, `exit=0`.

```json
{
  "ok": true,
  "artifact": {
    "id": "ART-1005",
    "jobId": "J-1005",
    "sha256": "5159aede574aa3d9c8c872702bab483344731f97c767ba4ca893e5a9657c9259"
  }
}
```

The hash is deterministic for the scenario input. It is a local-ledger artifact, not the on-chain one (the values happen to match because the scenario is the same; the testnet proof is a separate run).

## 6. Withdraw a credit

```bash
curl -fsS -X POST http://127.0.0.1:8789/api/credits/mira/withdraw \
  -H 'content-type: application/json' -d '{}' \
  | jq -e '.ok == true and .amountYocto == "5040000000000000000000" and .credits == "0"'; echo "exit=$?"
```

Expected: `true`, `exit=0`.

```json
{"ok":true,"amountYocto":"5040000000000000000000","credits":"0"}
```

A second call is a real error, not a silent success:

```bash
curl -s -o /tmp/queue-withdraw.json -w '%{http_code}\n' \
  -X POST http://127.0.0.1:8789/api/credits/mira/withdraw \
  -H 'content-type: application/json' -d '{}'
cat /tmp/queue-withdraw.json | jq -c .
```

Expected HTTP `409`, body `{"ok":false,"error":"There is no credit to claim for this agent.","code":"NO_CREDIT"}`. `curl -f` would exit `22` here.

## Exit codes at a glance

| Command | `0` | non-zero |
| --- | --- | --- |
| `curl -fsS` | HTTP 2xx | `22` on 4xx/5xx, `7` on connection failure |
| `jq -e` | filter is truthy | `1` if false/null, `2` on usage error, `5` on parse error |
| `npm run verify` | every gate that ran passed | a gate failed |
| `npm run verify:onchain` | all checks passed (41 `PASS` lines; 42 with a local reproducible build) | `1` mismatch, `2` RPC unreachable (SKIP) |
| `npm run test:contract` | Rust suite passed | test failure or missing `cargo` |

## What this does not prove

- The console API is a **local settlement ledger**. Steps 1–6 move no tokens and sign no transactions.
- `POST /api/demo/run` is a scripted scenario, not an autonomous agent.
- The local API has no user authentication by default and binds `127.0.0.1`. Do not expose it.
- The testnet proof is checked separately with `npm run verify:onchain`; see `docs/ONCHAIN.md`.
