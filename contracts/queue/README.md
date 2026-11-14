# QUEUE contract

A native-NEAR priority market for a single-operator FIFO job queue.

- **Network:** NEAR testnet only. Not audited. Do not deploy to mainnet.
- **Crate:** `queue` (cdylib + rlib), `near-sdk 5.30.1`, `#[near(contract_state)]`.
- **Money:** yoctoNEAR, `u128` in state, `U128` in JSON.
- **Time:** Unix seconds, derived from `env::block_timestamp() / 1e9`. A job's
  `deadline_at` is stored as an absolute time; `submit_job` takes a relative
  `deadline_secs` and sets `deadline_at = submitted_at + deadline_secs`.

## Build and test

```sh
cd contracts/queue
cargo test
cargo build --target wasm32-unknown-unknown --release
# target/wasm32-unknown-unknown/release/queue.wasm
```

The release profile is size-optimized (`opt-level = "z"`, LTO, strip,
`panic = "abort"`).

## Public methods

Amounts in the table are JSON `U128`; on-chain they are `u128`.

| Method | Access | Payable | Returns | Notes |
| --- | --- | --- | --- | --- |
| `new(owner_id: AccountId, operator_id: AccountId, treasury_id: AccountId, fee_bps: u16)` | deploy | no | state | `fee_bps <= 1000`. |
| `submit_job(title: String, input_hash: String, input_uri: String, duration_secs: u32, deadline_secs: u32, reward: U128, ask_per_sec: U128) -> u64` | anyone | yes | job id | Attached deposit is `reward + JOB_STORAGE_DEPOSIT + bond`; `bond = attached - reward - 0.0125 NEAR` and must be > 0. The storage deposit is non-refundable and backs the job record. |
| `set_move_ask(job_id: u64, ask_per_sec: U128)` | job owner | no | – | Queued jobs only. Affects future quotes, not past purchases. |
| `cancel_job(job_id: u64)` | job owner | no | – | Queued jobs only. Splits the bond as described below. |
| `quote_priority(job_id: u64, latest_start_at: u64) -> QuoteView` | view | no | quote | Pure; never mutates. |
| `get_quote(job_id: u64, latest_start_at: u64) -> QuoteView` | view | no | quote | Alias of `quote_priority`. |
| `request_priority(job_id: u64, latest_start_at: u64, max_spend: U128) -> PriorityView` | job owner | yes | priority | Attached must be `>= total + 0.003 + 0.003 × displaced` NEAR (non-refundable storage); `total <= max_spend`; a quote that displaces nobody is refused; excess becomes a credit for the caller. |
| `start_next() -> u64` | operator | no | job id | Starts the head, or marks an already-overdue head `MISSED` and refunds it. |
| `complete_job(job_id: u64, artifact_hash: String)` | operator | no | – | Late completion is `MISSED`; the hash is still recorded. |
| `fail_job(job_id: u64, reason_hash: String)` | operator | no | – | Running job only. Full `reward + bond` refund to the owner. |
| `claim_timeout(job_id: u64)` | anyone | no | – | Queued or running and `now > deadline_at`. Allowed while paused. |
| `withdraw_credit() -> U128` | anyone | no | amount | Zeroes the caller's credit before scheduling the transfer. Allowed while paused. |
| `set_operator(account_id: AccountId)` | owner | no | – | Allowed while paused. |
| `set_treasury(account_id: AccountId)` | owner | no | – | Allowed while paused. |
| `set_fee_bps(fee_bps: u16)` | owner | no | – | `<= 1000`; applies to future priority purchases. |
| `set_paused(paused: bool)` | owner | no | – | |
| `get_config() -> ConfigView` | view | no | config | |
| `get_storage_deposits() -> {job, priority_base, priority_per_displaced}` | view | no | yocto strings | Non-refundable storage deposits to add on top of `reward + bond` and the priority `total`. |
| `get_job(job_id: u64) -> JobView` | view | no | job | Panics if unknown. |
| `get_queue() -> Vec<JobView>` | view | no | queued jobs | FIFO order; excludes the running job. |
| `get_priority(priority_id: u64) -> PriorityView` | view | no | priority | Panics if unknown. |
| `get_credit(account_id: AccountId) -> U128` | view | no | credit | |
| `get_stats() -> StatsView` | view | no | stats | |
| `get_activity(limit: u32) -> Vec<ActivityView>` | view | no | activity | Most recent first; at most 128 entries. |

### Statuses

`QUEUED | RUNNING | DONE | MISSED | CANCELLED | FAILED`

`position` is 1-based while queued (`1` is the head) and `0` while running or
terminal.

## Priority algorithm

Let `base = max(now, running_started_at + running_duration)` when a job is
running, otherwise `base = now`. For a queued urgent job at queue position `p`,
candidate insertion index `i` has

```
start_i  = base + sum(duration of queued jobs before i)
finish_i = start_i + urgent.duration
```

The contract picks the **largest** `i` in `[0, p]` satisfying both:

```
start_i  <= latest_start_at
finish_i <= urgent.deadline_at
```

If `latest_start_at < now`, the quote is rejected even if no move is needed.
If no index satisfies both checks, the quote is infeasible.

The displaced set is the queued jobs in `[i, p)` — exactly the jobs the urgent
job jumps. Jobs already behind the urgent job are not delayed and are not paid.
For each displaced job:

```
delay_secs    = urgent.duration
new_finish_at = old_finish_at + urgent.duration
amount        = displaced.ask_per_sec * urgent.duration
slack_secs    = deadline_at - new_finish_at   // signed i64, negative means broken
```

The purchase is infeasible if any `new_finish_at > deadline_at` (strictly
greater). Note that an earlier insertion cannot repair a displaced deadline:
every jumped job is delayed by the same urgent duration regardless of how far
forward the urgent job moves.

```
compensation = sum(amount)
fee          = floor(compensation * fee_bps / 10_000)
total        = compensation + fee
```

`quote_priority` and `request_priority` call the same internal, non-mutating
`quote_internal` helper with the same block timestamp, so their math cannot
diverge. `request_priority` adds only deposit/budget checks and the state
transition.

## Settlement and accounting

- A job escrow is `reward + bond`, held while `QUEUED` or `RUNNING`.
- Successful, on-time `complete_job`: `reward` is transferred to the operator,
  `bond` back to the owner.
- Late `complete_job`: status `MISSED`; `reward + bond` refunded to the owner;
  the artifact hash is recorded. The deadline test is strict:
  `finished_at > deadline_at` is late, equality is on time.
- `start_next` on an overdue head: `MISSED`, `reward + bond` refunded, never
  started.
- `claim_timeout`: `MISSED`, `reward + bond` refunded to the owner. The caller
  receives nothing.
- `fail_job`: `FAILED`, full `reward + bond` refund. `reason_hash` is stored in
  `JobView.failure_hash`.
- Normal queued cancellation: `reward` refunded, `25%` of `bond` credited to
  treasury, `75%` refunded to the owner. The treasury cut is floored; the
  remainder goes to the owner.
- Cancellation after the job was actually expedited (at least one displaced
  job): `reward` refunded, `100%` of `bond` credited to treasury.
- Compensation, protocol fees, cancellation penalties and priority excess are
  **pull-payment credits**. Job rewards, bond refunds and missed-job refunds are
  direct native transfers from the contract, scheduled after state is final.
- `withdraw_credit` removes and zeroes the credit before creating the transfer
  promise; a zero credit is a no-op.

### Invariants

1. `submit_job`: `attached_deposit == reward + JOB_STORAGE_DEPOSIT + bond`,
   `bond > 0`. The storage deposit is not escrow and is non-refundable.
2. `request_priority`: `total <= max_spend`,
   `attached_deposit >= total + priority_storage_deposit(displaced)`; the
   attached deposit becomes the storage deposit plus credits:
   `compensation + fee + refunded == attached - storage_deposit`.
3. `total_escrow` is the sum of `reward + bond` for all `QUEUED` and `RUNNING`
   jobs. Every terminal transition subtracts exactly that job's escrow once.
4. `total_credits` is the sum of all `credits` balances. It increases only when
   a deposit is already in the contract and decreases only when a credit is
   zeroed for withdrawal.
5. No terminal status is written before the corresponding escrow/credit
   accounting is final; credits are zeroed before value leaves.
6. A priority purchase never breaks a deadline: `finish == deadline` is allowed,
   `finish > deadline` is not.
7. Active queue length is at most 128; stored activity is at most 128 entries.
8. All arithmetic that can grow uses checked `u128`/`u64` operations and panics
   on overflow rather than wrapping.

## Events and activity

Every event is logged as:

```
EVENT_JSON:{"standard":"queue","version":"1.0.0","event":"...","data":{...}}
```

| Event | When |
| --- | --- |
| `job_submitted` | Job escrow accepted. |
| `priority_purchased` | Priority reorder and credits settled. |
| `job_started` | Operator started the head. |
| `job_completed` | On-time completion and reward/bond settlement. |
| `job_missed` | Late completion, overdue start, or timeout; includes `reason`. |
| `job_cancelled` | Owner cancelled a queued job. |
| `job_failed` | Operator failed a running job. |
| `credit_withdrawn` | Credit zeroed and transfer scheduled. |
| `ask_updated` | Job owner changed the move ask. |

`get_activity(limit)` returns the lifecycle events newest-first, capped at 128
entries. `ActivityView.type` is the event name. `ask_updated` is emitted as an
event but is not stored in the activity ring; admin setters are silent.

## Views

- **`JobView`** includes id, owner, title, input_hash, input_uri, duration_secs,
  deadline_at, submitted_at, reward, bond, ask_per_sec, status, expedited,
  priority_id, priority_spend, moved_compensation, started_at, finished_at,
  artifact_hash, failure_hash, moves, move_count, position,
  projected_start_at, projected_finish_at.
- **`QuoteView`** includes job_id, now, latest_start_at, insert_index,
  projected_start_at, projected_finish_at, compensation, fee, total, displaced,
  feasible, reason, checks.
- **`DisplacedView`** includes job_id, owner, amount, delay_secs, new_finish_at,
  deadline_at, slack_secs (`i64`, can be negative).
- **`PriorityView`** includes id, job_id, requester, at, insert_index,
  compensation, fee, total, latest_start_at, attached, refunded, displaced.
- **`StatsView`** includes submitted, completed, missed, failed, cancelled,
  running, queued, moves, total_priority, total_compensation, total_fees,
  on_time_bps, total_escrow, total_credits.
  `on_time_bps = completed * 10_000 / (completed + missed)`; 0 when there are no
  outcomes. `total_priority` is the sum of `compensation + fee` charged, not
  including refunded excess.
- **`ConfigView`** includes owner_id, operator_id, treasury_id, fee_bps, paused,
  max_queue, max_activity.
- **`ActivityView`** includes id, at, type, actor, job_id, priority_id, amount,
  summary.

`moves` keeps up to the 32 most recent displacement records per job;
`move_count` is the total number of times the job was displaced.

## Limits

| Item | Limit |
| --- | --- |
| Title | 1–120 characters, not whitespace-only |
| `input_hash` | 1–128 bytes |
| `input_uri` | 0–256 bytes |
| `artifact_hash` / `reason_hash` | 1–128 bytes |
| `duration_secs` | 1–86,400 |
| `deadline_secs` | 1–604,800 |
| `fee_bps` | 0–1,000 |
| Queued jobs | 128 (running job is additional) |
| Stored activity | 128 |
| Per-job move records | 32 (total count is unbounded `move_count`) |

## Integration notes / deliberate interpretations

- **Bond input:** the specified `submit_job` signature has no `bond` parameter.
  The bond is therefore `attached - reward - JOB_STORAGE_DEPOSIT`. A deposit
  that does not exceed `reward + JOB_STORAGE_DEPOSIT` is rejected.
- **Slot selection:** the latest insertion index must satisfy both
  `start <= latest_start_at` and `start + duration <= urgent.deadline_at`.
  A loose cutoff cannot force an urgent job into a slot where it would already
  miss its own deadline.
- **Displacement scope:** only jobs between the insertion index and the urgent
  job's current position are jumped and paid. Jobs behind the urgent job keep
  their projection.
- **`slack_secs` is signed**, matching the TS scheduler: `deadline - new_finish`.
- **Zero-displacement request:** refused. A purchase that crosses nobody is a
  no-op, so the contract rejects it before creating a priority record or
  setting `expedited`. Integrators hide the buy action when
  `quote.displaced` is empty.
- **`fail_job` economics** were not specified; the contract refunds the full
  `reward + bond` to the owner and records `failure_hash`.
- **Pause scope:** pause blocks new obligations (`submit_job`, `set_move_ask`,
  `request_priority`, `start_next`) but keeps every exit path available:
  `cancel_job`, `complete_job`, `fail_job`, `claim_timeout`, `withdraw_credit`.
  Owner-only admin setters remain available so the contract can be recovered;
  `set_paused(false)` is never blocked.
- **`request_priority` is owner-only:** only the job owner may buy priority.
  A third party cannot flip `expedited` on someone else's job (which would
  make that owner's cancellation forfeit 100% of the bond instead of 25%).
- **Fees and bond cuts round down** (floor); the remainder stays with the owner
  (or is the compensation amount itself).
- **Direct transfers:** job refunds/rewards are pushed via native transfer
  promises. Credits are pull payments. This contract does not implement storage
  deposit refunds; testnet only.
- **Demo cutoff:** the local and on-chain scenarios use a cutoff below Mira's
  11s duration (`now + 5s` in the local runner), which produces four
  displacements and `0.02004` NEAR compensation. A later cutoff correctly
  selects a later insertion and displaces fewer jobs; that is the intended
  "fewest moves" behavior, not a discrepancy.

## Custody, upgrade and known storage edges

- **No built-in upgrade API.** The contract has no `upgrade`/`migrate` method.
  However, the contract account retains a **FullAccess** key in this deployment.
  That key can redeploy the wasm and move the account's testnet balance
  independently of the Rust access-control rules. There is no multisig or
  timelock. The live proof is tied to the deployed wasm hash; a source change
  requires a new deployment and a new proof.
- **C1 — priority storage shortfall.** The fixed priority deposit
  (`0.003 + 0.003 × displaced`) is measured against the actual bytes written.
  With one to three displaced jobs and 64-byte account IDs, the write can exceed
  the deposit by a small amount; a valid quote may then fail the storage check.
  The current proof uses four short-named displaced jobs and is not affected.
- **C2 — terminal record.** A maximum-size job record can grow by ~148 bytes on
  completion; the job deposit covers the create path but can underfund the
  largest terminal record by ~0.00014 NEAR. This is a slow storage subsidy, not
  an escrow loss.
- **C3 — failed native payout.** State is written before the transfer promise.
  If a recipient account is deleted or the transfer otherwise fails, the
  credit/refund is not automatically restored; the funds remain in the contract
  until manual intervention. This is a liveness/accounting edge case, not
  minting.
- These edges are disclosed in `docs/SECURITY.md`; they are not fixed in the
  deployed contract.
