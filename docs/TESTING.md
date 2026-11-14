# How QUEUE is tested

Unit tests show that the cases someone thought of work. The methods below look for the cases nobody thought of. They are the ones professional teams use on smart contracts and on-chain mechanisms: random-history invariant testing, differential testing against a reference model, Monte Carlo simulation, mutation testing, planted bugs, dependency audits, reproducible builds and checks against the live chain.

Everything here runs offline except the three commands marked "chain", which only read from NEAR testnet.

| Method | What it answers | Command | Result on this tree |
| --- | --- | --- | --- |
| Hosted console, end to end | Does the published page do what the README says, with no backend? | `npm run verify:pages` | headless Chromium on the static build: one click, four agents paid, 4 of 4 promises kept, a credit withdrawn; no request to `/api`, no script error |
| Unit tests | Do the specified cases work? | `npm test`, `npm run test:season`, `cargo test` in each contract | 13 core, 8 ledger, 34 server, 9 web, 8 client, 17 season; 37 v1, 62 v2 and 95 v3 contract tests |
| Invariant testing (random histories) | Does any sequence of valid actions break the money or deadline rules? | `cd contracts/queue-v2 && cargo test invariants` (v3: `contracts/queue-v3`) | v2: 48 histories per run pass; a 600-history run passes. v3 (with stake, rejection, release and liveness actions): 48 histories per run pass |
| Differential testing | Do the TypeScript rules and the Rust contract agree? | `npm run test:parity`, `npm run test:parity-v3` | v2: 20 histories, 1,284 steps: every quote, refusal, queue order, balance and status agrees; so does a 300-history run (24,866 steps). v3: 30 histories, 2,224 steps agree |
| Monte Carlo sweep | Does the claim hold across many seasons, not one? | `npm run season:sweep` | 300 seasons, 39,318 jobs: 0 of 3,464 moved jobs late; +1.19% on time vs FIFO |
| Mutation testing | Would the unit tests notice if the code were wrong? | `cargo mutants` (see below) | 92 of 95 viable mutants caught; the 3 survivors do not change behaviour |
| Planted bugs | Would each suite notice a broken rule on its own? | `npm run test:planted-bugs` | 8 of 8 caught by the unit tests, 8 of 8 by the invariants, 8 of 8 by the differential test |
| Dependency audit | Known advisories in the dependency tree? | `cd contracts/queue-v2 && cargo audit` | no vulnerability in the wasm build; one unmaintained crate noted below |
| Reproducible build check (chain) | Is the code on chain the code in this repository? | `npm run verify:v2-deployed`, `npm run verify:v1-deployed` | both contracts build to the wasm on chain, byte for byte, on macOS/Apple silicon with any cargo home ([how](#reproducible-build)) |
| Season re-check (chain) | Do the published numbers match the chain? | `npm run verify:season` | all checks pass; fails if the recomputed result differs from the committed one |
| v1 proof re-check (chain) | Does the scripted proof match the chain? | `npm run verify:onchain` | 27 of 27 transactions, method names and payouts included |
| v3 proof re-check (chain) | Does every v3 rule hold on the deployed contract? | `npm run verify:v3`, `npm run verify:v3-deployed` | every proof transaction re-read from an archival node: status, return value and events (prices, refunds, penalties, timelocks); the deployed code is the source, byte for byte |
| Research simulator | How do the rules compare when waiting has a cost? | `npm run research:sim` | 200 paired seeds per load: FIFO, EDF, a planner (Smith's rule), a blind fee, v2 and v3 on the same jobs ([README](../README.md#why-not-edf)) |
| Monitoring (chain) | Is the live contract still solvent and consistent? | `npm run monitor` (`-- --watch 10` to keep checking) | balance covers storage, escrow and credits; every job in one state; pause, operator and keys reported |
| Payout recovery on chain | Does a failed payout really come back? | `node scripts/season/payout-recovery.mjs` | yes: [transaction](https://testnet.nearblocks.io/txns/BsiMG2jX11ZeTY2ee7avSMASgCXZSPHrSkNMCiZEUnm3) |

## Invariant testing

`contracts/queue-v2/src/lib.rs`, module `invariants` (uses `proptest`). Each case is a random history of up to 90 valid actions by four accounts: submit (from a deposit or from the balance), buy priority, start, complete (on time or late), cancel, change the ask, claim a timeout, withdraw, deposit, wait. Half the jobs get a deadline a few seconds past their own place in line, and half the purchases aim at a slot that exists, so the histories spend their time near the limits the rules protect. A typical run of 48 histories makes about 60 purchases that move 75 jobs, sees about 130 refused quotes (80 of them protecting another job's deadline), 15 late deliveries and 30 jobs that reach the head too late to start.

After **every** step:

- escrow equals reward + bond of the jobs that are queued or running;
- the credit total equals the sum of every balance;
- the contract never owes or has paid out more than it received, and what it keeps (storage fees) never goes down;
- v3: the stake equals what was posted, less what was withdrawn and what was paid out to users; the storage still refundable is covered, what is kept for good never goes down, a release returns the whole deposit less at most one balance key, and the bytes in storage are always covered by the deposits held plus the money kept for good (allowing one balance key per account created by a payout); the stake never leaves while a job is queued or running; every job that ends missed or failed was paid exactly `min(priority spend + reward, stake)` if it was promised and nothing otherwise, and its owner's balance moved by exactly that; a submission or purchase is refused, with nothing charged, whenever the operator is not accepting work;
- every job is in exactly one state, and the counters add up;
- the queue is one contiguous schedule in position order.

Before every quote, the test works the rule out on its own from the public queue: which slot the buyer should get, and whether a job it would pass ends inside its safety margin. The contract's answer must match: the same slot, a refusal exactly when the test expects one, and for the same kind of reason.

After every purchase, additionally:

- no job other than the buyer changes place relative to the others;
- every job the buyer passed still finishes before its deadline, with the safety margin;
- no job that was on time by the schedule is late after the purchase;
- every account's balance changed by exactly what the quote said (each passed job's own ask × the buyer's duration, 1% to the treasury), and no other balance moved.

A late delivery is never paid as delivered, and the worker never starts a job that can no longer finish.

## Differential testing

`scripts/season/gen-traces.ts` drives the TypeScript rules (`SimChain`) through seeded random histories and records every result. The histories include hopeless submissions, infeasible jumps, and boundary probes built on purpose: a job whose deadline sits within a few seconds of the margin it needs to be passed, a buyer whose own deadline sits on its margin, a start one or two seconds either side of the last moment a job can still finish, and deliveries within a second of the deadline. The `sim_parity` test replays the same histories against the contract and compares each step: the quote (slot, price, each displaced job's payment and new finish time), whether a refusal protects another job's deadline, the queue order, every balance and every job status. The committed set has 56 purchases and 198 refused quotes, 141 of them protecting a deadline. This is what lets the simulator stand in for the contract in the sweep.

## Monte Carlo sweep

300 simulated 30-minute seasons (100 seeds at arrival rates 1.0, 1.25 and 1.5), scripted agent policy, each paired with FIFO and a blind fee on the same jobs. Results are in `data/season/sweep.json` and discussed in [`RESULTS.md`](RESULTS.md) §3b.

| Question | Result |
| --- | --- |
| Does a job moved back by a purchase ever end late? | Never: 0 of 3,464 |
| On-time deliveries against FIFO | +1.19% of jobs (95% CI 1.07–1.31%), at every load tested |
| Jobs FIFO delivers that the rule makes late | market 1.7% (none of them moved by a purchase); blind fee 9.9% |

## Mutation testing

`cargo-mutants` changes the contract one small piece at a time (a comparison flipped, a function body replaced) and checks that at least one test fails. A mutant that survives marks code the tests do not pin down.

Scope: the contract's money, deadline and queue functions (99 mutants), run against the fast unit tests:

```bash
cd contracts/queue-v2
cargo mutants --re 'quote_internal|request_priority|start_next|settle_completion|submit_job|cancel_job|claim_timeout|credit_spend|credit_add|admission|base_start|fee_floor|withdraw_credit|fn deposit|on_payout|complete_job_attested' -- -- --skip invariants --skip sim_parity
```

| | Mutants |
| --- | ---: |
| Caught by a test | 92 |
| Survived | 3 |
| Did not compile | 4 |

The quote function, where the deadline rule lives, scores 33 of 33. The 3 survivors are equivalent mutants: `if amount > 0 { credit_add(amount) }` changed to `>=` in three places, where `credit_add` already returns on zero, so the behaviour is the same.

## Planted bugs

Mutation testing scores the unit tests. To check the other two suites as well, `scripts/planted-bugs.mjs` breaks one rule at a time in a temporary copy of the contract and runs each suite alone. A suite catches a bug when at least one of its tests fails. Results are in [`data/season/planted-bugs.json`](../data/season/planted-bugs.json).

| Planted bug | Unit tests | Invariants | Differential |
| --- | --- | --- | --- |
| A passed job's safety margin is dropped | caught | caught | caught |
| A passed job's deadline is not checked at all | caught | caught | caught |
| The extra margin per hand-off is dropped | caught | caught | caught |
| The buyer's own margin is dropped when the slot is chosen | caught | caught | caught |
| Compensation uses the passed job's duration, not the buyer's | caught | caught | caught |
| The fee is rounded up by one yocto | caught | caught | caught |
| The worker may start a job that can no longer finish | caught | caught | caught |
| A late delivery is paid as if it were on time | caught | caught | caught |

## Dependency audit

`cargo audit` (RustSec advisory database) on `contracts/queue-v2`:

- **In the wasm build:** `wee_alloc` 0.4.5 is unmaintained (RUSTSEC-2022-0054). It comes from near-sdk's default features. Switching the allocator changes the wasm, so it is left as it is for the deployed build and should be turned off before any mainnet use.
- **Test-only, not in the wasm:** `crypto-bigint` 0.5.5 (RUSTSEC-2026-0387, timing variability) and `unsafe-libyaml` (unmaintained) arrive through near-sdk's unit-testing dependencies.

## Next steps

- Coverage-guided fuzzing (`cargo-fuzz`) and model checking of the pure arithmetic (Kani) or of the protocol (Quint).
- A sandbox integration suite (`near-workspaces`) once its local node accepts wasm from the current Rust toolchain; today the same ground is covered on testnet by the season and the payout-recovery transaction.
- An external audit before any mainnet use.

## Reproducible build

`scripts/repro-build.sh <contract dir> <account>` (behind `npm run verify:v1-deployed` and `npm run verify:v2-deployed`) rebuilds a contract and compares it with the code on chain, byte for byte. Two things make that work outside the folder and cargo home that deployed it:

- the compiler is pinned in `rust-toolchain.toml` (rustc 1.99.1, the version that built both deployed contracts);
- a release wasm keeps its dependencies' source paths in its panic messages, and those paths begin with the builder's cargo home. The script reads that directory out of the deployed code and maps the local crate directory onto it with `--remap-path-prefix`, so the strings, and with them the hash, come out the same.

Checked with an empty cargo home in a temporary directory: a plain build gives a different hash, the script's build gives the deployed one, for both contracts.

**Platform limit.** This holds on the platform that built the deployed code: macOS on Apple silicon. On a Linux x86-64 host the same source, compiler version and flags produce a different wasm (the compiled output is not identical across host platforms), so there the script reports a mismatch and names the host. To check the deployed code from Linux, compare the hash recorded in the run (`data/season/testnet-season-4/config.json`, `data/onchain-proof.json`) with the chain: `npm run verify:season` and `npm run verify:onchain` do that on any platform.

