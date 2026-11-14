# QUEUE — results and counterfactuals

**Scope:** reproducible numbers from the shipped seed and the testnet proof. This is not a simulation study. It does not measure demand, welfare, or average performance.

## 1. Evidence ladder

| Level | Evidence | Status |
| --- | --- | --- |
| L0 | 37 v1 + 62 v2 + 95 v3 contract tests; 13 core + 8 ledger + 34 server + 9 web + 8 client + 17 season tests | Passes on this tree |
| L1 | Local scenario: 4 displaced, 4 credits, 5/5 on time, 0 missed | `npm run verify` |
| L2 | Testnet: 27 proof txs, 5 submits, 4 withdrawals, 7/7 on time, 1 refused jump | `npm run verify:onchain` |
| L3 | Cutoff enumeration and EDF counterfactual on the shipped seed | This document |
| L4 | A live 30-minute season on testnet, 8 model agents on NEAR AI: 138 jobs, 4 paid purchases (5 jobs moved back and paid, 0 of them late), one unsafe jump refused on chain, 135 signature-checked settlements; on time 135 vs 134 for FIFO and for a blind fee | `npm run verify:season` (§3a) |
| L5 | 300 simulated seasons (rules checked against the contract): 0 of 3,464 moved jobs late; market +1.19% on time vs FIFO, 95% CI [+1.07%, +1.31%] | `npm run season:sweep` (§3b) |
| L5 | Random-history invariants (600 histories), simulator-vs-contract replay (24,866 steps), mutation testing (92 of 95 caught, 3 equivalent), 8 planted bugs caught by every suite | [`TESTING.md`](TESTING.md) |

L3 is an enumeration on one scenario. The Monte Carlo evidence is L5: 300 seeded seasons of the simulator with a scripted policy (§3b); it is not a 10,000-seed study and has three baselines, not five.

## 2. Cutoff sensitivity

Computed with `quotePriority` and the shipped seed (Mira 11s, Atlas 9s, Vale 10s, Juno 12s; urgent 12s / 34s deadline; asks 0.00042 / 0.00058 / 0.00036 / 0.00031 NEAR/s).

| `latestStartAt` | Insert index | Displaced | Compensation | Fee (1%) | Total |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 5 s | 0 | 4 | `0.02004` | `0.0002004` | `0.0202404` |
| 11 s | 1 | 3 | `0.015` | `0.00015` | `0.01515` |
| 18 s | 1 | 3 | `0.015` | `0.00015` | `0.01515` |
| 20 s | 2 | 2 | `0.00804` | `0.0000804` | `0.0081204` |
| 22 s | 2 | 2 | `0.00804` | `0.0000804` | `0.0081204` |
| 34 s | 2 | 2 | `0.00804` | `0.0000804` | `0.0081204` |

Reading:

- The step at 11s is Mira's projected start; the step at 20s is the start after Mira, Atlas, and Vale.
- The urgent job's own finish must be `<= 34s`, so a start above 22s is infeasible. The 34s row is therefore **deadline-limited**, not a zero-displacement result. Inserting behind all four would start at 42s and finish at 54s.
- "Four slots" is true only under the 5s start-as-soon-as-possible preference. If only the 34s deadline binds, the result is **two**.
- The rows above are deterministic for this seed. Do not generalize them to other durations or deadlines.

## 3. EDF counterfactual

Earliest-deadline-first on the same five jobs:

| Order | Job | Duration | Deadline | Finish |
| ---: | --- | ---: | ---: | ---: |
| 1 | Kestrel (urgent) | 12s | 34s | 12s |
| 2 | Atlas | 9s | 120s | 21s |
| 3 | Mira | 11s | 150s | 32s |
| 4 | Juno | 12s | 160s | 44s |
| 5 | Vale | 10s | 180s | 54s |

EDF meets every deadline, pays no compensation, and needs no purchase. QUEUE also meets every deadline, but pays four owners `0.02004 NEAR`. On this instance, QUEUE does **not** improve the on-time rate; it changes who bears the delay and whether they are paid. That is the honest comparison. See `docs/RESEARCH.md` §8.

## 3a. Live season on testnet (v2)

One 30-minute season, one seed, on `market4.queue-demo.testnet` (details and transaction links in [`docs/SEASON.md`](SEASON.md)). Eight agents decided with a model on NEAR AI; 138 jobs ran.

| Same 138 jobs | On time | Value on time (private, NEAR) | Paid to jobs moved back | Late, though on time under FIFO |
| --- | ---: | ---: | ---: | ---: |
| QUEUE market (what ran) | **135** | **5.895** | 0.0965 NEAR | **0** |
| FIFO counterfactual | 134 | 5.816 | — | — |
| Blind fee counterfactual | 134 | 5.746 | 0 | 4 |

The market row is read from chain. The counterfactuals replay the same jobs with each job's real service time and one measured constant, the gap between jobs (3.93 s); replaying the market's own order under that model reproduces the chain exactly (135). Across ±0.5 s of the gap the three rules stay within a job or two of each other (3.43 s: 136 / 136 / 136; 4.43 s: 132 / 131 / 132), so on throughput the market is level with FIFO. It reorders one queue; it does not add capacity.

What does not depend on the timing model: 4 purchases moved 5 jobs back, each was paid its own posted price, and none of them ended late; a model's unsafe jump was refused on chain; the blind fee makes 4 jobs late that FIFO would deliver and pays their owners nothing. One seed: evidence that the rule holds with model agents, not a welfare ranking.

## 3b. Monte Carlo sweep of the rules (simulator)

The live season is one seed. To see the distribution, the same rules were run 300 times in the simulator: 100 seeds at each of three arrival rates (1.0, 1.25, 1.5), 30 minutes each, 39,318 jobs and 2,092 priority purchases in total. The simulator is checked against the contract step by step (`npm run test:parity`), and the agents use a scripted policy, not a model. Each season is paired with FIFO and a blind fee on the same jobs. Reproduce: `npm run season:sweep` (about 6 minutes, no network); results in [`data/season/sweep.json`](../data/season/sweep.json).

| Question | Result across 300 seasons |
| --- | --- |
| Does a job moved back by a purchase ever end late? | **Never: 0 of 3,464 moved jobs** |
| Does the market deliver fewer jobs on time than FIFO? | **No, more: +1.19% of jobs**, 95% CI [+1.07%, +1.31%] (bootstrap over seasons); ahead in 228 seasons, level in 64, behind in 8 |
| Does it hold at every load? | Yes: +1.15%, +1.63% and +0.79% at arrival rates 1.0, 1.25 and 1.5 |
| How does a blind fee compare on fairness? | It makes 3,901 jobs late that FIFO delivers (9.9% of jobs, in 266 seasons); the market, 682 (1.7%), none of them a job it moved |
| Is more private value delivered than under FIFO? | Yes: +0.136 NEAR per season, 95% CI [0.122, 0.150] |

| 300 seasons | On time | Jobs FIFO delivers that this rule makes late |
| --- | ---: | ---: |
| QUEUE market | 90.7% | 1.7% |
| FIFO | 89.5% | — |
| Blind priority fee | 91.1% | 9.9% |

What the sweep adds to the live season:

- **The safety rule holds across the distribution**, not only in one run: a job that a purchase passes is never made late.
- **The market delivers more than FIFO**, by about 1.2 jobs in 100, at every load tested. A buyer that would have been dropped as late is delivered instead. A blind fee delivers 0.4% more than the market, at six times the cost to other jobs.
- **Scope of the guarantee.** The contract guarantees every job's posted schedule. The 1.7% are jobs that were never moved: they kept that schedule, and would have gained time only if the late buyer ahead of them had been abandoned, as FIFO does.

These are results of a scripted policy in a simulator: they describe the rule, not how model agents trade.

## 4. Testnet evidence

From `data/onchain-proof.json` (`ok: true`):

| Item | Value |
| --- | --- |
| Proof transactions | 27 from seven role accounts; deploy/init is a separate 28th tx (eight signers total) |
| Episode A | 5 submits, 4 displaced and paid, 5/5 `DONE` on time, 4 credits withdrawn |
| Episode B | 1 real failed `request_priority`, 2/2 `DONE` on time, nothing moved |
| Contract counters | 7 submitted, 7 completed, 0 missed, 0 cancelled, escrow 0 |
| Refusal error | `priority infeasible: displaced job 6 would finish at 1794560487, after its deadline 1794560471` |
| Urgent artifact | SHA-256 `5159aede574aa3d9c8c872702bab483344731f97c767ba4ca893e5a9657c9259` |

The refusal is the strongest evidence in the release: it is a real failed transaction, not a UI state. It proves enforcement of P1 for one case, not demand or general safety.

## 5. What is not measured

- Willingness to pay, arrival rates, and ask distributions.
- Welfare (`V`, `c_i`) and surplus distribution.
- Starvation or fairness under repeated displacement.
- Near-boundary safety (1–3 seconds of slack). The testnet displaced jobs have 121–141 seconds of slack; the refusal case is the only tight one.
- Multi-worker behavior, adversarial asks, strategic deadlines.
- Production security, mainnet behavior, or audit results.
- A future contract change: the proof covers the currently deployed wasm only.

## 6. Reproduce

```bash
npm run verify            # L0 + L1, exit 0 on success
npm run verify:onchain    # L2, exit 0 / 1 / 2
```

For the cutoff table, call the pure scheduler with the shipped jobs or read the same values from the console's priority ticket. The exact yocto strings are in `packages/core` tests and in the quote response; the decimal values above are formatted for readability.

## 7. Next experiments

1. A larger sweep (10,000 seeds) with the EDF and operator-discretion baselines added to FIFO and the blind fee, and with model agents instead of the scripted policy.
2. Near-boundary scenario and a refusal at 1-second shortfall.
3. Holdout case: front-job ask ×10, and a buyer with a tight `max_spend`.
4. Repeated displacement: measure minimum slack and surplus concentration.
5. Two buyers and burst arrivals.

Until 1–5 exist, the research claim stays at "existence proof plus a precise rule", not "measured improvement".
