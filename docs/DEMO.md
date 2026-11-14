# QUEUE — demo runbook

A 60–90 second demo that shows one complete moment: an urgent job buys earlier slots, four agents are paid, the worker delivers an artifact before the deadline, and every crossed promise is checked.

The demo runs on the **local settlement ledger**. That is deliberate: it needs no wallet, no RPC, and no funded account. Say so on camera. The contract is live on NEAR testnet; the testnet proof is a separate CLI path. If `data/onchain-proof.json` is missing, say the proof is unavailable, not that the contract does not exist.

## 0. The ready-made films

`docs/media/queue-demo.mp4` (74 s, 1920×1080, captions, no narration) is a screen recording of the product itself: one click on **Run the live scenario** in the hosted console, the purchase and the four paid agents, the worker's artifact, the four displaced jobs delivering (that stretch plays at ×4 and says so on screen), a withdrawal, the live season's numbers and the refused jump. It is recorded by a script from the same static build the hosted link serves: `npm run build:pages && npm run film:demo`. The console in it is the local ledger running in the browser tab, labelled "Local ledger"; the season numbers and the refusal are read from NEAR testnet.

`docs/media/queue-explainer.mp4` is a finished 44-second narrated explainer (airport line → agents → the jump → refusal → 5/5 on time → NEAR → the live season → how it was tested). Post it as is, or open the post with it and follow with a 30–60 second screen recording of the live console below. Re-render after any change with `npm -w @queue/web run render:explainer`; preview and edit frames with `npm -w @queue/web run studio`.

## 1. Pre-flight (10 minutes before recording)

- [ ] `npm install` completed.
- [ ] `npm run verify` passes. Do not record a broken build.
- [ ] `npm run dev` is running; <http://localhost:4178> loads.
- [ ] `curl -s http://localhost:8789/api/health` returns `ok: true`.
- [ ] Click **Reset** so the console is in standby with four queued jobs.
- [ ] Close personal tabs, notifications, Slack, and anything with a key or email.
- [ ] Set the browser to 100% zoom, dark appearance (the site has one theme), 1440×900 or 1920×1080.
- [ ] Have this script on a second screen or a printed page.
- [ ] Check that `data/deploy.json` is not visible on camera and has no `secretKey` fields (verified: zero). Never show `.env` or `.testnet/`.
- [ ] Do one dry run. Check the displaced count and the artifact.
- [ ] Optional: set `QUEUE_HOST=127.0.0.1` and `QUEUE_OPERATOR_TOKEN` if the machine is on a shared network.

The scenario runs on real wall-clock; there is no speed switch in the app. If a recording plays any stretch faster, say so on screen, as the ready-made demo does with its ×4 badge.

## 2. What is on screen

| Area | What it shows | Where |
| --- | --- | --- |
| Hero | Headline, "Run the live scenario", network mode, fee, invariant | Top |
| Scenario strip | Arrival → quote → purchase → work → settled | Above the console |
| Queue rail | Four queued jobs, projected starts/finishes, deadlines, asks; Kestrel at **NOW** after the purchase | Left |
| Priority ticket | Selected job, latest-start slider, displaced list, checks, compensation/fee/total, **Buy earlier slot** | Center |
| Worker | Current job, progress, artifact Markdown, SHA-256, delivery checks | Right |
| Credits owed | Four displaced agents, amounts, **Withdraw** | Lower left |
| Ledger | Every event with actor, amount, job ID, priority ID | Lower right |
| Proof | Contract/proof status; "proof pending" when no file exists | Below the console |

## 3. The 90-second shot list

Use the exact button labels. The scenario auto-buys and auto-starts; do not click **Buy earlier slot** during the run.

| Time | Action | Say this | Do not say |
| --- | --- | --- | --- |
| 0:00–0:06 | Start on the hero. | "Someone late for a flight asks to cut ahead of you in line. What if they had to pay you — and couldn't, if it made you miss yours? That's QUEUE, for AI agents." | "This is production." |
| 0:06–0:14 | Hover the queue cards: Mira, Atlas, Vale, Juno. Point at projected starts and deadline ticks. | "FIFO is cheap, but one slow job makes every later job late. A normal priority fee would bid up the same slot and pay nobody who moved." | "FIFO is broken." |
| 0:14–0:18 | Click **Run the live scenario** (hero) or **Run scenario** (console). | "QUEUE makes the queue a posted-price market. The jobs that give up position set the price." | "It's an auction." |
| 0:18–0:25 | Let the scenario strip advance to **arrival**. Kestrel's card appears with 12s duration and a 34s deadline. | "Kestrel's board brief arrives with 12 seconds of work and a 34-second deadline. In FIFO it would start after four jobs and finish 20 seconds late." | "Kestrel is a real customer." |
| 0:25–0:35 | Watch the purchase land. The queue reorders; Kestrel is at **NOW** with a **Priority** badge; four cards move back and show `+amount`. Open **Credits owed** if it is not visible. | "At a five-second cutoff, the quote displaces all four. Mira gets 0.00504, Atlas 0.00696, Vale 0.00432, Juno 0.00372. Compensation is 0.02004; the 1% fee is 0.0002004; total 0.0202404 NEAR. Every displaced deadline is checked before the purchase." | "Four jobs are displaced" if the screen shows three. Read the screen. |
| 0:35–0:45 | Point at the worker progress and the scenario strip **work**. | "The operator runs the 12-second brief. The worker computes the artifact from the submitted incident log; it is not a hard-coded success." | "An LLM wrote this." |
| 0:45–0:55 | At **settled**, point at the artifact Markdown, the SHA-256, and the auditor event. | "The artifact lands before the 34-second deadline. The SHA-256 is recorded. The auditor checks the hash and the delivery time." | "The contract verified the work." The contract stores the hash; it does not judge quality. |
| 0:55–1:05 | In **Credits owed**, click **Withdraw** on Mira's row. Show the success banner and the row clearing. | "Displaced agents are paid by pull payment. Mira withdraws her credit; in local mode this is a ledger entry, not a NEAR transaction." | "Mira received an on-chain payment." |
| 1:05–1:15 | Open the ledger. Expand `priority.bought` or `priority.quoted`; show the four `slot.paid` rows and the `job.completed` / `audit.passed` rows. | "Every move is in the ledger: the quote, the four payments, the fee, the start, the artifact, the audit." | "The ledger is a blockchain explorer." |
| 1:15–1:25 | Scroll to the Proof section. If it shows "Deployment record found", open the contract and transaction links. If it says "proof pending", leave it. | "The console is a local rehearsal. The proof is a separate CLI run on NEAR testnet: the contract at `market.queue-demo.testnet`, 27 proof transactions, Episode A 5 of 5 on time, Episode B a real refused jump and 2 of 2 on time — 7 of 7 total, four credits withdrawn. Testnet only, not audited." | "Mainnet", "NEAR Intents", "audited", "trustless"; "this exact run is on chain" (the testnet run is separate). |
| 1:15–1:25 (alt) | If you skipped the ledger, stay on the console ~45s after **settled**: the worker runs Mira, Atlas, Vale and Juno; the **Priority receipt** turns to “4 of 4 crossed promises kept”. | "Then the worker keeps going. Every agent that sold its slot still delivers before its own deadline: five of five on time." | "Guaranteed" for the real world; the guarantee is the contract's deadline check plus this run. |
| 1:25–1:30 | End on the hero or the repo/README line. | "The queue is a market. The displaced agents get paid, and their deadlines stay intact. Repo and `npm run verify` are in the README." | "First/only", "production-ready", "real users", "revenue". |

The urgent moment is about 16 seconds; the worker then drains the four displaced jobs (about 45 seconds more) and the receipt ends at 4 of 4 promises kept. A strong cut: hook (6s) → purchase (15s) → artifact (10s) → speed-ramped drain to the receipt (10s, label it "sped up") → proof links (10s). Do not slow the runner. If you need more time, record a second angle or replay the settled screen, not a slowed app.

If you need a shorter cut, drop the ledger segment (0:55–1:05 can absorb one credit withdrawal) and keep the hook, the displacement, the artifact, and the limits. Do not drop the "local ledger" and "not audited" lines.

## 3a. The v2 season segment (30–40 s, record after the v1 cut)

The local scenario and the v1 proof show scripted roles and a deterministic worker. This segment shows the live season: model agents on NEAR AI, limited keys, and a model signature the contract checks. It reads the finished run from the repo and the queue from testnet; it spends nothing.

| Time | Action | Say this | Do not say |
| --- | --- | --- | --- |
| 0:00–0:08 | Scroll to section **04 Live season · NEAR testnet**. Point at the three-row table. | "Then we let eight agents decide for themselves: each is a Qwen model on NEAR AI with a private budget and deadlines, signing with a key that can call five contract methods." | "Autonomous agents" without the limits; "they learn". |
| 0:08–0:16 | Point at the feed: sable's **bought priority** on #258 and its reason. | "Sable's model bought priority for a high-value task. Every job it passed was paid its own price, and none of the moved jobs ended late." | "The market beats FIFO." On throughput it is level within the timing noise. |
| 0:16–0:24 | Point at the red callout, then open its tx [`3BrEneh1…`](https://testnet.nearblocks.io/txns/3BrEneh1ypSrWAGtr73nU6hE4u5wRSzJFsWbeKjtUhdj). | "Kestrel's model tried a jump that would have made another agent late. It failed on chain, with the reason in the transaction." | "Impossible to break" (it is the projected schedule; the operator is trusted for liveness). |
| 0:24–0:34 | Open a settlement, e.g. [`Hnuu7i6H…`](https://testnet.nearblocks.io/txns/Hnuu7i6H3qH1v56gudxjL5aVQAGRVjo8FDc6ag9XZ2K8) (`complete_job_attested`, job 145). | "The worker answers on NEAR AI. The contract hashes the answer itself and checks the model's signature over that job's exact request before it pays." | "Trustless TEE" (the key is owner-pinned from NEAR AI's report; the hardware quote is not verified here). |
| 0:34–0:40 | Show the README line `npm run verify:season`. | "Anyone can re-check the season from chain data with one command, no keys." | "Audited." |

## 4. Full local scenario timeline

The runner is real wall-clock. The exact times can vary by a second; the order does not.

| Wall clock | Scenario phase | What happens | Where to see it |
| ---: | --- | --- | --- |
| 0.0s | standby → arrival | Reset; four jobs seeded: Mira 11s, Atlas 9s, Vale 10s, Juno 12s; deadlines 120–180s; asks 0.00031–0.00058 NEAR/s | Queue rail; scenario strip |
| ~1.6s | arrival → quote | Kestrel's urgent job is created: 12s, 34s deadline, 0.02 NEAR reward, 0.015 NEAR bond; quote at `latest_start_at = now + 5s`; four displaced; compensation 0.02004; fee 0.0002004; total 0.0202404 | Queue rail; ledger `priority.quoted`; scenario step "arrival" |
| ~2.8s | purchase | Queue reorders; four credits; Kestrel expedited; four `slot.paid` events | Queue rail; Credits owed; ledger |
| ~3.8s | work | Operator starts Kestrel; worker progress begins; 12-second duration | Worker panel; ledger `job.started` |
| ~15.8s | settled | Artifact Markdown; SHA-256; deadline check; `job.completed`; `audit.passed`; scenario done | Worker; ledger; scenario strip |
| any time after ~2.8s | — | Four credits are claimable; **Withdraw** clears one and logs `credit.withdrawn` | Credits owed; ledger |
| any time | — | **Reset** returns to standby; running timers are cleared | Console header |

`scripts/verify.sh` polls for `status: "done"` and `audit.passed` (up to 30 seconds), then waits for the 5/5 drain (up to ~70 seconds); that is the automated version of the same timeline.

## 5. How to inspect the quote without the auto-run

The auto scenario buys ~1.2 seconds after the quote, so the ticket may move on. If you want to show the quote math on camera, do a separate take:

1. Click **Reset**.
2. Click **New job**.
3. Create a fifth job: owner **Kestrel**, task **incident-triage**, title "Board brief: checkout incident", duration **12**, deadline **34** seconds, reward **0.02**, bond **0.015**, ask **0.0006**. Use any valid brief and the incident log input; the quote does not depend on the text.
4. Select the new job in the **Priority ticket**.
5. Set **Latest start** to **5s** (drag the slider; the default is 18s).
6. Read the quote: four displaced, per-agent amounts, compensation, fee, total, checks. Do **not** click **Buy earlier slot** if you want to keep the standby story.
7. Click **Reset** before the main run.

With a fifth urgent job behind four queued jobs, the default 18s cutoff displaces **three** jobs, not four. That is correct math, not a bug. Use 5s for the four-displaced moment. If you select one of the four standby jobs instead, there is no job ahead of it to displace, so the quote is a no-op. The contract rule is the same; only the cutoff input differs. See `docs/MECHANISM.md` §9.

## 6. Safe claims and forbidden claims

### Safe, evidence-backed lines

- "The quote displaced four jobs" — only if the screen shows four.
- "Each displaced job is paid its published ask × the urgent job's duration." — exact math in the ledger.
- "The protocol refuses a purchase that would move a displaced job past its deadline." — quote checks; contract rule.
- "The worker computed this artifact from the submitted incident log." — the artifact is deterministic; the input is visible.
- "This is a local settlement ledger, not a NEAR transaction." — the UI says so.
- "The contract is testnet-only and not audited." — true.
- "Testnet deployment is pending" — if `data/onchain-proof.json` is absent.
- "The operator is trusted for liveness and artifact attestation." — honest limitation.

### Do not say

| Claim | Why not |
| --- | --- |
| "Production-ready" | No audit, no mainnet, no multi-tenant auth, no SLA. |
| "Audited" | Not audited. |
| "Mainnet" / "live on mainnet" | Testnet only. |
| "NEAR Intents" / "cross-chain" / "chain signatures" | Not used. |
| "Trustless" | The operator is trusted for liveness and attestation; the admin can pause. |
| "The bond prevents fake bookings" | A missed job is refunded reward + bond; the bond prices cancellation, not no-show. |
| "The contract verifies the work" | It stores the artifact hash; it does not judge quality. |
| "Real users" / "revenue" / "waitlist" | No such data. Do not invent it. |
| "First" / "only" / "unique" | Unverified. The closest category is paid priority/queue markets. |
| "Zero fees" / "free" | NEAR transactions cost gas; the protocol fee is 1% of compensation. |
| "Instant finality" | Do not claim a finality property you have not measured. |
| "Four jobs displaced" when the screen shows three | Read the screen; the cutoff changes the result. |
| "On-chain" for a local row | Local rows are ledger entries. |
| "An LLM agent wrote this" (local demo, v1 proof) | In the local demo and the v1 proof the worker is deterministic; no external LLM. Only the v2 season uses NEAR AI. |
| "The market beats FIFO" (season) | On throughput it is level with FIFO within the replay's timing noise. Say: moved jobs were paid and none ended late; a blind fee breaks promises unpaid. |

## 7. Fallbacks

### The API is offline

1. Show the console's "API not running" state; it gives the exact command.
2. In a terminal: `npm run dev`.
3. Wait for `api http://localhost:8789` and `web http://localhost:4178`.
4. Click **Retry** in the console, or reload.
5. If it still fails, check `curl -s http://localhost:8789/api/health` and the terminal error. Do not fake the queue.

### The scenario is already running

The console asks for confirmation before starting another run. Either wait for **settled** or click **Reset** first. Do not start a second scenario on top of a running one.

### The testnet RPC is down

The local demo does not need RPC. Stay in local mode and say "local settlement ledger." If you wanted to show the testnet proof, say "the testnet proof is temporarily unavailable; the local rehearsal is the reproducible path." Do not substitute a local row for a transaction.

### The proof file is missing or stale

The contract is live at `market.queue-demo.testnet`, but the console reads `data/onchain-proof.json`. If that file is missing or does not match the contract, the Proof section says "Local rehearsal · proof pending." Say "the proof file is unavailable; the deploy and proof commands are in `docs/ONCHAIN.md`." Do not type a contract ID or hash by hand. If you need the proof on camera, run `npm run demo:onchain` and verify the output first.

### The worker fails or the artifact is missing

Show the error text. Do not claim success. Click **Reset** and run again. If it fails consistently, run `npm run verify` and read the failing step; record only after it passes.

### The browser is stale or the port is taken

- Hard reload (Cmd/Ctrl+Shift+R).
- Check ports: `lsof -nP -iTCP:4178 -sTCP:LISTEN` and `lsof -nP -iTCP:8789 -sTCP:LISTEN`.
- Stop the conflicting process, then `npm run dev`.
- If SQLite is corrupted: stop the server, remove `data/queue.db*`, restart (it reseeds).

### The recording is bad

Record another take. Do not edit the video to hide a failure or to splice in a different run. If you use a backup recording, label it as a backup of the same build; do not present a stale run as live.

## 8. How to record

### Setup

- **Resolution:** 1440×900 or 1920×1080, 30 or 60 fps.
- **Audio:** microphone close to the speaker; record system audio only if you need the UI sounds (there are none required).
- **Music:** none. Do not add copyrighted music.
- **Browser:** dark appearance; 100% zoom; hide the bookmarks bar and personal tabs; disable notifications.
- **Cursor:** visible; move slowly; do not circle things with the mouse for seconds.
- **Script:** second monitor or printed; speak naturally, not read-only.

### Capture

- **QuickTime Player (macOS):** File → New Screen Recording → select the screen/window → record. Use the microphone input.
- **OBS:** Display Capture + Audio Input Capture; 30/60 fps; record to MP4/MKV.
- Record a 3-second lead-in and a 3-second tail so the edit is easy.
- Keep the full run; do not cut the 12-second worker into a jump cut that implies instant work.

### Export and post

- Export H.264 MP4, 1080p or 1440×900. Check the file plays on another device.
- Watch it once with sound. Check: "local ledger" is audible, no false claims, no keys, no personal data.
- Add captions (burned-in or the platform's auto-captions). Verify the numbers and "not audited."
- Upload natively to X; keep a copy and an unlisted backup link.
- The human writes and posts the text; the agent does not post.
- The post must say the project was built at NEAR HACKATHON, tag `@NEARProtocol`, and include `#NEARHackathon`. Attach the video or screenshots.

### Length

- Target 75–90 seconds. The local scenario itself is ~16 seconds; the rest is explanation, the artifact, the credit, and the limits.
- If you cut to 60 seconds, keep: the hook, the four displacements/credits, the artifact hash, one limit ("local ledger, testnet only, not audited"), and the repo.
- Do not use a 3-minute architecture tour. One complete moment is the point.
