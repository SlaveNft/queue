# QUEUE — research note

**Status:** working note for a hackathon build, not a peer-reviewed paper. Citations are real works but their bibliographic details were **not verified** for this release. Numbers come from the shipped seed, the TypeScript scheduler, and `data/onchain-proof.json`. Nothing here claims external demand, production security, or general welfare.

## Abstract

A single worker processes agent jobs in FIFO order. FIFO cannot express urgency, and the usual fixes are unilateral: an operator reorders, or a blind priority fee bids up the same slot without paying the jobs that move. This note asks whether a **posted-ask, deadline-feasible slot market** can reorder one FIFO queue while keeping every displaced job's *stated* deadline. The mechanism lets an urgent job buy a prefix of the queue; each displaced job moves back by exactly the urgent duration and is paid its published per-second ask; the contract refuses the whole purchase if any displaced finish would pass its deadline. We state four enforceable properties, two limits (cutoff sensitivity and non-truthful asks), and a testnet existence proof: 27 transactions, 7 of 7 jobs on time, one real refused jump. We do **not** show that the market beats earliest-deadline-first on on-time rate, nor that it improves welfare. The claim is narrower: it makes reordering consensual, compensated, and contract-checked.

## 1. Research question

**RQ.** Can a posted-ask, deadline-feasible priority market reorder a single FIFO agent-work queue without making the displaced jobs late — and what does that cost in welfare, incentives, and operator discretion?

Sub-questions:

1. Is there a settlement rule that is safe for every displaced *stated* deadline and picks the fewest displacements?
2. What can the contract enforce without trusting the operator for order or payment?
3. When is a jump priced efficiently, and when does holdout or a self-reported deadline capture the surplus?
4. Is the observed four-displacement result a property of the mechanism or of the chosen cutoff?

## 2. Contributions

- **C1 — rule and properties.** A latest-feasible-insertion rule with exact per-second compensation and four stated properties (P1–P4 below), implemented twice: Rust contract and TypeScript scheduler.
- **C2 — incentive analysis.** A candid account of why posted asks are not truthful, why all-or-nothing settlement gives every displaced job a veto, and why `max_spend` is a cap rather than a bid.
- **C3 — existence proof.** A live testnet deployment with 27 proof transactions, including a real failed purchase that the contract refused for a deadline violation.
- **C4 — counterfactuals.** A cutoff enumeration and an EDF baseline on the shipped seed (`docs/RESULTS.md`). This is **not** a 10,000-seed simulation.
- **C5 — open artifact.** Contract, scheduler, proof JSON, artifacts, and a headless verification path.

The novelty claim is the settlement rule and its deadline-safety property, not the existence of queues, priority, or auctions.

## 3. Model

There is one worker and a set of jobs `i = 1..n`. Job `i` has:

- duration `d_i > 0` (seconds);
- stated deadline `D_i` (absolute time);
- published ask `a_i >= 0` (yoctoNEAR per second of delay);
- reward `r_i > 0` and bond `b_i > 0`, escrowed;
- owner `o_i`.

An urgent job `u` has duration `d_u`, deadline `D_u`, value `V` to its owner, and a latest-start cutoff `L`. Its position in the queue is `p`. Insertion at index `k in [0, p]` gives

```
start(k)  = base + sum_{j < k} d_j
finish(k) = start(k) + d_u
```

where `base = max(now, running_start + running_duration)` if a job is running, else `now`. The displaced set `S(k)` is the jobs at indices `k..p-1`. Each moves back by `d_u`, so its new finish is `old_finish_i + d_u`.

**Feasibility.** `k` is eligible iff `start(k) <= L`, `finish(k) <= D_u`, and for every `i in S(k)`, `old_finish_i + d_u <= D_i`.

**Payment.** `compensation(k) = sum_{i in S(k)} a_i * d_u`; `fee = floor(compensation * fee_bps / 10_000)`; `total = compensation + fee`. The buyer also pays a non-refundable storage deposit.

**Welfare (definition only).** Let `c_i` be owner `i`'s cost per second of delay and `V` the buyer's value of the earlier start. Ignoring transfers and the fee, the welfare change from a trade is

```
ΔW = V * 1[trade] - sum_{i in S(k)} c_i * d_u - fee
```

We do **not** measure `V` or `c_i`. Compensation is a transfer from buyer to displaced owners, not a welfare loss; the fee is a transfer to the treasury. A positive `ΔW` is therefore an assumption, not a result.

## 4. Mechanism

1. The buyer supplies `L` and `max_spend`, and must be the job owner.
2. The protocol enumerates eligible `k` and picks the **largest** one. Because the displaced sets are nested (`S(k2) ⊂ S(k1)` for `k1 < k2`), the largest eligible index has the fewest jobs and, with non-negative asks, the lowest compensation.
3. If no `k` is eligible, the quote is infeasible and nothing moves.
4. On acceptance the queue is reordered, each displaced owner receives a pull-payment credit, the fee goes to the treasury, and the urgent job is marked expedited.
5. A purchase that would displace nobody is refused. The owner cannot buy a jump it does not need.
6. Completion is separate: `start_next` starts the head; `complete_job` pays the operator on time or marks the job missed. The contract does not verify work quality.

## 5. Properties

**P1 — Deadline safety.** For every accepted purchase and every `i in S(k)`, `new_finish_i <= D_i`, and `finish(k) <= D_u`.
*Argument:* the quote rejects the purchase if any condition fails; the contract recomputes the same quote at execution. This is safety for the **stated** deadline, not for the owner's true need. Testnet evidence: the refused transaction `CvUazo…` is a real `request_priority` that failed with `priority infeasible: displaced job 6 would finish at …, after its deadline …`.

**P2 — Latest-insertion minimality.** Among eligible insertions, the largest `k` minimizes `|S(k)|` and, with `a_i >= 0`, minimizes compensation.
*Argument:* `S(k)` is a suffix of the jobs ahead; moving later removes jobs from the set. The full proof sketch is in `docs/MECHANISM.md` §7. This is a statement about the chosen rule, not about global welfare.

**P3 — Conservation.** Every yocto that enters the contract leaves as a refund, a credit withdrawal, an operator reward, a treasury fee, or remains as a tracked liability. No path mints money.
*Argument:* submit escrows `reward + bond`; priority credits sum to `compensation + fee + excess`; completion, failure, cancellation, and timeout each settle escrow once; terminal states are immutable. **Caveat C3:** a failed native transfer can leave funds in the contract without restoring the recipient's credit. That is a liveness/accounting edge case, not minting.

**P4 — No free jump.** A purchase that displaces nobody is refused; only the owner can buy; an accepted purchase pays strictly positive compensation when `S(k)` is non-empty (assuming positive asks); the fee is at least zero and the storage deposit is non-refundable.
*Argument:* contract guards plus the no-op test. This prevents a "flip expedited for free" grief.

**P5 — Cutoff sensitivity.** The number of displaced jobs is a step function of `L`. On the shipped seed: `L < 11s` gives 4; `11–19s` gives 3; `20s` and above gives 2, because the urgent job's own 34s deadline caps the latest feasible start at 22s. Four is a start-as-soon-as-possible preference, not a deadline requirement. See `docs/RESULTS.md`.

**P6 — Non-truthfulness and holdout.** The posted ask is not a truthful bid. An owner can raise `a_i` after a quote; a front job can set a very high ask or a tight deadline and make a purchase infeasible. `max_spend` caps overpayment but does not elicit truth. Settlement is all-or-nothing, so each displaced job has a veto. The mechanism has no strategy-proofness, no ask cap, and no forced sale.

## 6. Incentives and holdout

- **Why asks are not truthful.** The ask is a posted price, not a dominant-strategy bid. An owner with slack sells position cheaply; an owner with a tight deadline or market power raises the ask or the deadline. There is no incentive-compatible payment rule (no Vickrey/Clarke/Groves construction) and no reputation.
- **All-or-nothing veto.** A single infeasible job blocks the entire prefix. This protects the displaced but gives a front job bargaining power. The buyer's recourse is a later insertion, a different cutoff, or no purchase.
- **`max_spend` is a cap, not a bid.** It protects against a last-second raise; it does not discover value. A loose cap can overpay relative to the displayed quote; a tight cap reverts.
- **Self-reported deadlines.** The contract enforces the deadline the owner writes. An owner can claim a tight deadline to block jumps, or a loose one to sell its slot. Deadline safety is therefore not welfare safety.
- **Repeated displacement and fairness.** The contract permits the same job to be displaced repeatedly, checking its deadline each time. It does not measure starvation, distribution of surplus, or "rich buyer" effects. This is a fairness gap, not a bug in P1.
- **Demand.** There is no evidence of external willingness to pay. The demo's asks are seeded, not learned. Fee revenue at 1% of compensation is tiny in the demo (`0.0002004 NEAR`), and compensation tends toward zero when queue slack is abundant. A production model would more plausibly charge a percentage of the job reward or an SLA premium; that is a hypothesis, not a result.

## 7. Related work

The table is a map, not a literature review. Bibliographic details are **not verified** in this release.

| Area | Representative work | Relation to QUEUE | Verified? |
| --- | --- | --- | --- |
| Externalities and bargaining | Coase (1960), *The Problem of Social Cost* | Compensation is a Coasean side payment; QUEUE fixes the rule and the enforcement, not the bargain | not verified |
| Auctions and mechanism design | Vickrey (1961); Clarke (1971); Groves (1973); McAfee & McMillan (1987) | QUEUE is posted-price, not an auction; it does not claim truthfulness or efficiency | not verified |
| Bilateral trade limits | Myerson & Satterthwaite (1983) | Explains why holdout and incomplete trade are expected, not defects | not verified |
| Queue tolls and priority pricing | Naor (1969); Mendelson & Whang (1990) | Closest formal relatives: price access to a congested queue | Mendelson–Whang not verified |
| Market design | Roth (2002) | Design stance: rules, thickness, and failure modes matter more than the optimizer | not verified |
| Industry practice | Airline voluntary bumping; cloud spot/preemptible capacity; on-chain priority fees; airport fast-pass; appointment rescheduling | The category exists; QUEUE's narrow difference is posted asks plus a deadline check per displaced job | industry practice, not a formal citation |

The gap: most priority systems price **access** or **speed**; QUEUE prices the **delay of specific displaced jobs** and refuses a move that breaks a stated promise. That is a small, testable difference, not a new chain primitive.

## 8. Experimental design

**Current evidence (this release).**

- L0: 37 v1 + 62 v2 + 95 v3 contract tests; 13 core, 8 ledger, 34 server, 9 web, 8 client, 17 season tests.
- L1: deterministic local scenario, 5 of 5 on time, four credits.
- L2: testnet proof, 27 transactions, 7 of 7 on time, four withdrawals, one real refusal.
- L3: cutoff enumeration and an EDF counterfactual on the shipped seed, in `docs/RESULTS.md`.
- L4: a 30-minute live season with eight model agents on testnet (138 jobs; market 135, FIFO 134, blind fee 134 with 4 broken promises; 0 jobs moved by a purchase ended late), in `docs/RESULTS.md` §3a. One seed, not a statistical study.

**Run so far:** 300 seeded seasons against FIFO and a blind fee (`docs/RESULTS.md` §3b): no moved job late, market +1.2% on time vs FIFO. A paired research simulator with waiting costs (`scripts/research/queue-sim.ts`, `npm run research:sim`, 200 seeds per load, output `data/research/queue-sim.json`): one worker; every job has a private value if on time and a private cost per second of waiting; market agents post their true waiting cost as their ask and buy the earlier slot with the highest net gain; FIFO, EDF, a planner who knows every waiting cost (Smith's rule), a blind fee, v2 and v3 all run the same jobs on the same worker. Results in §9. **Proposed larger simulation (not run here).** Five baselines: FIFO, EDF, operator discretion, blind priority fee, and QUEUE. Arrivals Poisson; durations lognormal; 20% tight deadlines; asks heterogeneous (1–5× a base rate); one to three buyers; 10,000 seeds. Metrics: on-time %, missed %, average delay, buyer cost, seller surplus, refusal/holdout %, welfare under stated `V` and `c_i`, minimum slack, and Gini of surplus. Report near-boundary cases separately. Until that exists, claims about average performance rest on the 300-season sweep and its scripted policy.

**Why EDF is the right foil.** On the shipped seed, EDF orders Kestrel (34s), Atlas (120s), Mira (150s), Juno (160s), Vale (180s), finishes everything by 54s, and pays nobody. On the live season's 138 jobs an EDF replay delivers 138 on time (market 135, FIFO 134). A contract could enforce EDF: it is a sort by a number the contract holds (it cannot check that the number is true). EDF is free and maximises the on-time count; QUEUE does not beat it there. What EDF ignores is the cost of waiting inside the deadline, and that is where a market has something to price: in the research simulator QUEUE v3 recovers more of the planner's welfare gain than EDF at every load tested (§9). If a judge values only the on-time count, EDF wins; if waiting has a cost, or reordering must be consensual and paid, QUEUE has a case.

## 9. Results

The shipped seed, computed with `quotePriority`:

| Latest-start cutoff | Displaced | Compensation | Fee | Total |
| ---: | ---: | ---: | ---: | ---: |
| 5 s | 4 | 0.02004 | 0.0002004 | 0.0202404 |
| 18 s | 3 | 0.015 | 0.00015 | 0.01515 |
| 20–22 s | 2 | 0.00804 | 0.0000804 | 0.0081204 |
| 34 s | 2 | 0.00804 | 0.0000804 | 0.0081204 |

The 34 s row is deadline-limited: inserting behind all four would start at 42 s and finish at 54 s, past the 34 s deadline. "Four slots" is true only under the 5 s start preference. This is the single most important qualification in the demo.

Research simulator (200 paired seeds per load; welfare gain is measured against FIFO and shown as a share of the planner's gain):

| Load | On time FIFO · EDF · planner · blind · v2 · v3 | Share of planner's gain: EDF · blind · v2 · v3 | FIFO-on-time jobs made late: EDF · blind · v3 |
| ---: | --- | --- | --- |
| 0.95 | 88.6 · 96.8 · 93.2 · 93.6 · 93.7 · 94.4 % | 43 · 32 · 55 · 64 % | 2.0 · 4.8 · 1.3 % |
| 1.1 | 82.5 · 92.6 · 88.5 · 88.0 · 87.2 · 88.7 % | 21 · 37 · 32 · 46 % | 5.2 · 9.1 · 2.9 % |
| 1.3 | 72.8 · 84.2 · 81.0 · 78.5 · 76.2 · 79.0 % | 12 · 62 · 12 · 38 % | 10.7 · 14.6 · 5.1 % |
| 1.6 | 59.8 · 72.7 · 71.0 · 65.1 · 62.0 · 66.2 % | 17 · 89 · 4 · 43 % | 16.2 · 18.6 · 7.8 % |

EDF is best on the on-time count at every load. v3 beats EDF on welfare at every load and makes the fewest FIFO-on-time jobs late. The rule that lets a job already projected to miss be passed (v3) is what keeps the market useful under overload: v2's share falls to 4% at load 1.6 because one hopeless job blocks every purchase behind it. In heavy overload a blind fee recovers more welfare than v3, by making more jobs late and paying none of the jobs it passes. Under every reordering rule a share of jobs ends with less utility than under FIFO (v3 30–47%, EDF 40–52%, blind fee 55–80%, at loads 0.95–1.6); a purchase is a trade both sides accept against the queue as it stands, not against the FIFO world, so this is not a contradiction, but it means no rule here is a Pareto improvement over FIFO. Assumptions that favour the market: asks equal true waiting costs and nobody states a false deadline (the simulator has flags for strategic deadlines and ask caps; their runs are not part of this result).

Testnet: Episode A delivered 5 of 5 on time with four paid displacements and four withdrawals; Episode B recorded a real refused jump and delivered 2 of 2. Total 7 of 7, 0 missed. The refusal is evidence of enforcement, not of demand.

## 10. Threats to validity

- **One worker, one queue.** No multi-worker contention, no routing, no admission control.
- **Deterministic durations.** The demo's timings are fixed; real jobs vary, and variance can break a deadline that the quote thought safe.
- **Scripted agents.** Five job actors, one operator, one auditor. No learning, no external LLM, no independent key-holding services in the local run; the testnet proof does use separate signing accounts.
- **One run.** The proof is a single scenario, not a distribution.
- **Stated deadlines.** Owners choose their own deadlines; strategic misreporting is not modeled.
- **Testnet only.** No mainnet, no audit, no adversarial economic environment, no real value.
- **No demand data.** Willingness to pay, arrival rates, and ask distributions are unknown.
- **One contract version.** The live proof is tied to the deployed wasm; the tree rebuilds to the same hash. A future contract change would need a new proof.
- **No simulation.** The L3 evidence is an enumeration, not a Monte Carlo study.

## 11. Falsification

The thesis would be weakened or falsified if:

1. EDF matches the on-time rate and displaced owners prefer unpaid reordering to a paid delay — then the market is a transfer with no efficiency or legitimacy gain.
2. Asks are unresponsive or zero in real workloads — then compensation and the 1% fee collapse, and holdout is the only source of positive price.
3. Owners strategically set deadlines so that stated-deadline safety diverges from actual welfare — then P1 is a formal guarantee about a self-reported input.
4. A single worker is never contended, or jobs are independent enough to parallelize — then the queue market solves a disappearing problem.
5. Repeated displacement starves a job while still meeting its deadline — then the fairness claim fails even though P1 holds.
6. The contract cannot enforce order or payment without trusting the operator — then the chain adds no guarantee over a database.

None of these has been tested at scale. They are the experiments the next version should run.

## 12. Conclusion and future work

QUEUE is a small, precise rule: buy a prefix, pay each displaced job its posted per-second price, refuse the trade if a stated deadline would break. It is implemented twice, proven on testnet, and honest about its limits. It is not a general scheduler, an auction, a reputation system, or a business.

Future work: a seeded simulation with FIFO/EDF/operator-discretion/blind-fee baselines; a near-boundary scenario with 1–3 seconds of slack; truthful-deadline mechanisms (stake, forfeit, commit-reveal asks); multi-worker queueing models; a private payout callback for C3; and a storage-deposit fix for C1/C2. A production version also needs an external audit, multisig/timelock for the FullAccess key, and real demand evidence.

## Appendix — property to evidence

| Property | Evidence in this repo |
| --- | --- |
| P1 deadline safety | `contracts/queue` deadline tests; `packages/core/test/scheduler.test.ts`; refused tx in `data/onchain-proof.json` |
| P2 latest insertion | `docs/MECHANISM.md` §7 proof sketch; `test_urgent_deadline_steers_insertion_index` |
| P3 conservation | contract escrow/solvency tests; `verify:onchain` payment checks |
| P4 no free jump | `test_zero_displacement_priority_is_refused_and_not_expedited`; owner-only test |
| P5 cutoff sensitivity | `docs/RESULTS.md`; `quotePriority` enumeration |
| P6 holdout | disclosed in `docs/SECURITY.md` and `docs/MECHANISM.md`; **no test yet** |

Reproduce the local checks with `npm run verify`, the testnet checks with `npm run verify:onchain`, and the headless API path with `docs/HEADLESS.md`.
