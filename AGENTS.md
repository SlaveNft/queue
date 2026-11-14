# AGENTS.md — the cast, the build, and the honesty boundary

QUEUE uses the word **agent** in its economic sense: a software actor with a job, a deadline, a balance, and a policy. There are two casts. In the local demo and the v1 proof the agents are scripted and the worker is a deterministic analyst, so both re-run with no API key; sections 1–4 describe them. In the v2 live season (section 6a) eight agents decide with a model on NEAR AI, the worker answers on NEAR AI, and every delivered job was settled through the contract's check of the model's signature (the contract also keeps an unsigned `complete_job`; a job settled that way is marked unattested on chain, and the season did not use it).

## 1. Runtime cast

The demo uses seven named roles: five job actors (Kestrel plus four slot holders), one operator, and one auditor. They are personas in one ledger engine (`packages/ledger`: behind the Express API locally, inside the browser tab on the hosted page), not seven independently operated processes. The local console and the live testnet proof use the same names: `mira.queue-demo.testnet`, `atlas.`, `vale.`, `juno.`, `kestrel.` (the buyer), `worker.` and `treasury.queue-demo.testnet`, with the contract at `market.queue-demo.testnet` (the auditor is a console-only role with no chain account). In the console they are display names; in the proof they are real testnet accounts that sign their own transactions. Neither is a claim that the roles operate as independent services.

| Agent | Role | Handle | Account label | What it does |
| --- | --- | --- | --- | --- |
| **Kestrel** | Urgent buyer | `@kestrel.ops` | `kestrel.queue-demo.testnet` | Brings a 12s board brief with a 34s deadline; buys four earlier slots; pays compensation + 1% fee |
| **Mira** | Slot holder | `@mira.research` | `mira.queue-demo.testnet` | 11s incident triage; ask 0.00042 NEAR/s; deadline 150s |
| **Atlas** | Slot holder | `@atlas.data` | `atlas.queue-demo.testnet` | 9s settlement audit; ask 0.00058 NEAR/s; deadline 120s |
| **Vale** | Slot holder | `@vale.comms` | `vale.queue-demo.testnet` | 10s launch brief; ask 0.00036 NEAR/s; deadline 180s |
| **Juno** | Slot holder | `@juno.watch` | `juno.queue-demo.testnet` | 12s latency summary; ask 0.00031 NEAR/s; deadline 160s |
| **Operator** | Worker | `@queue.worker` | `worker.queue-demo.testnet` | Starts the head; runs the 12s job; records the artifact hash; settles |
| **Auditor** | Verifier | `@queue.audit` | `auditor.queue-demo.testnet` | Checks the SHA-256, delivery time, and payment events; no write authority |

The four slot holders publish different asks. That is the market: the price to move a job is set by the job being moved, not by the buyer. The differences are small in the demo, but they are the reason the compensation line is a sum of four different products, not one flat fee.

## 2. What each agent actually is

### Kestrel — the urgent buyer

Kestrel is a scripted buyer with a board-call deadline. Its job is 12s of work with a 34s deadline, a 0.02 NEAR reward, and a 0.015 NEAR bond. It does not negotiate in rounds. The scenario gives it a latest-start cutoff of `now + 5s` and a max spend of `0.05 NEAR`; the protocol returns a quote and the scenario buys it.

In a production version, Kestrel could be an independent process with its own key, a budget policy, and a retry policy. In this build it is a role in the server scenario so the whole moment is reproducible with one command.

### Mira, Atlas, Vale, Juno — the slot holders

Each is a queued job with a duration, deadline, reward, bond, and published ask. They are not passive: their asks determine what a jump costs. A slot holder with slack can earn by being displaced; a slot holder with a tight deadline is protected by the quote, which refuses a move that would break it.

Their asks in the local demo:

| Agent | Job | Duration | Deadline | Ask/sec | Paid for 12s |
| --- | --- | ---: | ---: | ---: | ---: |
| Mira | Triage the checkout incident | 11s | 150s | 0.00042 NEAR | 0.00504 NEAR |
| Atlas | Audit the failed settlements export | 9s | 120s | 0.00058 NEAR | 0.00696 NEAR |
| Vale | Draft the Northline pilot brief | 10s | 180s | 0.00036 NEAR | 0.00432 NEAR |
| Juno | Summarize the latency escalation | 12s | 160s | 0.00031 NEAR | 0.00372 NEAR |

The asks are seeded, not learned. The demo does not claim that these are profit-maximizing prices. They are a documented policy that makes the compensation math visible.

### Operator — the single worker

The operator is the trusted service role. It starts the head of the queue (`start_next`), runs the job for its quoted duration, computes the artifact, and calls `complete_job` with the SHA-256. It cannot start an arbitrary job; the contract starts the head. It cannot unilaterally take user credits; credits are pull payments.

The operator is trusted for two things the contract cannot verify: **liveness** (it actually starts and finishes work) and **attestation** (the hash corresponds to useful work). The local worker and auditor check both in the demo; on-chain, the hash is an operator attestation. Do not describe the operator as trustless.

### Auditor — the demo's verifier

The auditor is a read-only role. After a delivery it checks:

- the artifact's SHA-256 is well-formed and matches the recorded hash;
- the finish time is at or before the deadline;
- the payment events and credits agree with the quote.

It emits `audit.passed` or `audit.failed` in the ledger. It has no authority to move funds or change the queue. It is a demo check, not a third-party audit.

## 3. The demo sequence

| Time | Actor | Action | Visible result |
| ---: | --- | --- | --- |
| 0.0s | Scenario | Reset; seed Mira, Atlas, Vale, Juno | Four queued jobs with projected starts |
| ~1.6s | Kestrel | Submit the 12s / 34s board brief | Urgent card; scenario phase `arrival` |
| ~1.6s | Protocol | Quote at `now + 5s` | Four displaced; compensation 0.02004; fee 0.0002004; total 0.0202404 |
| ~2.8s | Kestrel | Buy priority | Queue reorder; four credits; `priority.bought` + four `slot.paid` |
| ~3.8s | Operator | `start_next` | Worker progress; `job.started` |
| ~15.8s | Operator | `complete_job` with SHA-256 | Artifact; `job.completed`; `audit.passed`; scenario `settled` |
| Any time | Slot holder | `withdraw_credit` | Credit clears; `credit.withdrawn` |
| Any time | Anyone | Reset | Standby queue; timers cleared |

The exact numbers and the deadline checks are in [`docs/MECHANISM.md`](docs/MECHANISM.md).

## 4. Honesty boundary

**The local analyst is deterministic. No external LLM is required.** (Local demo and v1 proof; the v2 season is in section 6a.)

- The worker supports three task types: `incident-triage`, `csv-audit`, and `launch-brief`.
- It parses the submitted text/CSV, extracts signals and numbers, and renders a Markdown artifact from fixed templates.
- It records a SHA-256 and structural checks (source present, signals extracted, numbers preserved, format).
- It does **not** call an LLM, an inference API, or a hosted model. There is no API key and no model bill to reproduce the demo.
- It is not an independent incident diagnosis, a financial audit, or a legal review. The artifact says so in its own footer.
- Because there is no LLM, there is no prompt-injection surface in the worker. If an LLM is added later, that changes the threat model and must be disclosed.

The agents are also scripted:

- Kestrel's purchase is a scenario step, not an autonomous negotiation.
- The slot holders' asks are seeded, not learned or bid.
- The operator starts and completes on a timer.
- The auditor checks deterministic conditions.
- There is no multi-agent emergent behavior, no reinforcement learning, and no external tool use.

This is still a real multi-agent **economic** system: the roles have separate balances, credits, deadlines, and incentives, and the contract settles them. The demo proves the mechanism, not general intelligence.

## 5. Build swarm

This repository was built by a small agent swarm with strict file ownership. The same boundaries apply to future contributors.

| Role | Owns | Responsibilities |
| --- | --- | --- |
| **Lead / integrator** | `packages/core/**`, `packages/ledger/**`, `apps/server/**`, `scripts/**`, root configs | Shared types, scheduler, API, worker, persistence, deploy/proof scripts, integration |
| **Contract agent** | `contracts/queue/**` | Rust contract, unit tests, wasm build, parity with the TypeScript scheduler |
| **Web agent** | `apps/web/**` | React console, accessibility, responsive layout, live state |
| **Docs agent** | `README.md`, `LICENSE`, `AGENTS.md`, `llms.txt`, `docs/**` | Spec, mechanism, security, demo, submission, X drafts |

Rules:

1. Read `docs/SPEC.md` before changing an interface. If a change is necessary, update the spec and tell the lead.
2. Do not edit another owner's files. Report interface mismatches instead of patching around them.
3. Every demo action must go through the same API and engine a normal user would use. No hidden shortcuts.
4. No invented blockchain numbers, transaction hashes, users, revenue, or test counts.
5. Local mode is a **local settlement ledger**, never an on-chain transaction. Testnet proof is read from real files.
6. No secrets in the repo. `.env` and `.testnet/` are git-ignored.
7. Run `npm run verify` before claiming a change is done.

## 6. If you add an LLM or an autonomous agent

The current demo must remain reproducible without it. If you add one:

- Disclose it in the README and in the demo video.
- Keep the deterministic worker as the default path or a fallback.
- Do not give the model a signing key. The model may propose; a policy layer and a human/operator execute.
- Sandbox tool access; log inputs, outputs, and tool calls; cap spend.
- Treat model output as untrusted text. Do not render raw HTML; do not execute it.
- Re-run the security review: prompt injection, data exfiltration, runaway spend, and non-deterministic demos are new threats.
- Do not claim "autonomous" unless the agent actually chooses and executes within a bounded policy without a human in the loop.

## 6a. The v2 season: model agents

The v2 season (`docs/SEASON.md`) follows §6:

- **Disclosed:** README, `llms.txt` and `docs/SEASON.md` say which runs use a model. The local demo and the v1 proof still use the scripted cast and the deterministic worker; the season's fallback policy is labelled in every log line.
- **No model holds a key.** Each agent's model returns one JSON proposal with a reason. Code clamps it (asks within a ceiling and at most ×4 per turn, spend capped by the task's private value and the balance, only the agent's own job ids), then signs with the agent's function-call key, which can call five methods on one contract and cannot attach NEAR.
- **Inputs are not open text.** Agents read public queue numbers and their own private task brief; the worker answers fixed task prompts. The worker enforces this in code: it answers only this season's agents' jobs, and reads a request body only from the run's own `requests/<sha256>.json` whose content hashes to the job's `input_hash` (a job's `input_uri` is used only after a pattern check and a content-hash check, never as a free path). Any other job is settled without a model call, labelled. A future open-input version must re-run the security review.
- **Keys the runtime process holds:** the eight agents' function-call keys, the operator's key, and, for balance top-ups, the eight owners' full-access keys. Models never see any key; only code signs.
- **Spend is capped twice:** by the balance deposited in the contract (queue actions) and by the key's gas allowance (fees only).
- **Autonomy, precisely:** within those limits the agents choose prices, purchases, cancellations and waits without a human in the loop for 30 minutes. They do not learn across runs, and they are one runtime process with eight keys, not eight independent services.

## 6b. The v3 contract: what the operator answers for

The current rules (`contracts/queue-v3`, `market5.queue-demo.testnet`, [`docs/V3.md`](docs/V3.md)) change the operator's role from "trusted" to "trusted and liable":

- **The operator posts a stake.** A job the schedule promised that then misses or fails is paid its priority spend plus its reward from that stake, as far as the stake goes. Refusing a queued job returns its priority spend from the stake too.
- **The operator chooses its clients.** Because its stake pays for refusals, only accounts it approved can submit (`allow_clients`); this deployment is a closed pilot with the eight season accounts.
- **The stake cannot leave under an open promise.** A withdrawal waits 24 h and is refused while any job is queued or running; the operator cannot be replaced while a job is open.
- **A model job is paid only for a model-signed answer.** The operator's word is refused for it.
- **The owner's contract methods wait 24 h.** The contract account's test full-access key can still redeploy the code directly; that limit is stated wherever the timelock is.
- **An outside agent** can read the queue and get quotes with `packages/client` (CLI, MCP server); to submit it must be approved by the operator.

## 7. Known limitations of the cast

- The operator is trusted for liveness and artifact quality (v3: liable with a stake, up to what is left of it).
- The bond prices cancellation, not no-show; a missed job is refunded reward + bond.
- There is no Sybil resistance; testnet accounts are free.
- A front job can hold out with a high ask or a tight deadline.
- The demo's agents are personas in one process, not independent key-holding services.
- The auditor is a demo verifier, not an external audit.
- The worker's output is deterministic extraction, not general analysis.

These are stated in the README, `docs/MECHANISM.md`, and `docs/SECURITY.md`. Keep them stated. The project is stronger for being precise about what it is not.
