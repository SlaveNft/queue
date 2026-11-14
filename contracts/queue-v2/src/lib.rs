//! QUEUE — the queue is a market.
//!
//! One operator, one FIFO queue. A job that cannot wait may buy an earlier slot.
//! Every job it jumps moves back by exactly the urgent job's duration and is
//! paid its published per-second price. A move is refused if it would break any
//! deadline. Settlement is native NEAR: job escrow is attached at submission;
//! compensation and protocol fees are pull-payment credits.
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
pub const MAX_TITLE_CHARS: usize = 120;
pub const MAX_INPUT_HASH_LEN: usize = 128;
pub const MAX_URI_LEN: usize = 256;
pub const MAX_HASH_LEN: usize = 128;
pub const MAX_DURATION_SECS: u32 = 86_400;
pub const MAX_DEADLINE_SECS: u32 = 604_800;
pub const MAX_MOVE_RECORDS: usize = 32;
pub const NS_PER_SEC: u64 = 1_000_000_000;
/// Non-refundable deposit that pays for a job record kept on chain forever
/// (1,250 bytes at 10^19 yocto/byte). The measured cost must fit inside it.
/// v2: 1,700 bytes, so the largest terminal record (long title, 128-byte
/// hashes, a TEE attestation tag), two fresh recovery credit keys (owner and
/// operator) and the one-time "request answered" marker fit.
pub const JOB_STORAGE_DEPOSIT: u128 = 17_000_000_000_000_000_000_000;
/// Non-refundable storage deposit for one priority record ...
/// v2: 600 bytes base (measured worst case 776 bytes for 1 displaced, base + per-displaced = 900), so a 1-displaced purchase with 64-byte account ids, a
/// fresh treasury credit key and a fresh requester credit key fits.
pub const PRIORITY_STORAGE_BASE: u128 = 6_000_000_000_000_000_000_000;
/// ... plus this much per displaced job (move record + displaced entry + credit key).
pub const PRIORITY_STORAGE_PER_DISPLACED: u128 = 3_000_000_000_000_000_000_000;
/// Non-refundable storage for a new balance key created by `deposit`.
pub const BALANCE_STORAGE_DEPOSIT: u128 = 2_000_000_000_000_000_000_000;
/// Largest model response `complete_job_attested` will hash on chain.
pub const MAX_RESPONSE_BYTES: usize = 65_536;
pub const MAX_TEE_SIGNERS: usize = 16;
/// Raw storage key of the pinned model id (kept outside the borsh state so the
/// layout of deployed v2 contracts does not change).
pub const TEE_MODEL_KEY: &[u8] = b"tee_model";
/// Raw storage prefix: `ans:<request sha256>` -> job id that settled it.
pub const ANSWERED_PREFIX: &[u8] = b"ans:";
/// Raw storage prefix: `req:<request sha256>` -> the job that submitted it. Claimed at submission, so a
/// copied request hash is refused up front and cannot burn another job's attested settlement.
pub const REQUEST_CLAIM_PREFIX: &[u8] = b"req:";
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
        }
    }
}

#[near(serializers = [borsh])]
pub struct Config {
    pub owner_id: AccountId,
    pub operator_id: AccountId,
    pub treasury_id: AccountId,
    pub fee_bps: u16,
    pub paused: bool,
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
    #[init]
    pub fn new(
        owner_id: AccountId,
        operator_id: AccountId,
        treasury_id: AccountId,
        fee_bps: u16,
    ) -> Self {
        require!(
            fee_bps <= MAX_FEE_BPS,
            format!("fee_bps cannot exceed {MAX_FEE_BPS}")
        );

        Self {
            config: Config {
                owner_id,
                operator_id,
                treasury_id,
                fee_bps,
                paused: false,
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
            },
            total_escrow: 0,
            total_credits: 0,
            tee_signers: Vec::new(),
        }
    }

    // -- admin -------------------------------------------------------------

    pub fn set_operator(&mut self, account_id: AccountId) {
        self.only_owner();
        self.config.operator_id = account_id;
    }

    pub fn set_treasury(&mut self, account_id: AccountId) {
        self.only_owner();
        self.config.treasury_id = account_id;
    }

    pub fn set_fee_bps(&mut self, fee_bps: u16) {
        self.only_owner();
        require!(
            fee_bps <= MAX_FEE_BPS,
            format!("fee_bps cannot exceed {MAX_FEE_BPS}")
        );
        self.config.fee_bps = fee_bps;
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.only_owner();
        self.config.paused = paused;
    }

    /// Owner only: pin the NEAR AI TEE signing keys (32-byte ed25519, hex)
    /// after checking NEAR AI's attestation report off chain. Several keys,
    /// because a hosted model may answer from more than one TEE node.
    pub fn set_tee_signers(&mut self, signers: Vec<String>) {
        self.only_owner();
        require!(
            signers.len() <= MAX_TEE_SIGNERS,
            format!("at most {MAX_TEE_SIGNERS} signers")
        );
        let signers: Vec<String> = signers.iter().map(|k| normalize_signer(k)).collect();
        for k in signers.iter() {
            require!(
                unhex(k).len() == 32,
                "each signer must be a 32-byte ed25519 public key in hex"
            );
        }
        self.tee_signers = signers.clone();
        emit_queue_event("tee_signers_set", json!({ "signers": signers }));
    }

    /// Owner only: pin the model id the signed text must name (or clear it).
    pub fn set_tee_model(&mut self, model: Option<String>) {
        self.only_owner();
        match &model {
            Some(m) => {
                validate_bytes("model", m, 1, 128);
                env::storage_write(TEE_MODEL_KEY, m.as_bytes());
            }
            None => {
                env::storage_remove(TEE_MODEL_KEY);
            }
        }
        emit_queue_event("tee_model_set", json!({ "model": model }));
    }

    pub fn get_tee_model(&self) -> Option<String> {
        env::storage_read(TEE_MODEL_KEY).map(|b| String::from_utf8_lossy(&b).into_owned())
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

    /// Submit a job. The attached deposit is `reward + bond`; the bond is the
    /// remainder after `reward`. It is returned on success and partly or fully
    /// forfeited on cancellation.
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
    ) -> u64 {
        self.require_not_paused();
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
        // Refuse only the truly hopeless: a job that could not finish even if it bought the front slot. A job that
        // is late at the back stays welcome: buying earlier slots is what the market is for.
        {
            let now = now_secs();
            let earliest_finish = checked_add_u64(
                checked_add_u64(self.base_start(now), duration_secs as u64),
                COMPLETE_MARGIN_SECS,
            );
            require!(
                earliest_finish <= checked_add_u64(now, deadline_secs as u64),
                "this job cannot finish by its deadline even at the front of the queue"
            );
            // Opt-in, for patient agents that will not buy: refuse unless it is on time at the back as it stands.
            if require_feasible_at_back == Some(true) {
                let a = self.admission(duration_secs, deadline_secs, now);
                require!(a.feasible_at_back, "this job would not finish by its deadline at the back of the queue");
            }
        }

        let attached = env::attached_deposit().as_yoctonear();
        let reserved = checked_add_u128(reward.0, JOB_STORAGE_DEPOSIT);
        let owner = env::predecessor_account_id();
        let (bond, funded_from) = if attached == 0 {
            // Balance-funded: the agent signs with a function-call key.
            let bond = bond
                .map(|b| b.0)
                .unwrap_or_else(|| env::panic_str("bond is required when paying from balance"));
            require!(bond > 0, "bond must be > 0");
            self.credit_spend(&owner, checked_add_u128(reserved, bond));
            (bond, "balance")
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
            (bond_from_deposit, "deposit")
        };
        let storage_before = env::storage_usage();
        let now = now_secs();
        let deadline_at = checked_add_u64(now, deadline_secs as u64);

        let id = self.next_job_id;
        self.next_job_id = checked_add_u64(id, 1);

        // First submitter of a request hash owns it; the claim is paid for by this job's storage deposit.
        if let Some(request_hash) = normalize_sha256(&input_hash) {
            let claim = claim_key(&request_hash);
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
            owner: env::predecessor_account_id(),
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
        };

        self.jobs.insert(&id, &job);
        assert_storage_covered(storage_before, JOB_STORAGE_DEPOSIT);
        self.queue.push(id);
        // The storage deposit is not escrow: it stays in the contract to back
        // the job record. Escrow is exactly reward + bond.
        let escrow = checked_add_u128(reward.0, bond);
        self.total_escrow = checked_add_u128(self.total_escrow, escrow);
        self.stats.submitted = checked_add_u64(self.stats.submitted, 1);

        emit_queue_event(
            "job_submitted",
            json!({
                "job_id": id,
                "owner": job.owner,
                "title": title,
                "duration_secs": duration_secs,
                "deadline_at": deadline_at,
                "submitted_at": now,
                "reward": reward.0.to_string(),
                "bond": bond.to_string(),
                "ask_per_sec": ask_per_sec.0.to_string(),
                "position": self.queue.len(),
                "funded_from": funded_from,
            }),
        );
        self.record_activity(
            "job_submitted",
            job.owner.clone(),
            Some(id),
            None,
            escrow,
            format!(
                "Job {id} submitted with {} yocto escrow ({} reward + {} bond).",
                escrow, reward.0, bond
            ),
        );

        id
    }

    pub fn set_move_ask(&mut self, job_id: u64, ask_per_sec: U128) {
        self.require_not_paused();
        let job = self.job_or_panic(job_id);
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

        let mut job = job;
        job.ask_per_sec = ask_per_sec.0;
        self.jobs.insert(&job_id, &job);

        emit_queue_event(
            "ask_updated",
            json!({
                "job_id": job_id,
                "owner": job.owner,
                "ask_per_sec": ask_per_sec.0.to_string(),
            }),
        );
    }

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
    /// charged on top; a caller budgeting all-in must subtract it (the season runtime does).
    #[payable]
    pub fn request_priority(
        &mut self,
        job_id: u64,
        latest_start_at: u64,
        max_spend: U128,
    ) -> PriorityView {
        self.require_not_paused();
        let requester = env::predecessor_account_id();
        // Only the owner may expedite a job. Otherwise a third party could flip
        // `expedited` on someone else's job and make its cancellation forfeit
        // the whole bond instead of 25%.
        require!(
            self.job_or_panic(job_id).owner == requester,
            "only the job owner can buy priority"
        );
        let now = now_secs();
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

        let attached = env::attached_deposit().as_yoctonear();
        require!(
            quote.total.0 <= max_spend.0,
            "priority total exceeds max_spend"
        );
        let storage_deposit = priority_storage_deposit(quote.displaced.len());
        let required = checked_add_u128(quote.total.0, storage_deposit);
        let (refunded, funded_from) = if attached == 0 {
            // Balance-funded (function-call key): spend exactly what is needed.
            self.credit_spend(&requester, required);
            (0, "balance")
        } else {
            require!(
                attached >= required,
                "attached deposit is below the priority total plus the storage deposit"
            );
            (checked_sub_u128(attached, required), "deposit")
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
        urgent.priority_spend = checked_add_u128(urgent.priority_spend, quote.total.0);
        self.jobs.insert(&job_id, &urgent);

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
            self.credit_add(&d.owner, d.amount.0);

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
            self.credit_add(&self.config.treasury_id.clone(), quote.fee.0);
        }

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
        };
        self.priorities.insert(&priority_id, &priority);
        if refunded > 0 {
            self.credit_add(&requester, refunded);
        }
        // Every write of the purchase, including a fresh requester or treasury
        // credit key, is inside the measured window.
        assert_storage_covered(storage_before, storage_deposit);

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
            requester,
            Some(job_id),
            Some(priority_id),
            quote.total.0,
            format!(
                "Job {job_id} bought priority #{} at index {}: {} yocto compensation, {} fee, {} refunded.",
                priority_id, quote.insert_index, quote.compensation.0, quote.fee.0, refunded
            ),
        );

        self.priority_view(&priority)
    }

    // -- operator lifecycle ------------------------------------------------

    pub fn start_next(&mut self) -> u64 {
        self.only_operator();
        self.require_not_paused();
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
        if let Some(pinned) = env::storage_read(TEE_MODEL_KEY) {
            require!(
                pinned == model.as_bytes(),
                "model is not the pinned model"
            );
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

    /// Non-refundable storage deposits: `submit_job` must attach
    /// `reward + job + bond`; `request_priority` must attach
    /// `total + priority_base + priority_per_displaced * displaced`.
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
        }
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

    fn only_operator(&self) {
        require!(
            env::predecessor_account_id() == self.config.operator_id,
            "only operator"
        );
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
            ask_per_sec: U128(job.ask_per_sec),
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
            let amount = checked_mul_u128(displaced_job.ask_per_sec, job.duration_secs as u128);
            compensation = checked_add_u128(compensation, amount);
            let handoffs = (index - insert_index as usize) as u64;
            let margin = checked_add_u64(DEADLINE_MARGIN_SECS, MARGIN_PER_HANDOFF_SECS * handoffs);
            if checked_add_u64(new_finish, margin) > displaced_job.deadline_at && first_bad.is_none() {
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
        let c = Contract::new(owner.clone(), operator.clone(), treasury.clone(), fee_bps);
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
            None, None,
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
                None, None,
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
                    None, None,
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
            Contract::new(owner.clone(), operator.clone(), treasury.clone(), 1_001)
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
        let b = submit_at(&mut fx.c, &fx.bob, NOW, "B", 10, 15, R, B, 200);
        let urgent = submit_at(&mut fx.c, &fx.dave, NOW, "urgent", 10, 1_000, R, B, 1);

        let q = quote_at(&fx.c, NOW, urgent, NOW);
        assert!(!q.feasible);
        assert_eq!(q.compensation.0, 10 * (100 + 200));
        assert!(q.reason.contains("displaced job"), "{}", q.reason);
        let displaced_b = q.displaced.iter().find(|d| d.job_id == b).unwrap();
        assert_eq!(displaced_b.new_finish_at, NOW + 30);
        assert_eq!(displaced_b.deadline_at, NOW + 15);
        assert_eq!(displaced_b.slack_secs, -15, "signed slack must go negative");
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
        assert_eq!(fx.c.get_job(2).ask_per_sec.0, 700);
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
                None, None,
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
        assert_eq!(fx.c.get_job(1).ask_per_sec.0, 500);
        assert_eq!(quote_at(&fx.c, NOW, urgent, NOW).compensation.0, 1_000);
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
        assert!(panics(|| fx.c.submit_job("A".into(), "h".into(), "".into(), 1, 1_000, U128(R), U128(u128::MAX), None, None)));
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
        assert!(panics(|| fx.c.submit_job("C".into(), "h".into(), "".into(), 10, 9, U128(R), U128(1), None, None)));
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
        assert!(panics(|| fx.c.submit_job("x".into(), "h".into(), "".into(), 10, 50, U128(R), U128(1), None, None)));
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
        assert!(panics(|| fx.c.submit_job("strict".into(), "h".into(), "".into(), 10, 50, U128(R), U128(1), None, Some(true))));
        let loose = submit_at(&mut fx.c, &fx.bob, NOW, "loose", 10, 50, R, B, 1);
        assert_eq!(fx.c.get_job(loose).status, JobStatus::Queued);
        as_(&fx.bob, NOW, R + B + JOB_STORAGE_DEPOSIT);
        let strict_ok = fx.c.submit_job("strict-ok".into(), "h".into(), "".into(), 10, 200, U128(R), U128(1), None, Some(true));
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
                None, None,
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
                None, None,
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
            None, None,
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
            Some(U128(B)), None,
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
            None
        )));
        as_(&fx.carol, NOW, 0);
        assert!(panics(|| fx.c.submit_job(
            "x".into(), "h".into(), "".into(), 1, 10, U128(R), U128(1), Some(U128(B)),
            None
        )));
        as_(&fx.carol, NOW, BALANCE_STORAGE_DEPOSIT);
        assert!(panics(|| fx.c.deposit()));
        as_(&fx.carol, NOW, R + B + JOB_STORAGE_DEPOSIT);
        assert!(panics(|| fx.c.submit_job(
            "x".into(), "h".into(), "".into(), 1, 10, U128(R), U128(1), Some(U128(B + 1)),
            None
        )));
        // Matching explicit bond with an attached deposit is fine.
        as_(&fx.carol, NOW, R + B + JOB_STORAGE_DEPOSIT);
        let id = fx.c.submit_job(
            "x".into(), "h".into(), "".into(), 1, 10, U128(R), U128(1), Some(U128(B)), None,
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
            None, None,
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
        assert!(panics(|| fx.c.submit_job("copy".into(), input.clone(), "".into(), 20, 1000, U128(R), U128(1), None, None)));
        // A job from before claims existed (no claim key) is still held to "one signed answer settles one job".
        env::storage_remove(&claim_key(&input));
        as_(&fx.bob, NOW + 11, R + B + JOB_STORAGE_DEPOSIT);
        let second = fx.c.submit_job("copy".into(), input.clone(), "".into(), 20, 1000, U128(R), U128(1), None, None);
        env::storage_remove(&claim_key(&input));
        as_(&fx.operator, NOW + 12, 0);
        assert_eq!(fx.c.start_next(), second);
        as_(&fx.operator, NOW + 20, 0);
        assert!(panics(|| fx.c.complete_job_attested(second, fs(&a, "response"), fs(&a, "signature_provider"), fs(&a, "signer"), Some(fs(&a, "model")))));
        assert_eq!(fx.c.get_job(second).status, JobStatus::Running);
        // The operator can still settle it the trusted way, and it is labelled unattested.
        as_(&fx.operator, NOW + 21, 0);
        fx.c.complete_job(second, "hash".into());
        assert!(!fx.c.get_job(second).attested);
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
            let mut c = Contract::new(acct("owner"), acct("operator"), treasury.clone(), 100);
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
        let id = fx.c.submit_job("😀".repeat(MAX_TITLE_CHARS), input.clone(), "u".repeat(MAX_URI_LEN), 20, 1000, U128(R), U128(1), None, None);
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
        }

        impl World {
            fn new() -> Self {
                let fx = setup_with_fee(100);
                let people = vec![fx.alice.clone(), fx.bob.clone(), fx.carol.clone(), fx.dave.clone()];
                let mut everyone = people.clone();
                everyone.extend([fx.owner.clone(), fx.operator.clone(), fx.treasury.clone()]);
                World { c: fx.c, people, everyone, operator: fx.operator, treasury: fx.treasury, now: NOW, running: None, money_in: 0, money_out: 0, retained: 0, all_ids: vec![] }
            }

            /// Run one call as `who` with `deposit` attached, then book the money that moved.
            fn call<T>(&mut self, who: &AccountId, deposit: u128, f: impl FnOnce(&mut Contract) -> T) -> T {
                as_(who, self.now, deposit);
                let out = f(&mut self.c);
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
                // The contract never pays out more than it took in: what it keeps is storage fees, and only grows.
                let held = escrow + credits + self.money_out;
                assert!(self.money_in >= held, "after {after}: paid out or owes more than it received");
                let retained = self.money_in - held;
                assert!(retained >= self.retained, "after {after}: retained storage fees went down ({} -> {retained})", self.retained);
                self.retained = retained;
                // Every job is in exactly one state.
                assert_eq!(
                    stats.submitted,
                    stats.completed + stats.missed + stats.cancelled + stats.failed + stats.queued as u64 + stats.running as u64,
                    "after {after}: job counters do not add up"
                );
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
                let id = if from_balance && self.credit(&who) >= need {
                    self.call(&who, 0, |c| c.submit_job("job".into(), "h".into(), "".into(), dur, deadline, U128(R), U128(ask), Some(U128(B)), None))
                } else {
                    self.call(&who, need, |c| c.submit_job("job".into(), "h".into(), "".into(), dur, deadline, U128(R), U128(ask), None, None))
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
                        let breaks = |i: usize| (i..at).any(|k| before[k].projected_finish_at + need + DEADLINE_MARGIN_SECS + MARGIN_PER_HANDOFF_SECS * (k - i) as u64 > before[k].deadline_at);
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
                        let on_time_before: Vec<u64> = before.iter().filter(|j| j.projected_finish_at <= j.deadline_at).map(|j| j.id).collect();

                        let attached = q.total.0 + priority_storage_deposit(q.displaced.len());
                        let owner = job.owner.clone();
                        self.call(&owner, attached, |c| c.request_priority(job.id, latest, U128(q.total.0)));

                        let after = self.queue();
                        // Nobody else changes place relative to each other.
                        let rest = |v: &[JobView]| v.iter().map(|j| j.id).filter(|id| *id != job.id).collect::<Vec<_>>();
                        assert_eq!(rest(&before), rest(&after), "a purchase reordered jobs other than the buyer");
                        // Deadline safety: every passed job still finishes before its deadline, with the margin.
                        for (k, d) in q.displaced.iter().enumerate() {
                            let j = after.iter().find(|j| j.id == d.job_id).unwrap();
                            assert_eq!(j.projected_finish_at, d.new_finish_at, "the quote and the queue disagree");
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
                        let id = self.call(&operator, 0, |c| c.start_next());
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
                        self.call(&operator, 0, |c| c.complete_job(id, "artifact".into()));
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
                        self.call(&anyone, 0, |c| c.claim_timeout(j.id));
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
            let mut c = Contract::new(acct("owner"), operator.clone(), treasury, 100);
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
                            let got = c.submit_job("job".into(), format!("h{i}"), "".into(), dur, deadline, U128(reward), U128(yocto(&step["ask"])), Some(U128(bond)), None);
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
