//! QUEUE v3 — the queue is a market.
//!
//! One operator, one FIFO queue. A job that cannot wait may buy an earlier slot.
//! Every job it jumps moves back by exactly the urgent job's duration and is
//! paid its published per-second price. A move is refused if it would break the
//! deadline of any job that was still on schedule; a job already projected to
//! miss has no promise left to protect, so it cannot block a jump (it is still
//! paid). Settlement is native NEAR; compensation and fees are pull credits.
//!
//! v3 adds accountability around the rule: the operator posts a stake and must be
//! live for the contract to take new work; a job that was on schedule and still
//! misses is paid back its priority spend plus a penalty from that stake; a job
//! that asks for a model answer can only be settled with the model's verified
//! signature; storage deposits come back when a finished job's record is
//! released; and every owner power waits out a public timelock.
//!
//! Testnet only. Not audited.

use near_sdk::collections::LookupMap;
use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise};
use serde_json::json;

pub const BPS_DENOMINATOR: u128 = 10_000;
pub const MAX_FEE_BPS: u16 = 1_000;
pub const MAX_QUEUE: usize = 128;
pub const MAX_ACTIVITY: usize = 128;
pub const MAX_TITLE_CHARS: usize = 80;
pub const MAX_INPUT_HASH_LEN: usize = 128;
pub const MAX_URI_LEN: usize = 256;
pub const MAX_HASH_LEN: usize = 128;
pub const MAX_DURATION_SECS: u32 = 86_400;
pub const MAX_DEADLINE_SECS: u32 = 604_800;
pub const MAX_MOVE_RECORDS: usize = 8;
/// A job may buy priority at most this many times (each purchase record is refunded on release).
pub const MAX_PURCHASES_PER_JOB: usize = 8;
/// An ask raise takes effect this many seconds after it is posted; a cut takes effect at once. A slot holder
/// cannot see an urgent job coming and reprice before it can buy.
pub const ASK_RAISE_DELAY_SECS: u64 = 30;
/// New work is accepted only while the operator has called the contract within this window (when a minimum stake
/// is set): a worker that is gone must not keep taking deposits.
pub const OPERATOR_HEARTBEAT_SECS: u64 = 180;
/// Shortest owner timelock the contract accepts.
pub const MIN_TIMELOCK_SECS: u64 = 60;
/// Anyone may release a finished job's record (refunding its storage to the owner) this long after it ended.
pub const RELEASE_AFTER_SECS: u64 = 7 * 86_400;
pub const NS_PER_SEC: u64 = 1_000_000_000;
/// Storage deposit for a job record (1,700 bytes at 10^19 yocto/byte): the largest terminal record (long title,
/// 128-byte hashes, a TEE attestation tag), two fresh recovery credit keys (owner and operator) and the one-time
/// "request answered" marker fit. The measured cost must fit inside it. `release_job` deletes the record and
/// credits the owner the whole deposit, less the bytes the job leaves behind for good (the marker of a model-settled
/// job, and a balance key if the refund had to create one).
pub const JOB_STORAGE_DEPOSIT: u128 = 17_000_000_000_000_000_000_000;
/// Storage deposit for one priority record: 600 bytes base (measured worst case 776 bytes for 1 displaced,
/// base + per-displaced = 900), so a 1-displaced purchase with 64-byte account ids, a fresh treasury credit key and
/// a fresh requester credit key fits. Refunded with the buyer's job by `release_job`.
pub const PRIORITY_STORAGE_BASE: u128 = 6_000_000_000_000_000_000_000;
/// ... plus this much per displaced job (move record + displaced entry + credit key).
pub const PRIORITY_STORAGE_PER_DISPLACED: u128 = 3_000_000_000_000_000_000_000;
/// Storage for a new balance key created by `deposit` (kept while the account has a balance key).
pub const BALANCE_STORAGE_DEPOSIT: u128 = 2_000_000_000_000_000_000_000;
/// Largest model response `complete_job_attested` will hash on chain.
pub const MAX_RESPONSE_BYTES: usize = 65_536;
pub const MAX_TEE_SIGNERS: usize = 16;
/// Raw storage prefix: `ans:<request sha256>` -> job id that settled it.
pub const ANSWERED_PREFIX: &[u8] = b"ans:";
/// Raw storage prefix: `req:<request sha256>` -> the job that submitted it. Claimed at submission, so a
/// copied request hash is refused up front and cannot burn another job's attested settlement.
pub const REQUEST_CLAIM_PREFIX: &[u8] = b"req:";
/// Raw storage prefix for accounts the operator approved to submit jobs.
pub const CLIENT_PREFIX: &[u8] = b"cli:";
/// Most accounts one `allow_clients` call may approve.
pub const MAX_CLIENTS_PER_CALL: usize = 32;
/// Highest ask a job may post (1 NEAR per second). Keeps `ask x duration` sums far from u128 overflow,
/// so a quote is always computed instead of aborting.
pub const MAX_ASK_PER_SEC: u128 = 1_000_000_000_000_000_000_000_000;
/// Seconds of margin a displaced job must keep before its deadline. Settling one job and starting the next
/// are separate transactions, so every start lands at least a block after the projection.
pub const DEADLINE_MARGIN_SECS: u64 = 3;
/// Extra margin per hand-off ahead of a displaced job: each settle + start pair adds its own block delay, so a job
/// deeper in the queue needs more room.
pub const MARGIN_PER_HANDOFF_SECS: u64 = 1;
/// Seconds a head must have to spare when it starts: completion is a later transaction.
pub const COMPLETE_MARGIN_SECS: u64 = 2;
/// Gas reserved for the callback that restores a failed payout as a credit.
/// The callback rewrites root state (including the activity log), so it gets 10 TGas of its own on top of its share
/// of unused gas.
pub const PAYOUT_CALLBACK_GAS: Gas = Gas::from_tgas(10);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "UPPERCASE")]
pub enum JobStatus {
    Queued,
    Running,
    Done,
    Missed,
    Cancelled,
    Failed,
    /// Refused by the operator before it started (for example input it cannot serve); everything refunded.
    Rejected,
}

impl JobStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            JobStatus::Queued => "QUEUED",
            JobStatus::Running => "RUNNING",
            JobStatus::Done => "DONE",
            JobStatus::Missed => "MISSED",
            JobStatus::Cancelled => "CANCELLED",
            JobStatus::Failed => "FAILED",
            JobStatus::Rejected => "REJECTED",
        }
    }

    pub fn is_terminal(self) -> bool {
        !matches!(self, JobStatus::Queued | JobStatus::Running)
    }
}

/// How a job's delivery is checked. `Model`: the answer must carry the pinned model's signature, verified by the
/// contract against the job's own request hash. `Operator`: the operator attests a hash (work that is not a model call).
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Verify {
    Model,
    Operator,
}

#[near(serializers = [borsh])]
pub struct Config {
    pub owner_id: AccountId,
    pub operator_id: AccountId,
    pub treasury_id: AccountId,
    pub fee_bps: u16,
    pub paused: bool,
    /// Seconds every owner proposal must wait before anyone can execute it.
    pub timelock_secs: u64,
    /// The operator's stake must be at least this for new work to be accepted (0 disables the stake and liveness
    /// checks; the testnet deployment sets it).
    pub min_operator_stake: u128,
}

/// An owner action. It becomes executable `timelock_secs` after it is proposed, by anyone.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Proposal {
    SetOwner { account_id: AccountId },
    SetOperator { account_id: AccountId },
    SetTreasury { account_id: AccountId },
    SetFeeBps { fee_bps: u16 },
    SetMinOperatorStake { amount: U128 },
    SetTeeSigners { signers: Vec<String> },
    SetTeeModel { model: Option<String> },
    /// Deploy new code whose sha256 (hex) is this; the code itself is sent to `execute_upgrade`.
    Upgrade { code_sha256: String },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct PendingProposal {
    pub id: u64,
    pub proposal: Proposal,
    pub proposed_at: u64,
    pub executable_at: u64,
}

/// Buy priority in the same transaction as the submission. `latest_start_at` defaults to the latest start that
/// still meets the job's own deadline. If `required`, the whole submission fails when the slot cannot be bought.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct PriorityRequest {
    pub latest_start_at: Option<u64>,
    pub max_spend: U128,
    pub required: Option<bool>,
}

#[near(serializers = [borsh])]
pub struct MoveRecord {
    /// The urgent job that jumped this one.
    pub by_job_id: u64,
    pub amount: u128,
    pub delay_secs: u32,
    pub at: u64,
}

#[near(serializers = [borsh])]
pub struct Job {
    pub id: u64,
    pub owner: AccountId,
    pub title: String,
    pub input_hash: String,
    pub input_uri: String,
    pub duration_secs: u32,
    pub deadline_at: u64,
    pub submitted_at: u64,
    pub reward: u128,
    pub bond: u128,
    pub ask_per_sec: u128,
    pub status: JobStatus,
    pub expedited: bool,
    pub priority_id: Option<u64>,
    pub priority_spend: u128,
    pub moved_compensation: u128,
    pub started_at: Option<u64>,
    pub finished_at: Option<u64>,
    pub artifact_hash: Option<String>,
    pub failure_hash: Option<String>,
    pub moves: Vec<MoveRecord>,
    pub move_count: u32,
    /// `tee-ed25519:<signer prefix>` when the artifact is a model answer whose
    /// TEE signature the contract verified against this job's input hash.
    pub attestation: Option<String>,
    pub verify: Verify,
    /// The schedule promised this job its deadline: true when it was projected on time at admission or after
    /// its own purchase. A promised job that misses is paid from the operator's stake.
    pub promised: bool,
    /// A raised ask waiting for `ask_effective_at`.
    pub ask_pending: Option<u128>,
    pub ask_effective_at: u64,
    /// Storage deposit held for this record; refunded by `release_job`.
    pub storage_deposit: u128,
    /// Every priority record this job bought (released with it).
    pub priority_ids: Vec<u64>,
    /// Paid to the owner from the operator's stake for a broken promise.
    pub penalty_paid: u128,
}

#[near(serializers = [borsh])]
pub struct DisplacedRecord {
    pub job_id: u64,
    pub owner: AccountId,
    pub amount: u128,
    pub delay_secs: u32,
    pub new_finish_at: u64,
    pub deadline_at: u64,
    /// deadline_at - new_finish_at; negative means the promise is broken.
    pub slack_secs: i64,
}

#[near(serializers = [borsh])]
pub struct Priority {
    pub id: u64,
    pub job_id: u64,
    pub requester: AccountId,
    pub at: u64,
    pub insert_index: u32,
    pub compensation: u128,
    pub fee: u128,
    pub total: u128,
    pub latest_start_at: u64,
    pub attached: u128,
    pub refunded: u128,
    pub displaced: Vec<DisplacedRecord>,
    /// Storage deposit held for this record; refunded with the job's release.
    pub storage_deposit: u128,
}

#[near(serializers = [borsh])]
pub struct Activity {
    pub id: u64,
    pub at: u64,
    pub event: String,
    pub actor: AccountId,
    pub job_id: Option<u64>,
    pub priority_id: Option<u64>,
    pub amount: u128,
    pub summary: String,
}

#[near(serializers = [borsh])]
pub struct StatsCounters {
    pub submitted: u64,
    pub completed: u64,
    pub missed: u64,
    pub cancelled: u64,
    pub failed: u64,
    pub attested: u64,
    pub moves: u64,
    pub total_priority: u128,
    pub total_compensation: u128,
    pub total_fees: u128,
    pub rejected: u64,
    pub released: u64,
    pub promises_broken: u64,
    pub total_penalties: u128,
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

#[near(serializers = [json])]
#[derive(Clone)]
pub struct ConfigView {
    pub owner_id: AccountId,
    pub operator_id: AccountId,
    pub treasury_id: AccountId,
    pub fee_bps: u16,
    pub paused: bool,
    pub max_queue: u32,
    pub max_activity: u32,
    /// Pinned NEAR AI TEE signing keys (ed25519, hex) accepted by
    /// `complete_job_attested`. Empty = attested completion disabled.
    pub tee_signers: Vec<String>,
    pub tee_model: Option<String>,
    pub timelock_secs: u64,
    pub min_operator_stake: U128,
    pub operator_stake: U128,
    pub operator_last_seen: u64,
    /// The operator called the contract within `OPERATOR_HEARTBEAT_SECS` and its stake covers the minimum: new work
    /// is accepted. Always true while no minimum stake is set.
    pub accepting_work: bool,
    /// Amount the operator asked to unstake, and when it can be withdrawn.
    pub unstake_pending: Option<(U128, u64)>,
    /// Only accounts the operator approved (`allow_clients`) can submit. True whenever a stake backs the queue.
    pub clients_only: bool,
}

#[near(serializers = [json])]
#[derive(Clone)]
pub struct MoveRecordView {
    pub by_job_id: u64,
    pub amount: U128,
    pub delay_secs: u32,
    pub at: u64,
}

#[near(serializers = [json])]
#[derive(Clone)]
pub struct JobView {
    pub id: u64,
    pub owner: AccountId,
    pub title: String,
    pub input_hash: String,
    pub input_uri: String,
    pub duration_secs: u32,
    pub deadline_at: u64,
    pub submitted_at: u64,
    pub reward: U128,
    pub bond: U128,
    /// The ask quotes use right now (a raise counts only after its delay).
    pub ask_per_sec: U128,
    pub status: JobStatus,
    pub expedited: bool,
    pub priority_id: Option<u64>,
    pub priority_spend: U128,
    pub moved_compensation: U128,
    pub started_at: Option<u64>,
    pub finished_at: Option<u64>,
    pub artifact_hash: Option<String>,
    pub failure_hash: Option<String>,
    pub moves: Vec<MoveRecordView>,
    pub move_count: u32,
    pub attested: bool,
    pub attestation: Option<String>,
    pub verify: Verify,
    pub promised: bool,
    /// A raised ask that quotes will use from `ask_effective_at`; `None` once it is in force.
    pub ask_pending: Option<U128>,
    pub ask_effective_at: u64,
    pub storage_deposit: U128,
    pub priority_ids: Vec<u64>,
    pub penalty_paid: U128,
    /// 1-based position while queued; 0 while running or terminal.
    pub position: u32,
    pub projected_start_at: u64,
    pub projected_finish_at: u64,
}

#[near(serializers = [json])]
#[derive(Clone)]
pub struct DisplacedView {
    pub job_id: u64,
    pub owner: AccountId,
    pub amount: U128,
    pub delay_secs: u32,
    pub new_finish_at: u64,
    pub deadline_at: u64,
    /// deadline_at - new_finish_at; negative means the promise would break.
    pub slack_secs: i64,
}

#[near(serializers = [json])]
#[derive(Clone)]
pub struct CheckView {
    pub key: String,
    pub label: String,
    pub ok: bool,
    pub detail: String,
}

#[near(serializers = [json])]
#[derive(Clone)]
pub struct QuoteView {
    pub job_id: u64,
    pub now: u64,
    pub latest_start_at: u64,
    pub insert_index: u32,
    pub projected_start_at: u64,
    pub projected_finish_at: u64,
    pub compensation: U128,
    pub fee: U128,
    pub total: U128,
    pub displaced: Vec<DisplacedView>,
    pub feasible: bool,
    pub reason: String,
    pub checks: Vec<CheckView>,
}

#[near(serializers = [json])]
#[derive(Clone)]
pub struct PriorityView {
    pub id: u64,
    pub job_id: u64,
    pub requester: AccountId,
    pub at: u64,
    pub insert_index: u32,
    pub compensation: U128,
    pub fee: U128,
    pub total: U128,
    pub latest_start_at: u64,
    pub attached: U128,
    pub refunded: U128,
    pub displaced: Vec<DisplacedView>,
}

#[near(serializers = [json])]
#[derive(Clone)]
pub struct StatsView {
    pub submitted: u64,
    pub completed: u64,
    pub missed: u64,
    pub cancelled: u64,
    pub failed: u64,
    /// Completions whose artifact is a TEE-signed model answer verified on chain.
    pub attested: u64,
    pub running: u32,
    pub queued: u32,
    pub moves: u64,
    pub total_priority: U128,
    pub total_compensation: U128,
    pub total_fees: U128,
    pub on_time_bps: u32,
    /// reward + bond currently held for QUEUED or RUNNING jobs.
    pub total_escrow: U128,
    /// Sum of all pull-payment credit balances.
    pub total_credits: U128,
    pub rejected: u64,
    pub released: u64,
    /// Promised jobs that still missed (each paid from the operator's stake).
    pub promises_broken: u64,
    pub total_penalties: U128,
    pub operator_stake: U128,
    /// Refundable storage deposits held for job and priority records not yet released.
    pub storage_held: U128,
}

#[near(serializers = [json])]
#[derive(Clone)]
pub struct ActivityView {
    pub id: u64,
    pub at: u64,
    #[serde(rename = "type")]
    pub event: String,
    pub actor: AccountId,
    pub job_id: Option<u64>,
    pub priority_id: Option<u64>,
    pub amount: U128,
    pub summary: String,
}

// ---------------------------------------------------------------------------
// State
/// What a new job of this size would face if submitted now: the earliest it could finish
/// (front slot, bought) and where it would finish at the back of the queue (no purchase).
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdmissionView {
    pub now: u64,
    pub deadline_at: u64,
    pub earliest_finish_at: u64,
    pub finish_at_back: u64,
    /// Accepted by `submit_job` at all (the front slot could deliver it).
    pub feasible_at_front: bool,
    /// On time without buying anything, if nothing else changes.
    pub feasible_at_back: bool,
}

// ---------------------------------------------------------------------------

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub config: Config,
    pub jobs: LookupMap<u64, Job>,
    pub priorities: LookupMap<u64, Priority>,
    pub credits: LookupMap<AccountId, u128>,
    /// FIFO ids of QUEUED jobs, excluding the running job.
    pub queue: Vec<u64>,
    pub running: Option<u64>,
    pub next_job_id: u64,
    pub next_priority_id: u64,
    pub next_activity_id: u64,
    pub activity: Vec<Activity>,
    pub stats: StatsCounters,
    pub total_escrow: u128,
    pub total_credits: u128,
    pub tee_signers: Vec<String>,
    pub tee_model: Option<String>,
    pub operator_stake: u128,
    pub operator_last_seen: u64,
    pub unstake_pending: Option<(u128, u64)>,
    pub proposals: LookupMap<u64, PendingProposal>,
    pub proposal_ids: Vec<u64>,
    pub next_proposal_id: u64,
    /// Refundable storage deposits held for job and priority records.
    pub storage_held: u128,
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

fn checked_add_u128(a: u128, b: u128) -> u128 {
    a.checked_add(b)
        .unwrap_or_else(|| env::panic_str("u128 overflow"))
}

fn checked_sub_u128(a: u128, b: u128) -> u128 {
    a.checked_sub(b)
        .unwrap_or_else(|| env::panic_str("u128 underflow"))
}

fn checked_mul_u128(a: u128, b: u128) -> u128 {
    a.checked_mul(b)
        .unwrap_or_else(|| env::panic_str("u128 overflow"))
}

/// floor(amount * fee_bps / 10_000) without overflowing for large `amount`.
fn fee_floor(amount: u128, fee_bps: u16) -> u128 {
    let bps = fee_bps as u128;
    (amount / BPS_DENOMINATOR) * bps + ((amount % BPS_DENOMINATOR) * bps) / BPS_DENOMINATOR
}

fn checked_add_u64(a: u64, b: u64) -> u64 {
    a.checked_add(b)
        .unwrap_or_else(|| env::panic_str("u64 overflow"))
}

/// Signed deadline slack, matching the TS scheduler. Unix seconds from block
/// timestamps are far below i64::MAX (u64 nanoseconds / 1e9), so the cast is
/// safe for all on-chain times.
fn slack_secs(deadline_at: u64, new_finish_at: u64) -> i64 {
    if new_finish_at <= deadline_at {
        (deadline_at - new_finish_at) as i64
    } else {
        -((new_finish_at - deadline_at) as i64)
    }
}

fn now_secs() -> u64 {
    env::block_timestamp() / NS_PER_SEC
}

fn validate_bytes(label: &str, value: &str, min: usize, max: usize) {
    let len = value.len();
    require!(
        len >= min && len <= max,
        format!("{label} must be {min}..{max} bytes")
    );
}

fn validate_title(title: &str) {
    require!(!title.trim().is_empty(), "title is required");
    let len = title.chars().count();
    require!(
        len <= MAX_TITLE_CHARS,
        format!("title must be at most {MAX_TITLE_CHARS} characters")
    );
}

fn check(key: &str, label: &str, ok: bool, detail: String) -> CheckView {
    CheckView {
        key: key.to_string(),
        label: label.to_string(),
        ok,
        detail,
    }
}

fn emit_queue_event(event: &str, data: serde_json::Value) {
    let payload = json!({
        "standard": "queue",
        "version": "1.0.0",
        "event": event,
        "data": data,
    });
    env::log_str(&format!("EVENT_JSON:{payload}"));
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(h: &str) -> Vec<u8> {
    let h = h.trim_start_matches("0x");
    if !h.len().is_multiple_of(2) || !h.is_ascii() {
        return vec![];
    }
    (0..h.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&h[i..i + 2], 16))
        .collect::<Result<Vec<_>, _>>()
        .unwrap_or_default()
}

/// `sha256:<hex>`, `0x<hex>` or `<hex>` -> lowercase 64-char hex, if it is one.
fn normalize_sha256(h: &str) -> Option<String> {
    let h = h.trim();
    let h = h.strip_prefix("sha256:").unwrap_or(h);
    let h = h.strip_prefix("0x").unwrap_or(h).to_ascii_lowercase();
    (h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit())).then_some(h)
}

/// Raw storage key for a request claim: the prefix plus the 32 hash bytes (not 64 hex chars), so the claim fits in
/// the job's storage deposit next to the largest record.
fn claim_key(request_hash: &str) -> Vec<u8> {
    [REQUEST_CLAIM_PREFIX, &unhex(request_hash)].concat()
}

fn client_key(account_id: &AccountId) -> Vec<u8> {
    [CLIENT_PREFIX, account_id.as_bytes()].concat()
}

fn normalize_signer(k: &str) -> String {
    k.trim().trim_start_matches("0x").to_ascii_lowercase()
}

/// Send native NEAR. State is final before this is called. If the transfer
/// fails (for example the receiver was deleted), the private callback puts
/// the amount back as a pull credit for the same account, so nothing is
/// stranded in the contract.
fn transfer_yocto(to: &AccountId, amount: u128) {
    if amount == 0 {
        return;
    }
    let _ = Promise::new(to.clone())
        .transfer(NearToken::from_yoctonear(amount))
        .then(
            Contract::ext(env::current_account_id())
                .with_static_gas(PAYOUT_CALLBACK_GAS)
                .on_payout(to.clone(), U128(amount)),
        );
}

/// The ask quotes use at `now`: a raise counts only once its delay has passed.
fn effective_ask(job: &Job, now: u64) -> u128 {
    match job.ask_pending {
        Some(raised) if now >= job.ask_effective_at => raised,
        _ => job.ask_per_sec,
    }
}

fn priority_storage_deposit(displaced: usize) -> u128 {
    checked_add_u128(
        PRIORITY_STORAGE_BASE,
        checked_mul_u128(PRIORITY_STORAGE_PER_DISPLACED, displaced as u128),
    )
}

/// Storage written since `before`, in yocto. Panics if it exceeds the deposit
/// the caller paid for it, so the contract never subsidises user storage.
fn assert_storage_covered(before: u64, deposit: u128) {
    let used = env::storage_usage().saturating_sub(before) as u128;
    let cost = checked_mul_u128(used, env::storage_byte_cost().as_yoctonear());
    require!(
        cost <= deposit,
        format!("storage cost {cost} exceeds the storage deposit {deposit}")
    );
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[near]
impl Contract {
    /// `tee_signers` / `tee_model` may be pinned here, before anyone has deposited; afterwards only through the
    /// timelock.
    #[init]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        owner_id: AccountId,
        operator_id: AccountId,
        treasury_id: AccountId,
        fee_bps: u16,
        timelock_secs: Option<u64>,
        min_operator_stake: Option<U128>,
        tee_signers: Option<Vec<String>>,
        tee_model: Option<String>,
    ) -> Self {
        require!(
            fee_bps <= MAX_FEE_BPS,
            format!("fee_bps cannot exceed {MAX_FEE_BPS}")
        );
        let timelock_secs = timelock_secs.unwrap_or(86_400);
        require!(
            timelock_secs >= MIN_TIMELOCK_SECS,
            format!("timelock_secs must be at least {MIN_TIMELOCK_SECS}")
        );
        let tee_signers = tee_signers.unwrap_or_default();
        Self::validate_proposal(&Proposal::SetTeeSigners { signers: tee_signers.clone() });
        Self::validate_proposal(&Proposal::SetTeeModel { model: tee_model.clone() });

        Self {
            config: Config {
                owner_id,
                operator_id,
                treasury_id,
                fee_bps,
                paused: false,
                timelock_secs,
                min_operator_stake: min_operator_stake.map(|a| a.0).unwrap_or(0),
            },
            jobs: LookupMap::new(b"j"),
            priorities: LookupMap::new(b"p"),
            credits: LookupMap::new(b"c"),
            queue: Vec::new(),
            running: None,
            next_job_id: 1,
            next_priority_id: 1,
            next_activity_id: 1,
            activity: Vec::new(),
            stats: StatsCounters {
                submitted: 0,
                completed: 0,
                missed: 0,
                cancelled: 0,
                failed: 0,
                attested: 0,
                moves: 0,
                total_priority: 0,
                total_compensation: 0,
                total_fees: 0,
                rejected: 0,
                released: 0,
                promises_broken: 0,
                total_penalties: 0,
            },
            total_escrow: 0,
            total_credits: 0,
            tee_signers: tee_signers.iter().map(|k| normalize_signer(k)).collect(),
            tee_model,
            operator_stake: 0,
            operator_last_seen: now_secs(),
            unstake_pending: None,
            proposals: LookupMap::new(b"g"),
            proposal_ids: Vec::new(),
            next_proposal_id: 1,
            storage_held: 0,
        }
    }

    // -- governance: every owner power waits out the timelock ----------------

    /// Owner only: queue an action. Anyone can execute it once `timelock_secs` have passed, so users always see a
    /// change coming (and can leave: cancellations, withdrawals and exits never pause).
    pub fn propose(&mut self, proposal: Proposal) -> PendingProposal {
        self.only_owner();
        Self::validate_proposal(&proposal);
        let now = now_secs();
        let id = self.next_proposal_id;
        self.next_proposal_id = checked_add_u64(id, 1);
        let pending = PendingProposal {
            id,
            proposal,
            proposed_at: now,
            executable_at: checked_add_u64(now, self.config.timelock_secs),
        };
        self.proposals.insert(&id, &pending);
        self.proposal_ids.push(id);
        emit_queue_event(
            "proposal_queued",
            json!({ "id": id, "proposal": pending.proposal, "executable_at": pending.executable_at }),
        );
        pending
    }

    /// Owner only: drop a queued proposal before it runs.
    pub fn cancel_proposal(&mut self, id: u64) {
        self.only_owner();
        require!(self.proposals.remove(&id).is_some(), "no such proposal");
        self.proposal_ids.retain(|p| *p != id);
        emit_queue_event("proposal_cancelled", json!({ "id": id }));
    }

    /// Anyone: run a proposal whose timelock has passed. An upgrade runs through `execute_upgrade` instead.
    pub fn execute_proposal(&mut self, id: u64) {
        require!(
            !matches!(self.proposals.get(&id).map(|p| p.proposal), Some(Proposal::Upgrade { .. })),
            "an upgrade runs through execute_upgrade with the code attached"
        );
        if let Some(Proposal::SetOperator { account_id }) = self.proposals.get(&id).map(|p| p.proposal) {
            if account_id != self.config.operator_id {
                // The outgoing operator's stake goes back to it; that may happen only when no job relies on it.
                self.require_no_open_jobs("the operator cannot be replaced");
            }
        }
        let pending = self.take_ready_proposal(id);
        self.apply_proposal(pending.proposal.clone());
        emit_queue_event("proposal_executed", json!({ "id": id, "proposal": pending.proposal }));
    }

    fn apply_proposal(&mut self, proposal: Proposal) {
        match proposal {
            Proposal::SetOwner { account_id } => self.config.owner_id = account_id,
            Proposal::SetOperator { account_id } => {
                // The stake belongs to the operator that posted it: a new operator posts its own. The old one gets
                // what is left back as a credit (so an owner cannot take a stake by naming itself operator).
                let old = self.config.operator_id.clone();
                if old != account_id {
                    let stake = std::mem::take(&mut self.operator_stake);
                    self.unstake_pending = None;
                    if stake > 0 {
                        self.credit_add(&old, stake);
                        emit_queue_event("stake_returned", json!({ "account_id": old, "amount": stake.to_string() }));
                    }
                }
                self.config.operator_id = account_id;
                self.operator_last_seen = now_secs();
            }
            Proposal::SetTreasury { account_id } => self.config.treasury_id = account_id,
            Proposal::SetFeeBps { fee_bps } => self.config.fee_bps = fee_bps,
            Proposal::SetMinOperatorStake { amount } => self.config.min_operator_stake = amount.0,
            Proposal::SetTeeSigners { signers } => {
                self.tee_signers = signers.iter().map(|k| normalize_signer(k)).collect();
            }
            Proposal::SetTeeModel { model } => self.tee_model = model,
            Proposal::Upgrade { .. } => unreachable!("execute_proposal refuses upgrades"),
        }
    }

    /// Anyone: deploy the code a ready `Upgrade` proposal named. The raw wasm is the call's input; its sha256 must
    /// equal the proposal's. The new code's `migrate` runs in the same batch.
    pub fn execute_upgrade(&mut self) -> Promise {
        let code = env::input().unwrap_or_else(|| env::panic_str("attach the wasm as the call input"));
        let hash = hex(&env::sha256(&code));
        let id = self
            .proposal_ids
            .iter()
            .copied()
            .find(|id| matches!(self.proposals.get(id).map(|p| p.proposal), Some(Proposal::Upgrade { code_sha256 }) if code_sha256 == hash))
            .unwrap_or_else(|| env::panic_str("no upgrade proposal for this code"));
        self.take_ready_proposal(id);
        emit_queue_event("upgrade_executed", json!({ "id": id, "code_sha256": hash }));
        Promise::new(env::current_account_id())
            .deploy_contract(code)
            .function_call("migrate".to_string(), vec![], NearToken::from_yoctonear(0), Gas::from_tgas(30))
    }

    /// Run after an upgrade. This version keeps the state layout, so it only re-reads it.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        env::state_read().unwrap_or_else(|| env::panic_str("no state to migrate"))
    }

    pub fn get_proposals(&self) -> Vec<PendingProposal> {
        self.proposal_ids.iter().filter_map(|id| self.proposals.get(id)).collect()
    }

    /// Owner only, immediate: stop new jobs and purchases (cancellations, settlements, withdrawals and timeouts
    /// still work). Resuming is immediate too; neither moves money.
    pub fn set_paused(&mut self, paused: bool) {
        self.only_owner();
        self.config.paused = paused;
        emit_queue_event("paused", json!({ "paused": paused }));
    }

    pub fn get_tee_model(&self) -> Option<String> {
        self.tee_model.clone()
    }

    // -- operator: stake and liveness -------------------------------------

    /// Operator: add to the stake. The stake pays users back when a job the schedule promised still misses.
    #[payable]
    pub fn stake(&mut self) -> U128 {
        self.only_operator();
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "attach the stake");
        self.operator_stake = checked_add_u128(self.operator_stake, amount);
        emit_queue_event("operator_staked", json!({ "amount": amount.to_string(), "stake": self.operator_stake.to_string() }));
        U128(self.operator_stake)
    }

    /// Operator: start taking stake out. It stays at risk until the timelock passes, so a queue it promised
    /// cannot be abandoned with the money.
    pub fn request_unstake(&mut self, amount: U128) {
        self.only_operator();
        require!(amount.0 > 0 && amount.0 <= self.operator_stake, "amount must be 1..stake");
        let at = checked_add_u64(now_secs(), self.config.timelock_secs);
        self.unstake_pending = Some((amount.0, at));
        emit_queue_event("unstake_requested", json!({ "amount": amount.0.to_string(), "at": at }));
    }

    /// Operator: withdraw a requested unstake after its timelock (capped by what is left of the stake). Refused
    /// while any job is queued or running: the stake answers for every job the queue has taken, so it leaves only
    /// when none is open.
    pub fn withdraw_unstaked(&mut self) -> U128 {
        self.only_operator();
        let (amount, at) = self.unstake_pending.unwrap_or_else(|| env::panic_str("no unstake requested"));
        self.require_no_open_jobs("the stake cannot be withdrawn");
        require!(now_secs() >= at, "unstake is still timelocked");
        let amount = amount.min(self.operator_stake);
        self.operator_stake -= amount;
        self.unstake_pending = None;
        transfer_yocto(&self.config.operator_id.clone(), amount);
        emit_queue_event("unstaked", json!({ "amount": amount.to_string(), "stake": self.operator_stake.to_string() }));
        U128(amount)
    }

    /// Operator: approve accounts that may submit jobs. Wherever a stake backs the queue, only approved accounts
    /// can submit: the operator's stake pays for a promise it breaks or a job it refuses, so the operator decides
    /// whose work it takes before any money moves. Attach the storage the new entries need; the rest is returned.
    #[payable]
    pub fn allow_clients(&mut self, accounts: Vec<AccountId>) {
        self.only_operator();
        require!(
            !accounts.is_empty() && accounts.len() <= MAX_CLIENTS_PER_CALL,
            format!("approve 1..{MAX_CLIENTS_PER_CALL} accounts per call")
        );
        let before = env::storage_usage();
        for account_id in accounts.iter() {
            env::storage_write(&client_key(account_id), b"1");
        }
        let cost = checked_mul_u128(
            env::storage_usage().saturating_sub(before) as u128,
            env::storage_byte_cost().as_yoctonear(),
        );
        let attached = env::attached_deposit().as_yoctonear();
        require!(
            attached >= cost,
            format!("attach {cost} yocto for the storage of the new entries")
        );
        transfer_yocto(&self.config.operator_id.clone(), attached - cost);
        emit_queue_event("clients_allowed", json!({ "accounts": accounts }));
    }

    /// Operator: stop taking new jobs from an account. Jobs it already has in the queue are not touched.
    pub fn remove_client(&mut self, account_id: AccountId) {
        self.only_operator();
        require!(env::storage_remove(&client_key(&account_id)), "not an approved client");
        emit_queue_event("client_removed", json!({ "account_id": account_id }));
    }

    /// Operator: say "the worker is up". Every operator call counts too.
    pub fn heartbeat(&mut self) -> u64 {
        self.only_operator();
        self.operator_last_seen
    }

    // -- balances ----------------------------------------------------------

    /// Fund your own balance. The balance is the same pull credit that
    /// displacement payments go to, and `submit_job` / `request_priority`
    /// called with no attached deposit spend from it. This is what lets an
    /// agent act with a function-call access key, which cannot attach NEAR:
    /// the most the agent can ever spend is what was deposited, and
    /// `withdraw_credit` only ever pays the agent's own account.
    #[payable]
    pub fn deposit(&mut self) -> U128 {
        self.require_not_paused();
        let account = env::predecessor_account_id();
        let attached = env::attached_deposit().as_yoctonear();
        let storage = if self.credits.contains_key(&account) {
            0
        } else {
            BALANCE_STORAGE_DEPOSIT
        };
        require!(
            attached > storage,
            "attached deposit must exceed the balance storage deposit"
        );
        let amount = checked_sub_u128(attached, storage);
        self.credit_add(&account, amount);
        emit_queue_event(
            "balance_deposited",
            json!({ "account_id": account, "amount": amount.to_string(), "at": now_secs() }),
        );
        self.record_activity(
            "balance_deposited",
            account.clone(),
            None,
            None,
            amount,
            format!("Deposited {amount} yocto to the balance."),
        );
        U128(self.credits.get(&account).unwrap_or(0))
    }

    // -- jobs --------------------------------------------------------------

    /// Submit a job. Escrow is `reward + bond`, plus a storage deposit refunded by `release_job`.
    ///
    /// Funding: from the caller's balance (no attached NEAR; `bond` required), or from the attached deposit
    /// (`reward + storage + bond`; without `priority` the bond is whatever is attached beyond reward + storage).
    ///
    /// `verify` defaults to `model` when a model key is pinned and `input_hash` is a sha256, else `operator`.
    /// `priority` buys an earlier slot in the same transaction (see `PriorityRequest`); when funded by deposit, the
    /// purchase is paid from what is attached beyond `reward + storage + bond`, and any rest is credited back.
    #[payable]
    #[allow(clippy::too_many_arguments)]
    pub fn submit_job(
        &mut self,
        title: String,
        input_hash: String,
        input_uri: String,
        duration_secs: u32,
        deadline_secs: u32,
        reward: U128,
        ask_per_sec: U128,
        bond: Option<U128>,
        require_feasible_at_back: Option<bool>,
        verify: Option<Verify>,
        priority: Option<PriorityRequest>,
    ) -> u64 {
        self.require_not_paused();
        let now = now_secs();
        self.require_accepting_work(now);
        self.require_client(&env::predecessor_account_id());
        validate_title(&title);
        validate_bytes("input_hash", &input_hash, 1, MAX_INPUT_HASH_LEN);
        validate_bytes("input_uri", &input_uri, 0, MAX_URI_LEN);
        require!(
            (1..=MAX_DURATION_SECS).contains(&duration_secs),
            format!("duration_secs must be 1..{MAX_DURATION_SECS}")
        );
        require!(
            (1..=MAX_DEADLINE_SECS).contains(&deadline_secs),
            format!("deadline_secs must be 1..{MAX_DEADLINE_SECS}")
        );
        require!(
            deadline_secs >= duration_secs,
            "deadline_secs must be at least duration_secs: the job could never finish on time"
        );
        require!(reward.0 > 0, "reward must be > 0");
        require!(
            ask_per_sec.0 <= MAX_ASK_PER_SEC,
            "ask_per_sec must be at most 1 NEAR per second"
        );
        require!(
            self.queue.len() < MAX_QUEUE,
            format!("queue is full (max {MAX_QUEUE})")
        );
        // Refuse only the truly hopeless: a job that could not finish even if it bought the front slot.
        {
            let earliest_finish = checked_add_u64(
                checked_add_u64(self.base_start(now), duration_secs as u64),
                COMPLETE_MARGIN_SECS,
            );
            require!(
                earliest_finish <= checked_add_u64(now, deadline_secs as u64),
                "this job cannot finish by its deadline even at the front of the queue"
            );
            if require_feasible_at_back == Some(true) && priority.is_none() {
                let a = self.admission(duration_secs, deadline_secs, now);
                require!(a.feasible_at_back, "this job would not finish by its deadline at the back of the queue");
            }
        }
        let request_hash = normalize_sha256(&input_hash);
        let verify = verify.unwrap_or(if !self.tee_signers.is_empty() && request_hash.is_some() {
            Verify::Model
        } else {
            Verify::Operator
        });
        if verify == Verify::Model {
            require!(
                request_hash.is_some(),
                "a model job needs input_hash = sha256 of the exact request body"
            );
            require!(
                !self.tee_signers.is_empty(),
                "no model key is pinned: submit with verify = operator"
            );
        }

        let attached = env::attached_deposit().as_yoctonear();
        let reserved = checked_add_u128(reward.0, JOB_STORAGE_DEPOSIT);
        let owner = env::predecessor_account_id();
        // `budget`: attached NEAR left for an atomic purchase (None = pay it from the balance).
        let (bond, funded_from, budget) = if attached == 0 {
            let bond = bond
                .map(|b| b.0)
                .unwrap_or_else(|| env::panic_str("bond is required when paying from balance"));
            require!(bond > 0, "bond must be > 0");
            self.credit_spend(&owner, checked_add_u128(reserved, bond));
            (bond, "balance", None)
        } else if priority.is_some() {
            let bond = bond
                .map(|b| b.0)
                .unwrap_or_else(|| env::panic_str("bond is required with an atomic priority purchase"));
            require!(bond > 0, "bond must be > 0");
            let need = checked_add_u128(reserved, bond);
            require!(
                attached >= need,
                "attached deposit must cover reward + storage deposit + bond (+ the priority budget)"
            );
            (bond, "deposit", Some(attached - need))
        } else {
            require!(
                attached > reserved,
                "attached deposit must be reward + storage deposit + a positive bond"
            );
            let bond_from_deposit = checked_sub_u128(attached, reserved);
            if let Some(b) = bond {
                require!(
                    b.0 == bond_from_deposit,
                    "bond does not match the attached deposit"
                );
            }
            (bond_from_deposit, "deposit", None)
        };
        let storage_before = env::storage_usage();
        let deadline_at = checked_add_u64(now, deadline_secs as u64);

        let id = self.next_job_id;
        self.next_job_id = checked_add_u64(id, 1);

        // First submitter of a request hash owns it; the claim is paid for by this job's storage deposit.
        if let Some(request_hash) = request_hash.as_ref() {
            let claim = claim_key(request_hash);
            if let Some(prev) = env::storage_read(&claim) {
                env::panic_str(&format!(
                    "this request hash is already used by job {}; submit a fresh request",
                    String::from_utf8_lossy(&prev)
                ));
            }
            env::storage_write(&claim, id.to_string().as_bytes());
        }

        let job = Job {
            id,
            owner: owner.clone(),
            title: title.clone(),
            input_hash,
            input_uri,
            duration_secs,
            deadline_at,
            submitted_at: now,
            reward: reward.0,
            bond,
            ask_per_sec: ask_per_sec.0,
            status: JobStatus::Queued,
            expedited: false,
            priority_id: None,
            priority_spend: 0,
            moved_compensation: 0,
            started_at: None,
            finished_at: None,
            artifact_hash: None,
            failure_hash: None,
            moves: Vec::new(),
            move_count: 0,
            attestation: None,
            verify,
            promised: false,
            ask_pending: None,
            ask_effective_at: now,
            storage_deposit: JOB_STORAGE_DEPOSIT,
            priority_ids: Vec::new(),
            penalty_paid: 0,
        };

        self.jobs.insert(&id, &job);
        assert_storage_covered(storage_before, JOB_STORAGE_DEPOSIT);
        self.queue.push(id);
        self.storage_held = checked_add_u128(self.storage_held, JOB_STORAGE_DEPOSIT);
        let escrow = checked_add_u128(reward.0, bond);
        self.total_escrow = checked_add_u128(self.total_escrow, escrow);
        self.stats.submitted = checked_add_u64(self.stats.submitted, 1);

        emit_queue_event(
            "job_submitted",
            json!({
                "job_id": id,
                "owner": owner,
                "title": title,
                "duration_secs": duration_secs,
                "deadline_at": deadline_at,
                "submitted_at": now,
                "reward": reward.0.to_string(),
                "bond": bond.to_string(),
                "ask_per_sec": ask_per_sec.0.to_string(),
                "position": self.queue.len(),
                "funded_from": funded_from,
                "verify": verify,
            }),
        );
        self.record_activity(
            "job_submitted",
            owner.clone(),
            Some(id),
            None,
            escrow,
            format!("Job {id} submitted with {escrow} yocto escrow ({} reward + {bond} bond).", reward.0),
        );

        if let Some(p) = priority {
            let latest = p.latest_start_at.unwrap_or_else(|| {
                deadline_at
                    .saturating_sub(duration_secs as u64)
                    .saturating_sub(DEADLINE_MARGIN_SECS)
            });
            let quote = self.quote_internal(id, latest, now);
            let storage = priority_storage_deposit(quote.displaced.len());
            let affordable = quote.total.0 <= p.max_spend.0
                && budget.is_none_or(|b| b >= checked_add_u128(quote.total.0, storage));
            if quote.feasible && !quote.displaced.is_empty() && affordable {
                self.buy_internal(&owner, id, latest, p.max_spend, budget, now);
            } else {
                let why = if !quote.feasible {
                    format!("priority infeasible: {}", quote.reason)
                } else if quote.displaced.is_empty() {
                    "nothing to buy: the job is already in its best feasible slot".to_string()
                } else {
                    "priority total exceeds max_spend or the attached budget".to_string()
                };
                // `required` asks for a slot that meets the cutoff; a job already standing in one has it.
                let already_there = quote.feasible && quote.displaced.is_empty();
                require!(p.required != Some(true) || already_there, why.clone());
                if let Some(b) = budget {
                    self.credit_add(&owner, b);
                }
                emit_queue_event("priority_skipped", json!({ "job_id": id, "reason": why }));
            }
        }

        // The promise: on schedule as the queue now stands. Kept by every later purchase (the contract refuses one
        // that would break it); broken only if the operator falls behind, which its stake pays for.
        let mut job = self.job_or_panic(id);
        let (_, _, finish) = self.job_projection(&job, now);
        job.promised = checked_add_u64(finish, COMPLETE_MARGIN_SECS) <= job.deadline_at;
        self.jobs.insert(&id, &job);
        id
    }

    /// Change the ask. A cut takes effect at once; a raise only after `ASK_RAISE_DELAY_SECS`.
    pub fn set_move_ask(&mut self, job_id: u64, ask_per_sec: U128) {
        self.require_not_paused();
        let mut job = self.job_or_panic(job_id);
        require!(
            env::predecessor_account_id() == job.owner,
            "only the job owner can set the ask"
        );
        require!(
            job.status == JobStatus::Queued,
            "only queued jobs can change their ask"
        );
        require!(
            ask_per_sec.0 <= MAX_ASK_PER_SEC,
            "ask_per_sec must be at most 1 NEAR per second"
        );
        let now = now_secs();
        let current = effective_ask(&job, now);
        job.ask_per_sec = current;
        let effective_at = if ask_per_sec.0 > current {
            job.ask_pending = Some(ask_per_sec.0);
            job.ask_effective_at = checked_add_u64(now, ASK_RAISE_DELAY_SECS);
            job.ask_effective_at
        } else {
            job.ask_per_sec = ask_per_sec.0;
            job.ask_pending = None;
            job.ask_effective_at = now;
            now
        };
        self.jobs.insert(&job_id, &job);

        emit_queue_event(
            "ask_updated",
            json!({
                "job_id": job_id,
                "owner": job.owner,
                "ask_per_sec": ask_per_sec.0.to_string(),
                "effective_at": effective_at,
            }),
        );
    }

    /// Owner: leave the queue. The reward and 75% of the bond come back; a job that bought priority forfeits the
    /// whole bond (it moved others for a slot it then gave up).
    pub fn cancel_job(&mut self, job_id: u64) {
        // Exit path: allowed while paused.
        let mut job = self.job_or_panic(job_id);
        require!(
            env::predecessor_account_id() == job.owner,
            "only the job owner can cancel"
        );
        require!(
            job.status == JobStatus::Queued,
            "only queued jobs can cancel"
        );

        let now = now_secs();
        let reward_refund = job.reward;
        let bond_to_treasury = if job.expedited {
            job.bond
        } else {
            // floor(25%); division avoids any overflow on huge bonds.
            job.bond / 4
        };
        let bond_refund = checked_sub_u128(job.bond, bond_to_treasury);

        job.status = JobStatus::Cancelled;
        job.finished_at = Some(now);
        self.jobs.insert(&job_id, &job);
        self.remove_from_queue(job_id);
        self.total_escrow =
            checked_sub_u128(self.total_escrow, checked_add_u128(job.reward, job.bond));
        self.stats.cancelled = checked_add_u64(self.stats.cancelled, 1);

        if bond_to_treasury > 0 {
            self.credit_add(&self.config.treasury_id.clone(), bond_to_treasury);
        }
        // State is final before value leaves the contract.
        transfer_yocto(&job.owner, checked_add_u128(reward_refund, bond_refund));

        emit_queue_event(
            "job_cancelled",
            json!({
                "job_id": job_id,
                "owner": job.owner,
                "reward_refund": reward_refund.to_string(),
                "bond_refund": bond_refund.to_string(),
                "bond_to_treasury": bond_to_treasury.to_string(),
                "expedited": job.expedited,
                "at": now,
            }),
        );
        self.record_activity(
            "job_cancelled",
            job.owner.clone(),
            Some(job_id),
            job.priority_id,
            checked_add_u128(reward_refund, bond_refund),
            format!(
                "Job {job_id} cancelled: {} yocto refunded, {} yocto bond to treasury.",
                checked_add_u128(reward_refund, bond_refund),
                bond_to_treasury
            ),
        );
    }

    // -- priority ----------------------------------------------------------

    pub fn quote_priority(&self, job_id: u64, latest_start_at: u64) -> QuoteView {
        self.quote_internal(job_id, latest_start_at, now_secs())
    }

    pub fn get_quote(&self, job_id: u64, latest_start_at: u64) -> QuoteView {
        self.quote_internal(job_id, latest_start_at, now_secs())
    }

    /// Where a job of this size would stand if submitted now: front (bought) and back (FIFO) finish times.
    pub fn get_admission(&self, duration_secs: u32, deadline_secs: u32) -> AdmissionView {
        self.admission(duration_secs, deadline_secs, now_secs())
    }

    /// Buy an earlier slot. `max_spend` caps the price (compensation + fee), not the storage deposit for the
    /// priority record (`PRIORITY_STORAGE_BASE` + `PRIORITY_STORAGE_PER_DISPLACED` per jumped job), which is
    /// charged on top and refunded when the job is released.
    #[payable]
    pub fn request_priority(
        &mut self,
        job_id: u64,
        latest_start_at: u64,
        max_spend: U128,
    ) -> PriorityView {
        self.require_not_paused();
        let now = now_secs();
        self.require_accepting_work(now);
        let requester = env::predecessor_account_id();
        let attached = env::attached_deposit().as_yoctonear();
        let priority = self.buy_internal(
            &requester,
            job_id,
            latest_start_at,
            max_spend,
            (attached > 0).then_some(attached),
            now,
        );
        self.priority_view(&priority)
    }

    // -- operator lifecycle ------------------------------------------------

    /// Start the head of the queue. Allowed while paused: a pause stops new work, the queue still drains.
    pub fn start_next(&mut self) -> u64 {
        self.only_operator();
        require!(self.running.is_none(), "a job is already running");
        require!(!self.queue.is_empty(), "queue is empty");

        let job_id = self.queue[0];
        let mut job = self.job_or_panic(job_id);
        let now = now_secs();

        let cannot_finish = checked_add_u64(checked_add_u64(now, job.duration_secs as u64), COMPLETE_MARGIN_SECS) > job.deadline_at;
        if cannot_finish {
            // The promise is already broken (or would be by the time the work ends). Never start it: settle it
            // as missed, so the worker's time goes to a job that can still be delivered.
            job.status = JobStatus::Missed;
            job.finished_at = Some(now);
            self.pay_broken_promise(&mut job);
            self.jobs.insert(&job_id, &job);
            self.remove_from_queue(job_id);
            self.total_escrow =
                checked_sub_u128(self.total_escrow, checked_add_u128(job.reward, job.bond));
            self.stats.missed = checked_add_u64(self.stats.missed, 1);
            transfer_yocto(&job.owner, checked_add_u128(job.reward, job.bond));

            emit_queue_event(
                "job_missed",
                json!({
                    "job_id": job_id,
                    "owner": job.owner,
                    "reward": job.reward.to_string(),
                    "bond": job.bond.to_string(),
                    "reason": if now > job.deadline_at { "deadline_passed_before_start" } else { "cannot_finish_before_deadline" },
                    "artifact_hash": null,
                    "at": now,
                }),
            );
            self.record_activity(
                "job_missed",
                job.owner.clone(),
                Some(job_id),
                job.priority_id,
                checked_add_u128(job.reward, job.bond),
                format!("Job {job_id} missed: it could not finish before its deadline; escrow refunded."),
            );
            return job_id;
        }

        job.status = JobStatus::Running;
        job.started_at = Some(now);
        self.jobs.insert(&job_id, &job);
        self.remove_from_queue(job_id);
        self.running = Some(job_id);

        let projected_finish = checked_add_u64(now, job.duration_secs as u64);
        emit_queue_event(
            "job_started",
            json!({
                "job_id": job_id,
                "owner": job.owner,
                "operator": self.config.operator_id,
                "started_at": now,
                "projected_finish_at": projected_finish,
            }),
        );
        self.record_activity(
            "job_started",
            self.config.operator_id.clone(),
            Some(job_id),
            job.priority_id,
            0,
            format!("Job {job_id} started; projected finish {projected_finish}."),
        );
        job_id
    }

    /// Operator attests the artifact hash. Trusted: the contract cannot see
    /// the work. Prefer `complete_job_attested` when the work is a model call.
    pub fn complete_job(&mut self, job_id: u64, artifact_hash: String) {
        self.only_operator();
        // Exit path: a running job must be settleable while paused.
        validate_bytes("artifact_hash", &artifact_hash, 1, MAX_HASH_LEN);
        require!(
            self.job_or_panic(job_id).verify == Verify::Operator,
            "this job asked for a model answer: settle it with complete_job_attested, or fail_job"
        );
        self.settle_completion(job_id, artifact_hash, None);
    }

    /// Complete a job whose work is one NEAR AI chat completion, checking the
    /// model's own signature instead of the operator's word.
    ///
    /// `response` is the exact response body NEAR AI returned; `signature` is
    /// the ed25519 signature (hex) over `{model}:{sha256(request)}:{sha256(response)}`
    /// made by the model's signing key; `signer` must be a key the owner pinned;
    /// `model` must equal the pinned model id when one is pinned.
    ///
    /// The contract hashes `response` itself and takes the request hash from
    /// the job's own `input_hash`, fixed at submission, so an edited answer or
    /// an answer to another prompt is refused. Each request hash can settle
    /// one job only, so a signed answer cannot be reused for a second job.
    /// Only the provider form is accepted: a gateway receipt (`{req}:{res}`)
    /// does not show which model ran.
    ///
    /// Trust boundary: this proves the bytes were signed by a key the owner
    /// pinned. Whether that key lives in genuine TEE hardware is checked off
    /// chain, from NEAR AI's attestation report, before pinning.
    pub fn complete_job_attested(
        &mut self,
        job_id: u64,
        response: String,
        signature: String,
        signer: String,
        model: Option<String>,
    ) {
        self.only_operator();
        require!(
            response.len() <= MAX_RESPONSE_BYTES,
            format!("response must be at most {MAX_RESPONSE_BYTES} bytes")
        );
        let signer = normalize_signer(&signer);
        require!(
            self.tee_signers.contains(&signer),
            "signer is not a pinned TEE key"
        );
        let job = self.job_or_panic(job_id);
        let request_hash = normalize_sha256(&job.input_hash).unwrap_or_else(|| {
            env::panic_str("job input_hash is not a sha256 of a request body; use complete_job")
        });
        let model = model.unwrap_or_else(|| {
            env::panic_str("model is required: only the model's own signature is accepted, not a gateway receipt")
        });
        if let Some(pinned) = &self.tee_model {
            require!(pinned == &model, "model is not the pinned model");
        }
        // The request must belong to this job (claimed at its submission). Jobs from before the claim existed
        // have no claim and fall back to the answered-once marker below.
        let claim = claim_key(&request_hash);
        if let Some(owner_job) = env::storage_read(&claim) {
            require!(
                owner_job == job_id.to_string().as_bytes(),
                "this request hash was claimed by another job"
            );
        }
        let marker = [ANSWERED_PREFIX, request_hash.as_bytes()].concat();
        if let Some(prev) = env::storage_read(&marker) {
            env::panic_str(&format!(
                "this request was already answered and settled for job {}; a signed answer settles one job",
                String::from_utf8_lossy(&prev)
            ));
        }
        let response_hash = hex(&env::sha256(response.as_bytes()));
        let text = format!("{model}:{request_hash}:{response_hash}");
        let sig: [u8; 64] = unhex(&signature)
            .try_into()
            .unwrap_or_else(|_| env::panic_str("signature must be 64 bytes of hex"));
        let pk: [u8; 32] = unhex(&signer)
            .try_into()
            .unwrap_or_else(|_| env::panic_str("signer must be 32 bytes of hex"));
        require!(
            env::ed25519_verify(&sig, text.as_bytes(), &pk),
            "TEE signature does not verify for this job's request and this response"
        );
        let tag = format!("tee-ed25519:{}", &signer[..16]);
        env::storage_write(&marker, job_id.to_string().as_bytes());
        self.settle_completion(job_id, response_hash, Some(tag));
    }

    /// Private callback for `transfer_yocto`: a failed payout becomes a pull
    /// credit for the same account instead of being stranded.
    #[private]
    pub fn on_payout(&mut self, account_id: AccountId, amount: U128) -> bool {
        // A native transfer returns no bytes on success.
        let ok = env::promise_result_checked(0, 64).is_ok();
        if !ok {
            self.credit_add(&account_id, amount.0);
            // Event only: growing the activity log here would make the callback heavier exactly when it matters.
            emit_queue_event(
                "payout_failed_credited",
                json!({ "account_id": account_id, "amount": amount.0.to_string(), "at": now_secs() }),
            );
        }
        ok
    }

    pub fn fail_job(&mut self, job_id: u64, reason_hash: String) {
        self.only_operator();
        // Exit path: a running job must be settleable while paused.
        validate_bytes("reason_hash", &reason_hash, 1, MAX_HASH_LEN);

        let mut job = self.job_or_panic(job_id);
        require!(
            job.status == JobStatus::Running && self.running == Some(job_id),
            "job is not running"
        );
        let now = now_secs();
        job.status = JobStatus::Failed;
        job.failure_hash = Some(reason_hash.clone());
        job.finished_at = Some(now);
        self.pay_broken_promise(&mut job);
        self.jobs.insert(&job_id, &job);
        self.running = None;

        self.total_escrow =
            checked_sub_u128(self.total_escrow, checked_add_u128(job.reward, job.bond));
        self.stats.failed = checked_add_u64(self.stats.failed, 1);
        transfer_yocto(&job.owner, checked_add_u128(job.reward, job.bond));

        emit_queue_event(
            "job_failed",
            json!({
                "job_id": job_id,
                "owner": job.owner,
                "operator": self.config.operator_id,
                "reward_refund": job.reward.to_string(),
                "bond_refund": job.bond.to_string(),
                "reason_hash": reason_hash,
                "at": now,
            }),
        );
        self.record_activity(
            "job_failed",
            self.config.operator_id.clone(),
            Some(job_id),
            job.priority_id,
            checked_add_u128(job.reward, job.bond),
            format!("Job {job_id} failed; full escrow refunded to owner."),
        );
    }

    pub fn claim_timeout(&mut self, job_id: u64) {
        // Deliberately allowed while paused: this is an exit path.
        let mut job = self.job_or_panic(job_id);
        require!(
            job.status == JobStatus::Queued || job.status == JobStatus::Running,
            "only queued or running jobs can time out"
        );
        let now = now_secs();
        require!(now > job.deadline_at, "job deadline has not passed");

        let was_running = job.status == JobStatus::Running;
        job.status = JobStatus::Missed;
        job.finished_at = Some(now);
        self.pay_broken_promise(&mut job);
        self.jobs.insert(&job_id, &job);
        if was_running {
            self.running = None;
        } else {
            self.remove_from_queue(job_id);
        }
        self.total_escrow =
            checked_sub_u128(self.total_escrow, checked_add_u128(job.reward, job.bond));
        self.stats.missed = checked_add_u64(self.stats.missed, 1);
        transfer_yocto(&job.owner, checked_add_u128(job.reward, job.bond));

        let claimer = env::predecessor_account_id();
        emit_queue_event(
            "job_missed",
            json!({
                "job_id": job_id,
                "owner": job.owner,
                "reward": job.reward.to_string(),
                "bond": job.bond.to_string(),
                "reason": "timeout",
                "was_running": was_running,
                "claimed_by": claimer,
                "artifact_hash": job.artifact_hash,
                "at": now,
            }),
        );
        self.record_activity(
            "job_missed",
            claimer,
            Some(job_id),
            job.priority_id,
            checked_add_u128(job.reward, job.bond),
            format!("Job {job_id} timed out; escrow refunded to owner."),
        );
    }

    /// Operator: refuse a queued job it cannot serve (unsupported input, a request body it cannot fetch). The owner
    /// gets reward + bond back at once, plus anything it paid for priority, from the operator's stake: taking a job
    /// is the operator's decision, so refusing late is the operator's cost. The record is released at once.
    pub fn reject_job(&mut self, job_id: u64, reason: String) {
        self.only_operator();
        validate_bytes("reason", &reason, 1, MAX_HASH_LEN);
        let mut job = self.job_or_panic(job_id);
        require!(job.status == JobStatus::Queued, "only queued jobs can be rejected");
        let now = now_secs();
        job.status = JobStatus::Rejected;
        job.failure_hash = Some(reason.clone());
        job.finished_at = Some(now);
        self.remove_from_queue(job_id);
        self.total_escrow =
            checked_sub_u128(self.total_escrow, checked_add_u128(job.reward, job.bond));
        self.stats.rejected = checked_add_u64(self.stats.rejected, 1);
        let back = job.priority_spend.min(self.operator_stake);
        if back > 0 {
            self.operator_stake -= back;
            self.credit_add(&job.owner.clone(), back);
            job.penalty_paid = back;
            self.stats.total_penalties = checked_add_u128(self.stats.total_penalties, back);
        }
        self.jobs.insert(&job_id, &job);
        transfer_yocto(&job.owner, checked_add_u128(job.reward, job.bond));
        emit_queue_event(
            "job_rejected",
            json!({
                "job_id": job_id,
                "owner": job.owner,
                "reason": reason,
                "refund": checked_add_u128(job.reward, job.bond).to_string(),
                "priority_refund": back.to_string(),
                "at": now,
            }),
        );
        self.record_activity(
            "job_rejected",
            self.config.operator_id.clone(),
            Some(job_id),
            job.priority_id,
            checked_add_u128(job.reward, job.bond),
            format!("Job {job_id} rejected by the operator before it started; escrow refunded."),
        );
        self.release_internal(job_id);
    }

    /// Delete a finished job's record (and its priority records) and refund their storage deposits to its owner.
    /// The owner may do it at once; anyone may after `RELEASE_AFTER_SECS`. Its events stay in chain history.
    /// The request-hash marker stays, so a signed answer can never settle a second job; its bytes are kept back.
    pub fn release_job(&mut self, job_id: u64) -> U128 {
        let job = self.job_or_panic(job_id);
        require!(job.status.is_terminal(), "only a finished job can be released");
        let caller = env::predecessor_account_id();
        let ended = job.finished_at.unwrap_or(job.submitted_at);
        require!(
            caller == job.owner || now_secs() >= ended.saturating_add(RELEASE_AFTER_SECS),
            format!("only the owner can release a job before {} s have passed", RELEASE_AFTER_SECS)
        );
        U128(self.release_internal(job_id))
    }

    // -- credits -----------------------------------------------------------

    pub fn withdraw_credit(&mut self) -> U128 {
        let account = env::predecessor_account_id();
        let amount = self.credits.get(&account).unwrap_or(0);
        if amount == 0 {
            return U128(0);
        }

        // Zero the credit before scheduling the transfer (no re-entrancy window).
        self.credits.remove(&account);
        self.total_credits = checked_sub_u128(self.total_credits, amount);
        transfer_yocto(&account, amount);

        emit_queue_event(
            "credit_withdrawn",
            json!({
                "account_id": account,
                "amount": amount.to_string(),
                "at": now_secs(),
            }),
        );
        self.record_activity(
            "credit_withdrawn",
            account,
            None,
            None,
            amount,
            format!("Withdrew {amount} yocto of credit."),
        );
        U128(amount)
    }

    // -- views -------------------------------------------------------------

    /// Storage deposits: `submit_job` must attach `reward + job + bond`; `request_priority` must attach
    /// `total + priority_base + priority_per_displaced * displaced`. Job and priority deposits come back (as
    /// credit) when the finished job is released with `release_job`.
    pub fn get_storage_deposits(&self) -> serde_json::Value {
        json!({
            "job": JOB_STORAGE_DEPOSIT.to_string(),
            "balance": BALANCE_STORAGE_DEPOSIT.to_string(),
            "priority_base": PRIORITY_STORAGE_BASE.to_string(),
            "priority_per_displaced": PRIORITY_STORAGE_PER_DISPLACED.to_string(),
        })
    }

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            owner_id: self.config.owner_id.clone(),
            operator_id: self.config.operator_id.clone(),
            treasury_id: self.config.treasury_id.clone(),
            fee_bps: self.config.fee_bps,
            paused: self.config.paused,
            max_queue: MAX_QUEUE as u32,
            max_activity: MAX_ACTIVITY as u32,
            tee_signers: self.tee_signers.clone(),
            tee_model: self.tee_model.clone(),
            timelock_secs: self.config.timelock_secs,
            min_operator_stake: U128(self.config.min_operator_stake),
            operator_stake: U128(self.operator_stake),
            operator_last_seen: self.operator_last_seen,
            accepting_work: !self.config.paused && self.accepting_work(now_secs()),
            unstake_pending: self.unstake_pending.map(|(a, t)| (U128(a), t)),
            clients_only: self.clients_only(),
        }
    }

    /// May this account submit jobs right now (approved by the operator, or the queue is open)?
    pub fn is_client(&self, account_id: AccountId) -> bool {
        !self.clients_only() || env::storage_has_key(&client_key(&account_id))
    }

    pub fn get_job(&self, job_id: u64) -> JobView {
        let job = self.job_or_panic(job_id);
        let now = now_secs();
        let (position, projected_start_at, projected_finish_at) = self.job_projection(&job, now);
        self.job_view(&job, position, projected_start_at, projected_finish_at)
    }

    pub fn get_queue(&self) -> Vec<JobView> {
        let now = now_secs();
        let projections = self.projection_list(now);
        self.queue
            .iter()
            .enumerate()
            .filter_map(|(index, job_id)| {
                let job = self.jobs.get(job_id)?;
                let (start, finish) = projections.get(index).copied().unwrap_or((now, now));
                Some(self.job_view(&job, (index + 1) as u32, start, finish))
            })
            .collect()
    }

    pub fn get_priority(&self, priority_id: u64) -> PriorityView {
        let priority = self
            .priorities
            .get(&priority_id)
            .unwrap_or_else(|| env::panic_str("priority not found"));
        self.priority_view(&priority)
    }

    pub fn get_credit(&self, account_id: AccountId) -> U128 {
        U128(self.credits.get(&account_id).unwrap_or(0))
    }

    pub fn get_stats(&self) -> StatsView {
        let outcomes = self.stats.completed.saturating_add(self.stats.missed);
        let on_time_bps = self
            .stats
            .completed
            .checked_mul(BPS_DENOMINATOR as u64)
            .and_then(|scaled| scaled.checked_div(outcomes))
            .unwrap_or(0) as u32;

        StatsView {
            submitted: self.stats.submitted,
            completed: self.stats.completed,
            missed: self.stats.missed,
            cancelled: self.stats.cancelled,
            failed: self.stats.failed,
            attested: self.stats.attested,
            running: if self.running.is_some() { 1 } else { 0 },
            queued: self.queue.len() as u32,
            moves: self.stats.moves,
            total_priority: U128(self.stats.total_priority),
            total_compensation: U128(self.stats.total_compensation),
            total_fees: U128(self.stats.total_fees),
            on_time_bps,
            total_escrow: U128(self.total_escrow),
            total_credits: U128(self.total_credits),
            rejected: self.stats.rejected,
            released: self.stats.released,
            promises_broken: self.stats.promises_broken,
            total_penalties: U128(self.stats.total_penalties),
            operator_stake: U128(self.operator_stake),
            storage_held: U128(self.storage_held),
        }
    }

    /// Most recent activity first, capped at MAX_ACTIVITY. `limit = 0` is empty.
    pub fn get_activity(&self, limit: u32) -> Vec<ActivityView> {
        let take = limit.min(MAX_ACTIVITY as u32) as usize;
        self.activity
            .iter()
            .rev()
            .take(take)
            .map(|a| ActivityView {
                id: a.id,
                at: a.at,
                event: a.event.clone(),
                actor: a.actor.clone(),
                job_id: a.job_id,
                priority_id: a.priority_id,
                amount: U128(a.amount),
                summary: a.summary.clone(),
            })
            .collect()
    }
}

// ---------------------------------------------------------------------------
// Internal helpers (not exported)
// ---------------------------------------------------------------------------

impl Contract {
    fn only_owner(&self) {
        require!(
            env::predecessor_account_id() == self.config.owner_id,
            "only owner"
        );
    }

    /// One purchase: the rule, the payments and the records. `budget`: attached NEAR available for it (the rest is
    /// credited back), or None to pay from the requester's balance.
    fn buy_internal(
        &mut self,
        requester: &AccountId,
        job_id: u64,
        latest_start_at: u64,
        max_spend: U128,
        budget: Option<u128>,
        now: u64,
    ) -> Priority {
        // Only the owner may expedite a job. Otherwise a third party could flip
        // `expedited` on someone else's job and make its cancellation forfeit
        // the whole bond instead of 25%.
        require!(
            &self.job_or_panic(job_id).owner == requester,
            "only the job owner can buy priority"
        );
        let quote = self.quote_internal(job_id, latest_start_at, now);
        require!(
            quote.feasible,
            format!("priority infeasible: {}", quote.reason)
        );
        // A purchase that crosses nobody buys nothing; refusing it also stops
        // free, unbounded growth of priority records.
        require!(
            !quote.displaced.is_empty(),
            "nothing to buy: the job is already in its best feasible slot"
        );

        require!(
            quote.total.0 <= max_spend.0,
            "priority total exceeds max_spend"
        );
        let storage_deposit = priority_storage_deposit(quote.displaced.len());
        let required = checked_add_u128(quote.total.0, storage_deposit);
        let attached = budget.unwrap_or(0);
        let (refunded, funded_from) = match budget {
            None => {
                // Balance-funded (function-call key): spend exactly what is needed.
                self.credit_spend(requester, required);
                (0, "balance")
            }
            Some(available) => {
                require!(
                    available >= required,
                    "attached deposit is below the priority total plus the storage deposit"
                );
                (checked_sub_u128(available, required), "deposit")
            }
        };
        let storage_before = env::storage_usage();

        let priority_id = self.next_priority_id;
        self.next_priority_id = checked_add_u64(priority_id, 1);

        // Reorder: remove the urgent job, then insert it before its displaced set.
        let old_index = self
            .queue
            .iter()
            .position(|id| *id == job_id)
            .unwrap_or_else(|| env::panic_str("queued job missing from queue"));
        let insert_index = quote.insert_index as usize;
        require!(
            insert_index <= old_index,
            "insert index cannot move a job backwards"
        );
        let moved = self.queue.remove(old_index);
        self.queue.insert(insert_index, moved);

        let mut urgent = self.job_or_panic(job_id);
        // A request that displaces nobody is a valid zero-cost quote outcome,
        // but no slot was actually bought, so it does not become "expedited".
        urgent.expedited = urgent.expedited || !quote.displaced.is_empty();
        urgent.priority_id = Some(priority_id);
        require!(
            urgent.priority_ids.len() < MAX_PURCHASES_PER_JOB,
            format!("a job can buy priority at most {MAX_PURCHASES_PER_JOB} times")
        );
        urgent.priority_ids.push(priority_id);
        // The quote checked the buyer's own deadline with margin: the schedule now promises it.
        urgent.promised = true;
        urgent.priority_spend = checked_add_u128(urgent.priority_spend, quote.total.0);
        self.jobs.insert(&job_id, &urgent);

        // Balance keys this purchase creates stay after the buyer's job is released; their bytes are the part of the
        // storage deposit that does not come back. The rest does.
        let mut key_bytes: u64 = 0;
        let mut displaced_records = Vec::with_capacity(quote.displaced.len());
        for d in quote.displaced.iter() {
            let mut displaced = self.job_or_panic(d.job_id);
            displaced.moved_compensation =
                checked_add_u128(displaced.moved_compensation, d.amount.0);
            displaced.move_count = displaced
                .move_count
                .checked_add(1)
                .unwrap_or_else(|| env::panic_str("move count overflow"));
            if displaced.moves.len() >= MAX_MOVE_RECORDS {
                displaced.moves.remove(0);
            }
            displaced.moves.push(MoveRecord {
                by_job_id: job_id,
                amount: d.amount.0,
                delay_secs: d.delay_secs,
                at: now,
            });
            self.jobs.insert(&d.job_id, &displaced);
            key_bytes += self.credit_add_counting(&d.owner, d.amount.0);

            displaced_records.push(DisplacedRecord {
                job_id: d.job_id,
                owner: d.owner.clone(),
                amount: d.amount.0,
                delay_secs: d.delay_secs,
                new_finish_at: d.new_finish_at,
                deadline_at: d.deadline_at,
                slack_secs: d.slack_secs,
            });
        }

        if quote.fee.0 > 0 {
            key_bytes += self.credit_add_counting(&self.config.treasury_id.clone(), quote.fee.0);
        }
        if refunded > 0 {
            key_bytes += self.credit_add_counting(requester, refunded);
        }
        let storage_refundable = storage_deposit.saturating_sub(checked_mul_u128(
            key_bytes as u128,
            env::storage_byte_cost().as_yoctonear(),
        ));

        let priority = Priority {
            id: priority_id,
            job_id,
            requester: requester.clone(),
            at: now,
            insert_index: quote.insert_index,
            compensation: quote.compensation.0,
            fee: quote.fee.0,
            total: quote.total.0,
            latest_start_at,
            attached,
            refunded,
            displaced: displaced_records,
            storage_deposit: storage_refundable,
        };
        self.priorities.insert(&priority_id, &priority);
        // Every write of the purchase, including a fresh requester or treasury
        // credit key, is inside the measured window.
        assert_storage_covered(storage_before, storage_deposit);
        self.storage_held = checked_add_u128(self.storage_held, storage_refundable);

        self.stats.moves = checked_add_u64(self.stats.moves, quote.displaced.len() as u64);
        self.stats.total_priority = checked_add_u128(self.stats.total_priority, quote.total.0);
        self.stats.total_compensation =
            checked_add_u128(self.stats.total_compensation, quote.compensation.0);
        self.stats.total_fees = checked_add_u128(self.stats.total_fees, quote.fee.0);

        let displaced_ids: Vec<u64> = quote.displaced.iter().map(|d| d.job_id).collect();
        emit_queue_event(
            "priority_purchased",
            json!({
                "priority_id": priority_id,
                "job_id": job_id,
                "requester": requester,
                "at": now,
                "insert_index": quote.insert_index,
                "compensation": quote.compensation.0.to_string(),
                "fee": quote.fee.0.to_string(),
                "total": quote.total.0.to_string(),
                "attached": attached.to_string(),
                "refunded": refunded.to_string(),
                "funded_from": funded_from,
                "latest_start_at": latest_start_at,
                "displaced_count": displaced_ids.len(),
                "displaced_ids": displaced_ids,
            }),
        );
        self.record_activity(
            "priority_purchased",
            requester.clone(),
            Some(job_id),
            Some(priority_id),
            quote.total.0,
            format!(
                "Job {job_id} bought priority #{} at index {}: {} yocto compensation, {} fee, {} refunded.",
                priority_id, quote.insert_index, quote.compensation.0, quote.fee.0, refunded
            ),
        );

        priority
    }

    /// A job the schedule promised (on time at admission or after its own purchase) ended without delivery: its
    /// owner gets back what it paid for priority plus a penalty equal to its reward, from the operator's stake (as
    /// far as the stake goes). Credited, so the owner withdraws it with the rest of its balance.
    fn pay_broken_promise(&mut self, job: &mut Job) {
        if !job.promised || job.penalty_paid > 0 {
            return;
        }
        let owed = checked_add_u128(job.priority_spend, job.reward);
        let paid = owed.min(self.operator_stake);
        self.stats.promises_broken = checked_add_u64(self.stats.promises_broken, 1);
        if paid == 0 {
            emit_queue_event("promise_broken", json!({ "job_id": job.id, "owner": job.owner, "owed": owed.to_string(), "paid": "0" }));
            return;
        }
        self.operator_stake -= paid;
        job.penalty_paid = paid;
        self.stats.total_penalties = checked_add_u128(self.stats.total_penalties, paid);
        self.credit_add(&job.owner.clone(), paid);
        emit_queue_event(
            "promise_broken",
            json!({ "job_id": job.id, "owner": job.owner, "owed": owed.to_string(), "paid": paid.to_string(), "stake_left": self.operator_stake.to_string() }),
        );
    }

    /// Remove a terminal job's record and its priority records; credit the owner what was deposited for them, less
    /// the bytes that stay in the contract because of this job. Returns the refund.
    fn release_internal(&mut self, job_id: u64) -> u128 {
        let job = self.job_or_panic(job_id);
        let mut deposited = job.storage_deposit;
        // The whole deposit comes back, less the bytes this job leaves in the contract for good.
        let mut kept_bytes: u64 = 0;
        // The refund lands in the owner's balance; a balance key created for it is the owner's to pay.
        let fresh_credit = !self.credits.contains_key(&job.owner);
        if fresh_credit {
            let before = env::storage_usage();
            self.credits.insert(&job.owner, &0);
            kept_bytes += env::storage_usage().saturating_sub(before);
        }
        for pid in job.priority_ids.iter() {
            if let Some(p) = self.priorities.remove(pid) {
                deposited = checked_add_u128(deposited, p.storage_deposit);
            }
        }
        self.jobs.remove(&job_id);
        if let Some(request_hash) = normalize_sha256(&job.input_hash) {
            env::storage_remove(&claim_key(&request_hash));
            // The "request answered" marker of a model-settled job stays (a signed answer settles one job, ever).
            let marker = [ANSWERED_PREFIX, request_hash.as_bytes()].concat();
            if let Some(value) = env::storage_read(&marker) {
                if value == job_id.to_string().as_bytes() {
                    let before = env::storage_usage();
                    env::storage_remove(&marker);
                    kept_bytes += before.saturating_sub(env::storage_usage());
                    env::storage_write(&marker, &value);
                }
            }
        }
        let kept = checked_mul_u128(kept_bytes as u128, env::storage_byte_cost().as_yoctonear());
        let refund = deposited.saturating_sub(kept);
        self.storage_held = self.storage_held.saturating_sub(deposited);
        self.stats.released = checked_add_u64(self.stats.released, 1);
        self.credit_add(&job.owner, refund);
        if fresh_credit && refund == 0 {
            self.credits.remove(&job.owner);
        }
        emit_queue_event(
            "job_released",
            json!({ "job_id": job_id, "owner": job.owner, "storage_refund": refund.to_string() }),
        );
        refund
    }

    /// Every operator call is also a heartbeat.
    fn only_operator(&mut self) {
        require!(
            env::predecessor_account_id() == self.config.operator_id,
            "only operator"
        );
        self.operator_last_seen = now_secs();
    }

    /// New work is accepted only from a live, staked operator (when a minimum stake is set).
    fn accepting_work(&self, now: u64) -> bool {
        self.config.min_operator_stake == 0
            || (self.operator_stake >= self.config.min_operator_stake
                && now <= self.operator_last_seen.saturating_add(OPERATOR_HEARTBEAT_SECS))
    }

    /// A stake backs the queue (posted, or required): submissions are limited to accounts the operator approved.
    fn clients_only(&self) -> bool {
        self.config.min_operator_stake > 0 || self.operator_stake > 0
    }

    fn require_client(&self, account_id: &AccountId) {
        require!(
            !self.clients_only() || env::storage_has_key(&client_key(account_id)),
            format!("{account_id} is not an approved client of this queue: the operator approves accounts with allow_clients; nothing was charged")
        );
    }

    fn require_no_open_jobs(&self, what: &str) {
        require!(
            self.queue.is_empty() && self.running.is_none(),
            format!("{what} while a job is queued or running: the stake answers for every open job")
        );
    }

    fn require_accepting_work(&self, now: u64) {
        require!(
            self.operator_stake >= self.config.min_operator_stake,
            "the operator's stake is below the minimum: no new work is accepted, nothing was charged"
        );
        require!(
            self.accepting_work(now),
            format!("the worker is offline (no operator call in the last {OPERATOR_HEARTBEAT_SECS} s): no new work is accepted, nothing was charged")
        );
    }

    fn validate_proposal(proposal: &Proposal) {
        match proposal {
            Proposal::SetFeeBps { fee_bps } => require!(
                *fee_bps <= MAX_FEE_BPS,
                format!("fee_bps cannot exceed {MAX_FEE_BPS}")
            ),
            Proposal::SetTeeSigners { signers } => {
                require!(
                    signers.len() <= MAX_TEE_SIGNERS,
                    format!("at most {MAX_TEE_SIGNERS} signers")
                );
                for k in signers.iter() {
                    require!(
                        unhex(&normalize_signer(k)).len() == 32,
                        "each signer must be a 32-byte ed25519 public key in hex"
                    );
                }
            }
            Proposal::SetTeeModel { model: Some(m) } => validate_bytes("model", m, 1, 128),
            Proposal::Upgrade { code_sha256 } => require!(
                normalize_sha256(code_sha256).as_deref() == Some(code_sha256.as_str()),
                "code_sha256 must be 64 lowercase hex characters"
            ),
            _ => {}
        }
    }

    fn take_ready_proposal(&mut self, id: u64) -> PendingProposal {
        let pending = self
            .proposals
            .get(&id)
            .unwrap_or_else(|| env::panic_str("no such proposal"));
        require!(
            now_secs() >= pending.executable_at,
            format!("proposal {id} is timelocked until {}", pending.executable_at)
        );
        self.proposals.remove(&id);
        self.proposal_ids.retain(|p| *p != id);
        pending
    }

    fn require_not_paused(&self) {
        require!(!self.config.paused, "contract is paused");
    }

    fn job_or_panic(&self, job_id: u64) -> Job {
        self.jobs
            .get(&job_id)
            .unwrap_or_else(|| env::panic_str("job not found"))
    }

    fn remove_from_queue(&mut self, job_id: u64) -> bool {
        if let Some(index) = self.queue.iter().position(|id| *id == job_id) {
            self.queue.remove(index);
            true
        } else {
            false
        }
    }

    fn settle_completion(&mut self, job_id: u64, artifact_hash: String, attestation: Option<String>) {
        let mut job = self.job_or_panic(job_id);
        require!(
            job.status == JobStatus::Running && self.running == Some(job_id),
            "job is not running"
        );
        let now = now_secs();
        job.artifact_hash = Some(artifact_hash.clone());
        job.finished_at = Some(now);
        let attested = attestation.is_some();
        job.attestation = attestation;

        if now > job.deadline_at {
            job.status = JobStatus::Missed;
            self.pay_broken_promise(&mut job);
            self.jobs.insert(&job_id, &job);
            self.running = None;
            self.total_escrow =
                checked_sub_u128(self.total_escrow, checked_add_u128(job.reward, job.bond));
            self.stats.missed = checked_add_u64(self.stats.missed, 1);
            transfer_yocto(&job.owner, checked_add_u128(job.reward, job.bond));

            emit_queue_event(
                "job_missed",
                json!({
                    "job_id": job_id,
                    "owner": job.owner,
                    "reward": job.reward.to_string(),
                    "bond": job.bond.to_string(),
                    "reason": "late_completion",
                    "artifact_hash": artifact_hash,
                    "at": now,
                }),
            );
            self.record_activity(
                "job_missed",
                job.owner.clone(),
                Some(job_id),
                job.priority_id,
                checked_add_u128(job.reward, job.bond),
                format!("Job {job_id} completed late; marked missed and escrow refunded."),
            );
            return;
        }

        job.status = JobStatus::Done;
        self.jobs.insert(&job_id, &job);
        self.running = None;
        self.total_escrow =
            checked_sub_u128(self.total_escrow, checked_add_u128(job.reward, job.bond));
        self.stats.completed = checked_add_u64(self.stats.completed, 1);
        if attested {
            self.stats.attested = checked_add_u64(self.stats.attested, 1);
        }

        transfer_yocto(&self.config.operator_id.clone(), job.reward);
        transfer_yocto(&job.owner, job.bond);

        emit_queue_event(
            "job_completed",
            json!({
                "job_id": job_id,
                "owner": job.owner,
                "operator": self.config.operator_id,
                "reward": job.reward.to_string(),
                "bond": job.bond.to_string(),
                "artifact_hash": artifact_hash,
                "finished_at": now,
                "deadline_at": job.deadline_at,
                "on_time": true,
                "attestation": job.attestation,
            }),
        );
        self.record_activity(
            "job_completed",
            self.config.operator_id.clone(),
            Some(job_id),
            job.priority_id,
            checked_add_u128(job.reward, job.bond),
            format!(
                "Job {job_id} completed on time{}; {} reward to operator, {} bond returned.",
                if attested { " (TEE-attested answer)" } else { "" },
                job.reward, job.bond
            ),
        );
    }

    fn credit_spend(&mut self, account_id: &AccountId, amount: u128) {
        let balance = self.credits.get(account_id).unwrap_or(0);
        require!(
            balance >= amount,
            format!("balance too low: need {amount} yocto, have {balance}; deposit first or attach NEAR")
        );
        let rest = balance - amount;
        if rest == 0 {
            self.credits.remove(account_id);
        } else {
            self.credits.insert(account_id, &rest);
        }
        self.total_credits = checked_sub_u128(self.total_credits, amount);
    }

    fn credit_add(&mut self, account_id: &AccountId, amount: u128) {
        if amount == 0 {
            return;
        }
        let balance = self.credits.get(account_id).unwrap_or(0);
        let new_balance = checked_add_u128(balance, amount);
        self.credits.insert(account_id, &new_balance);
        self.total_credits = checked_add_u128(self.total_credits, amount);
    }

    /// `credit_add`, returning the bytes a fresh balance key added (0 when the account already had one).
    fn credit_add_counting(&mut self, account_id: &AccountId, amount: u128) -> u64 {
        let before = env::storage_usage();
        self.credit_add(account_id, amount);
        env::storage_usage().saturating_sub(before)
    }

    fn record_activity(
        &mut self,
        event: &str,
        actor: AccountId,
        job_id: Option<u64>,
        priority_id: Option<u64>,
        amount: u128,
        summary: String,
    ) {
        let id = self.next_activity_id;
        self.next_activity_id = checked_add_u64(id, 1);
        self.activity.push(Activity {
            id,
            at: now_secs(),
            event: event.to_string(),
            actor,
            job_id,
            priority_id,
            amount,
            summary,
        });
        if self.activity.len() > MAX_ACTIVITY {
            self.activity.remove(0);
        }
    }

    fn admission(&self, duration_secs: u32, deadline_secs: u32, now: u64) -> AdmissionView {
        let base = self.base_start(now);
        let queued: u64 = self
            .queue
            .iter()
            .map(|id| self.job_or_panic(*id).duration_secs as u64)
            .fold(0u64, checked_add_u64);
        let earliest_finish_at = checked_add_u64(base, duration_secs as u64);
        let finish_at_back = checked_add_u64(earliest_finish_at, queued);
        let deadline_at = checked_add_u64(now, deadline_secs as u64);
        AdmissionView {
            now,
            deadline_at,
            earliest_finish_at,
            finish_at_back,
            feasible_at_front: checked_add_u64(earliest_finish_at, COMPLETE_MARGIN_SECS) <= deadline_at,
            feasible_at_back: checked_add_u64(finish_at_back, COMPLETE_MARGIN_SECS) <= deadline_at,
        }
    }

    fn base_start(&self, now: u64) -> u64 {
        if let Some(running_id) = self.running {
            if let Some(running) = self.jobs.get(&running_id) {
                let started_at = running.started_at.unwrap_or(now);
                let finish = checked_add_u64(started_at, running.duration_secs as u64);
                return finish.max(now);
            }
        }
        now
    }

    /// Start/finish projections for every queued job, in queue order.
    fn projection_list(&self, now: u64) -> Vec<(u64, u64)> {
        let mut cursor = self.base_start(now);
        let mut out = Vec::with_capacity(self.queue.len());
        for job_id in self.queue.iter() {
            let Some(job) = self.jobs.get(job_id) else {
                continue;
            };
            let start = cursor;
            let finish = checked_add_u64(start, job.duration_secs as u64);
            out.push((start, finish));
            cursor = finish;
        }
        out
    }

    fn job_projection(&self, job: &Job, now: u64) -> (u32, u64, u64) {
        match job.status {
            JobStatus::Queued => {
                if let Some(index) = self.queue.iter().position(|id| *id == job.id) {
                    let projections = self.projection_list(now);
                    if let Some((start, finish)) = projections.get(index).copied() {
                        return ((index + 1) as u32, start, finish);
                    }
                }
                (0, 0, 0)
            }
            JobStatus::Running => {
                let start = job.started_at.unwrap_or(now);
                let finish = checked_add_u64(start, job.duration_secs as u64);
                (0, start, finish)
            }
            _ => (0, job.started_at.unwrap_or(0), job.finished_at.unwrap_or(0)),
        }
    }

    fn job_view(
        &self,
        job: &Job,
        position: u32,
        projected_start_at: u64,
        projected_finish_at: u64,
    ) -> JobView {
        JobView {
            id: job.id,
            owner: job.owner.clone(),
            title: job.title.clone(),
            input_hash: job.input_hash.clone(),
            input_uri: job.input_uri.clone(),
            duration_secs: job.duration_secs,
            deadline_at: job.deadline_at,
            submitted_at: job.submitted_at,
            reward: U128(job.reward),
            bond: U128(job.bond),
            ask_per_sec: U128(effective_ask(job, now_secs())),
            status: job.status,
            expedited: job.expedited,
            priority_id: job.priority_id,
            priority_spend: U128(job.priority_spend),
            moved_compensation: U128(job.moved_compensation),
            started_at: job.started_at,
            finished_at: job.finished_at,
            artifact_hash: job.artifact_hash.clone(),
            failure_hash: job.failure_hash.clone(),
            moves: job
                .moves
                .iter()
                .map(|m| MoveRecordView {
                    by_job_id: m.by_job_id,
                    amount: U128(m.amount),
                    delay_secs: m.delay_secs,
                    at: m.at,
                })
                .collect(),
            move_count: job.move_count,
            attested: job.attestation.is_some(),
            attestation: job.attestation.clone(),
            verify: job.verify,
            promised: job.promised,
            ask_pending: job.ask_pending.filter(|_| now_secs() < job.ask_effective_at).map(U128),
            ask_effective_at: job.ask_effective_at,
            storage_deposit: U128(job.storage_deposit),
            priority_ids: job.priority_ids.clone(),
            penalty_paid: U128(job.penalty_paid),
            position,
            projected_start_at,
            projected_finish_at,
        }
    }

    fn priority_view(&self, priority: &Priority) -> PriorityView {
        PriorityView {
            id: priority.id,
            job_id: priority.job_id,
            requester: priority.requester.clone(),
            at: priority.at,
            insert_index: priority.insert_index,
            compensation: U128(priority.compensation),
            fee: U128(priority.fee),
            total: U128(priority.total),
            latest_start_at: priority.latest_start_at,
            attached: U128(priority.attached),
            refunded: U128(priority.refunded),
            displaced: priority
                .displaced
                .iter()
                .map(|d| DisplacedView {
                    job_id: d.job_id,
                    owner: d.owner.clone(),
                    amount: U128(d.amount),
                    delay_secs: d.delay_secs,
                    new_finish_at: d.new_finish_at,
                    deadline_at: d.deadline_at,
                    slack_secs: d.slack_secs,
                })
                .collect(),
        }
    }

    /// Single source of truth for both `quote_priority` and `request_priority`.
    /// Never mutates state.
    fn quote_internal(&self, job_id: u64, latest_start_at: u64, now: u64) -> QuoteView {
        let job = self.job_or_panic(job_id);
        let latest_ok = latest_start_at >= now;

        if job.status != JobStatus::Queued {
            let (_, projected_start_at, projected_finish_at) = self.job_projection(&job, now);
            return QuoteView {
                job_id,
                now,
                latest_start_at,
                insert_index: 0,
                projected_start_at,
                projected_finish_at,
                compensation: U128(0),
                fee: U128(0),
                total: U128(0),
                displaced: Vec::new(),
                feasible: false,
                reason: "job is not queued".to_string(),
                checks: vec![
                    check(
                        "job_queued",
                        "Job is waiting in the queue",
                        false,
                        format!("Job status is {}.", job.status.as_str()),
                    ),
                    check(
                        "latest_start",
                        "Latest start is not in the past",
                        latest_ok,
                        format!("now = {now}, latest_start_at = {latest_start_at}."),
                    ),
                    check(
                        "insertion_slot",
                        "A slot exists at or before latest start",
                        false,
                        "Only queued jobs can buy priority.".to_string(),
                    ),
                    check(
                        "urgent_deadline",
                        "Urgent job still meets its deadline",
                        true,
                        "Not evaluated for a non-queued job.".to_string(),
                    ),
                    check(
                        "displaced_deadlines",
                        "Every displaced deadline still holds",
                        true,
                        "No displacement is possible.".to_string(),
                    ),
                ],
            };
        }

        let position = self
            .queue
            .iter()
            .position(|id| *id == job_id)
            .unwrap_or_else(|| env::panic_str("queued job missing from queue"));
        let base = self.base_start(now);

        // Prefix durations of jobs ahead of each candidate insert index. The
        // urgent job is at `position`, so for i <= position this is identical
        // to the prefix in the queue with the urgent job removed. A slot is
        // eligible only if it satisfies the caller's cutoff AND the urgent
        // job's own deadline; otherwise an earlier valid slot is skipped.
        let mut selected: Option<(u32, u64)> = None;
        let mut prefix: u64 = 0;
        for index in 0..=position {
            if index > 0 {
                let ahead_id = self.queue[index - 1];
                let ahead = self.job_or_panic(ahead_id);
                prefix = checked_add_u64(prefix, ahead.duration_secs as u64);
            }
            let start = checked_add_u64(base, prefix);
            let finish = checked_add_u64(start, job.duration_secs as u64);
            // Same buyer margin as the final check, so a slot is never chosen and then refused.
            if start <= latest_start_at && checked_add_u64(finish, DEADLINE_MARGIN_SECS) <= job.deadline_at {
                selected = Some((index as u32, start));
            }
        }

        let Some((insert_index, urgent_start)) = selected else {
            let earliest_finish = checked_add_u64(base, job.duration_secs as u64);
            let cutoff_ok = base <= latest_start_at;
            let urgent_ok = checked_add_u64(earliest_finish, DEADLINE_MARGIN_SECS) <= job.deadline_at;
            let reason = if !latest_ok {
                "latest_start_at is in the past".to_string()
            } else if cutoff_ok && !urgent_ok {
                format!(
                    "urgent job would finish at {earliest_finish}, after its deadline {}",
                    job.deadline_at
                )
            } else {
                "latest_start_at is earlier than the earliest possible start".to_string()
            };
            return QuoteView {
                job_id,
                now,
                latest_start_at,
                insert_index: 0,
                projected_start_at: base,
                projected_finish_at: earliest_finish,
                compensation: U128(0),
                fee: U128(0),
                total: U128(0),
                displaced: Vec::new(),
                feasible: false,
                reason,
                checks: vec![
                    check(
                        "job_queued",
                        "Job is waiting in the queue",
                        true,
                        format!("Job position is {}.", position + 1),
                    ),
                    check(
                        "latest_start",
                        "Latest start is not in the past",
                        latest_ok,
                        format!("now = {now}, latest_start_at = {latest_start_at}."),
                    ),
                    check(
                        "insertion_slot",
                        "A slot satisfies the cutoff and urgent deadline",
                        false,
                        format!(
                            "No insert index can start at or before {latest_start_at} and finish by {}.",
                            job.deadline_at
                        ),
                    ),
                    check(
                        "urgent_deadline",
                        "Urgent job still meets its deadline",
                        urgent_ok,
                        format!(
                            "Earliest finish is {earliest_finish}; deadline is {}.",
                            job.deadline_at
                        ),
                    ),
                    check(
                        "displaced_deadlines",
                        "Every displaced deadline still holds",
                        true,
                        "No jobs are displaced.".to_string(),
                    ),
                ],
            };
        };

        let urgent_finish = checked_add_u64(urgent_start, job.duration_secs as u64);
        // The buyer gets the same margin as the jobs it passes: its real start lands after a settle and a start
        // transaction, and a slot it cannot keep would cost it the price for nothing.
        let urgent_ok = checked_add_u64(urgent_finish, DEADLINE_MARGIN_SECS) <= job.deadline_at;

        let mut displaced = Vec::with_capacity(position - insert_index as usize);
        let mut compensation: u128 = 0;
        let mut first_bad: Option<u64> = None;

        // Only jobs between the new slot and the urgent job's old position are
        // jumped. Jobs already behind the urgent job keep their projection.
        let mut cursor = checked_add_u64(base, prefix_before(self, insert_index as usize));
        for index in insert_index as usize..position {
            let displaced_id = self.queue[index];
            let displaced_job = self.job_or_panic(displaced_id);
            let old_finish = checked_add_u64(cursor, displaced_job.duration_secs as u64);
            let new_finish = checked_add_u64(old_finish, job.duration_secs as u64);
            let amount = checked_mul_u128(effective_ask(&displaced_job, now), job.duration_secs as u128);
            compensation = checked_add_u128(compensation, amount);
            let handoffs = (index - insert_index as usize) as u64;
            let margin = checked_add_u64(DEADLINE_MARGIN_SECS, MARGIN_PER_HANDOFF_SECS * handoffs);
            // A job already projected to miss its deadline has no promise left to keep: it cannot block the jump
            // (it is still paid its ask).
            let doomed = checked_add_u64(old_finish, COMPLETE_MARGIN_SECS) > displaced_job.deadline_at;
            if !doomed && checked_add_u64(new_finish, margin) > displaced_job.deadline_at && first_bad.is_none() {
                first_bad = Some(displaced_id);
            }
            displaced.push(DisplacedView {
                job_id: displaced_id,
                owner: displaced_job.owner.clone(),
                amount: U128(amount),
                delay_secs: job.duration_secs,
                new_finish_at: new_finish,
                deadline_at: displaced_job.deadline_at,
                slack_secs: slack_secs(displaced_job.deadline_at, new_finish),
            });
            cursor = old_finish;
        }
        let displaced_ok = first_bad.is_none();

        let fee = fee_floor(compensation, self.config.fee_bps);
        let total = checked_add_u128(compensation, fee);
        let feasible = latest_ok && urgent_ok && displaced_ok;

        let reason = if !latest_ok {
            "latest_start_at is in the past".to_string()
        } else if !urgent_ok {
            format!(
                "urgent job would finish at {urgent_finish}, after its deadline {}",
                job.deadline_at
            )
        } else if let Some(bad_id) = first_bad {
            let bad = displaced
                .iter()
                .find(|d| d.job_id == bad_id)
                .cloned()
                .unwrap_or_else(|| env::panic_str("displaced job missing"));
            if bad.new_finish_at > bad.deadline_at {
                format!(
                    "displaced job {bad_id} would finish at {}, after its deadline {}",
                    bad.new_finish_at, bad.deadline_at
                )
            } else {
                format!(
                    "displaced job {bad_id} would finish at {}, inside the safety margin before its deadline {}",
                    bad.new_finish_at, bad.deadline_at
                )
            }
        } else {
            String::new()
        };

        let displaced_detail = if displaced.is_empty() {
            "No jobs are displaced.".to_string()
        } else if displaced_ok {
            format!(
                "{} job(s) move back {}s; every deadline still holds.",
                displaced.len(),
                job.duration_secs
            )
        } else {
            format!(
                "Job {} would finish after its deadline.",
                first_bad.unwrap_or(0)
            )
        };

        QuoteView {
            job_id,
            now,
            latest_start_at,
            insert_index,
            projected_start_at: urgent_start,
            projected_finish_at: urgent_finish,
            compensation: U128(compensation),
            fee: U128(fee),
            total: U128(total),
            displaced,
            feasible,
            reason,
            checks: vec![
                check(
                    "job_queued",
                    "Job is waiting in the queue",
                    true,
                    format!("Job position is {}.", position + 1),
                ),
                check(
                    "latest_start",
                    "Latest start is not in the past",
                    latest_ok,
                    format!("now = {now}, latest_start_at = {latest_start_at}."),
                ),
                check(
                    "insertion_slot",
                    "A slot satisfies the cutoff and urgent deadline",
                    true,
                    format!(
                        "Insert index {insert_index} starts at {urgent_start} (cutoff {latest_start_at}) and finishes by {}.",
                        job.deadline_at
                    ),
                ),
                check(
                    "urgent_deadline",
                    "Urgent job still meets its deadline",
                    urgent_ok,
                    format!(
                        "Finishes at {urgent_finish}; deadline is {}.",
                        job.deadline_at
                    ),
                ),
                check(
                    "displaced_deadlines",
                    "Every displaced deadline still holds",
                    displaced_ok,
                    displaced_detail,
                ),
            ],
        }
    }
}

// Prefix duration of queued jobs strictly before `index`. Free function so the
// quote path cannot accidentally mutate state.
fn prefix_before(contract: &Contract, index: usize) -> u64 {
    let mut total = 0u64;
    for id in contract.queue.iter().take(index) {
        if let Some(job) = contract.jobs.get(id) {
            total = checked_add_u64(total, job.duration_secs as u64);
        }
    }
    total
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// Test-only shortcuts for owner actions: the unit tests written against v2 call these. They keep the owner check
/// and validation but skip the timelock, which has its own tests.
#[cfg(test)]
impl Contract {
    pub fn set_operator(&mut self, account_id: AccountId) {
        self.owner_apply(Proposal::SetOperator { account_id });
    }
    pub fn set_treasury(&mut self, account_id: AccountId) {
        self.owner_apply(Proposal::SetTreasury { account_id });
    }
    pub fn set_fee_bps(&mut self, fee_bps: u16) {
        self.owner_apply(Proposal::SetFeeBps { fee_bps });
    }
    pub fn set_tee_signers(&mut self, signers: Vec<String>) {
        self.owner_apply(Proposal::SetTeeSigners { signers });
    }
    pub fn set_tee_model(&mut self, model: Option<String>) {
        self.owner_apply(Proposal::SetTeeModel { model });
    }
    pub fn set_min_operator_stake(&mut self, amount: u128) {
        self.owner_apply(Proposal::SetMinOperatorStake { amount: U128(amount) });
    }
    fn owner_apply(&mut self, proposal: Proposal) {
        self.only_owner();
        Self::validate_proposal(&proposal);
        self.apply_proposal(proposal);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::mock::MockAction;
    use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
    use near_sdk::testing_env;
    use std::panic::{catch_unwind, AssertUnwindSafe};

    const NOW: u64 = 1_700_000_000;
    const R: u128 = 1_000_000;
    const B: u128 = 500_000;
    /// Storage price per byte in the test environment (the protocol's 10^19 yocto).
    const BYTE: u128 = 10_000_000_000_000_000_000;
    const FEE: u16 = 1_000;

    fn acct(name: &str) -> AccountId {
        format!("{name}.testnet").parse().unwrap()
    }

    fn as_(signer: &AccountId, secs: u64, deposit: u128) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(acct("queue"))
            .signer_account_id(signer.clone())
            .predecessor_account_id(signer.clone())
            .block_timestamp(secs * NS_PER_SEC)
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .account_balance(NearToken::from_near(10_000))
            .build());
    }

    struct Fx {
        c: Contract,
        owner: AccountId,
        operator: AccountId,
        treasury: AccountId,
        alice: AccountId,
        bob: AccountId,
        carol: AccountId,
        dave: AccountId,
    }

    fn setup_with_fee(fee_bps: u16) -> Fx {
        let owner = acct("owner");
        let operator = acct("operator");
        let treasury = acct("treasury");
        let (alice, bob, carol, dave) = (acct("alice"), acct("bob"), acct("carol"), acct("dave"));
        as_(&owner, NOW, 0);
        let c = Contract::new(owner.clone(), operator.clone(), treasury.clone(), fee_bps, None, None, None, None);
        Fx {
            c,
            owner,
            operator,
            treasury,
            alice,
            bob,
            carol,
            dave,
        }
    }

    fn setup() -> Fx {
        setup_with_fee(FEE)
    }

    #[allow(clippy::too_many_arguments)]
    fn submit_at(
        c: &mut Contract,
        who: &AccountId,
        ts: u64,
        title: &str,
        duration_secs: u32,
        deadline_secs: u32,
        reward: u128,
        bond: u128,
        ask_per_sec: u128,
    ) -> u64 {
        as_(who, ts, reward + bond + JOB_STORAGE_DEPOSIT);
        c.submit_job(
            title.to_string(),
            "sha256:input".to_string(),
            "https://example.test/input.txt".to_string(),
            duration_secs,
            deadline_secs,
            U128(reward),
            U128(ask_per_sec),
            None, None, None, None
        )
    }

    fn quote_at(c: &Contract, ts: u64, job_id: u64, latest_start_at: u64) -> QuoteView {
        let signer = acct("viewer");
        as_(&signer, ts, 0);
        c.quote_priority(job_id, latest_start_at)
    }

    fn request_at(
        c: &mut Contract,
        who: &AccountId,
        ts: u64,
        job_id: u64,
        latest_start_at: u64,
        max_spend: u128,
        attached: u128,
    ) -> PriorityView {
        // Tests reason about compensation and refunds; the non-refundable
        // storage deposit for the quoted displacement is added on top.
        let displaced = quote_at(c, ts, job_id, latest_start_at).displaced.len();
        as_(who, ts, attached + priority_storage_deposit(displaced));
        c.request_priority(job_id, latest_start_at, U128(max_spend))
    }

    fn panics<F, R>(f: F) -> bool
    where
        F: FnOnce() -> R,
    {
        catch_unwind(AssertUnwindSafe(f)).is_err()
    }

    fn transfers() -> Vec<(AccountId, u128)> {
        get_created_receipts()
            .into_iter()
            .flat_map(|receipt| {
                let receiver = receipt.receiver_id.clone();
                receipt
                    .actions
                    .into_iter()
                    .filter_map(move |action| match action {
                        MockAction::Transfer { deposit, .. } => {
                            Some((receiver.clone(), deposit.as_yoctonear()))
                        }
                        _ => None,
                    })
            })
            .collect()
    }

    fn transferred_to(account_id: &AccountId) -> u128 {
        transfers()
            .into_iter()
            .filter(|(to, _)| to == account_id)
            .map(|(_, amount)| amount)
            .sum()
    }

    fn has_log(needle: &str) -> bool {
        get_logs().iter().any(|line| line.contains(needle))
    }

    fn queue_ids(fx: &Fx) -> Vec<u64> {
        fx.c.get_queue().into_iter().map(|j| j.id).collect()
    }

    // 1 -------------------------------------------------------------------
    #[test]
    fn test_submit_escrows_fifo_and_positions() {
        let mut fx = setup();
        let a = submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 100, R, B, 100);
        let b = submit_at(&mut fx.c, &fx.alice, NOW, "B", 20, 200, R, B, 200);

        let ja = fx.c.get_job(a);
        let jb = fx.c.get_job(b);
        assert_eq!(ja.bond.0, B, "bond is attached deposit minus reward");
        assert_eq!(ja.status, JobStatus::Queued);
        assert_eq!(ja.deadline_at, NOW + 100);
        assert_eq!(ja.position, 1);
        assert_eq!(ja.projected_start_at, NOW);
        assert_eq!(ja.projected_finish_at, NOW + 10);
        assert_eq!(jb.position, 2);
        assert_eq!(jb.projected_start_at, NOW + 10);
        assert_eq!(jb.projected_finish_at, NOW + 30);

        let queue = fx.c.get_queue();
        assert_eq!(queue.len(), 2);
        assert_eq!(queue[0].id, a);
        assert_eq!(queue[1].id, b);

        let stats = fx.c.get_stats();
        assert_eq!(stats.submitted, 2);
        assert_eq!(stats.queued, 2);
        assert_eq!(stats.running, 0);
        assert_eq!(stats.total_escrow.0, 2 * (R + B));
        assert_eq!(stats.total_credits.0, 0);
        assert!(has_log("\"event\":\"job_submitted\""));
        assert_eq!(fx.c.get_activity(10).len(), 2);
    }

    // 2 -------------------------------------------------------------------
    #[test]
    fn test_submit_rejects_missing_bond() {
        let mut fx = setup();
        as_(&fx.alice, NOW, R);
        let failed = panics(|| {
            fx.c.submit_job(
                "no bond".to_string(),
                "sha256:input".to_string(),
                String::new(),
                10,
                100,
                U128(R),
                U128(10),
                None, None, None, None
            )
        });
        assert!(failed, "attached deposit must include a positive bond");
    }

    // 3 -------------------------------------------------------------------
    #[test]
    fn test_submit_input_bounds() {
        let mut fx = setup();
        let long_title = "a".repeat(MAX_TITLE_CHARS + 1);
        let long_uri = "u".repeat(MAX_URI_LEN + 1);
        let long_hash = "h".repeat(MAX_INPUT_HASH_LEN + 1);

        let cases: Vec<(String, String, String, u32, u32)> = vec![
            (
                "".to_string(),
                "sha256:input".to_string(),
                String::new(),
                1,
                1,
            ),
            (long_title, "sha256:input".to_string(), String::new(), 1, 1),
            ("title".to_string(), "".to_string(), String::new(), 1, 1),
            ("title".to_string(), long_hash, String::new(), 1, 1),
            (
                "title".to_string(),
                "sha256:input".to_string(),
                long_uri,
                1,
                1,
            ),
            (
                "title".to_string(),
                "sha256:input".to_string(),
                String::new(),
                0,
                1,
            ),
            (
                "title".to_string(),
                "sha256:input".to_string(),
                String::new(),
                MAX_DURATION_SECS + 1,
                1,
            ),
            (
                "title".to_string(),
                "sha256:input".to_string(),
                String::new(),
                1,
                0,
            ),
            (
                "title".to_string(),
                "sha256:input".to_string(),
                String::new(),
                1,
                MAX_DEADLINE_SECS + 1,
            ),
        ];

        for (title, input_hash, input_uri, duration, deadline) in cases {
            as_(&fx.alice, NOW, 2);
            let failed = panics(|| {
                fx.c.submit_job(
                    title.clone(),
                    input_hash.clone(),
                    input_uri.clone(),
                    duration,
                    deadline,
                    U128(1),
                    U128(0),
                    None, None, None, None
                )
            });
            assert!(
                failed,
                "expected bounds failure for duration={duration} deadline={deadline}"
            );
        }

        // A valid job still fits after all rejected submissions.
        let id = submit_at(&mut fx.c, &fx.alice, NOW, "valid", 1, 1 + COMPLETE_MARGIN_SECS as u32, 1, 1, 0);
        assert_eq!(fx.c.get_job(id).status, JobStatus::Queued);
    }

    // 4 -------------------------------------------------------------------
    #[test]
    fn test_new_fee_cap_and_admin_config() {
        let owner = acct("owner");
        let operator = acct("operator");
        let treasury = acct("treasury");
        as_(&owner, NOW, 0);
        assert!(panics(|| {
            Contract::new(owner.clone(), operator.clone(), treasury.clone(), 1_001, None, None, None, None)
        }));

        let mut fx = setup();
        let cfg = fx.c.get_config();
        assert_eq!(cfg.owner_id, fx.owner);
        assert_eq!(cfg.operator_id, fx.operator);
        assert_eq!(cfg.treasury_id, fx.treasury);
        assert_eq!(cfg.fee_bps, FEE);
        assert!(!cfg.paused);
        assert_eq!(cfg.max_queue, MAX_QUEUE as u32);

        as_(&fx.owner, NOW, 0);
        fx.c.set_fee_bps(0);
        fx.c.set_operator(fx.carol.clone());
        fx.c.set_treasury(fx.dave.clone());
        fx.c.set_paused(true);
        let cfg = fx.c.get_config();
        assert_eq!(cfg.fee_bps, 0);
        assert_eq!(cfg.operator_id, fx.carol);
        assert_eq!(cfg.treasury_id, fx.dave);
        assert!(cfg.paused);

        as_(&fx.owner, NOW, 0);
        assert!(panics(|| fx.c.set_fee_bps(1_001)));
    }

    // 5 -------------------------------------------------------------------
    #[test]
    fn test_quote_exact_math_and_no_mutation() {
        let mut fx = setup();
        let a = submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 1_000, R, B, 100);
        let b = submit_at(&mut fx.c, &fx.bob, NOW, "B", 10, 1_000, R, B, 200);
        let c = submit_at(&mut fx.c, &fx.carol, NOW, "C", 10, 1_000, R, B, 300);
        let d = submit_at(&mut fx.c, &fx.dave, NOW, "D", 10, 1_000, R, B, 400);
        let urgent = submit_at(&mut fx.c, &fx.dave, NOW, "urgent", 12, 1_000, R, B, 1);

        let before_queue = queue_ids(&fx);
        let before_stats = fx.c.get_stats();
        let before_credit = fx.c.get_credit(fx.alice.clone()).0;

        let q = quote_at(&fx.c, NOW, urgent, NOW);
        assert!(q.feasible, "reason: {}", q.reason);
        assert_eq!(q.insert_index, 0);
        assert_eq!(q.projected_start_at, NOW);
        assert_eq!(q.projected_finish_at, NOW + 12);
        assert_eq!(q.compensation.0, 12 * (100 + 200 + 300 + 400));
        assert_eq!(q.compensation.0, 12_000);
        assert_eq!(q.fee.0, 1_200);
        assert_eq!(q.total.0, 13_200);
        assert_eq!(q.displaced.len(), 4);
        assert_eq!(q.displaced[0].job_id, a);
        assert_eq!(q.displaced[1].job_id, b);
        assert_eq!(q.displaced[2].job_id, c);
        assert_eq!(q.displaced[3].job_id, d);
        assert_eq!(q.displaced[0].amount.0, 1_200);
        assert_eq!(q.displaced[1].amount.0, 2_400);
        assert_eq!(q.displaced[2].amount.0, 3_600);
        assert_eq!(q.displaced[3].amount.0, 4_800);
        assert_eq!(q.displaced[0].delay_secs, 12);
        assert_eq!(q.displaced[0].new_finish_at, NOW + 22);
        assert_eq!(q.displaced[0].slack_secs, 1_000 - 22);
        assert_eq!(q.checks.len(), 5);
        assert!(q.checks.iter().all(|c| c.ok));

        // Quote is a pure view.
        assert_eq!(queue_ids(&fx), before_queue);
        let after_stats = fx.c.get_stats();
        assert_eq!(after_stats.total_escrow.0, before_stats.total_escrow.0);
        assert_eq!(after_stats.total_credits.0, before_stats.total_credits.0);
        assert_eq!(fx.c.get_credit(fx.alice.clone()).0, before_credit);
    }

    // 6 -------------------------------------------------------------------
    #[test]
    fn test_demo_quote_four_displacements() {
        const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
        let mut fx = setup_with_fee(100); // demo fee: 1%
        submit_at(
            &mut fx.c,
            &fx.alice,
            NOW,
            "Triage the checkout incident",
            11,
            150,
            R,
            B,
            NEAR / 100_000 * 42,
        );
        submit_at(
            &mut fx.c,
            &fx.bob,
            NOW,
            "Audit the failed settlements export",
            9,
            120,
            R,
            B,
            NEAR / 100_000 * 58,
        );
        submit_at(
            &mut fx.c,
            &fx.carol,
            NOW,
            "Draft the Northline pilot brief",
            10,
            180,
            R,
            B,
            NEAR / 100_000 * 36,
        );
        submit_at(
            &mut fx.c,
            &fx.carol,
            NOW,
            "Summarize the latency escalation",
            12,
            160,
            R,
            B,
            NEAR / 100_000 * 31,
        );
        let kestrel = submit_at(
            &mut fx.c,
            &fx.dave,
            NOW,
            "Board brief",
            12,
            34,
            NEAR * 2 / 100,
            NEAR * 15 / 1_000,
            1,
        );

        // AGENTS.md's now + 5s cutoff. BUILD_SPEC.md's 18s cutoff would not
        // displace Mira (11s), so it cannot produce the documented four moves.
        let q = quote_at(&fx.c, NOW, kestrel, NOW + 5);
        assert!(q.feasible, "reason: {}", q.reason);
        assert_eq!(q.insert_index, 0);
        assert_eq!(q.displaced.len(), 4);
        assert_eq!(q.compensation.0, NEAR / 100_000 * 2_004);
        assert_eq!(q.fee.0, NEAR * 2_004 / 10_000_000);
        assert_eq!(q.total.0, NEAR * 202_404 / 10_000_000);
        assert!(q.displaced.iter().all(|d| d.slack_secs > 0));
        assert_eq!(q.projected_finish_at, NOW + 12);
    }

    // 7 -------------------------------------------------------------------
    #[test]
    fn test_latest_feasible_insertion_index() {
        let mut fx = setup();
        let a = submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 1_000, R, B, 100);
        let b = submit_at(&mut fx.c, &fx.bob, NOW, "B", 10, 1_000, R, B, 200);
        let c = submit_at(&mut fx.c, &fx.carol, NOW, "C", 10, 1_000, R, B, 300);
        let urgent = submit_at(&mut fx.c, &fx.dave, NOW, "urgent", 5, 1_000, R, B, 1);

        let q = quote_at(&fx.c, NOW, urgent, NOW + 15);
        assert!(q.feasible, "reason: {}", q.reason);
        assert_eq!(q.insert_index, 1, "latest index whose start <= cutoff");
        assert_eq!(q.projected_start_at, NOW + 10);
        assert_eq!(q.projected_finish_at, NOW + 15);
        assert_eq!(q.displaced.len(), 2);
        assert_eq!(q.displaced[0].job_id, b);
        assert_eq!(q.displaced[1].job_id, c);
        assert_eq!(q.compensation.0, 5 * (200 + 300));
        assert_eq!(q.fee.0, 250);
        assert_eq!(q.total.0, 2_750);
        assert_eq!(q.displaced[0].new_finish_at, NOW + 25);
        assert_eq!(q.displaced[1].new_finish_at, NOW + 35);
        assert_ne!(q.displaced[0].job_id, a);
    }

    // 8 -------------------------------------------------------------------
    #[test]
    fn test_non_tail_urgent_only_jumps_jobs_ahead() {
        let mut fx = setup();
        let a = submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 1_000, R, B, 100);
        let b = submit_at(&mut fx.c, &fx.bob, NOW, "B", 10, 1_000, R, B, 200);
        let urgent = submit_at(&mut fx.c, &fx.dave, NOW, "urgent", 10, 1_000, R, B, 1);
        let c = submit_at(&mut fx.c, &fx.carol, NOW, "C", 10, 1_000, R, B, 300);

        // C is already behind the urgent job and must not be delayed or paid.
        let c_before = fx.c.get_job(c);
        assert_eq!(c_before.projected_start_at, NOW + 30);
        assert_eq!(c_before.projected_finish_at, NOW + 40);

        let q = quote_at(&fx.c, NOW, urgent, NOW);
        assert!(q.feasible, "reason: {}", q.reason);
        assert_eq!(q.insert_index, 0);
        assert_eq!(q.displaced.len(), 2);
        assert_eq!(q.displaced[0].job_id, a);
        assert_eq!(q.displaced[1].job_id, b);
        assert_eq!(q.compensation.0, 10 * (100 + 200));

        let p = request_at(&mut fx.c, &fx.dave, NOW, urgent, NOW, 3_300, 3_300);
        assert_eq!(p.total.0, 3_300);
        assert_eq!(queue_ids(&fx), vec![urgent, a, b, c]);

        let c_after = fx.c.get_job(c);
        assert_eq!(c_after.projected_start_at, c_before.projected_start_at);
        assert_eq!(c_after.projected_finish_at, c_before.projected_finish_at);
        assert_eq!(c_after.move_count, 0);
        assert_eq!(c_after.moved_compensation.0, 0);
        assert_eq!(fx.c.get_credit(fx.carol.clone()).0, 0);
    }

    // 9 -------------------------------------------------------------------
    #[test]
    fn test_urgent_deadline_steers_insertion_index() {
        // The cutoff is deliberately loose: the latest cutoff slot would miss
        // the urgent deadline, but the front slot still meets it.
        let mut fx = setup();
        let a = submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 1_000, R, B, 100);
        let b = submit_at(&mut fx.c, &fx.bob, NOW, "B", 10, 1_000, R, B, 200);
        let urgent = submit_at(&mut fx.c, &fx.dave, NOW, "urgent", 5, 8, R, B, 1);

        let q = quote_at(&fx.c, NOW, urgent, NOW + 100);
        assert!(q.feasible, "reason: {}", q.reason);
        assert_eq!(
            q.insert_index, 0,
            "must fall back to the earlier slot that meets the urgent deadline"
        );
        assert_eq!(q.projected_start_at, NOW);
        assert_eq!(q.projected_finish_at, NOW + 5);
        assert_eq!(q.displaced.len(), 2);
        assert_eq!(q.displaced[0].job_id, a);
        assert_eq!(q.displaced[1].job_id, b);
        assert_eq!(q.compensation.0, 5 * (100 + 200));
        assert!(
            q.checks
                .iter()
                .find(|c| c.key == "urgent_deadline")
                .unwrap()
                .ok
        );
    }

    // 10 -------------------------------------------------------------------
    #[test]
    fn test_urgent_deadline_infeasible_at_every_slot() {
        let mut fx = setup();
        submit_at(&mut fx.c, &fx.alice, NOW, "A", 1, 1_000, R, B, 100);
        // Two seconds of spare time: enough to be admitted, not enough for the buyer's 3 s margin at any slot.
        let urgent = submit_at(&mut fx.c, &fx.dave, NOW, "urgent", 10, 12, R, B, 1);

        let q = quote_at(&fx.c, NOW + 1, urgent, NOW + 100);
        assert!(!q.feasible);
        assert_eq!(q.insert_index, 0);
        assert!(q.displaced.is_empty());
        assert_eq!(q.compensation.0, 0);
        assert_eq!(q.total.0, 0);
        assert!(q.reason.contains("urgent job would finish"), "{}", q.reason);
        assert!(
            !q.checks
                .iter()
                .find(|c| c.key == "urgent_deadline")
                .unwrap()
                .ok
        );
    }

    // 11 -------------------------------------------------------------------
    #[test]
    fn test_latest_start_in_the_past_rejected() {
        let mut fx = setup();
        submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 1_000, R, B, 100);
        let urgent = submit_at(&mut fx.c, &fx.dave, NOW, "urgent", 5, 1_000, R, B, 1);

        let q = quote_at(&fx.c, NOW, urgent, NOW.saturating_sub(1));
        assert!(!q.feasible);
        assert_eq!(q.reason, "latest_start_at is in the past");
        assert!(
            !q.checks
                .iter()
                .find(|c| c.key == "latest_start")
                .unwrap()
                .ok
        );
    }

    // 12 ------------------------------------------------------------------
    #[test]
    fn test_deadline_protection_and_signed_slack() {
        let mut fx = setup();
        let a = submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 1_000, R, B, 100);
        // B is on schedule (finishes at +20, deadline +25) but a 10 s jump would make it late.
        let b = submit_at(&mut fx.c, &fx.bob, NOW, "B", 10, 25, R, B, 200);
        let urgent = submit_at(&mut fx.c, &fx.dave, NOW, "urgent", 10, 1_000, R, B, 1);

        let q = quote_at(&fx.c, NOW, urgent, NOW);
        assert!(!q.feasible);
        assert_eq!(q.compensation.0, 10 * (100 + 200));
        assert!(q.reason.contains("displaced job"), "{}", q.reason);
        let displaced_b = q.displaced.iter().find(|d| d.job_id == b).unwrap();
        assert_eq!(displaced_b.new_finish_at, NOW + 30);
        assert_eq!(displaced_b.deadline_at, NOW + 25);
        assert_eq!(displaced_b.slack_secs, -5, "signed slack must go negative");
        let displaced_a = q.displaced.iter().find(|d| d.job_id == a).unwrap();
        assert_eq!(displaced_a.slack_secs, 1_000 - 20);

        // Request refuses with the same helper and does not mutate.
        let before = queue_ids(&fx);
        as_(&fx.dave, NOW, q.total.0);
        assert!(panics(|| {
            fx.c.request_priority(urgent, NOW, U128(q.total.0));
        }));
        assert_eq!(queue_ids(&fx), before);
    }

    // 13 ------------------------------------------------------------------
    #[test]
    fn test_budget_and_attached_deposit_rejections() {
        let mut fx = setup();
        let a = submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 1_000, R, B, 100);
        let b = submit_at(&mut fx.c, &fx.bob, NOW, "B", 10, 1_000, R, B, 200);
        let urgent = submit_at(&mut fx.c, &fx.dave, NOW, "urgent", 10, 1_000, R, B, 1);

        let q = quote_at(&fx.c, NOW, urgent, NOW);
        assert_eq!(q.total.0, 3_300);

        let storage = priority_storage_deposit(q.displaced.len());
        as_(&fx.dave, NOW, 3_300 + storage);
        assert!(panics(|| {
            fx.c.request_priority(urgent, NOW, U128(3_299));
        }));

        as_(&fx.dave, NOW, 3_299 + storage);
        assert!(panics(|| {
            fx.c.request_priority(urgent, NOW, U128(3_300));
        }));

        // The exact total without the storage deposit is also refused.
        as_(&fx.dave, NOW, 3_300);
        assert!(panics(|| {
            fx.c.request_priority(urgent, NOW, U128(3_300));
        }));

        // Attaching more than max_spend is allowed only because the actual
        // charge (total) still fits; the excess becomes a credit.
        let p = request_at(&mut fx.c, &fx.dave, NOW, urgent, NOW, 3_300, 3_400);
        assert_eq!(p.total.0, 3_300);
        assert_eq!(p.refunded.0, 100);
        assert_eq!(fx.c.get_credit(fx.dave.clone()).0, 100);
        assert_eq!(queue_ids(&fx), vec![urgent, a, b]);
        assert_eq!(fx.c.get_stats().total_credits.0, 3_400);
        assert_eq!(fx.c.get_stats().total_escrow.0, 3 * (R + B));
    }

    // 14 ------------------------------------------------------------------
    #[test]
    fn test_priority_reorder_credits_fee_and_excess() {
        let mut fx = setup();
        let a = submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 1_000, R, B, 100);
        let b = submit_at(&mut fx.c, &fx.bob, NOW, "B", 10, 1_000, R, B, 200);
        let c = submit_at(&mut fx.c, &fx.carol, NOW, "C", 10, 1_000, R, B, 300);
        let d = submit_at(&mut fx.c, &fx.dave, NOW, "D", 10, 1_000, R, B, 400);
        let urgent = submit_at(&mut fx.c, &fx.dave, NOW, "urgent", 12, 1_000, R, B, 1);

        let p = request_at(&mut fx.c, &fx.dave, NOW, urgent, NOW, 15_000, 15_000);
        assert_eq!(p.id, 1);
        assert_eq!(p.job_id, urgent);
        assert_eq!(p.insert_index, 0);
        assert_eq!(p.compensation.0, 12_000);
        assert_eq!(p.fee.0, 1_200);
        assert_eq!(p.total.0, 13_200);
        assert_eq!(p.refunded.0, 1_800);
        assert_eq!(p.displaced.len(), 4);

        assert_eq!(queue_ids(&fx), vec![urgent, a, b, c, d]);
        assert_eq!(fx.c.get_credit(fx.alice.clone()).0, 1_200);
        assert_eq!(fx.c.get_credit(fx.bob.clone()).0, 2_400);
        assert_eq!(fx.c.get_credit(fx.carol.clone()).0, 3_600);
        assert_eq!(fx.c.get_credit(fx.dave.clone()).0, 1_800 + 4_800);
        assert_eq!(fx.c.get_credit(fx.treasury.clone()).0, 1_200);

        let urgent_view = fx.c.get_job(urgent);
        assert_eq!(urgent_view.position, 1);
        assert!(urgent_view.expedited);
        assert_eq!(urgent_view.priority_id, Some(1));
        assert_eq!(urgent_view.priority_spend.0, 13_200);
        assert_eq!(fx.c.get_job(a).position, 2);

        let stats = fx.c.get_stats();
        assert_eq!(stats.moves, 4);
        assert_eq!(stats.total_priority.0, 13_200);
        assert_eq!(stats.total_compensation.0, 12_000);
        assert_eq!(stats.total_fees.0, 1_200);
        assert_eq!(stats.total_escrow.0, 5 * (R + B));
        assert_eq!(stats.total_credits.0, 15_000);
        assert!(
            transfers().is_empty(),
            "priority settles internally as credits"
        );

        let stored = fx.c.get_priority(1);
        assert_eq!(stored.total.0, 13_200);
        assert_eq!(stored.displaced.len(), 4);
        assert_eq!(fx.c.get_activity(1)[0].event, "priority_purchased");
        assert!(has_log("\"event\":\"priority_purchased\""));
    }

    // 15 ------------------------------------------------------------------
    #[test]
    fn test_withdraw_credit_zeroes_first_and_prevents_double_spend() {
        let mut fx = setup();
        let a = submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 1_000, R, B, 100);
        let urgent = submit_at(&mut fx.c, &fx.dave, NOW, "urgent", 5, 1_000, R, B, 1);
        request_at(&mut fx.c, &fx.dave, NOW, urgent, NOW, 550, 550);

        assert_eq!(fx.c.get_credit(fx.alice.clone()).0, 500);
        assert_eq!(fx.c.get_credit(fx.treasury.clone()).0, 50);
        assert_eq!(fx.c.get_stats().total_credits.0, 550);

        as_(&fx.alice, NOW + 1, 0);
        let withdrawn = fx.c.withdraw_credit();
        assert_eq!(withdrawn.0, 500);
        assert_eq!(fx.c.get_credit(fx.alice.clone()).0, 0);
        assert_eq!(
            fx.c.get_stats().total_credits.0,
            50,
            "fee credit remains for treasury"
        );
        assert_eq!(transferred_to(&fx.alice), 500);
        assert!(has_log("\"event\":\"credit_withdrawn\""));
        assert_eq!(fx.c.get_activity(1)[0].event, "credit_withdrawn");
        assert_eq!(fx.c.get_job(a).id, a);

        as_(&fx.alice, NOW + 2, 0);
        let zero = fx.c.withdraw_credit();
        assert_eq!(zero.0, 0);
        assert!(transfers().is_empty(), "no second transfer");
    }

    // 16 ------------------------------------------------------------------
    #[test]
    fn test_start_and_complete_on_time_exact_deadline() {
        let mut fx = setup();
        let a = submit_at(&mut fx.c, &fx.alice, NOW, "A", 5, 10, R, B, 100);

        as_(&fx.operator, NOW + 1, 0);
        let started = fx.c.start_next();
        assert_eq!(started, a);
        let view = fx.c.get_job(a);
        assert_eq!(view.status, JobStatus::Running);
        assert_eq!(view.started_at, Some(NOW + 1));
        assert_eq!(view.position, 0);
        assert_eq!(view.projected_finish_at, NOW + 6);
        assert_eq!(fx.c.get_stats().running, 1);
        assert_eq!(fx.c.get_stats().queued, 0);
        assert!(has_log("\"event\":\"job_started\""));

        as_(&fx.operator, NOW + 10, 0);
        fx.c.complete_job(a, "sha256:artifact".to_string());
        let view = fx.c.get_job(a);
        assert_eq!(view.status, JobStatus::Done);
        assert_eq!(view.artifact_hash.as_deref(), Some("sha256:artifact"));
        assert_eq!(view.finished_at, Some(NOW + 10));
        assert_eq!(transferred_to(&fx.operator), R);
        assert_eq!(transferred_to(&fx.alice), B);
        assert!(has_log("\"event\":\"job_completed\""));

        let stats = fx.c.get_stats();
        assert_eq!(stats.completed, 1);
        assert_eq!(stats.missed, 0);
        assert_eq!(stats.on_time_bps, 10_000);
        assert_eq!(stats.total_escrow.0, 0);
        assert_eq!(stats.running, 0);

        as_(&fx.operator, NOW + 11, 0);
        assert!(panics(|| fx.c.complete_job(a, "again".to_string())));
        assert!(panics(|| fx.c.start_next()));
    }

    // 17 ------------------------------------------------------------------
    #[test]
    fn test_late_completion_is_missed_and_refunds() {
        let mut fx = setup();
        let a = submit_at(&mut fx.c, &fx.alice, NOW, "A", 2, 5, R, B, 100);
        as_(&fx.operator, NOW, 0);
        fx.c.start_next();

        as_(&fx.operator, NOW + 6, 0);
        fx.c.complete_job(a, "sha256:late-artifact".to_string());
        let view = fx.c.get_job(a);
        assert_eq!(view.status, JobStatus::Missed);
        assert_eq!(
            view.artifact_hash.as_deref(),
            Some("sha256:late-artifact"),
            "late artifact hash is still recorded"
        );
        assert_eq!(transferred_to(&fx.alice), R + B);
        assert_eq!(transferred_to(&fx.operator), 0);
        assert!(has_log("\"event\":\"job_missed\""));
        assert!(has_log("\"reason\":\"late_completion\""));

        let stats = fx.c.get_stats();
        assert_eq!(stats.completed, 0);
        assert_eq!(stats.missed, 1);
        assert_eq!(stats.on_time_bps, 0);
        assert_eq!(stats.total_escrow.0, 0);
    }

    // 18 ------------------------------------------------------------------
    #[test]
    fn test_start_next_marks_overdue_head_missed() {
        let mut fx = setup();
        let a = submit_at(&mut fx.c, &fx.alice, NOW, "A", 1, 3, R, B, 100);

        as_(&fx.operator, NOW + 4, 0);
        let settled = fx.c.start_next();
        assert_eq!(settled, a);
        let view = fx.c.get_job(a);
        assert_eq!(view.status, JobStatus::Missed);
        assert_eq!(view.started_at, None, "an overdue job is never started");
        assert_eq!(view.finished_at, Some(NOW + 4));
        assert_eq!(transferred_to(&fx.alice), R + B);
        assert_eq!(fx.c.get_stats().missed, 1);
        assert_eq!(fx.c.get_stats().total_escrow.0, 0);
        assert!(fx.c.get_queue().is_empty());
        assert!(has_log("\"reason\":\"deadline_passed_before_start\""));
    }

    // 19 ------------------------------------------------------------------
    #[test]
    fn test_claim_timeout_queued_and_running() {
        let mut fx = setup();
        let queued = submit_at(&mut fx.c, &fx.alice, NOW, "queued", 1, 3, R, B, 100);
        as_(&fx.carol, NOW + 4, 0);
        fx.c.claim_timeout(queued);
        assert_eq!(fx.c.get_job(queued).status, JobStatus::Missed);
        assert_eq!(transferred_to(&fx.alice), R + B);
        assert_eq!(fx.c.get_stats().missed, 1);
        assert!(fx.c.get_activity(1)[0].actor == fx.carol);

        let running = submit_at(&mut fx.c, &fx.alice, NOW + 4, "running", 2, 4, R, B, 100);
        as_(&fx.operator, NOW + 4, 0);
        fx.c.start_next();
        as_(&fx.carol, NOW + 9, 0);
        fx.c.claim_timeout(running);
        assert_eq!(fx.c.get_job(running).status, JobStatus::Missed);
        assert_eq!(fx.c.get_stats().running, 0);
        assert_eq!(fx.c.get_stats().missed, 2);
        assert_eq!(fx.c.get_stats().total_escrow.0, 0);
        assert!(panics(|| fx.c.claim_timeout(running)));

        let early = submit_at(&mut fx.c, &fx.alice, NOW + 9, "early", 2, 10, R, B, 100);
        as_(&fx.carol, NOW + 10, 0);
        assert!(panics(|| fx.c.claim_timeout(early)));
    }

    // 20 ------------------------------------------------------------------
    #[test]
    fn test_normal_cancel_refund_and_treasury_bond_cut() {
        let mut fx = setup();
        let a = submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 100, R, B, 100);

        as_(&fx.alice, NOW + 1, 0);
        fx.c.cancel_job(a);
        let view = fx.c.get_job(a);
        assert_eq!(view.status, JobStatus::Cancelled);
        assert_eq!(view.finished_at, Some(NOW + 1));
        assert_eq!(transferred_to(&fx.alice), R + 375_000);
        assert_eq!(transferred_to(&fx.treasury), 0);
        assert_eq!(fx.c.get_credit(fx.treasury.clone()).0, 125_000);
        assert_eq!(fx.c.get_stats().total_credits.0, 125_000);
        assert_eq!(fx.c.get_stats().total_escrow.0, 0);
        assert_eq!(fx.c.get_stats().cancelled, 1);
        assert!(fx.c.get_queue().is_empty());
        assert!(has_log("\"event\":\"job_cancelled\""));
        assert_eq!(fx.c.get_activity(1)[0].amount.0, R + 375_000);
    }

    // 21 ------------------------------------------------------------------
    #[test]
    fn test_expedited_cancel_forfeits_full_bond() {
        let mut fx = setup();
        let a = submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 1_000, R, B, 100);
        let urgent = submit_at(&mut fx.c, &fx.dave, NOW, "urgent", 5, 1_000, R, B, 1);
        request_at(&mut fx.c, &fx.dave, NOW, urgent, NOW, 550, 550);
        assert!(fx.c.get_job(urgent).expedited);
        assert_eq!(fx.c.get_credit(fx.treasury.clone()).0, 50);

        as_(&fx.dave, NOW + 1, 0);
        fx.c.cancel_job(urgent);
        let view = fx.c.get_job(urgent);
        assert_eq!(view.status, JobStatus::Cancelled);
        assert!(view.expedited);
        assert_eq!(transferred_to(&fx.dave), R);
        assert_eq!(
            fx.c.get_credit(fx.treasury.clone()).0,
            50 + B,
            "100% of bond goes to treasury after expediting"
        );
        assert_eq!(fx.c.get_stats().total_escrow.0, R + B, "job A remains");
        assert_eq!(fx.c.get_job(a).status, JobStatus::Queued);
    }

    // 22 ------------------------------------------------------------------
    #[test]
    fn test_operator_and_owner_access_control() {
        let mut fx = setup();
        let a = submit_at(&mut fx.c, &fx.alice, NOW, "A", 5, 100, R, B, 100);
        submit_at(&mut fx.c, &fx.bob, NOW, "B", 5, 100, R, B, 100);

        as_(&fx.alice, NOW, 0);
        assert!(panics(|| fx.c.start_next()));
        as_(&fx.bob, NOW, 0);
        assert!(panics(|| fx.c.set_operator(fx.bob.clone())));
        assert!(panics(|| fx.c.set_treasury(fx.bob.clone())));
        assert!(panics(|| fx.c.set_fee_bps(100)));
        assert!(panics(|| fx.c.set_paused(true)));
        assert!(panics(|| fx.c.set_move_ask(1, U128(1))));

        as_(&fx.operator, NOW, 0);
        fx.c.start_next();
        as_(&fx.alice, NOW + 1, 0);
        assert!(panics(|| fx.c.complete_job(a, "artifact".to_string())));
        assert!(panics(|| fx.c.fail_job(a, "reason".to_string())));
        assert!(panics(|| fx.c.cancel_job(2)));
        assert!(panics(|| fx.c.set_move_ask(2, U128(5))));

        // Owner can rotate the operator; the job owner can still set the ask.
        as_(&fx.owner, NOW + 1, 0);
        fx.c.set_operator(fx.carol.clone());
        as_(&fx.bob, NOW + 1, 0);
        fx.c.set_move_ask(2, U128(700));
        // v3: a raise waits ASK_RAISE_DELAY_SECS before quotes use it.
        assert_eq!(fx.c.get_job(2).ask_pending.map(|a| a.0), Some(700));
        assert_eq!(fx.c.get_job(2).ask_per_sec.0, 100);
        as_(&fx.bob, NOW + 1 + ASK_RAISE_DELAY_SECS, 0);
        assert_eq!(fx.c.get_job(2).ask_per_sec.0, 700);
        assert_eq!(fx.c.get_job(2).ask_pending, None);
        as_(&fx.operator, NOW + 1, 0);
        assert!(panics(|| fx.c.complete_job(a, "artifact".to_string())));
        as_(&fx.carol, NOW + 2, 0);
        fx.c.complete_job(a, "artifact".to_string());
        assert_eq!(fx.c.get_job(a).status, JobStatus::Done);
    }

    // 23 ------------------------------------------------------------------
    #[test]
    fn test_pause_blocks_mutations_but_allows_exits() {
        let mut fx = setup();
        // D starts first so the queue contains A, B and the urgent job.
        let d = submit_at(&mut fx.c, &fx.alice, NOW, "running", 10, 100, R, B, 1);
        as_(&fx.operator, NOW, 0);
        fx.c.start_next();
        submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 1_000, R, B, 100);
        submit_at(&mut fx.c, &fx.bob, NOW, "B", 10, 1_000, R, B, 200);
        let urgent = submit_at(&mut fx.c, &fx.dave, NOW, "urgent", 5, 1_000, R, B, 1);
        // Running D finishes at NOW+10, so the earliest urgent slot starts
        // there and displaces A and B.
        request_at(&mut fx.c, &fx.dave, NOW, urgent, NOW + 10, 1_650, 1_650);
        assert_eq!(fx.c.get_credit(fx.alice.clone()).0, 500);

        as_(&fx.owner, NOW + 1, 0);
        fx.c.set_paused(true);
        assert!(fx.c.get_config().paused);

        as_(&fx.alice, NOW + 1, R + B);
        assert!(panics(|| {
            fx.c.submit_job(
                "blocked".to_string(),
                "h".to_string(),
                String::new(),
                1,
                1,
                U128(R),
                U128(1),
                None, None, None, None
            )
        }));
        as_(&fx.alice, NOW + 1, 0);
        assert!(panics(|| fx.c.set_move_ask(2, U128(10))));
        as_(&fx.dave, NOW + 1, 0);
        assert!(panics(|| {
            fx.c.request_priority(urgent, NOW + 10, U128(1_650))
        }));
        as_(&fx.operator, NOW + 1, 0);
        assert!(panics(|| fx.c.start_next()));

        // Exit paths still work while paused: cancel, complete, withdraw.
        as_(&fx.alice, NOW + 1, 0);
        fx.c.cancel_job(2);
        assert_eq!(fx.c.get_job(2).status, JobStatus::Cancelled);
        assert_eq!(fx.c.withdraw_credit().0, 500);
        assert_eq!(fx.c.get_credit(fx.alice.clone()).0, 0);

        as_(&fx.operator, NOW + 1, 0);
        fx.c.complete_job(d, "artifact".to_string());
        assert_eq!(fx.c.get_job(d).status, JobStatus::Done);
        assert_eq!(fx.c.get_stats().running, 0);

        as_(&fx.owner, NOW + 200, 0);
        fx.c.set_paused(false);
        assert!(!fx.c.get_config().paused);
    }

    // 24 ------------------------------------------------------------------
    #[test]
    fn test_fee_rounding_floor() {
        let mut fx = setup();
        as_(&fx.owner, NOW, 0);
        fx.c.set_fee_bps(333);
        let a = submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 1_000, R, B, 100);
        let urgent = submit_at(&mut fx.c, &fx.dave, NOW, "urgent", 1, 1_000, R, B, 1);

        let p = request_at(&mut fx.c, &fx.dave, NOW, urgent, NOW, 103, 103);
        assert_eq!(p.compensation.0, 100);
        assert_eq!(p.fee.0, 3, "333 bps of 100 floors to 3");
        assert_eq!(p.total.0, 103);
        assert_eq!(fx.c.get_credit(fx.treasury.clone()).0, 3);
        assert_eq!(fx.c.get_credit(fx.alice.clone()).0, 100);
        assert_eq!(fx.c.get_job(a).moved_compensation.0, 100);
    }

    // 25 ------------------------------------------------------------------
    #[test]
    fn test_set_move_ask_changes_future_compensation() {
        let mut fx = setup();
        submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 1_000, R, B, 100);
        let urgent = submit_at(&mut fx.c, &fx.dave, NOW, "urgent", 2, 1_000, R, B, 1);
        assert_eq!(quote_at(&fx.c, NOW, urgent, NOW).compensation.0, 200);

        as_(&fx.bob, NOW, 0);
        assert!(panics(|| fx.c.set_move_ask(1, U128(500))));
        as_(&fx.alice, NOW, 0);
        fx.c.set_move_ask(1, U128(500));
        assert!(has_log("\"event\":\"ask_updated\""));
        // A raise is not visible to quotes until its delay has passed: an urgent job already waiting pays the old ask.
        assert_eq!(quote_at(&fx.c, NOW, urgent, NOW).compensation.0, 200);
        assert_eq!(quote_at(&fx.c, NOW + ASK_RAISE_DELAY_SECS, urgent, NOW + ASK_RAISE_DELAY_SECS).compensation.0, 1_000);
        // A cut is immediate.
        as_(&fx.alice, NOW + 1, 0);
        fx.c.set_move_ask(1, U128(50));
        assert_eq!(fx.c.get_job(1).ask_per_sec.0, 50);
        assert_eq!(fx.c.get_job(1).ask_pending, None);
        assert_eq!(quote_at(&fx.c, NOW + 1, urgent, NOW + 1).compensation.0, 100);
    }

    // 26 ------------------------------------------------------------------
    #[test]
    fn test_multiple_displacements_accumulate_moves() {
        let mut fx = setup();
        let a = submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 1_000, R, B, 100);
        let b = submit_at(&mut fx.c, &fx.bob, NOW, "B", 10, 1_000, R, B, 200);
        let c = submit_at(&mut fx.c, &fx.carol, NOW, "C", 10, 1_000, R, B, 300);
        let u1 = submit_at(&mut fx.c, &fx.dave, NOW, "U1", 5, 1_000, R, B, 100);
        request_at(&mut fx.c, &fx.dave, NOW, u1, NOW, 3_300, 3_300);
        assert_eq!(queue_ids(&fx), vec![u1, a, b, c]);

        let u2 = submit_at(&mut fx.c, &fx.dave, NOW, "U2", 3, 1_000, R, B, 1);
        request_at(&mut fx.c, &fx.dave, NOW, u2, NOW, 2_310, 2_310);
        assert_eq!(queue_ids(&fx), vec![u2, u1, a, b, c]);

        assert_eq!(fx.c.get_credit(fx.alice.clone()).0, 800);
        assert_eq!(fx.c.get_credit(fx.bob.clone()).0, 1_600);
        assert_eq!(fx.c.get_credit(fx.carol.clone()).0, 2_400);
        assert_eq!(fx.c.get_credit(fx.dave.clone()).0, 300);
        assert_eq!(fx.c.get_credit(fx.treasury.clone()).0, 510);

        let ja = fx.c.get_job(a);
        assert_eq!(ja.move_count, 2);
        assert_eq!(ja.moves.len(), 2);
        assert_eq!(ja.moved_compensation.0, 800);
        assert_eq!(ja.moves[0].by_job_id, u1);
        assert_eq!(ja.moves[1].by_job_id, u2);

        let j1 = fx.c.get_job(u1);
        assert_eq!(j1.move_count, 1);
        assert_eq!(j1.moved_compensation.0, 300);
        assert_eq!(j1.priority_id, Some(1));
        assert_eq!(fx.c.get_job(u2).priority_id, Some(2));

        let stats = fx.c.get_stats();
        assert_eq!(stats.moves, 7);
        assert_eq!(stats.total_priority.0, 5_610);
        assert_eq!(stats.total_compensation.0, 5_100);
        assert_eq!(stats.total_fees.0, 510);
        assert_eq!(stats.total_credits.0, 5_610);
    }

    // 27 ------------------------------------------------------------------
    #[test]
    fn test_overflow_guard_in_compensation() {
        // An unbounded ask would make every quote past it abort. Asks are capped, and the
        // largest possible sum (cap x longest duration x full queue) is computed, not aborted.
        let mut fx = setup();
        as_(&fx.alice, NOW, R + B + JOB_STORAGE_DEPOSIT);
        assert!(panics(|| fx.c.submit_job("A".into(), "h".into(), "".into(), 1, 1_000, U128(R), U128(u128::MAX), None, None, None, None)));
        for i in 0..(MAX_QUEUE - 1) {
            submit_at(&mut fx.c, &fx.alice, NOW, &format!("A{i}"), 1, MAX_DEADLINE_SECS, 1, 1, MAX_ASK_PER_SEC);
        }
        let urgent = submit_at(&mut fx.c, &fx.dave, NOW, "urgent", MAX_DURATION_SECS, MAX_DEADLINE_SECS, 1, 1, 1);
        as_(&fx.carol, NOW, 0);
        let q = fx.c.quote_priority(urgent, NOW);
        assert_eq!(q.compensation.0, MAX_ASK_PER_SEC * MAX_DURATION_SECS as u128 * (MAX_QUEUE as u128 - 1));
        let first = fx.c.get_queue()[0].id;
        as_(&fx.alice, NOW, 0);
        assert!(panics(|| fx.c.set_move_ask(first, U128(MAX_ASK_PER_SEC + 1))));
    }

    #[test]
    fn test_start_next_skips_a_job_that_can_no_longer_finish() {
        // A head whose remaining time is shorter than its work is settled as missed, not started.
        let mut fx = setup();
        let a = submit_at(&mut fx.c, &fx.alice, NOW, "A", 5, 10, R, B, 100);
        let b = submit_at(&mut fx.c, &fx.alice, NOW, "B", 5, 100, R, B, 100);
        as_(&fx.operator, NOW + 6, 0);
        assert_eq!(fx.c.start_next(), a);
        assert_eq!(fx.c.get_job(a).status, JobStatus::Missed);
        assert!(has_log("\"reason\":\"cannot_finish_before_deadline\""));
        assert_eq!(transferred_to(&fx.alice), R + B);
        as_(&fx.operator, NOW + 6, 0);
        assert_eq!(fx.c.start_next(), b);
        assert_eq!(fx.c.get_job(b).status, JobStatus::Running);
        // And a job whose deadline is shorter than its work is refused at submission.
        as_(&fx.alice, NOW, R + B + JOB_STORAGE_DEPOSIT);
        assert!(panics(|| fx.c.submit_job("C".into(), "h".into(), "".into(), 10, 9, U128(R), U128(1), None, None, None, None)));
    }

    #[test]
    fn test_displaced_job_keeps_a_safety_margin() {
        // Zero slack is not enough: every start lands at least a block after its projection.
        let mut fx = setup();
        // A: 10 s of work, deadline exactly 10 + 5 + margin - 1 after a 5 s jump -> refused.
        let a = submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 10 + 5 + DEADLINE_MARGIN_SECS as u32 - 1, R, B, 1);
        let urgent = submit_at(&mut fx.c, &fx.dave, NOW, "urgent", 5, 1_000, R, B, 1);
        let q = quote_at(&fx.c, NOW, urgent, NOW);
        assert!(!q.feasible);
        assert!(q.reason.contains(&format!("displaced job {a} would finish at")), "{}", q.reason);
        assert!(q.reason.contains("inside the safety margin"), "{}", q.reason);
        // One more second of slack and the same jump is accepted.
        let mut fx = setup();
        submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 10 + 5 + DEADLINE_MARGIN_SECS as u32, R, B, 1);
        let urgent = submit_at(&mut fx.c, &fx.dave, NOW, "urgent", 5, 1_000, R, B, 1);
        assert!(quote_at(&fx.c, NOW, urgent, NOW).feasible);
    }

    #[test]
    fn test_buyer_keeps_a_margin_too() {
        // The buyer may not buy a slot it can only keep with zero slack.
        let mut fx = setup();
        submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 1_000, R, B, 1);
        let urgent = submit_at(&mut fx.c, &fx.dave, NOW, "urgent", 5, 5 + DEADLINE_MARGIN_SECS as u32 - 1, R, B, 1);
        let q = quote_at(&fx.c, NOW, urgent, NOW);
        assert!(!q.feasible);
        assert!(q.reason.contains("urgent job would finish"), "{}", q.reason);
        let mut fx = setup();
        submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 1_000, R, B, 1);
        let urgent = submit_at(&mut fx.c, &fx.dave, NOW, "urgent", 5, 5 + DEADLINE_MARGIN_SECS as u32, R, B, 1);
        assert!(quote_at(&fx.c, NOW, urgent, NOW).feasible);
    }

    #[test]
    fn test_margin_grows_with_handoffs() {
        // A job three hand-offs deep needs base + 2 extra seconds, not a flat margin.
        let mut fx = setup();
        submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 1_000, R, B, 1);
        submit_at(&mut fx.c, &fx.alice, NOW, "B", 10, 1_000, R, B, 1);
        // C finishes at 30 today and 35 after a 5 s jump; it needs 35 + 3 + 2 = 40.
        let c = submit_at(&mut fx.c, &fx.bob, NOW, "C", 10, 39, R, B, 1);
        let urgent = submit_at(&mut fx.c, &fx.dave, NOW, "urgent", 5, 1_000, R, B, 1);
        let q = quote_at(&fx.c, NOW, urgent, NOW);
        assert!(!q.feasible);
        assert!(q.reason.contains(&format!("displaced job {c}")), "{}", q.reason);
        let mut fx = setup();
        submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 1_000, R, B, 1);
        submit_at(&mut fx.c, &fx.alice, NOW, "B", 10, 1_000, R, B, 1);
        submit_at(&mut fx.c, &fx.bob, NOW, "C", 10, 40, R, B, 1);
        let urgent = submit_at(&mut fx.c, &fx.dave, NOW, "urgent", 5, 1_000, R, B, 1);
        assert!(quote_at(&fx.c, NOW, urgent, NOW).feasible);
    }

    #[test]
    fn test_submit_refuses_only_the_hopeless() {
        // Refused only when even the front slot cannot deliver; late-at-the-back is fine.
        let mut fx = setup();
        let long = submit_at(&mut fx.c, &fx.alice, NOW, "long", 60, 1_000, R, B, 1);
        as_(&fx.operator, NOW, 0);
        assert_eq!(fx.c.start_next(), long);
        // The worker is busy until NOW + 60: a 10 s job due in 50 s can never make it.
        as_(&fx.bob, NOW + 1, R + B + JOB_STORAGE_DEPOSIT);
        assert!(panics(|| fx.c.submit_job("x".into(), "h".into(), "".into(), 10, 50, U128(R), U128(1), None, None, None, None)));
        // Due in 80 s it can (front slot finishes at 70 + 2): admitted even though others may queue ahead.
        let ok = submit_at(&mut fx.c, &fx.bob, NOW + 1, "ok", 10, 80, R, B, 1);
        assert_eq!(fx.c.get_job(ok).status, JobStatus::Queued);
    }

    #[test]
    fn test_admission_view_and_opt_in_back_check() {
        let mut fx = setup();
        submit_at(&mut fx.c, &fx.alice, NOW, "A", 30, 1_000, R, B, 1);
        submit_at(&mut fx.c, &fx.alice, NOW, "B", 30, 1_000, R, B, 1);
        as_(&fx.carol, NOW, 0);
        let a = fx.c.get_admission(10, 50);
        assert_eq!(a.earliest_finish_at, NOW + 10);
        assert_eq!(a.finish_at_back, NOW + 70);
        assert!(a.feasible_at_front && !a.feasible_at_back);
        // Default: late at the back is welcome (it can buy). Opted in: refused.
        as_(&fx.bob, NOW, R + B + JOB_STORAGE_DEPOSIT);
        assert!(panics(|| fx.c.submit_job("strict".into(), "h".into(), "".into(), 10, 50, U128(R), U128(1), None, Some(true), None, None)));
        let loose = submit_at(&mut fx.c, &fx.bob, NOW, "loose", 10, 50, R, B, 1);
        assert_eq!(fx.c.get_job(loose).status, JobStatus::Queued);
        as_(&fx.bob, NOW, R + B + JOB_STORAGE_DEPOSIT);
        let strict_ok = fx.c.submit_job("strict-ok".into(), "h".into(), "".into(), 10, 200, U128(R), U128(1), None, Some(true), None, None);
        assert_eq!(fx.c.get_job(strict_ok).status, JobStatus::Queued);
    }

    #[test]
    fn test_payout_callback_state_io_fits_its_gas() {
        // The callback deserializes and re-serializes root state, including a full activity log.
        // Fill the log with the longest entries, then price that I/O with NEAR's storage costs.
        let mut fx = setup();
        let long: AccountId = "l".repeat(64).parse().unwrap();
        for i in 0..MAX_ACTIVITY {
            let id = submit_at(&mut fx.c, &long, NOW, &"t".repeat(MAX_TITLE_CHARS), 1, MAX_DEADLINE_SECS, R, B, 1);
            if i % 2 == 0 {
                as_(&long, NOW, 0);
                fx.c.cancel_job(id);
            }
        }
        assert_eq!(fx.c.get_activity(1_000).len(), MAX_ACTIVITY);
        let state = borsh::to_vec(&fx.c).unwrap().len() as u64;
        // Protocol costs (gas): storage_read_base 56_356_845_750, read per byte 5_611_005,
        // storage_write_base 64_196_736_000, write per byte 31_018_539, evicted per byte 32_117_307.
        let io = 56_356_845_750 + state * 5_611_005 + 64_196_736_000 + state * (31_018_539 + 32_117_307);
        eprintln!("payout callback root state: {state} bytes, ~{} Ggas of storage I/O", io / 1_000_000_000);
        assert!(io < PAYOUT_CALLBACK_GAS.as_gas() / 2, "state I/O {io} gas leaves too little of the callback's {} gas", PAYOUT_CALLBACK_GAS.as_gas());
    }

    #[test]
    fn test_start_needs_spare_time_for_completion() {
        // Exactly zero spare time is not enough; completion lands in a later block.
        let mut fx = setup();
        let a = submit_at(&mut fx.c, &fx.alice, NOW, "A", 5, 10, R, B, 1);
        as_(&fx.operator, NOW + 4, 0);
        assert_eq!(fx.c.start_next(), a);
        assert_eq!(fx.c.get_job(a).status, JobStatus::Missed);
        let b = submit_at(&mut fx.c, &fx.alice, NOW + 4, "B", 5, 10, R, B, 1);
        as_(&fx.operator, NOW + 7, 0);
        assert_eq!(fx.c.start_next(), b);
        assert_eq!(fx.c.get_job(b).status, JobStatus::Running);
    }

    // 28 ------------------------------------------------------------------
    #[test]
    fn test_queue_and_activity_caps() {
        let mut fx = setup();
        for i in 0..MAX_QUEUE {
            let title = format!("job-{i}");
            submit_at(
                &mut fx.c,
                &fx.alice,
                NOW,
                &title,
                1,
                MAX_DEADLINE_SECS,
                1,
                1,
                1,
            );
        }
        assert_eq!(fx.c.get_stats().queued, MAX_QUEUE as u32);
        assert_eq!(fx.c.get_stats().total_escrow.0, 2 * MAX_QUEUE as u128);
        assert_eq!(fx.c.get_activity(1_000).len(), MAX_ACTIVITY);

        as_(&fx.alice, NOW, 2);
        assert!(panics(|| {
            fx.c.submit_job(
                "overflow".to_string(),
                "h".to_string(),
                String::new(),
                1,
                MAX_DEADLINE_SECS,
                U128(1),
                U128(1),
                None, None, None, None
            )
        }));

        as_(&fx.alice, NOW + 1, 0);
        fx.c.cancel_job(1);
        let activity = fx.c.get_activity(1_000);
        assert_eq!(activity.len(), MAX_ACTIVITY);
        assert_eq!(activity[0].event, "job_cancelled");
        assert_eq!(activity[0].id, 129);
        assert_eq!(activity.last().unwrap().id, 2, "oldest activity is evicted");
        assert!(fx.c.get_activity(0).is_empty());
        assert_eq!(fx.c.get_stats().queued, (MAX_QUEUE - 1) as u32);
    }

    // 29 ------------------------------------------------------------------
    #[test]
    fn test_failed_job_refunds_and_records_hash() {
        let mut fx = setup();
        let a = submit_at(&mut fx.c, &fx.alice, NOW, "A", 5, 100, R, B, 100);
        as_(&fx.operator, NOW, 0);
        fx.c.start_next();
        as_(&fx.operator, NOW + 1, 0);
        fx.c.fail_job(a, "sha256:failure".to_string());

        let view = fx.c.get_job(a);
        assert_eq!(view.status, JobStatus::Failed);
        assert_eq!(view.failure_hash.as_deref(), Some("sha256:failure"));
        assert_eq!(transferred_to(&fx.alice), R + B);
        assert_eq!(fx.c.get_stats().total_escrow.0, 0);
        assert_eq!(fx.c.get_stats().running, 0);
        assert!(has_log("\"event\":\"job_failed\""));
    }

    // 30 ------------------------------------------------------------------
    #[test]
    fn test_on_time_bps_mixed_outcomes() {
        let mut fx = setup();
        let a = submit_at(&mut fx.c, &fx.alice, NOW, "A", 2, 10, R, B, 1);
        as_(&fx.operator, NOW, 0);
        fx.c.start_next();
        as_(&fx.operator, NOW + 2, 0);
        fx.c.complete_job(a, "artifact".to_string());
        assert_eq!(fx.c.get_stats().on_time_bps, 10_000);

        let b = submit_at(&mut fx.c, &fx.alice, NOW + 2, "B", 1, 3, R, B, 1);
        as_(&fx.carol, NOW + 6, 0);
        fx.c.claim_timeout(b);
        let stats = fx.c.get_stats();
        assert_eq!(stats.completed, 1);
        assert_eq!(stats.missed, 1);
        assert_eq!(stats.on_time_bps, 5_000);
    }

    // 31 ------------------------------------------------------------------
    #[test]
    fn test_events_for_full_lifecycle() {
        let mut fx = setup();
        submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 1_000, R, B, 100);
        assert!(has_log("\"event\":\"job_submitted\""));

        let urgent = submit_at(&mut fx.c, &fx.dave, NOW, "urgent", 5, 1_000, R, B, 1);
        request_at(&mut fx.c, &fx.dave, NOW, urgent, NOW, 550, 550);
        assert!(has_log("\"event\":\"priority_purchased\""));

        as_(&fx.operator, NOW + 1, 0);
        fx.c.start_next();
        assert!(has_log("\"event\":\"job_started\""));
        as_(&fx.operator, NOW + 5, 0);
        fx.c.complete_job(urgent, "artifact".to_string());
        assert!(has_log("\"event\":\"job_completed\""));

        let c = submit_at(&mut fx.c, &fx.alice, NOW + 5, "C", 1, 3, R, B, 1);
        as_(&fx.carol, NOW + 10, 0);
        fx.c.claim_timeout(c);
        assert!(has_log("\"event\":\"job_missed\""));

        let d = submit_at(&mut fx.c, &fx.alice, NOW + 10, "D", 1, 100, R, B, 1);
        as_(&fx.alice, NOW + 11, 0);
        fx.c.cancel_job(d);
        assert!(has_log("\"event\":\"job_cancelled\""));

        as_(&fx.alice, NOW + 12, 0);
        fx.c.withdraw_credit();
        assert!(has_log("\"event\":\"credit_withdrawn\""));

        let types: Vec<String> = fx.c.get_activity(50).into_iter().map(|a| a.event).collect();
        for expected in [
            "job_submitted",
            "priority_purchased",
            "job_started",
            "job_completed",
            "job_missed",
            "job_cancelled",
            "credit_withdrawn",
        ] {
            assert!(types.iter().any(|t| t == expected), "missing {expected}");
        }
        assert_eq!(types[0], "credit_withdrawn", "newest activity first");
    }

    // 32 ------------------------------------------------------------------
    #[test]
    fn test_zero_displacement_priority_is_refused_and_not_expedited() {
        let mut fx = setup();
        let a = submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 1_000, R, B, 100);

        let q = quote_at(&fx.c, NOW, a, NOW + 100);
        assert!(q.feasible);
        assert_eq!(q.insert_index, 0);
        assert!(q.displaced.is_empty());
        assert_eq!(q.total.0, 0);

        // Buying a slot you already hold is refused: no record, no flag.
        as_(&fx.alice, NOW, priority_storage_deposit(0));
        assert!(panics(|| fx.c.request_priority(a, NOW + 100, U128(0))));
        let view = fx.c.get_job(a);
        assert_eq!(view.priority_id, None);
        assert!(!view.expedited, "no slot was bought");
        assert_eq!(fx.c.get_stats().total_priority.0, 0);

        // Cancelling still uses the normal 25% bond rule.
        as_(&fx.alice, NOW + 1, 0);
        fx.c.cancel_job(a);
        assert_eq!(fx.c.get_credit(fx.treasury.clone()).0, 125_000);
        assert_eq!(transferred_to(&fx.alice), R + 375_000);
    }

    // 34b -----------------------------------------------------------------
    #[test]
    fn test_only_owner_can_buy_priority() {
        let mut fx = setup();
        let a = submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 1_000, R, B, 0);
        let victim = submit_at(&mut fx.c, &fx.bob, NOW, "victim", 10, 1_000, R, B, 0);

        // A zero-ask queue makes the jump free; a stranger still cannot use it
        // to flip `expedited` and make the victim's cancel forfeit the bond.
        let q = quote_at(&fx.c, NOW, victim, NOW);
        assert!(q.feasible);
        assert_eq!(q.displaced.len(), 1);
        as_(&fx.carol, NOW, priority_storage_deposit(1));
        assert!(panics(|| fx.c.request_priority(victim, NOW, U128(0))));
        assert!(!fx.c.get_job(victim).expedited);
        assert_eq!(queue_ids(&fx), vec![a, victim]);

        // The owner can.
        request_at(&mut fx.c, &fx.bob, NOW, victim, NOW, 0, 0);
        assert!(fx.c.get_job(victim).expedited);
        assert_eq!(queue_ids(&fx), vec![victim, a]);
    }

    // 34d -----------------------------------------------------------------
    #[test]
    fn test_priority_storage_deposit_covers_worst_case_accounts() {
        let mut fx = setup();
        // 64-char account ids are the longest NEAR allows: worst-case storage.
        let long = |i: usize| -> AccountId {
            let head = format!("{i:02}");
            format!("{}{}", head, "x".repeat(64 - head.len())).parse().unwrap()
        };
        let mut ids = Vec::new();
        for i in 0..40 {
            ids.push(submit_at(&mut fx.c, &long(i), NOW, "slot", 1, 100_000, R, B, 1));
        }
        let buyer = long(99);
        let urgent = submit_at(&mut fx.c, &buyer, NOW, "urgent", 1, 100_000, R, B, 1);
        let q = quote_at(&fx.c, NOW, urgent, NOW);
        assert_eq!(q.displaced.len(), 40);
        // Panics inside if measured storage exceeds the deposit.
        request_at(&mut fx.c, &buyer, NOW, urgent, NOW, q.total.0, q.total.0 + 1);
        assert_eq!(queue_ids(&fx)[0], urgent);
    }

    // 34c -----------------------------------------------------------------
    #[test]
    fn test_storage_deposit_is_required_and_not_escrow() {
        let mut fx = setup();
        // reward + bond without the storage deposit is refused.
        as_(&fx.alice, NOW, R + B);
        assert!(panics(|| {
            fx.c.submit_job(
                "A".to_string(),
                "sha256:input".to_string(),
                "".to_string(),
                10,
                1_000,
                U128(R),
                U128(1),
                None, None, None, None
            )
        }));
        // With it, escrow is exactly reward + bond; the deposit backs storage.
        let a = submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 1_000, R, B, 1);
        assert_eq!(fx.c.get_job(a).bond.0, B);
        assert_eq!(fx.c.get_stats().total_escrow.0, R + B);

        // The largest allowed job record fits inside the fixed deposit.
        let title = "\u{1F600}".repeat(MAX_TITLE_CHARS);
        as_(&fx.bob, NOW, R + B + JOB_STORAGE_DEPOSIT);
        fx.c.submit_job(
            title,
            "h".repeat(MAX_INPUT_HASH_LEN),
            "u".repeat(MAX_URI_LEN),
            10,
            1_000,
            U128(R),
            U128(1),
            None, None, None, None
        );
    }

    // 33 ------------------------------------------------------------------
    #[test]
    fn test_json_view_shapes() {
        let mut fx = setup();
        let a = submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 1_000, R, B, 100);
        let urgent = submit_at(&mut fx.c, &fx.dave, NOW, "urgent", 5, 1_000, R, B, 1);

        let job = serde_json::to_value(fx.c.get_job(a)).unwrap();
        assert_eq!(job["status"], "QUEUED");
        assert_eq!(job["reward"], "1000000");
        assert_eq!(job["bond"], "500000");
        assert!(job["position"].is_number());
        assert!(job["projected_start_at"].is_number());
        assert!(job["moves"].is_array());

        let quote = serde_json::to_value(quote_at(&fx.c, NOW, urgent, NOW)).unwrap();
        assert!(quote["compensation"].is_string());
        assert!(quote["total"].is_string());
        assert!(quote["displaced"][0]["amount"].is_string());
        assert!(quote["displaced"][0]["slack_secs"].is_number());
        assert!(quote["checks"][0]["ok"].is_boolean());
        assert_eq!(quote["feasible"], true);

        request_at(&mut fx.c, &fx.dave, NOW, urgent, NOW, 550, 550);
        let activity = serde_json::to_value(fx.c.get_activity(1)).unwrap();
        assert_eq!(activity[0]["type"], "priority_purchased");
        assert!(activity[0]["amount"].is_string());
        assert_eq!(activity[0]["actor"], "dave.testnet");
    }

    // 34 ------------------------------------------------------------------
    #[test]
    fn test_solvency_invariant_across_lifecycle() {
        let mut fx = setup();
        let a = submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 1_000, R, B, 100);
        let b = submit_at(&mut fx.c, &fx.bob, NOW, "B", 10, 1_000, R, B, 200);
        let c = submit_at(&mut fx.c, &fx.carol, NOW, "C", 10, 1_000, R, B, 300);
        let urgent = submit_at(&mut fx.c, &fx.dave, NOW, "urgent", 10, 1_000, R, B, 1);
        assert_eq!(fx.c.get_stats().total_escrow.0, 4 * (R + B));

        request_at(&mut fx.c, &fx.dave, NOW, urgent, NOW, 7_000, 7_000);
        assert_eq!(fx.c.get_stats().total_escrow.0, 4 * (R + B));
        assert_eq!(fx.c.get_stats().total_credits.0, 7_000);

        as_(&fx.operator, NOW, 0);
        fx.c.start_next();
        as_(&fx.operator, NOW + 5, 0);
        fx.c.complete_job(urgent, "artifact".to_string());
        assert_eq!(fx.c.get_stats().total_escrow.0, 3 * (R + B));

        as_(&fx.alice, NOW + 6, 0);
        fx.c.cancel_job(a);
        assert_eq!(fx.c.get_stats().total_escrow.0, 2 * (R + B));
        assert_eq!(fx.c.get_stats().total_credits.0, 7_000 + 125_000);

        as_(&fx.alice, NOW + 7, 0);
        assert_eq!(fx.c.withdraw_credit().0, 1_000);
        assert_eq!(fx.c.get_stats().total_credits.0, 131_000);

        // Every remaining wei is either active escrow or a credit liability.
        let credits = fx.c.get_credit(fx.alice.clone()).0
            + fx.c.get_credit(fx.bob.clone()).0
            + fx.c.get_credit(fx.carol.clone()).0
            + fx.c.get_credit(fx.dave.clone()).0
            + fx.c.get_credit(fx.treasury.clone()).0;
        assert_eq!(credits, 131_000);
        assert_eq!(fx.c.get_stats().total_credits.0, credits);
        assert_eq!(
            fx.c.get_stats().total_escrow.0 + fx.c.get_stats().total_credits.0,
            3_131_000,
            "lifetime deposits 6,007,000 - transfers 2,876,000"
        );
        assert_eq!(fx.c.get_job(b).status, JobStatus::Queued);
        assert_eq!(fx.c.get_job(c).status, JobStatus::Queued);
    }

    // -- v2: balances, TEE attestation, storage, payout recovery -----------

    const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
    const ATTEST: &str = include_str!("test_attestation.json");

    fn attest_fx() -> serde_json::Value {
        serde_json::from_str(ATTEST).unwrap()
    }

    fn fs(v: &serde_json::Value, k: &str) -> String {
        v[k].as_str().unwrap().to_string()
    }

    #[test]
    fn test_v2_balance_funded_submit_and_priority() {
        let mut fx = setup();
        let a = submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 1000, R, B, 100);
        as_(&fx.bob, NOW, BALANCE_STORAGE_DEPOSIT + NEAR);
        assert_eq!(fx.c.deposit().0, NEAR);
        assert_eq!(fx.c.get_stats().total_credits.0, NEAR);

        // A function-call key cannot attach NEAR: everything below attaches 0.
        as_(&fx.bob, NOW, 0);
        let b = fx.c.submit_job(
            "B".into(),
            "sha256:x".into(),
            "".into(),
            5,
            1000,
            U128(R),
            U128(1),
            Some(U128(B)), None, None, None
        );
        let after_submit = NEAR - R - B - JOB_STORAGE_DEPOSIT;
        assert_eq!(fx.c.get_credit(fx.bob.clone()).0, after_submit);
        assert_eq!(fx.c.get_job(b).bond.0, B);
        assert!(has_log("\"funded_from\":\"balance\""));

        let q = quote_at(&fx.c, NOW, b, NOW);
        assert_eq!(q.displaced.len(), 1);
        as_(&fx.bob, NOW, 0);
        let p = fx.c.request_priority(b, NOW, q.total);
        assert_eq!(p.refunded.0, 0);
        assert!(transfers().is_empty(), "balance-funded purchase moves no native NEAR");
        assert_eq!(
            fx.c.get_credit(fx.bob.clone()).0,
            after_submit - q.total.0 - priority_storage_deposit(1)
        );
        assert_eq!(queue_ids(&fx), vec![b, a]);
        assert_eq!(fx.c.get_credit(fx.alice.clone()).0, q.compensation.0);
        let sum = fx.c.get_credit(fx.bob.clone()).0
            + fx.c.get_credit(fx.alice.clone()).0
            + fx.c.get_credit(fx.treasury.clone()).0;
        assert_eq!(fx.c.get_stats().total_credits.0, sum);

        // Withdrawal pays only the caller's own account.
        as_(&fx.bob, NOW, 0);
        let left = fx.c.withdraw_credit().0;
        assert_eq!(transferred_to(&fx.bob), left);
    }

    #[test]
    fn test_v2_balance_funding_refusals() {
        let mut fx = setup();
        as_(&fx.carol, NOW, 0);
        assert!(panics(|| fx.c.submit_job(
            "x".into(), "h".into(), "".into(), 1, 10, U128(R), U128(1), None,
            None, None, None
        )));
        as_(&fx.carol, NOW, 0);
        assert!(panics(|| fx.c.submit_job(
            "x".into(), "h".into(), "".into(), 1, 10, U128(R), U128(1), Some(U128(B)),
            None, None, None
        )));
        as_(&fx.carol, NOW, BALANCE_STORAGE_DEPOSIT);
        assert!(panics(|| fx.c.deposit()));
        as_(&fx.carol, NOW, R + B + JOB_STORAGE_DEPOSIT);
        assert!(panics(|| fx.c.submit_job(
            "x".into(), "h".into(), "".into(), 1, 10, U128(R), U128(1), Some(U128(B + 1)),
            None, None, None
        )));
        // Matching explicit bond with an attached deposit is fine.
        as_(&fx.carol, NOW, R + B + JOB_STORAGE_DEPOSIT);
        let id = fx.c.submit_job(
            "x".into(), "h".into(), "".into(), 1, 10, U128(R), U128(1), Some(U128(B)), None, None, None
        );
        assert_eq!(fx.c.get_job(id).bond.0, B);
        assert_eq!(fx.c.get_stats().total_credits.0, 0);
    }

    /// Mocked storage outlives a Contract value: forget raw keys for a request so each case starts fresh.
    fn forget_request(input_hash: &str) {
        if let Some(h) = normalize_sha256(input_hash) {
            env::storage_remove(&claim_key(&h));
            env::storage_remove(&[ANSWERED_PREFIX, h.as_bytes()].concat());
        }
    }

    fn running_model_job(fx: &mut Fx, input_hash: &str, signers: Vec<String>) -> u64 {
        as_(&fx.alice, NOW, R + B + JOB_STORAGE_DEPOSIT);
        forget_request(input_hash);
        let id = fx.c.submit_job(
            "model job".into(),
            input_hash.into(),
            "".into(),
            20,
            1000,
            U128(R),
            U128(1),
            None, None, None, None
        );
        as_(&fx.owner, NOW, 0);
        fx.c.set_tee_signers(signers);
        as_(&fx.operator, NOW + 1, 0);
        assert_eq!(fx.c.start_next(), id);
        id
    }

    #[test]
    fn test_v2_attested_completion_provider_form() {
        let mut fx = setup();
        let a = attest_fx();
        let id = running_model_job(&mut fx, &format!("sha256:{}", fs(&a, "request_hash")), vec![fs(&a, "signer")]);
        as_(&fx.operator, NOW + 10, 0);
        fx.c.complete_job_attested(
            id,
            fs(&a, "response"),
            fs(&a, "signature_provider"),
            format!("0x{}", fs(&a, "signer").to_uppercase()),
            Some(fs(&a, "model")),
        );
        let job = fx.c.get_job(id);
        assert_eq!(job.status, JobStatus::Done);
        assert!(job.attested);
        assert_eq!(job.artifact_hash.unwrap(), fs(&a, "response_hash"));
        assert_eq!(fx.c.get_stats().attested, 1);
        assert_eq!(transferred_to(&fx.operator), R);
        assert!(has_log("tee-ed25519:"));
    }

    #[test]
    fn test_v2_gateway_receipt_is_not_accepted() {
        // A gateway receipt ({req}:{res}) does not show which model ran.
        let mut fx = setup();
        let a = attest_fx();
        let id = running_model_job(&mut fx, &fs(&a, "request_hash"), vec![fs(&a, "signer")]);
        as_(&fx.operator, NOW + 10, 0);
        assert!(panics(|| fx.c.complete_job_attested(id, fs(&a, "response"), fs(&a, "signature_gateway"), fs(&a, "signer"), None)));
        as_(&fx.operator, NOW + 10, 0);
        fx.c.complete_job_attested(id, fs(&a, "response"), fs(&a, "signature_provider"), fs(&a, "signer"), Some(fs(&a, "model")));
        assert!(fx.c.get_job(id).attested);
    }

    #[test]
    fn test_v2_signed_answer_settles_one_job_only() {
        // Two jobs with the same request hash; the second may not reuse the answer.
        let mut fx = setup();
        let a = attest_fx();
        let input = fs(&a, "request_hash");
        let first = running_model_job(&mut fx, &input, vec![fs(&a, "signer")]);
        as_(&fx.operator, NOW + 10, 0);
        fx.c.complete_job_attested(first, fs(&a, "response"), fs(&a, "signature_provider"), fs(&a, "signer"), Some(fs(&a, "model")));
        // A copied request hash is refused at submission, so it can never burn the real job's answer.
        as_(&fx.bob, NOW + 11, R + B + JOB_STORAGE_DEPOSIT);
        assert!(panics(|| fx.c.submit_job("copy".into(), input.clone(), "".into(), 20, 1000, U128(R), U128(1), None, None, None, None)));
        // A job from before claims existed (no claim key) is still held to "one signed answer settles one job".
        env::storage_remove(&claim_key(&input));
        as_(&fx.bob, NOW + 11, R + B + JOB_STORAGE_DEPOSIT);
        let second = fx.c.submit_job("copy".into(), input.clone(), "".into(), 20, 1000, U128(R), U128(1), None, None, None, None);
        env::storage_remove(&claim_key(&input));
        as_(&fx.operator, NOW + 12, 0);
        assert_eq!(fx.c.start_next(), second);
        as_(&fx.operator, NOW + 20, 0);
        assert!(panics(|| fx.c.complete_job_attested(second, fs(&a, "response"), fs(&a, "signature_provider"), fs(&a, "signer"), Some(fs(&a, "model")))));
        assert_eq!(fx.c.get_job(second).status, JobStatus::Running);
        // v3: a job that asked for a model answer cannot be settled on the operator's word; the operator can only
        // fail it, which refunds the owner.
        as_(&fx.operator, NOW + 21, 0);
        assert_eq!(fx.c.get_job(second).verify, Verify::Model);
        assert!(panics(|| fx.c.complete_job(second, "hash".into())));
        fx.c.fail_job(second, "no valid signed answer".into());
        assert_eq!(fx.c.get_job(second).status, JobStatus::Failed);
    }

    #[test]
    fn test_v2_pinned_model_is_enforced() {
        let mut fx = setup();
        let a = attest_fx();
        let id = running_model_job(&mut fx, &fs(&a, "request_hash"), vec![fs(&a, "signer")]);
        as_(&fx.alice, NOW, 0);
        assert!(panics(|| fx.c.set_tee_model(Some("x".into()))));
        as_(&fx.owner, NOW, 0);
        fx.c.set_tee_model(Some("another/model".into()));
        assert_eq!(fx.c.get_tee_model().as_deref(), Some("another/model"));
        as_(&fx.operator, NOW + 10, 0);
        assert!(panics(|| fx.c.complete_job_attested(id, fs(&a, "response"), fs(&a, "signature_provider"), fs(&a, "signer"), Some(fs(&a, "model")))));
        as_(&fx.owner, NOW, 0);
        fx.c.set_tee_model(Some(fs(&a, "model")));
        as_(&fx.operator, NOW + 10, 0);
        fx.c.complete_job_attested(id, fs(&a, "response"), fs(&a, "signature_provider"), fs(&a, "signer"), Some(fs(&a, "model")));
        assert!(fx.c.get_job(id).attested);
    }

    #[test]
    fn test_v2_attested_refusals() {
        let a = attest_fx();
        let good_input = fs(&a, "request_hash");
        let other_input = hex(&env::sha256(b"a different request"));
        // (input hash on the job, response, signer pinned, model, why)
        let cases: Vec<(String, String, String, Option<String>, &str)> = vec![
            (good_input.clone(), fs(&a, "response").replace("roll back", "ship it"), fs(&a, "signer"), Some(fs(&a, "model")), "edited answer"),
            (other_input, fs(&a, "response"), fs(&a, "signer"), Some(fs(&a, "model")), "answer to another request"),
            (good_input.clone(), fs(&a, "response"), "22".repeat(32), Some(fs(&a, "model")), "unpinned signer"),
            (good_input.clone(), fs(&a, "response"), fs(&a, "signer"), Some("other/model".into()), "wrong model in signed text"),
            ("sha256:input".into(), fs(&a, "response"), fs(&a, "signer"), Some(fs(&a, "model")), "input is not a sha256"),
        ];
        for (input, response, pinned, model, why) in cases {
            let mut fx = setup();
            let id = running_model_job(&mut fx, &input, vec![pinned]);
            as_(&fx.operator, NOW + 10, 0);
            let refused = panics(|| {
                fx.c.complete_job_attested(id, response.clone(), fs(&a, "signature_provider"), fs(&a, "signer"), model.clone())
            });
            assert!(refused, "must refuse: {why}");
        }
        // Only the operator may submit, and only the owner may pin.
        let mut fx = setup();
        let id = running_model_job(&mut fx, &good_input, vec![fs(&a, "signer")]);
        as_(&fx.alice, NOW + 10, 0);
        assert!(panics(|| fx.c.complete_job_attested(id, fs(&a, "response"), fs(&a, "signature_provider"), fs(&a, "signer"), Some(fs(&a, "model")))));
        as_(&fx.alice, NOW, 0);
        assert!(panics(|| fx.c.set_tee_signers(vec![fs(&a, "signer")])));
        as_(&fx.owner, NOW, 0);
        assert!(panics(|| fx.c.set_tee_signers(vec!["abcd".into()])));
    }

    #[test]
    fn test_v2_priority_storage_small_sets_long_accounts_fresh_keys() {
        // 1-3 displaced, 64-byte ids, no treasury credit key yet,
        // and a fresh requester credit key from the excess.
        let long = |i: usize| -> AccountId {
            let head = format!("{i:02}");
            format!("{}{}", head, "x".repeat(64 - head.len())).parse().unwrap()
        };
        for n in 1..=3usize {
            as_(&acct("owner"), NOW, 0);
            // Mocked storage outlives a Contract value, so every round uses
            // fresh account ids: no credit key exists before the purchase.
            let treasury = long(70 + n);
            let mut c = Contract::new(acct("owner"), acct("operator"), treasury.clone(), 100, None, None, None, None);
            assert_eq!(c.get_credit(treasury.clone()).0, 0);
            for i in 0..n {
                submit_at(&mut c, &long(10 * n + i), NOW, "slot", 1, 100_000, 1, 1, 100);
            }
            let buyer = long(90 + n);
            let urgent = submit_at(&mut c, &buyer, NOW, "u", 1, 100_000, 1, 1, 100);
            let q = quote_at(&c, NOW, urgent, NOW);
            assert_eq!(q.displaced.len(), n);
            request_at(&mut c, &buyer, NOW, urgent, NOW, q.total.0, q.total.0 + 1);
            assert!(c.get_credit(treasury).0 > 0);
            assert_eq!(c.get_credit(buyer).0, 1);
        }
    }

    #[test]
    fn test_v2_largest_terminal_job_fits_its_deposit() {
        // Everything one job can ever write, measured step by step. `testing_env!` resets
        // the storage counter, so each step is read inside its own context and the deltas are summed.
        let mut fx = setup();
        let a = attest_fx();
        let owner: AccountId = "o".repeat(64).parse().unwrap();
        // The longest input hash that still normalizes to a sha256, so it also writes a request claim.
        let input = format!("{}sha256:0x{}", " ".repeat(MAX_INPUT_HASH_LEN - 73), fs(&a, "request_hash"));
        assert_eq!(input.len(), MAX_INPUT_HASH_LEN);
        forget_request(&input);
        as_(&fx.owner, NOW, 0);
        fx.c.set_tee_signers(vec![fs(&a, "signer")]);
        let mut used: u64 = 0;

        as_(&owner, NOW, R + B + JOB_STORAGE_DEPOSIT);
        let before = env::storage_usage();
        let id = fx.c.submit_job("😀".repeat(MAX_TITLE_CHARS), input.clone(), "u".repeat(MAX_URI_LEN), 20, 1000, U128(R), U128(1), None, None, None, None);
        used += env::storage_usage() - before;

        as_(&fx.operator, NOW + 1, 0);
        let before = env::storage_usage();
        fx.c.start_next();
        used += env::storage_usage().saturating_sub(before);

        as_(&fx.operator, NOW + 10, 0);
        let before = env::storage_usage();
        fx.c.complete_job_attested(id, fs(&a, "response"), fs(&a, "signature_provider"), fs(&a, "signer"), Some(fs(&a, "model")));
        used += env::storage_usage().saturating_sub(before);
        assert!(fx.c.get_job(id).attested);

        // Both payouts (owner's bond, operator's reward) can fail and come back as fresh credit keys; model
        // the worst case with two 64-byte account ids.
        for who in ["p".repeat(64), "q".repeat(64)] {
            let who: AccountId = who.parse().unwrap();
            as_(&acct("queue"), NOW + 10, 0);
            let before = env::storage_usage();
            fx.c.credits.insert(&who, &1);
            used += env::storage_usage() - before;
        }
        let cost = used as u128 * env::storage_byte_cost().as_yoctonear();
        eprintln!("worst-case job storage: {used} bytes of {}", JOB_STORAGE_DEPOSIT / env::storage_byte_cost().as_yoctonear());
        assert!(cost <= JOB_STORAGE_DEPOSIT, "worst-case job writes {used} bytes = {cost} yocto > deposit {JOB_STORAGE_DEPOSIT}");
    }

    #[test]
    fn test_v2_failed_payout_is_restored_as_credit() {
        let mut fx = setup();
        let ctx = || {
            VMContextBuilder::new()
                .current_account_id(acct("queue"))
                .predecessor_account_id(acct("queue"))
                .block_timestamp(NOW * NS_PER_SEC)
                .build()
        };
        testing_env!(ctx(), near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(), Default::default(), vec![near_sdk::PromiseResult::Failed]);
        assert!(!fx.c.on_payout(fx.alice.clone(), U128(777)));
        assert_eq!(fx.c.get_credit(fx.alice.clone()).0, 777);
        assert_eq!(fx.c.get_stats().total_credits.0, 777);
        assert!(has_log("payout_failed_credited"));
        testing_env!(ctx(), near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(), Default::default(), vec![near_sdk::PromiseResult::Successful(vec![])]);
        assert!(fx.c.on_payout(fx.bob.clone(), U128(5)));
        assert_eq!(fx.c.get_credit(fx.bob.clone()).0, 0);
        // Private: nobody else can mint credit through it.
        as_(&fx.alice, NOW, 0);
        assert!(panics(|| fx.c.on_payout(fx.alice.clone(), U128(1))));
    }

    #[test]
    fn test_v2_payouts_carry_a_recovery_callback() {
        let mut fx = setup();
        let id = submit_at(&mut fx.c, &fx.alice, NOW, "A", 1, 100, R, B, 1);
        as_(&fx.operator, NOW, 0);
        fx.c.start_next();
        as_(&fx.operator, NOW + 1, 0);
        fx.c.complete_job(id, "hash".into());
        let callbacks = get_created_receipts()
            .into_iter()
            .flat_map(|r| r.actions)
            .filter(|a| matches!(a, MockAction::FunctionCallWeight { method_name, .. } if method_name == b"on_payout"))
            .count();
        assert_eq!(callbacks, 2, "operator reward and owner bond each get a callback");
    }

    // -- cases found by mutation testing (cargo-mutants) ----------------------

    #[test]
    fn test_slot_start_uses_the_durations_of_the_jobs_ahead() {
        // Different durations, so a slot's start depends on exactly which jobs are ahead of it.
        let mut fx = setup();
        submit_at(&mut fx.c, &fx.alice, NOW, "A", 3, 1_000, R, B, 1);
        let b = submit_at(&mut fx.c, &fx.alice, NOW, "B", 7, 1_000, R, B, 1);
        let c = submit_at(&mut fx.c, &fx.bob, NOW, "C", 2, 1_000, R, B, 1);
        let urgent = submit_at(&mut fx.c, &fx.dave, NOW, "urgent", 5, 1_000, R, B, 1);
        // Slots start at +0, +3, +10, +12. The latest one that starts within 5 s is the second.
        let q = quote_at(&fx.c, NOW, urgent, NOW + 5);
        assert!(q.feasible, "{}", q.reason);
        assert_eq!(q.insert_index, 1);
        assert_eq!(q.projected_start_at, NOW + 3);
        assert_eq!(q.displaced.iter().map(|d| d.job_id).collect::<Vec<_>>(), vec![b, c]);
    }

    #[test]
    fn test_no_slot_reason_names_the_cutoff_when_the_worker_is_busy() {
        let mut fx = setup();
        let long = submit_at(&mut fx.c, &fx.alice, NOW, "long", 60, 1_000, R, B, 1);
        as_(&fx.operator, NOW, 0);
        assert_eq!(fx.c.start_next(), long);
        submit_at(&mut fx.c, &fx.alice, NOW, "A", 5, 1_000, R, B, 1);
        // Admitted with exactly the completion margin; too tight for the buyer's 3 s margin at any slot.
        let urgent = submit_at(&mut fx.c, &fx.dave, NOW, "urgent", 10, 72, R, B, 1);
        // The cutoff is before the worker is free, and the deadline is out of reach too: the cutoff is named.
        let q = quote_at(&fx.c, NOW, urgent, NOW + 30);
        assert!(!q.feasible);
        assert_eq!(q.reason, "latest_start_at is earlier than the earliest possible start");
        // With a cutoff the worker can meet, the buyer's own deadline is the reason.
        let q = quote_at(&fx.c, NOW, urgent, NOW + 90);
        assert!(!q.feasible);
        assert!(q.reason.starts_with("urgent job would finish at"), "{}", q.reason);
    }

    #[test]
    fn test_handoff_margin_counts_from_the_buyers_new_slot() {
        // The buyer lands in the second slot: the first job it passes has no hand-off ahead, the next has one.
        let build = |tight_deadline: u32| {
            let mut fx = setup();
            submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 1_000, R, B, 1);
            submit_at(&mut fx.c, &fx.alice, NOW, "B", 10, 1_000, R, B, 1);
            submit_at(&mut fx.c, &fx.bob, NOW, "C", 10, tight_deadline, R, B, 1);
            let urgent = submit_at(&mut fx.c, &fx.dave, NOW, "urgent", 5, 1_000, R, B, 1);
            quote_at(&fx.c, NOW, urgent, NOW + 12)
        };
        // C finishes at +35 after the jump and needs 3 + 1 seconds of margin: +39 is enough, +38 is not.
        let ok = build(39);
        assert_eq!(ok.insert_index, 1);
        assert!(ok.feasible, "{}", ok.reason);
        assert!(!build(38).feasible);
    }

    #[test]
    fn test_refusal_text_tells_a_broken_deadline_from_a_thin_margin() {
        let reason = |deadline: u32| {
            let mut fx = setup();
            submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, deadline, R, B, 1);
            let urgent = submit_at(&mut fx.c, &fx.dave, NOW, "urgent", 5, 1_000, R, B, 1);
            let q = quote_at(&fx.c, NOW, urgent, NOW);
            assert!(!q.feasible);
            q.reason
        };
        // A would finish at +15 after the jump.
        assert!(reason(14).contains("after its deadline"), "{}", reason(14));
        assert!(reason(15).contains("inside the safety margin"), "{}", reason(15));
        assert!(reason(17).contains("inside the safety margin"), "{}", reason(17));
    }

    // -- v3 rules ---------------------------------------------------------------
    //
    // Each rule v3 adds over v2, tested on its own: doomed jobs, atomic purchase, delayed ask raises, operator stake
    // and liveness, broken-promise penalties, rejection, record release and the owner timelock.

    mod v3_rules {
        use super::*;

        const STAKE: u128 = 10 * R;

        fn view(c: &Contract, at: u64, id: u64) -> JobView {
            as_(&acct("viewer"), at, 0);
            c.get_job(id)
        }

        fn credit_at(c: &Contract, at: u64, who: &AccountId) -> u128 {
            as_(&acct("viewer"), at, 0);
            c.get_credit(who.clone()).0
        }

        fn config_at(c: &Contract, at: u64) -> ConfigView {
            as_(&acct("viewer"), at, 0);
            c.get_config()
        }

        fn stats_at(c: &Contract, at: u64) -> StatsView {
            as_(&acct("viewer"), at, 0);
            c.get_stats()
        }

        /// Owner sets the minimum stake, operator posts `stake`.
        fn staked(fx: &mut Fx, at: u64, stake: u128, min: u128) {
            as_(&fx.owner, at, 0);
            fx.c.set_min_operator_stake(min);
            if stake > 0 {
                as_(&fx.operator, at, stake);
                fx.c.stake();
            }
            if stake > 0 || min > 0 {
                allow(fx, at, &[fx.alice.clone(), fx.bob.clone(), fx.carol.clone(), fx.dave.clone()]);
            }
        }

        /// The operator approves accounts to submit (attaching more than the entries cost; the rest comes back).
        fn allow(fx: &mut Fx, at: u64, accounts: &[AccountId]) {
            as_(&fx.operator, at, 1_000 * BYTE);
            fx.c.allow_clients(accounts.to_vec());
        }

        #[allow(clippy::too_many_arguments)]
        fn submit_buying(
            c: &mut Contract,
            who: &AccountId,
            ts: u64,
            duration_secs: u32,
            deadline_secs: u32,
            budget: u128,
            max_spend: u128,
            required: Option<bool>,
        ) -> u64 {
            submit_buying_by(c, who, ts, duration_secs, deadline_secs, budget, max_spend, required, Some(ts))
        }

        /// `latest`: the cutoff for the bought slot (`None` = the latest start that still meets the deadline).
        #[allow(clippy::too_many_arguments)]
        fn submit_buying_by(
            c: &mut Contract,
            who: &AccountId,
            ts: u64,
            duration_secs: u32,
            deadline_secs: u32,
            budget: u128,
            max_spend: u128,
            required: Option<bool>,
            latest: Option<u64>,
        ) -> u64 {
            as_(who, ts, R + B + JOB_STORAGE_DEPOSIT + budget);
            c.submit_job(
                "urgent".to_string(),
                "sha256:input".to_string(),
                String::new(),
                duration_secs,
                deadline_secs,
                U128(R),
                U128(0),
                Some(U128(B)),
                None,
                None,
                Some(PriorityRequest { latest_start_at: latest, max_spend: U128(max_spend), required }),
            )
        }

        // ---- doomed jobs ----

        #[test]
        fn a_job_already_projected_to_miss_does_not_block_a_purchase_and_is_still_paid() {
            let build = |at: u64| {
                let mut fx = setup();
                // A is at the front with a deadline 20 s out; the worker stays idle, so its projection slides.
                let a = submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 20, R, B, 7);
                let urgent = submit_at(&mut fx.c, &fx.dave, NOW, "urgent", 2, 1_000, R, B, 0);
                (fx, a, urgent, at)
            };
            // At +7 A is still on schedule (finish +17, +2 margin = +19 <= +20): the jump would make it late.
            let (fx, _, urgent, at) = build(NOW + 7);
            let q = quote_at(&fx.c, at, urgent, at);
            assert!(!q.feasible);
            assert!(q.reason.starts_with("displaced job"), "{}", q.reason);
            // At +9 A can no longer finish in time wherever it stands: it cannot block, and it is paid its ask.
            let (mut fx, a, urgent, at) = build(NOW + 9);
            let q = quote_at(&fx.c, at, urgent, at);
            assert!(q.feasible, "{}", q.reason);
            assert_eq!(q.displaced.len(), 1);
            assert_eq!(q.displaced[0].job_id, a);
            assert_eq!(q.displaced[0].amount.0, 7 * 2);
            request_at(&mut fx.c, &fx.dave, at, urgent, at, q.total.0, q.total.0);
            assert_eq!(credit_at(&fx.c, at, &fx.alice), 14);
            assert_eq!(credit_at(&fx.c, at, &fx.treasury), 1);
            assert_eq!(queue_ids(&fx), vec![urgent, a]);
        }

        // ---- atomic submit + purchase ----

        #[test]
        fn submit_can_buy_its_slot_in_the_same_transaction() {
            let mut fx = setup();
            let a = submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 1_000, R, B, 5);
            // Price: 5 x 4 = 20 compensation + 10% fee = 22, plus the storage for a 1-job purchase; 7 extra comes back.
            let budget = 22 + priority_storage_deposit(1) + 7;
            let u = submit_buying(&mut fx.c, &fx.dave, NOW, 4, 100, budget, 1_000, Some(true));
            assert!(has_log("\"event\":\"priority_purchased\""));
            assert_eq!(queue_ids(&fx), vec![u, a]);
            let job = view(&fx.c, NOW, u);
            assert!(job.expedited);
            assert!(job.promised);
            assert_eq!(job.priority_spend.0, 22);
            assert_eq!(job.storage_deposit.0, JOB_STORAGE_DEPOSIT);
            assert_eq!(credit_at(&fx.c, NOW, &fx.alice), 20);
            assert_eq!(credit_at(&fx.c, NOW, &fx.treasury), 2);
            assert_eq!(credit_at(&fx.c, NOW, &fx.dave), 7);
        }

        #[test]
        fn a_required_purchase_that_cannot_happen_fails_the_whole_submission() {
            let mut fx = setup();
            // A has 2 s of spare time: passing it would make it late, and it is not doomed.
            submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 12, R, B, 5);
            let budget = 1_000 + priority_storage_deposit(1);
            // (On chain the panic reverts the submission; the mocked state here keeps partial writes, so the rest
            // of the test uses a fresh contract.)
            assert!(panics(|| submit_buying(&mut fx.c, &fx.dave, NOW, 4, 100, budget, 1_000, Some(true))));
            let mut fx = setup();
            submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 12, R, B, 5);

            // Not required: the job joins the back, the purchase is skipped and the whole budget is credited back.
            let u = submit_buying(&mut fx.c, &fx.dave, NOW, 4, 100, budget, 1_000, None);
            assert!(has_log("\"event\":\"priority_skipped\""));
            assert_eq!(fx.c.get_queue().last().unwrap().id, u);
            assert!(!view(&fx.c, NOW, u).expedited);
            assert_eq!(credit_at(&fx.c, NOW, &fx.dave), budget);
        }

        #[test]
        fn with_the_default_cutoff_a_job_buys_only_when_its_deadline_needs_it() {
            let mut fx = setup();
            let a = submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 1_000, R, B, 5);
            let budget = 22 + priority_storage_deposit(1);
            // The back of the queue meets this deadline: nothing is bought, `required` is satisfied, budget returned.
            let u = submit_buying_by(&mut fx.c, &fx.dave, NOW, 4, 100, budget, 1_000, Some(true), None);
            assert_eq!(queue_ids(&fx), vec![a, u]);
            assert_eq!(credit_at(&fx.c, NOW, &fx.dave), budget);
            // This one would be late at the back (+14 +4 +3 > +16): it buys the front, passing both.
            let budget = 22 + priority_storage_deposit(2);
            let v = submit_buying_by(&mut fx.c, &fx.carol, NOW, 4, 16, budget, 1_000, Some(true), None);
            assert_eq!(queue_ids(&fx)[0], v);
            assert!(view(&fx.c, NOW, v).promised);
        }

        #[test]
        fn a_purchase_over_max_spend_is_skipped_or_fails_when_required() {
            let mut fx = setup();
            submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 1_000, R, B, 5);
            let budget = 1_000 + priority_storage_deposit(1);
            assert!(panics(|| submit_buying(&mut fx.c, &fx.dave, NOW, 4, 100, budget, 21, Some(true))));
            let u = submit_buying(&mut fx.c, &fx.dave, NOW, 4, 100, budget, 21, Some(false));
            assert!(!view(&fx.c, NOW, u).expedited);
            assert_eq!(credit_at(&fx.c, NOW, &fx.dave), budget);
        }

        #[test]
        fn a_balance_funded_submission_can_buy_its_slot_too() {
            let mut fx = setup();
            submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 1_000, R, B, 5);
            let start = R + B + JOB_STORAGE_DEPOSIT + 22 + priority_storage_deposit(1) + 100;
            as_(&fx.dave, NOW, start + BALANCE_STORAGE_DEPOSIT);
            fx.c.deposit();
            as_(&fx.dave, NOW, 0);
            let u = fx.c.submit_job(
                "urgent".into(),
                "sha256:input".into(),
                String::new(),
                4,
                100,
                U128(R),
                U128(0),
                Some(U128(B)),
                None,
                None,
                Some(PriorityRequest { latest_start_at: Some(NOW), max_spend: U128(22), required: Some(true) }),
            );
            assert_eq!(fx.c.get_queue()[0].id, u);
            // Exactly the escrow, the job storage, the price and the purchase storage were spent.
            assert_eq!(credit_at(&fx.c, NOW, &fx.dave), 100);
        }

        // ---- delayed ask raises ----

        #[test]
        fn a_raise_waits_its_delay_a_newer_raise_restarts_it_and_a_cut_is_immediate() {
            let mut fx = setup();
            submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 10_000, R, B, 100);
            let urgent = submit_at(&mut fx.c, &fx.dave, NOW, "urgent", 2, 10_000, R, B, 0);
            let price = |c: &Contract, t: u64| quote_at(c, t, urgent, t).compensation.0;

            as_(&fx.alice, NOW, 0);
            fx.c.set_move_ask(1, U128(500));
            assert!(has_log(&format!("\"effective_at\":{}", NOW + ASK_RAISE_DELAY_SECS)));
            assert_eq!(view(&fx.c, NOW, 1).ask_pending.map(|a| a.0), Some(500));
            assert_eq!(price(&fx.c, NOW + ASK_RAISE_DELAY_SECS - 1), 200);
            assert_eq!(price(&fx.c, NOW + ASK_RAISE_DELAY_SECS), 1_000);

            // A second raise before the first lands replaces it and starts its own delay.
            let mut fx2 = setup();
            submit_at(&mut fx2.c, &fx2.alice, NOW, "A", 10, 10_000, R, B, 100);
            submit_at(&mut fx2.c, &fx2.dave, NOW, "urgent", 2, 10_000, R, B, 0);
            as_(&fx2.alice, NOW, 0);
            fx2.c.set_move_ask(1, U128(500));
            as_(&fx2.alice, NOW + 10, 0);
            fx2.c.set_move_ask(1, U128(400));
            assert_eq!(price(&fx2.c, NOW + ASK_RAISE_DELAY_SECS), 200);
            assert_eq!(price(&fx2.c, NOW + 10 + ASK_RAISE_DELAY_SECS), 800);
            assert_eq!(view(&fx2.c, NOW + 10 + ASK_RAISE_DELAY_SECS, 1).ask_per_sec.0, 400);
            assert_eq!(view(&fx2.c, NOW + 10 + ASK_RAISE_DELAY_SECS, 1).ask_pending, None);

            // A cut lands at once and drops any pending raise.
            as_(&fx.alice, NOW + 1, 0);
            fx.c.set_move_ask(1, U128(50));
            assert_eq!(price(&fx.c, NOW + 1), 100);
            assert_eq!(price(&fx.c, NOW + 1 + ASK_RAISE_DELAY_SECS), 100);
            assert_eq!(view(&fx.c, NOW + 1, 1).ask_pending, None);
        }

        #[test]
        fn a_raise_that_has_landed_is_the_base_for_the_next_change() {
            let mut fx = setup();
            submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 10_000, R, B, 100);
            let urgent = submit_at(&mut fx.c, &fx.dave, NOW, "urgent", 2, 10_000, R, B, 0);
            as_(&fx.alice, NOW, 0);
            fx.c.set_move_ask(1, U128(500));
            // After the raise landed, 300 is a cut from 500: immediate.
            let t = NOW + ASK_RAISE_DELAY_SECS + 5;
            as_(&fx.alice, t, 0);
            fx.c.set_move_ask(1, U128(300));
            assert_eq!(quote_at(&fx.c, t, urgent, t).compensation.0, 600);
        }

        // ---- operator stake and liveness ----

        #[test]
        fn no_new_work_without_the_minimum_stake_or_a_live_worker() {
            let mut fx = setup();
            staked(&mut fx, NOW, 0, STAKE);
            assert!(!config_at(&fx.c, NOW).accepting_work);
            assert!(panics(|| submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 1_000, R, B, 5)));

            as_(&fx.operator, NOW, STAKE);
            fx.c.stake();
            assert!(config_at(&fx.c, NOW).accepting_work);
            let a = submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 10_000, R, B, 5);
            let u = submit_at(&mut fx.c, &fx.dave, NOW, "urgent", 2, 10_000, R, B, 0);

            // The worker goes quiet: after OPERATOR_HEARTBEAT_SECS no submission and no purchase is taken.
            let late = NOW + OPERATOR_HEARTBEAT_SECS + 1;
            assert!(config_at(&fx.c, NOW + OPERATOR_HEARTBEAT_SECS).accepting_work);
            assert!(!config_at(&fx.c, late).accepting_work);
            assert!(panics(|| submit_at(&mut fx.c, &fx.bob, late, "B", 10, 10_000, R, B, 5)));
            assert!(panics(|| request_at(&mut fx.c, &fx.dave, late, u, late, 1_000, 1_000)));
            // Exits still work: a queued job can leave.
            as_(&fx.alice, late, 0);
            fx.c.cancel_job(a);

            // Any operator call is a heartbeat.
            as_(&fx.operator, late, 0);
            assert_eq!(fx.c.heartbeat(), late);
            submit_at(&mut fx.c, &fx.bob, late, "B", 10, 10_000, R, B, 5);
            as_(&fx.operator, late + 100, 0);
            fx.c.start_next();
            assert!(config_at(&fx.c, late + 100 + OPERATOR_HEARTBEAT_SECS).accepting_work);
        }

        #[test]
        fn no_minimum_stake_means_always_accepting() {
            let mut fx = setup();
            assert!(config_at(&fx.c, NOW + 10 * OPERATOR_HEARTBEAT_SECS).accepting_work);
            submit_at(&mut fx.c, &fx.alice, NOW + 10 * OPERATOR_HEARTBEAT_SECS, "A", 10, 1_000, R, B, 5);
        }

        #[test]
        fn only_the_operator_stakes_and_unstaking_waits_out_the_timelock() {
            let mut fx = setup();
            as_(&fx.alice, NOW, STAKE);
            assert!(panics(|| fx.c.stake()));
            as_(&fx.operator, NOW, 0);
            assert!(panics(|| fx.c.stake()), "a zero stake is refused");
            as_(&fx.operator, NOW, STAKE);
            assert_eq!(fx.c.stake().0, STAKE);

            as_(&fx.operator, NOW, 0);
            assert!(panics(|| fx.c.request_unstake(U128(STAKE + 1))));
            assert!(panics(|| fx.c.withdraw_unstaked()), "nothing requested yet");
            fx.c.request_unstake(U128(4 * R));
            let ready = NOW + 86_400;
            assert_eq!(config_at(&fx.c, NOW).unstake_pending.map(|(a, t)| (a.0, t)), Some((4 * R, ready)));
            as_(&fx.operator, ready - 1, 0);
            assert!(panics(|| fx.c.withdraw_unstaked()));
            as_(&fx.operator, ready, 0);
            assert_eq!(fx.c.withdraw_unstaked().0, 4 * R);
            assert_eq!(transferred_to(&fx.operator), 4 * R);
            assert_eq!(config_at(&fx.c, ready).operator_stake.0, STAKE - 4 * R);
            assert_eq!(config_at(&fx.c, ready).unstake_pending, None);
        }

        #[test]
        fn a_penalty_while_unstaking_caps_the_withdrawal_at_what_is_left() {
            let mut fx = setup();
            staked(&mut fx, NOW, 2 * R, 0);
            as_(&fx.operator, NOW, 0);
            fx.c.request_unstake(U128(2 * R));
            // A promised job misses; its owner is paid R from the stake first.
            let a = submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 20, R, B, 5);
            assert!(view(&fx.c, NOW, a).promised);
            as_(&fx.operator, NOW + 15, 0);
            fx.c.start_next();
            as_(&fx.operator, NOW + 86_400, 0);
            assert_eq!(fx.c.withdraw_unstaked().0, R);
        }

        // ---- broken promises ----

        #[test]
        fn a_promised_job_that_misses_is_paid_its_reward_from_the_stake() {
            let mut fx = setup();
            staked(&mut fx, NOW, STAKE, STAKE);
            let a = submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 20, R, B, 5);
            assert!(view(&fx.c, NOW, a).promised);
            // The operator starts it too late to finish: missed, escrow refunded, and R from the stake.
            as_(&fx.operator, NOW + 15, 0);
            fx.c.start_next();
            assert_eq!(transferred_to(&fx.alice), R + B);
            assert_eq!(view(&fx.c, NOW + 15, a).status, JobStatus::Missed);
            assert_eq!(credit_at(&fx.c, NOW + 15, &fx.alice), R);
            assert_eq!(view(&fx.c, NOW + 15, a).penalty_paid.0, R);
            let s = stats_at(&fx.c, NOW + 15);
            assert_eq!(s.promises_broken, 1);
            assert_eq!(s.total_penalties.0, R);
            assert_eq!(s.operator_stake.0, STAKE - R);
            // The stake fell below the minimum: no new work until the operator tops it up.
            assert!(!config_at(&fx.c, NOW + 15).accepting_work);
            assert!(panics(|| submit_at(&mut fx.c, &fx.bob, NOW + 15, "B", 10, 1_000, R, B, 5)));
        }

        #[test]
        fn a_buyer_whose_bought_slot_is_lost_gets_its_price_back_too() {
            let mut fx = setup();
            staked(&mut fx, NOW, STAKE, STAKE);
            submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 1_000, R, B, 5);
            let u = submit_at(&mut fx.c, &fx.dave, NOW, "urgent", 4, 30, R, B, 0);
            request_at(&mut fx.c, &fx.dave, NOW, u, NOW, 22, 22);
            assert_eq!(fx.c.get_queue()[0].id, u);
            // The worker sits idle past the last moment the bought slot could still be kept.
            as_(&fx.operator, NOW + 27, 0);
            assert_eq!(fx.c.start_next(), u);
            assert_eq!(view(&fx.c, NOW + 27, u).status, JobStatus::Missed);
            assert_eq!(credit_at(&fx.c, NOW + 27, &fx.dave), R + 22);
        }

        #[test]
        fn a_job_admitted_already_late_at_the_back_was_promised_nothing() {
            let mut fx = setup();
            staked(&mut fx, NOW, STAKE, STAKE);
            submit_at(&mut fx.c, &fx.alice, NOW, "A", 50, 1_000, R, B, 5);
            // B could only make it by buying the front; at the back it is late, so nothing was promised.
            let b = submit_at(&mut fx.c, &fx.bob, NOW, "B", 5, 20, R, B, 5);
            assert!(!view(&fx.c, NOW, b).promised);
            as_(&fx.carol, NOW + 21, 0);
            fx.c.claim_timeout(b);
            assert_eq!(credit_at(&fx.c, NOW + 21, &fx.bob), 0);
            assert_eq!(stats_at(&fx.c, NOW + 21).operator_stake.0, STAKE);
        }

        #[test]
        fn penalties_are_paid_as_far_as_the_stake_goes_and_once_per_job() {
            let mut fx = setup();
            staked(&mut fx, NOW, R / 2, 0);
            let a = submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 20, R, B, 5);
            as_(&fx.operator, NOW, 0);
            fx.c.start_next();
            // Delivered late: missed; the owner gets what is left of the stake.
            as_(&fx.operator, NOW + 25, 0);
            fx.c.complete_job(a, "artifact".into());
            assert_eq!(transferred_to(&fx.operator), 0, "a late delivery earns nothing");
            assert_eq!(transferred_to(&fx.alice), R + B);
            assert_eq!(view(&fx.c, NOW + 25, a).status, JobStatus::Missed);
            assert_eq!(credit_at(&fx.c, NOW + 25, &fx.alice), R / 2);
            assert_eq!(stats_at(&fx.c, NOW + 25).operator_stake.0, 0);
            assert_eq!(stats_at(&fx.c, NOW + 25).promises_broken, 1);
        }

        #[test]
        fn a_failed_promised_job_is_paid_from_the_stake() {
            let mut fx = setup();
            staked(&mut fx, NOW, STAKE, 0);
            let a = submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 1_000, R, B, 5);
            as_(&fx.operator, NOW, 0);
            fx.c.start_next();
            as_(&fx.operator, NOW + 5, 0);
            fx.c.fail_job(a, "model unavailable".into());
            assert_eq!(credit_at(&fx.c, NOW + 5, &fx.alice), R);
        }

        // ---- rejection ----

        #[test]
        fn the_operator_can_refuse_a_queued_job_and_pays_back_its_priority_spend() {
            let mut fx = setup();
            staked(&mut fx, NOW, STAKE, STAKE);
            submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 1_000, R, B, 5);
            let u = submit_at(&mut fx.c, &fx.dave, NOW, "urgent", 4, 100, R, B, 0);
            request_at(&mut fx.c, &fx.dave, NOW, u, NOW, 22, 22);

            as_(&fx.alice, NOW + 1, 0);
            assert!(panics(|| fx.c.reject_job(u, "unsupported".into())), "only the operator rejects");
            as_(&fx.operator, NOW + 1, 0);
            assert!(panics(|| fx.c.reject_job(u, String::new())), "a reason is required");
            fx.c.reject_job(u, "unsupported input".into());
            assert!(has_log("\"event\":\"job_rejected\""));
            assert!(has_log("\"event\":\"job_released\""));
            assert_eq!(transferred_to(&fx.dave), R + B);
            // The price comes back from the stake; the freed storage comes back as credit too.
            let back = credit_at(&fx.c, NOW + 1, &fx.dave);
            assert!(back > 22 && back <= 22 + JOB_STORAGE_DEPOSIT + priority_storage_deposit(1), "{back}");
            assert_eq!(stats_at(&fx.c, NOW + 1).operator_stake.0, STAKE - 22);
            assert_eq!(stats_at(&fx.c, NOW + 1).rejected, 1);
            assert!(panics(|| view(&fx.c, NOW + 1, u)), "the record is gone");
            assert!(panics(|| fx.c.get_priority(1)), "its priority record too");
            // Alice keeps the compensation she was paid for being passed.
            assert_eq!(credit_at(&fx.c, NOW + 1, &fx.alice), 20);
        }

        #[test]
        fn a_running_job_cannot_be_rejected() {
            let mut fx = setup();
            let a = submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 1_000, R, B, 5);
            as_(&fx.operator, NOW, 0);
            fx.c.start_next();
            assert!(panics(|| fx.c.reject_job(a, "late".into())));
        }

        // ---- release ----

        #[test]
        fn the_owner_releases_a_finished_job_and_gets_its_storage_back() {
            let mut fx = setup();
            let a = submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 1_000, R, B, 5);
            as_(&fx.alice, NOW, 0);
            assert!(panics(|| fx.c.release_job(a)), "a queued job cannot be released");
            as_(&fx.operator, NOW, 0);
            fx.c.start_next();
            as_(&fx.operator, NOW + 10, 0);
            fx.c.complete_job(a, "artifact".into());
            let held = stats_at(&fx.c, NOW + 10).storage_held.0;

            as_(&fx.bob, NOW + 11, 0);
            assert!(panics(|| fx.c.release_job(a)), "only the owner, before the retention period");
            as_(&fx.alice, NOW + 11, 0);
            let refund = fx.c.release_job(a).0;
            // Alice had no balance in the contract: the key the refund needs is hers to pay, nothing else is kept.
            let key = BYTE * (1 + 4 + fx.alice.as_str().len() as u128 + 16 + 40);
            assert_eq!(refund, JOB_STORAGE_DEPOSIT - key, "{refund}");
            assert_eq!(credit_at(&fx.c, NOW + 11, &fx.alice), refund);
            assert_eq!(stats_at(&fx.c, NOW + 11).storage_held.0, held - JOB_STORAGE_DEPOSIT);
            assert_eq!(stats_at(&fx.c, NOW + 11).released, 1);
            assert!(panics(|| view(&fx.c, NOW + 11, a)));
            as_(&fx.alice, NOW + 12, 0);
            assert!(panics(|| fx.c.release_job(a)), "released once");
        }

        #[test]
        fn anyone_may_release_after_the_retention_period_and_the_refund_goes_to_the_owner() {
            let mut fx = setup();
            let a = submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 1_000, R, B, 5);
            as_(&fx.alice, NOW + 5, 0);
            fx.c.cancel_job(a);
            as_(&fx.bob, NOW + 5 + RELEASE_AFTER_SECS - 1, 0);
            assert!(panics(|| fx.c.release_job(a)));
            as_(&fx.bob, NOW + 5 + RELEASE_AFTER_SECS, 0);
            let refund = fx.c.release_job(a).0;
            assert!(refund > 0);
            assert_eq!(credit_at(&fx.c, NOW + 5 + RELEASE_AFTER_SECS, &fx.alice), refund);
            assert_eq!(credit_at(&fx.c, NOW + 5 + RELEASE_AFTER_SECS, &fx.bob), 0);
        }

        #[test]
        fn releasing_a_buyer_refunds_its_purchase_storage_too() {
            let mut fx = setup();
            submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 1_000, R, B, 5);
            let u = submit_at(&mut fx.c, &fx.dave, NOW, "urgent", 4, 100, R, B, 0);
            request_at(&mut fx.c, &fx.dave, NOW, u, NOW, 22, 22);
            as_(&fx.operator, NOW, 0);
            fx.c.start_next();
            as_(&fx.operator, NOW + 4, 0);
            fx.c.complete_job(u, "artifact".into());
            as_(&fx.dave, NOW + 5, 0);
            let before = credit_at(&fx.c, NOW + 5, &fx.dave);
            as_(&fx.dave, NOW + 5, 0);
            let refund = fx.c.release_job(u).0;
            // Both deposits, less the balance keys the purchase created (Alice's and the treasury's) and, if Dave
            // had none, his own.
            let kept = JOB_STORAGE_DEPOSIT + priority_storage_deposit(1) - refund;
            assert!(kept > 0 && kept <= 3 * 200 * BYTE, "kept {kept}");
            assert_eq!(credit_at(&fx.c, NOW + 5, &fx.dave), before + refund);
            assert!(panics(|| fx.c.get_priority(1)));
            // The job it passed still runs and is paid normally.
            as_(&fx.operator, NOW + 5, 0);
            fx.c.start_next();
        }

        // ---- governance ----

        #[test]
        fn a_job_whose_owner_has_a_balance_gets_its_whole_storage_deposit_back() {
            let mut fx = setup();
            as_(&fx.alice, NOW, R + BALANCE_STORAGE_DEPOSIT);
            fx.c.deposit();
            let balance = credit_at(&fx.c, NOW, &fx.alice);
            let a = submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 1_000, R, B, 5);
            as_(&fx.operator, NOW, 0);
            fx.c.start_next();
            as_(&fx.operator, NOW + 10, 0);
            fx.c.complete_job(a, "artifact".into());
            as_(&fx.alice, NOW + 11, 0);
            assert_eq!(fx.c.release_job(a).0, JOB_STORAGE_DEPOSIT, "nothing of the deposit is kept");
            assert_eq!(credit_at(&fx.c, NOW + 11, &fx.alice), balance + JOB_STORAGE_DEPOSIT);
            assert_eq!(stats_at(&fx.c, NOW + 11).storage_held.0, 0);
        }

        // ---- approved clients ----

        #[test]
        fn where_a_stake_backs_the_queue_only_approved_accounts_submit_and_an_outsider_is_charged_nothing() {
            let mut fx = setup();
            assert!(!config_at(&fx.c, NOW).clients_only, "no stake: the queue is open");
            staked(&mut fx, NOW, STAKE, R);
            assert!(config_at(&fx.c, NOW).clients_only);
            let eve = acct("eve");
            assert!(!fx.c.is_client(eve.clone()) && fx.c.is_client(fx.alice.clone()));

            // An outsider is refused before escrow, storage or a purchase: attached or from a balance.
            as_(&eve, NOW, 10 * R + JOB_STORAGE_DEPOSIT + BALANCE_STORAGE_DEPOSIT);
            fx.c.deposit();
            let balance = credit_at(&fx.c, NOW, &eve);
            let escrow = stats_at(&fx.c, NOW).total_escrow.0;
            as_(&eve, NOW, R + B + JOB_STORAGE_DEPOSIT);
            assert!(panics(|| fx.c.submit_job("x".into(), "sha256:input".into(), String::new(), 10, 1_000, U128(R), U128(5), Some(U128(B)), None, None, None)));
            as_(&eve, NOW, 0);
            assert!(panics(|| fx.c.submit_job("x".into(), "sha256:input".into(), String::new(), 10, 1_000, U128(R), U128(5), Some(U128(B)), None, None, None)));
            assert_eq!(credit_at(&fx.c, NOW, &eve), balance, "nothing was charged");
            assert_eq!(stats_at(&fx.c, NOW).total_escrow.0, escrow);
            assert_eq!(stats_at(&fx.c, NOW).submitted, 0);

            // Only the operator approves; an approved account submits; a removed one cannot, its queued job stays.
            as_(&fx.owner, NOW, R);
            assert!(panics(|| fx.c.allow_clients(vec![eve.clone()])), "the owner cannot approve");
            as_(&fx.operator, NOW, 0);
            assert!(panics(|| fx.c.allow_clients(vec![eve.clone()])), "the entry's storage must be attached");
            allow(&mut fx, NOW, std::slice::from_ref(&eve));
            assert!(has_log("\"event\":\"clients_allowed\""));
            let e = submit_at(&mut fx.c, &eve, NOW, "E", 10, 1_000, R, B, 5);
            as_(&fx.alice, NOW, 0);
            assert!(panics(|| fx.c.remove_client(eve.clone())), "only the operator removes");
            as_(&fx.operator, NOW, 0);
            fx.c.remove_client(eve.clone());
            assert!(panics(|| fx.c.remove_client(eve.clone())), "removed once");
            as_(&eve, NOW, R + B + JOB_STORAGE_DEPOSIT);
            assert!(panics(|| fx.c.submit_job("y".into(), "sha256:other".into(), String::new(), 10, 1_000, U128(R), U128(5), Some(U128(B)), None, None, None)));
            assert_eq!(view(&fx.c, NOW, e).status, JobStatus::Queued);
        }

        // ---- the stake stays while jobs are open ----

        #[test]
        fn the_stake_cannot_be_withdrawn_while_a_job_is_queued_or_running() {
            let mut fx = setup();
            staked(&mut fx, NOW, STAKE, R);
            as_(&fx.operator, NOW, 0);
            fx.c.request_unstake(U128(STAKE));
            // Just before the unstake matures the operator is still taking work.
            let ready = NOW + 86_400;
            as_(&fx.operator, ready - 5, 0);
            fx.c.heartbeat();
            let a = submit_at(&mut fx.c, &fx.alice, ready - 5, "A", 10, 60, R, B, 5);
            assert!(view(&fx.c, ready - 5, a).promised);
            as_(&fx.operator, ready, 0);
            assert!(panics(|| fx.c.withdraw_unstaked()), "queued job");
            as_(&fx.operator, ready, 0);
            fx.c.start_next();
            as_(&fx.operator, ready + 1, 0);
            assert!(panics(|| fx.c.withdraw_unstaked()), "running job");
            assert_eq!(config_at(&fx.c, ready + 1).operator_stake.0, STAKE, "the whole stake is still there");
            // The job runs out its deadline: its owner is paid from the stake, and only then may the rest leave.
            as_(&fx.alice, ready + 200, 0);
            fx.c.claim_timeout(a);
            assert_eq!(view(&fx.c, ready + 200, a).penalty_paid.0, R);
            as_(&fx.operator, ready + 201, 0);
            assert_eq!(fx.c.withdraw_unstaked().0, STAKE - R);
        }

        #[test]
        fn the_operator_cannot_be_replaced_while_a_job_is_open() {
            let mut fx = setup();
            staked(&mut fx, NOW, STAKE, R);
            as_(&fx.owner, NOW, 0);
            let p = fx.c.propose(Proposal::SetOperator { account_id: fx.bob.clone() });
            let ready = NOW + 86_400;
            as_(&fx.operator, ready - 5, 0);
            fx.c.heartbeat();
            let a = submit_at(&mut fx.c, &fx.alice, ready - 5, "A", 10, 60, R, B, 5);
            // Checked when it runs, not when it was proposed; a refusal leaves the proposal queued.
            as_(&fx.carol, ready, 0);
            assert!(panics(|| fx.c.execute_proposal(p.id)));
            assert_eq!(fx.c.get_proposals().len(), 1);
            assert_eq!(config_at(&fx.c, ready).operator_stake.0, STAKE);
            as_(&fx.operator, ready, 0);
            fx.c.start_next();
            as_(&fx.operator, ready + 10, 0);
            fx.c.complete_job(a, "artifact".into());
            as_(&fx.carol, ready + 11, 0);
            fx.c.execute_proposal(p.id);
            assert_eq!(config_at(&fx.c, ready + 11).operator_id, fx.bob);
            assert_eq!(credit_at(&fx.c, ready + 11, &fx.operator), STAKE);
        }

        #[test]
        fn owner_changes_wait_out_the_timelock_and_anyone_can_run_them() {
            let mut fx = setup();
            as_(&fx.alice, NOW, 0);
            assert!(panics(|| fx.c.propose(Proposal::SetFeeBps { fee_bps: 50 })));
            as_(&fx.owner, NOW, 0);
            assert!(panics(|| fx.c.propose(Proposal::SetFeeBps { fee_bps: MAX_FEE_BPS + 1 })), "validated when proposed");
            let p = fx.c.propose(Proposal::SetFeeBps { fee_bps: 50 });
            assert_eq!(p.executable_at, NOW + 86_400);
            assert!(has_log("\"event\":\"proposal_queued\""));
            assert_eq!(fx.c.get_proposals().len(), 1);

            as_(&fx.bob, NOW + 86_399, 0);
            assert!(panics(|| fx.c.execute_proposal(p.id)));
            as_(&fx.bob, NOW + 86_400, 0);
            fx.c.execute_proposal(p.id);
            assert_eq!(config_at(&fx.c, NOW + 86_400).fee_bps, 50);
            assert!(fx.c.get_proposals().is_empty());
            as_(&fx.bob, NOW + 86_401, 0);
            assert!(panics(|| fx.c.execute_proposal(p.id)), "runs once");
        }

        #[test]
        fn the_owner_can_cancel_a_proposal_before_it_runs() {
            let mut fx = setup();
            as_(&fx.owner, NOW, 0);
            let p = fx.c.propose(Proposal::SetTreasury { account_id: acct("mallory") });
            as_(&fx.alice, NOW, 0);
            assert!(panics(|| fx.c.cancel_proposal(p.id)));
            as_(&fx.owner, NOW + 10, 0);
            fx.c.cancel_proposal(p.id);
            as_(&fx.bob, NOW + 86_400, 0);
            assert!(panics(|| fx.c.execute_proposal(p.id)));
            assert_eq!(config_at(&fx.c, NOW + 86_400).treasury_id, fx.treasury);
        }

        #[test]
        fn the_timelock_has_a_floor() {
            as_(&acct("owner"), NOW, 0);
            assert!(panics(|| Contract::new(acct("owner"), acct("operator"), acct("treasury"), 100, Some(MIN_TIMELOCK_SECS - 1), None, None, None)));
            let c = Contract::new(acct("owner"), acct("operator"), acct("treasury"), 100, Some(MIN_TIMELOCK_SECS), None, None, None);
            assert_eq!(c.get_config().timelock_secs, MIN_TIMELOCK_SECS);
        }

        #[test]
        fn model_keys_can_be_pinned_at_deploy_and_are_validated() {
            let a = attest_fx();
            let signer = fs(&a, "signer");
            as_(&acct("owner"), NOW, 0);
            let c = Contract::new(acct("owner"), acct("operator"), acct("treasury"), 100, None, None, Some(vec![format!("0x{}", signer.to_uppercase())]), Some("model-x".into()));
            assert_eq!(c.get_config().tee_signers, vec![signer.to_lowercase()]);
            assert_eq!(c.get_tee_model(), Some("model-x".to_string()));
            assert!(panics(|| Contract::new(acct("owner"), acct("operator"), acct("treasury"), 100, None, None, Some(vec!["abc".into()]), None)));
            assert!(panics(|| Contract::new(acct("owner"), acct("operator"), acct("treasury"), 100, None, None, None, Some(String::new()))));
        }

        #[test]
        fn pause_is_immediate_stops_new_work_and_lets_the_queue_drain() {
            let mut fx = setup();
            let a = submit_at(&mut fx.c, &fx.alice, NOW, "A", 10, 1_000, R, B, 5);
            let b = submit_at(&mut fx.c, &fx.bob, NOW, "B", 10, 1_000, R, B, 5);
            as_(&fx.alice, NOW, 0);
            assert!(panics(|| fx.c.set_paused(true)));
            as_(&fx.owner, NOW, 0);
            fx.c.set_paused(true);
            assert!(panics(|| submit_at(&mut fx.c, &fx.carol, NOW, "C", 10, 1_000, R, B, 5)));
            as_(&fx.operator, NOW, 0);
            assert_eq!(fx.c.start_next(), a);
            as_(&fx.operator, NOW + 10, 0);
            fx.c.complete_job(a, "artifact".into());
            as_(&fx.bob, NOW + 10, 0);
            fx.c.cancel_job(b);
        }

        #[test]
        fn a_new_operator_does_not_inherit_the_old_operators_stake() {
            let mut fx = setup();
            staked(&mut fx, NOW, STAKE, 0);
            as_(&fx.operator, NOW, 0);
            fx.c.request_unstake(U128(R));
            as_(&fx.owner, NOW, 0);
            let p = fx.c.propose(Proposal::SetOperator { account_id: fx.owner.clone() });
            as_(&fx.bob, NOW + 86_400, 0);
            fx.c.execute_proposal(p.id);
            assert!(has_log("\"event\":\"stake_returned\""));
            let cfg = config_at(&fx.c, NOW + 86_400);
            assert_eq!(cfg.operator_id, fx.owner);
            assert_eq!(cfg.operator_stake.0, 0);
            assert_eq!(cfg.unstake_pending, None);
            assert_eq!(credit_at(&fx.c, NOW + 86_400, &fx.operator), STAKE);
            as_(&fx.owner, NOW + 86_400, 0);
            assert!(panics(|| fx.c.withdraw_unstaked()));
        }

        fn as_with_input(signer: &AccountId, secs: u64, input: Vec<u8>) {
            let mut b = VMContextBuilder::new();
            b.current_account_id(acct("queue"))
                .signer_account_id(signer.clone())
                .predecessor_account_id(signer.clone())
                .block_timestamp(secs * NS_PER_SEC)
                .account_balance(NearToken::from_near(10_000));
            b.context.input = input.into();
            testing_env!(b.build());
        }

        #[test]
        fn an_upgrade_deploys_only_the_proposed_code_after_the_timelock() {
            let mut fx = setup();
            let code = b"\0asm-new-version".to_vec();
            let hash = hex(&env::sha256(&code));
            as_(&fx.owner, NOW, 0);
            assert!(panics(|| fx.c.propose(Proposal::Upgrade { code_sha256: "nothex".into() })));
            let p = fx.c.propose(Proposal::Upgrade { code_sha256: hash.clone() });
            as_(&fx.bob, NOW + 86_400, 0);
            assert!(panics(|| fx.c.execute_proposal(p.id)), "an upgrade needs the code itself");

            as_with_input(&fx.bob, NOW + 86_399, code.clone());
            assert!(panics(|| fx.c.execute_upgrade()), "still timelocked");
            as_with_input(&fx.bob, NOW + 86_400, b"\0asm-other".to_vec());
            assert!(panics(|| fx.c.execute_upgrade()), "different code");
            as_with_input(&fx.bob, NOW + 86_400, code.clone());
            let _ = fx.c.execute_upgrade();
            let actions: Vec<MockAction> = get_created_receipts().into_iter().flat_map(|r| r.actions).collect();
            assert!(actions.iter().any(|a| matches!(a, MockAction::DeployContract { code: c, .. } if *c == code)));
            assert!(actions.iter().any(|a| matches!(a, MockAction::FunctionCallWeight { method_name, .. } if method_name == b"migrate")));
            assert!(fx.c.get_proposals().is_empty());
        }
    }

    // -- property-based invariants ------------------------------------------
    //
    // Random sequences of valid actions (submit, buy priority, start, complete, cancel, time out, withdraw,
    // deposit, change ask, wait). After every step the invariants below must hold. Each case runs in its own
    // thread because the mocked chain's storage is thread-local.

    mod invariants {
        use super::*;
        use proptest::prelude::*;
        use std::collections::HashMap;

        #[derive(Clone, Debug)]
        enum Act {
            Submit { who: usize, dur: u32, slack: u32, tight: Option<u32>, ask: u128, from_balance: bool },
            Buy { pick: usize, cutoff: u64, slot: Option<usize> },
            Probe { who: usize, buyer: usize, dur: u32, need: u32, ahead: usize, edge: u32, buyer_edge: Option<u32>, ask: u128 },
            Start,
            Complete { extra: u64 },
            Cancel { pick: usize },
            SetAsk { pick: usize, ask: u128 },
            Timeout { pick: usize },
            Withdraw { who: usize },
            Deposit { who: usize, amount: u128 },
            Wait { secs: u64 },
            // v3
            Stake { amount: u128 },
            Unstake { amount: u128 },
            WithdrawUnstaked,
            Heartbeat,
            Reject { pick: usize },
            Release { pick: usize, by_owner: bool },
        }

        fn act() -> impl Strategy<Value = Act> {
            prop_oneof![
                // `tight` puts the deadline a little past the job's own place in line, so that later jumps land
                // within seconds of its safety margin; otherwise the deadline is measured from now.
                5 => (0usize..4, 1u32..40, 0u32..240, proptest::option::of(0u32..48), 0u128..5_000, any::<bool>())
                    .prop_map(|(who, dur, slack, tight, ask, from_balance)| Act::Submit { who, dur, slack, tight, ask, from_balance }),
                // Half the purchases aim at a slot that exists (the start of a job ahead), so most of them move someone.
                5 => (0usize..16, 0u64..90, proptest::option::of(0usize..16)).prop_map(|(pick, cutoff, slot)| Act::Buy { pick, cutoff, slot }),
                // A jump built to land within two seconds of a margin: see `Act::Probe` in `step`.
                3 => (0usize..4, 0usize..4, 1u32..40, 1u32..40, 0usize..4, 0u32..5, proptest::option::of(0u32..5), 0u128..5_000)
                    .prop_map(|(who, buyer, dur, need, ahead, edge, buyer_edge, ask)| Act::Probe { who, buyer, dur, need, ahead, edge, buyer_edge, ask }),
                3 => Just(Act::Start),
                // Mostly on time or a few seconds over; one in four well past the deadline.
                3 => prop_oneof![3 => 0u64..6, 1 => 0u64..120].prop_map(|extra| Act::Complete { extra }),
                1 => (0usize..16).prop_map(|pick| Act::Cancel { pick }),
                1 => (0usize..16, 0u128..5_000).prop_map(|(pick, ask)| Act::SetAsk { pick, ask }),
                1 => (0usize..16).prop_map(|pick| Act::Timeout { pick }),
                1 => (0usize..4).prop_map(|who| Act::Withdraw { who }),
                1 => (0usize..4, 1u128..200_000).prop_map(|(who, amount)| Act::Deposit { who, amount }),
                2 => (0u64..25).prop_map(|secs| Act::Wait { secs }),
                1 => (1u128..3 * R).prop_map(|amount| Act::Stake { amount }),
                1 => (1u128..3 * R).prop_map(|amount| Act::Unstake { amount }),
                1 => Just(Act::WithdrawUnstaked),
                1 => Just(Act::Heartbeat),
                1 => (0usize..16).prop_map(|pick| Act::Reject { pick }),
                2 => (0usize..64, any::<bool>()).prop_map(|(pick, by_owner)| Act::Release { pick, by_owner }),
            ]
        }

        struct World {
            c: Contract,
            people: Vec<AccountId>,
            everyone: Vec<AccountId>,
            operator: AccountId,
            treasury: AccountId,
            now: u64,
            running: Option<u64>,
            money_in: u128,
            money_out: u128,
            retained: u128,
            all_ids: Vec<u64>,
            released: Vec<u64>,
            stake_in: u128,
            stake_out: u128,
            /// Bytes of contract storage added, less bytes freed, over the whole history.
            bytes: i128,
        }

        impl World {
            fn new() -> Self {
                let fx = setup_with_fee(100);
                // v3 world: a 60 s timelock (so unstakes can land inside a history) and a minimum stake of R, posted
                // twice over, so broken promises, rejections and an under-staked operator all happen.
                as_(&fx.owner, NOW, 0);
                let c = Contract::new(fx.owner.clone(), fx.operator.clone(), fx.treasury.clone(), 100, Some(MIN_TIMELOCK_SECS), Some(U128(R)), None, None);
                let people = vec![fx.alice.clone(), fx.bob.clone(), fx.carol.clone(), fx.dave.clone()];
                let mut c = c;
                as_(&fx.operator, NOW, 1_000 * BYTE);
                c.allow_clients(people.clone());
                let mut everyone = people.clone();
                everyone.extend([fx.owner.clone(), fx.operator.clone(), fx.treasury.clone()]);
                let mut w = World { c, people, everyone, operator: fx.operator, treasury: fx.treasury, now: NOW, running: None, money_in: 0, money_out: 0, retained: 0, all_ids: vec![], released: vec![], stake_in: 0, stake_out: 0, bytes: 0 };
                w.step(&Act::Stake { amount: 2 * R });
                w
            }

            fn accepting(&self) -> bool {
                as_(&acct("viewer"), self.now, 0);
                self.c.get_config().accepting_work
            }

            /// Ending a job: a promised job is paid `priority_spend + reward` from the stake (as far as it goes),
            /// an unpromised one nothing; the owner's balance moves by exactly that.
            fn expect_penalty(&mut self, before: &JobView, stake_before: u128, credit_before: u128) {
                as_(&acct("viewer"), self.now, 0);
                let after = self.c.get_job(before.id);
                if !matches!(after.status, JobStatus::Missed | JobStatus::Failed) {
                    assert_eq!(after.penalty_paid.0, 0, "job {} ended {:?} yet was paid a penalty", after.id, after.status);
                    return;
                }
                let owed = if before.promised { before.priority_spend.0 + before.reward.0 } else { 0 };
                let paid = owed.min(stake_before);
                assert_eq!(after.penalty_paid.0, paid, "job {} (promised: {}) was paid the wrong penalty", after.id, before.promised);
                assert_eq!(self.c.get_credit(after.owner.clone()).0, credit_before + paid, "job {} owner credit is off", after.id);
            }

            fn stake_now(&self) -> u128 {
                as_(&acct("viewer"), self.now, 0);
                self.c.get_config().operator_stake.0
            }

            /// Run one call as `who` with `deposit` attached, then book the money that moved.
            fn call<T>(&mut self, who: &AccountId, deposit: u128, f: impl FnOnce(&mut Contract) -> T) -> T {
                as_(who, self.now, deposit);
                let before = env::storage_usage();
                let out = f(&mut self.c);
                self.bytes += env::storage_usage() as i128 - before as i128;
                self.money_in += deposit;
                self.money_out += transfers().into_iter().map(|(_, amount)| amount).sum::<u128>();
                out
            }

            fn credit(&self, who: &AccountId) -> u128 {
                as_(&acct("viewer"), self.now, 0);
                self.c.get_credit(who.clone()).0
            }

            fn queue(&self) -> Vec<JobView> {
                as_(&acct("viewer"), self.now, 0);
                self.c.get_queue()
            }

            fn check(&mut self, after: &str) {
                as_(&acct("viewer"), self.now, 0);
                let stats = self.c.get_stats();
                let queue = self.c.get_queue();
                // Escrow is exactly reward + bond of every queued or running job.
                let mut escrow: u128 = queue.iter().map(|j| j.reward.0 + j.bond.0).sum();
                if let Some(id) = self.running {
                    let j = self.c.get_job(id);
                    assert_eq!(j.status, JobStatus::Running, "after {after}: tracked running job is {:?}", j.status);
                    escrow += j.reward.0 + j.bond.0;
                }
                assert_eq!(stats.total_escrow.0, escrow, "after {after}: escrow does not match the open jobs");
                // Credits are exactly the sum of every balance.
                let credits: u128 = self.everyone.iter().map(|a| self.c.get_credit(a.clone()).0).sum();
                assert_eq!(stats.total_credits.0, credits, "after {after}: credit total does not match the balances");
                // The stake is what was posted, less what was withdrawn and what was paid out to users.
                assert_eq!(stats.operator_stake.0 + self.stake_out + stats.total_penalties.0, self.stake_in, "after {after}: stake does not add up");
                // The contract never pays out more than it took in. What it holds beyond escrow, balances and stake is
                // storage: deposits still refundable (`storage_held`) plus what it keeps for good, which only grows.
                let held = escrow + credits + stats.operator_stake.0 + self.money_out;
                assert!(self.money_in >= held, "after {after}: paid out or owes more than it received");
                let retained = self.money_in - held;
                assert!(retained >= stats.storage_held.0, "after {after}: refundable storage is not covered");
                let kept = retained - stats.storage_held.0;
                assert!(kept >= self.retained, "after {after}: kept storage went down ({} -> {kept})", self.retained);
                self.retained = kept;
                // Storage is paid for: every byte the contract holds is covered by a deposit still held for its
                // record or by money kept for good. The only bytes nobody deposited for are balance keys created by
                // a payout from the stake or a returned stake: at most one per account.
                let funded = stats.storage_held.0 + kept;
                let unpaid_keys = self.everyone.len() as u128 * 125 * BYTE;
                let cost = self.bytes.max(0) as u128 * BYTE;
                assert!(cost <= funded + unpaid_keys, "after {after}: {} bytes in storage cost {cost}, deposits cover {funded}", self.bytes);
                // Every job is in exactly one state.
                assert_eq!(
                    stats.submitted,
                    stats.completed + stats.missed + stats.cancelled + stats.failed + stats.rejected + stats.queued as u64 + stats.running as u64,
                    "after {after}: job counters do not add up"
                );
                assert_eq!(stats.released as usize, self.released.len(), "after {after}: release count is off");
                assert_eq!(stats.queued as usize, queue.len());
                assert_eq!(stats.running as usize, usize::from(self.running.is_some()));
                // The queue is one contiguous schedule in position order.
                for (i, j) in queue.iter().enumerate() {
                    assert_eq!(j.position as usize, i + 1, "after {after}: positions are not 1..n");
                    assert_eq!(j.projected_finish_at, j.projected_start_at + j.duration_secs as u64);
                    if i > 0 {
                        assert_eq!(j.projected_start_at, queue[i - 1].projected_finish_at, "after {after}: schedule has a gap or overlap");
                    }
                }
            }

            /// Submit one job if the contract would accept it; says whether it joined the queue.
            fn submit(&mut self, who: usize, dur: u32, deadline: u32, ask: u128, from_balance: bool) -> bool {
                let who = self.people[who].clone();
                as_(&acct("viewer"), self.now, 0);
                if self.c.get_queue().len() >= MAX_QUEUE || !self.c.get_admission(dur, deadline).feasible_at_front {
                    return false;
                }
                let need = R + B + JOB_STORAGE_DEPOSIT;
                if !self.accepting() {
                    // No live, staked operator: refused before anything is charged.
                    as_(&who, self.now, need);
                    assert!(panics(|| self.c.submit_job("job".into(), "h".into(), "".into(), dur, deadline, U128(R), U128(ask), None, None, None, None)));
                    return false;
                }
                let id = if from_balance && self.credit(&who) >= need {
                    self.call(&who, 0, |c| c.submit_job("job".into(), "h".into(), "".into(), dur, deadline, U128(R), U128(ask), Some(U128(B)), None, None, None))
                } else {
                    self.call(&who, need, |c| c.submit_job("job".into(), "h".into(), "".into(), dur, deadline, U128(R), U128(ask), None, None, None, None))
                };
                self.all_ids.push(id);
                true
            }

            fn step(&mut self, a: &Act) {
                match a.clone() {
                    Act::Wait { secs } => self.now += secs,
                    Act::Submit { who, dur, slack, tight, ask, from_balance } => {
                        as_(&acct("viewer"), self.now, 0);
                        let deadline = match tight {
                            Some(extra) => (self.c.get_admission(dur, u32::MAX).finish_at_back - self.now) as u32 + extra,
                            None => dur + COMPLETE_MARGIN_SECS as u32 + slack,
                        };
                        self.submit(who, dur, deadline, ask, from_balance);
                    }
                    Act::Probe { who, buyer, dur, need, ahead, edge, buyer_edge, ask } => {
                        // Random deadlines seldom land on a margin, so build the case: a job joins the back
                        // with a deadline within two seconds of what it needs to be passed by the next job,
                        // and that job asks for a slot up to three places ahead of it, where the margin is one
                        // second wider per hand-off. Half the time the buyer's own deadline sits on its margin.
                        let before = self.queue();
                        let ahead = ahead.min(before.len());
                        as_(&acct("viewer"), self.now, 0);
                        let back_finish = self.c.get_admission(dur, u32::MAX).finish_at_back;
                        let slot_start = if ahead == 0 { back_finish - dur as u64 } else { before[before.len() - ahead].projected_start_at };
                        let margin = DEADLINE_MARGIN_SECS + MARGIN_PER_HANDOFF_SECS * ahead as u64;
                        let passed_deadline = back_finish + need as u64 + margin + edge as u64 - 2 - self.now;
                        if !self.submit(who, dur, passed_deadline as u32, ask, false) {
                            return;
                        }
                        let buyer_deadline = match buyer_edge {
                            Some(e) => slot_start + need as u64 + DEADLINE_MARGIN_SECS + e as u64 - 2 - self.now,
                            None => back_finish + need as u64 + 240 - self.now,
                        };
                        if !self.submit(buyer, need, buyer_deadline as u32, 0, false) {
                            return;
                        }
                        let at = before.len() + 1;
                        self.step(&Act::Buy { pick: at, cutoff: 0, slot: Some(at - 1 - ahead) });
                    }
                    Act::Buy { pick, cutoff, slot } => {
                        let before = self.queue();
                        if before.len() < 2 {
                            return;
                        }
                        let at = pick % before.len();
                        let job = before[at].clone();
                        let latest = match slot {
                            Some(slot) if at > 0 => before[slot % at].projected_start_at + cutoff % 3,
                            _ => self.now + cutoff,
                        };
                        as_(&acct("viewer"), self.now, 0);
                        let q = self.c.quote_priority(job.id, latest);
                        // An independent reading of the rule, from the public queue alone: the slot is the latest
                        // one at or ahead of the buyer that meets its cutoff and its own deadline with the margin;
                        // the jump is refused only if a job it would pass ends inside that job's margin.
                        let need = job.duration_secs as u64;
                        let slot_fits = |j: &JobView| j.projected_start_at <= latest && j.projected_start_at + need + DEADLINE_MARGIN_SECS <= job.deadline_at;
                        let best = (0..=at).rev().find(|i| slot_fits(&before[*i]));
                        // v3: a job already projected to miss cannot block the jump.
                        let doomed = |k: usize| before[k].projected_finish_at + COMPLETE_MARGIN_SECS > before[k].deadline_at;
                        let breaks = |i: usize| (i..at).any(|k| !doomed(k) && before[k].projected_finish_at + need + DEADLINE_MARGIN_SECS + MARGIN_PER_HANDOFF_SECS * (k - i) as u64 > before[k].deadline_at);
                        match best {
                            None => assert!(!q.feasible && !q.reason.starts_with("displaced job"), "no slot fits, yet the quote says: {}", q.reason),
                            Some(i) if breaks(i) => assert!(!q.feasible && q.reason.starts_with("displaced job"), "a passed job would be late, yet the quote says: {}", q.reason),
                            Some(i) => {
                                assert!(q.feasible, "a safe slot exists, yet the quote refuses: {}", q.reason);
                                assert_eq!(q.insert_index as usize, i, "the quote chose a different slot");
                            }
                        }
                        if !q.feasible {
                            assert!(!q.reason.is_empty(), "an infeasible quote must say why");
                            return;
                        }
                        if q.displaced.is_empty() {
                            return;
                        }
                        // What every balance should gain: each passed job's own ask x the buyer's duration, plus the fee.
                        let mut expect: HashMap<AccountId, u128> = HashMap::new();
                        for d in &q.displaced {
                            let passed = before.iter().find(|j| j.id == d.job_id).unwrap();
                            assert_eq!(d.amount.0, passed.ask_per_sec.0 * job.duration_secs as u128, "compensation is ask x duration");
                            *expect.entry(d.owner.clone()).or_default() += d.amount.0;
                        }
                        assert_eq!(q.fee.0, q.compensation.0 * 100 / 10_000, "fee is 1% of compensation, rounded down");
                        *expect.entry(self.treasury.clone()).or_default() += q.fee.0;
                        let credit_before: HashMap<AccountId, u128> = self.everyone.iter().map(|a| (a.clone(), self.credit(a))).collect();
                        // On schedule = the contract would still start it (2 s start margin). v3 protects exactly these.
                        let on_time_before: Vec<u64> = before.iter().filter(|j| j.projected_finish_at + COMPLETE_MARGIN_SECS <= j.deadline_at).map(|j| j.id).collect();

                        let attached = q.total.0 + priority_storage_deposit(q.displaced.len());
                        let owner = job.owner.clone();
                        if !self.accepting() {
                            as_(&owner, self.now, attached);
                            assert!(panics(|| self.c.request_priority(job.id, latest, U128(q.total.0))));
                            return;
                        }
                        self.call(&owner, attached, |c| c.request_priority(job.id, latest, U128(q.total.0)));
                        // The buyer now holds a promise.
                        as_(&acct("viewer"), self.now, 0);
                        assert!(self.c.get_job(job.id).promised, "a buyer must hold a promise");

                        let after = self.queue();
                        // Nobody else changes place relative to each other.
                        let rest = |v: &[JobView]| v.iter().map(|j| j.id).filter(|id| *id != job.id).collect::<Vec<_>>();
                        assert_eq!(rest(&before), rest(&after), "a purchase reordered jobs other than the buyer");
                        // Deadline safety: every passed job still finishes before its deadline, with the margin.
                        for (k, d) in q.displaced.iter().enumerate() {
                            let j = after.iter().find(|j| j.id == d.job_id).unwrap();
                            assert_eq!(j.projected_finish_at, d.new_finish_at, "the quote and the queue disagree");
                            let was = before.iter().find(|b| b.id == d.job_id).unwrap();
                            if !on_time_before.contains(&was.id) {
                                continue; // v3: already projected to miss, so not protected (still paid, checked above)
                            }
                            let margin = DEADLINE_MARGIN_SECS + MARGIN_PER_HANDOFF_SECS * k as u64;
                            assert!(j.projected_finish_at + margin <= j.deadline_at, "job {} was moved inside its safety margin", j.id);
                        }
                        // No job that was on time by the schedule is made late by the purchase.
                        for id in on_time_before {
                            let j = after.iter().find(|j| j.id == id).unwrap();
                            assert!(j.projected_finish_at <= j.deadline_at, "job {id} was on time before the purchase and is late after it");
                        }
                        // The buyer got the slot it paid for, and can keep it.
                        let me = after.iter().find(|j| j.id == job.id).unwrap();
                        assert!(me.projected_start_at <= latest && me.projected_finish_at + DEADLINE_MARGIN_SECS <= me.deadline_at);
                        assert!(me.expedited);
                        // Everybody was paid exactly what the quote said, and nobody else's balance moved.
                        for a in self.everyone.clone() {
                            let gained = self.credit(&a) - credit_before[&a];
                            assert_eq!(gained, expect.get(&a).copied().unwrap_or(0), "{a} balance moved by the wrong amount");
                        }
                    }
                    Act::Start => {
                        if self.running.is_some() || self.queue().is_empty() {
                            return;
                        }
                        let operator = self.operator.clone();
                        let head = self.queue()[0].clone();
                        let (stake, credit) = (self.stake_now(), self.credit(&head.owner));
                        let id = self.call(&operator, 0, |c| c.start_next());
                        assert_eq!(id, head.id);
                        self.expect_penalty(&head, stake, credit);
                        as_(&acct("viewer"), self.now, 0);
                        let j = self.c.get_job(id);
                        match j.status {
                            JobStatus::Running => {
                                assert!(self.now + j.duration_secs as u64 + COMPLETE_MARGIN_SECS <= j.deadline_at, "started a job that cannot finish in time");
                                self.running = Some(id);
                            }
                            JobStatus::Missed => {}
                            other => panic!("start_next left job {id} as {other:?}"),
                        }
                    }
                    Act::Complete { extra } => {
                        let Some(id) = self.running else { return };
                        as_(&acct("viewer"), self.now, 0);
                        let j = self.c.get_job(id);
                        self.now = self.now.max(j.started_at.unwrap() + j.duration_secs as u64) + extra;
                        let operator = self.operator.clone();
                        let before = self.c.get_job(id);
                        let (stake, credit) = (self.stake_now(), self.credit(&before.owner));
                        self.call(&operator, 0, |c| c.complete_job(id, "artifact".into()));
                        self.expect_penalty(&before, stake, credit);
                        self.running = None;
                        as_(&acct("viewer"), self.now, 0);
                        let done = self.c.get_job(id);
                        // A late delivery is never paid as delivered.
                        assert_eq!(done.status == JobStatus::Done, self.now <= done.deadline_at);
                    }
                    Act::Cancel { pick } => {
                        let q = self.queue();
                        if q.is_empty() {
                            return;
                        }
                        let j = q[pick % q.len()].clone();
                        self.call(&j.owner, 0, |c| c.cancel_job(j.id));
                    }
                    Act::SetAsk { pick, ask } => {
                        let q = self.queue();
                        if q.is_empty() {
                            return;
                        }
                        let j = q[pick % q.len()].clone();
                        self.call(&j.owner, 0, |c| c.set_move_ask(j.id, U128(ask)));
                    }
                    Act::Timeout { pick } => {
                        let mut late: Vec<JobView> = self.queue().into_iter().filter(|j| j.deadline_at < self.now).collect();
                        if let Some(id) = self.running {
                            as_(&acct("viewer"), self.now, 0);
                            let j = self.c.get_job(id);
                            if j.deadline_at < self.now {
                                late.push(j);
                            }
                        }
                        if late.is_empty() {
                            return;
                        }
                        let j = late[pick % late.len()].clone();
                        let anyone = self.people[pick % 4].clone();
                        let (stake, credit) = (self.stake_now(), self.credit(&j.owner));
                        self.call(&anyone, 0, |c| c.claim_timeout(j.id));
                        self.expect_penalty(&j, stake, credit);
                        if self.running == Some(j.id) {
                            self.running = None;
                        }
                    }
                    Act::Withdraw { who } => {
                        let who = self.people[who].clone();
                        let credit = self.credit(&who);
                        if credit == 0 {
                            return;
                        }
                        let paid = self.call(&who, 0, |c| c.withdraw_credit());
                        assert_eq!(paid.0, credit);
                        assert_eq!(self.credit(&who), 0);
                    }
                    Act::Deposit { who, amount } => {
                        let who = self.people[who].clone();
                        let before = self.credit(&who);
                        self.call(&who, amount + BALANCE_STORAGE_DEPOSIT, |c| c.deposit());
                        assert!(self.credit(&who) >= before + amount);
                    }
                    Act::Stake { amount } => {
                        let operator = self.operator.clone();
                        self.call(&operator, amount, |c| c.stake());
                        self.stake_in += amount;
                    }
                    Act::Unstake { amount } => {
                        let stake = self.stake_now();
                        if stake == 0 {
                            return;
                        }
                        let operator = self.operator.clone();
                        self.call(&operator, 0, |c| c.request_unstake(U128(amount.min(stake))));
                    }
                    Act::WithdrawUnstaked => {
                        as_(&acct("viewer"), self.now, 0);
                        let Some((amount, at)) = self.c.get_config().unstake_pending else { return };
                        let operator = self.operator.clone();
                        if self.now < at {
                            as_(&operator, self.now, 0);
                            assert!(panics(|| self.c.withdraw_unstaked()), "an unstake left before its timelock");
                            return;
                        }
                        if !self.queue().is_empty() || self.running.is_some() {
                            as_(&operator, self.now, 0);
                            assert!(panics(|| self.c.withdraw_unstaked()), "stake left while a job was open");
                            return;
                        }
                        let stake = self.stake_now();
                        let out = self.call(&operator, 0, |c| c.withdraw_unstaked());
                        assert_eq!(out.0, amount.0.min(stake), "an unstake paid more than requested or than is left");
                        self.stake_out += out.0;
                    }
                    Act::Heartbeat => {
                        let operator = self.operator.clone();
                        self.call(&operator, 0, |c| c.heartbeat());
                        assert!(self.stake_now() < R || self.accepting(), "a staked operator that just called must be accepting work");
                    }
                    Act::Reject { pick } => {
                        let q = self.queue();
                        if q.is_empty() {
                            return;
                        }
                        let j = q[pick % q.len()].clone();
                        let (stake, credit) = (self.stake_now(), self.credit(&j.owner));
                        let operator = self.operator.clone();
                        self.call(&operator, 0, |c| c.reject_job(j.id, "unsupported".into()));
                        self.released.push(j.id);
                        // Reward and bond go back natively; the priority spend (as far as the stake goes) and the freed
                        // storage come back as credit.
                        let back = j.priority_spend.0.min(stake);
                        assert_eq!(self.stake_now(), stake - back);
                        let gained = self.credit(&j.owner) - credit;
                        assert!(gained >= back && gained <= back + JOB_STORAGE_DEPOSIT + MAX_PURCHASES_PER_JOB as u128 * priority_storage_deposit(MAX_QUEUE), "reject credited {gained}");
                        as_(&acct("viewer"), self.now, 0);
                        assert!(panics(|| self.c.get_job(j.id)), "a rejected job's record is released");
                    }
                    Act::Release { pick, by_owner } => {
                        if self.all_ids.is_empty() {
                            return;
                        }
                        let id = self.all_ids[pick % self.all_ids.len()];
                        if self.released.contains(&id) {
                            as_(&acct("viewer"), self.now, 0);
                            assert!(panics(|| self.c.release_job(id)), "a job was released twice");
                            return;
                        }
                        as_(&acct("viewer"), self.now, 0);
                        let j = self.c.get_job(id);
                        let caller = if by_owner { j.owner.clone() } else { self.people[(pick + 1) % 4].clone() };
                        let ended = j.finished_at.unwrap_or(j.submitted_at);
                        let allowed = matches!(j.status, JobStatus::Done | JobStatus::Missed | JobStatus::Cancelled | JobStatus::Failed)
                            && (caller == j.owner || self.now >= ended + RELEASE_AFTER_SECS);
                        if !allowed {
                            as_(&caller, self.now, 0);
                            assert!(panics(|| self.c.release_job(id)), "release of job {id} ({:?}) by {caller} should be refused", j.status);
                            return;
                        }
                        let held = self.c.get_stats().storage_held.0;
                        let credit = self.credit(&j.owner);
                        let refund = self.call(&caller, 0, |c| c.release_job(id)).0;
                        self.released.push(id);
                        as_(&acct("viewer"), self.now, 0);
                        let freed = held - self.c.get_stats().storage_held.0;
                        assert!(freed >= JOB_STORAGE_DEPOSIT, "release freed less than the job's own deposit");
                        assert!(refund <= freed, "release refunded more than was deposited");
                        // Only a balance key created for the refund may be kept back (no model jobs in this world).
                        assert!(refund + 200 * env::storage_byte_cost().as_yoctonear() >= freed, "release kept {} of the deposit", freed - refund);
                        assert_eq!(self.credit(&j.owner), credit + refund, "the refund must go to the owner");
                    }
                }
            }
        }

        proptest! {
            // 48 histories by default (about a minute); set PROPTEST_CASES for a deeper run.
            #![proptest_config(ProptestConfig { cases: 48, max_shrink_iters: 300, ..ProptestConfig::default() })]

            #[test]
            fn random_histories_keep_every_invariant(acts in proptest::collection::vec(act(), 1..90)) {
                let outcome = std::thread::spawn(move || {
                    let mut w = World::new();
                    w.check("init");
                    for (i, a) in acts.iter().enumerate() {
                        w.step(a);
                        w.check(&format!("step {i}: {a:?}"));
                    }
                })
                .join();
                prop_assert!(outcome.is_ok(), "an invariant failed or a valid action panicked (see the message above)");
            }
        }
    }

    // -- differential test: the TypeScript rules against the contract ---------
    //
    // `sim_traces.json` holds seeded random histories recorded from SimChain (scripts/season/gen-traces.ts).
    // Each history is replayed here step by step; the contract must agree on every quote, every refusal, the
    // queue order, every balance and every job status. Regenerate the file when either side's rules change.

    mod sim_parity {
        use super::*;
        use serde_json::Value;

        const TRACES: &str = include_str!("sim_traces.json");

        fn id(v: &Value) -> AccountId {
            v.as_str().unwrap().parse().unwrap()
        }
        fn yocto(v: &Value) -> u128 {
            v.as_str().unwrap().parse().unwrap()
        }

        fn check_quote(c: &Contract, t: u64, step: &Value, ctx: &str) -> QuoteView {
            as_(&acct("viewer"), t, 0);
            let q = c.quote_priority(step["job"].as_u64().unwrap(), step["latest"].as_u64().unwrap());
            let want = &step["quote"];
            assert_eq!(q.feasible, want["feasible"].as_bool().unwrap(), "{ctx}: feasibility differs ({})", q.reason);
            if q.feasible {
                assert_eq!(q.insert_index as u64, want["insert"].as_u64().unwrap(), "{ctx}: slot differs");
                assert_eq!(q.total.0, yocto(&want["total"]), "{ctx}: price differs");
                let moved = want["displaced"].as_array().unwrap();
                assert_eq!(q.displaced.len(), moved.len(), "{ctx}: displaced set differs");
                for (d, w) in q.displaced.iter().zip(moved) {
                    assert_eq!(d.job_id, w["job"].as_u64().unwrap(), "{ctx}: displaced job differs");
                    assert_eq!(d.amount.0, yocto(&w["amount"]), "{ctx}: compensation differs");
                    assert_eq!(d.new_finish_at, w["finish"].as_u64().unwrap(), "{ctx}: new finish differs");
                }
            } else {
                // Both sides must agree on whether the refusal protects another job's deadline.
                assert_eq!(q.reason.starts_with("displaced job"), want["safety"].as_bool().unwrap(), "{ctx}: refusal kind differs ({})", q.reason);
            }
            q
        }

        fn replay(trace: &Value) -> usize {
            let operator = id(&trace["operator"]);
            let treasury = id(&trace["treasury"]);
            let (reward, bond) = (yocto(&trace["reward"]), yocto(&trace["bond"]));
            as_(&acct("owner"), trace["start"].as_u64().unwrap(), 0);
            let mut c = Contract::new(acct("owner"), operator.clone(), treasury, 100, None, None, None, None);
            let steps = trace["steps"].as_array().unwrap();
            for (i, step) in steps.iter().enumerate() {
                let t = step["t"].as_u64().unwrap();
                let op = step["op"].as_str().unwrap();
                let ctx = format!("history {} step {i} ({op})", trace["seed"]);
                match op {
                    "deposit" => {
                        as_(&id(&step["who"]), t, yocto(&step["amount"]) + BALANCE_STORAGE_DEPOSIT);
                        c.deposit();
                    }
                    "submit" => {
                        let (dur, deadline) = (step["duration"].as_u64().unwrap() as u32, step["deadline"].as_u64().unwrap() as u32);
                        if step["ok"].as_bool().unwrap() {
                            as_(&id(&step["who"]), t, 0);
                            let got = c.submit_job("job".into(), format!("h{i}"), "".into(), dur, deadline, U128(reward), U128(yocto(&step["ask"])), Some(U128(bond)), None, None, None);
                            assert_eq!(got, step["job"].as_u64().unwrap(), "{ctx}: job id differs");
                        } else {
                            // The simulator refused it as hopeless; the contract must refuse it for the same reason.
                            as_(&acct("viewer"), t, 0);
                            assert!(deadline < dur || !c.get_admission(dur, deadline).feasible_at_front, "{ctx}: the simulator refused a job the contract would accept");
                        }
                    }
                    "quote" => {
                        check_quote(&c, t, step, &ctx);
                    }
                    "buy" => {
                        let q = check_quote(&c, t, step, &ctx);
                        as_(&id(&step["who"]), t, 0);
                        c.request_priority(step["job"].as_u64().unwrap(), step["latest"].as_u64().unwrap(), U128(q.total.0));
                    }
                    "start" => {
                        as_(&operator, t, 0);
                        let got = c.start_next();
                        assert_eq!(got, step["job"].as_u64().unwrap(), "{ctx}: a different job was at the head");
                    }
                    "complete" => {
                        as_(&operator, t, 0);
                        c.complete_job(step["job"].as_u64().unwrap(), "artifact".into());
                    }
                    "cancel" => {
                        as_(&id(&step["who"]), t, 0);
                        c.cancel_job(step["job"].as_u64().unwrap());
                    }
                    "ask" => {
                        as_(&id(&step["who"]), t, 0);
                        c.set_move_ask(step["job"].as_u64().unwrap(), U128(yocto(&step["ask"])));
                    }
                    "timeout" => {
                        as_(&id(&trace["agents"][0]), t, 0);
                        c.claim_timeout(step["job"].as_u64().unwrap());
                    }
                    "wait" => {}
                    other => panic!("unknown step {other}"),
                }
                // After every step the two sides hold the same state.
                let state = &step["state"];
                as_(&acct("viewer"), t, 0);
                let order: Vec<u64> = c.get_queue().into_iter().map(|j| j.id).collect();
                let want: Vec<u64> = state["order"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap()).collect();
                assert_eq!(order, want, "{ctx}: queue order differs");
                assert_eq!(c.get_stats().running == 1, !state["running"].is_null(), "{ctx}: running flag differs");
                for (who, amount) in state["credits"].as_object().unwrap() {
                    assert_eq!(c.get_credit(who.parse().unwrap()).0, yocto(amount), "{ctx}: balance of {who} differs");
                }
                for (job, status) in state["status"].as_object().unwrap() {
                    let got = serde_json::to_value(c.get_job(job.parse().unwrap()).status).unwrap();
                    assert_eq!(&got, status, "{ctx}: status of job {job} differs");
                }
            }
            steps.len()
        }

        #[test]
        fn contract_matches_the_simulator_on_recorded_histories() {
            let all: Value = serde_json::from_str(TRACES).unwrap();
            let traces = all["traces"].as_array().unwrap().clone();
            assert!(traces.len() >= 20, "expected at least 20 recorded histories");
            let mut steps = 0;
            for trace in traces {
                // The mocked chain's storage is thread-local: one fresh thread per history.
                steps += std::thread::spawn(move || replay(&trace)).join().unwrap_or_else(|_| panic!("the contract and the simulator disagree (see the message above)"));
            }
            eprintln!("sim parity: {steps} steps agreed");
        }
    }
}
