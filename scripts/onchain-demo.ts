// @ts-nocheck
// Run the real QUEUE scenario on NEAR testnet and write a public proof file.
// Testnet only. Never prints secret keys.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  ROOT,
  loadEnv,
  loadKey,
  account,
  call,
  callExpectingRefusal,
  nearBalance,
  view,
  readJson,
  writeJson,
  sha256,
} from "./lib.mjs";
import { buildArtifact, INCIDENT_INPUT, SETTLEMENT_CSV, LAUNCH_INPUT } from "@queue/ledger";

loadEnv();
const deployInfo = readJson("data/deploy.json");
if (!deployInfo?.contractId) {
  console.error("No data/deploy.json. Run `npm run deploy:testnet` first.");
  process.exit(1);
}

const contractId = process.env.QUEUE_CONTRACT_ID || deployInfo.contractId;
const operatorId = process.env.QUEUE_OPERATOR_ACCOUNT_ID;
if (!operatorId) throw new Error("QUEUE_OPERATOR_ACCOUNT_ID missing in .env");
const operatorKey = loadKey(operatorId);
const operator = account(operatorId, operatorKey.secretKey);
const treasuryId = process.env.QUEUE_TREASURY_ACCOUNT_ID;

const roleKeys = {
  mira: loadKey(process.env.QUEUE_MIRA_ACCOUNT_ID),
  atlas: loadKey(process.env.QUEUE_ATLAS_ACCOUNT_ID),
  vale: loadKey(process.env.QUEUE_VALE_ACCOUNT_ID),
  juno: loadKey(process.env.QUEUE_JUNO_ACCOUNT_ID),
  kestrel: loadKey(process.env.QUEUE_BUYER_ACCOUNT_ID),
  orion: loadKey(process.env.QUEUE_ORION_ACCOUNT_ID),
};
const accounts = Object.fromEntries(
  Object.entries(roleKeys).map(([name, key]) => [name, account(key.accountId, key.secretKey)]),
);

const seedJobs = [
  {
    owner: "mira",
    title: "Triage the checkout incident",
    task: "incident-triage",
    input: INCIDENT_INPUT,
    duration: 11,
    deadline: 180,
    reward: "0.01",
    bond: "0.005",
    ask: "0.00042",
  },
  {
    owner: "atlas",
    title: "Audit the failed settlements export",
    task: "csv-audit",
    input: SETTLEMENT_CSV,
    duration: 9,
    deadline: 180,
    reward: "0.01",
    bond: "0.005",
    ask: "0.00058",
  },
  {
    owner: "vale",
    title: "Draft the Northline pilot brief",
    task: "launch-brief",
    input: LAUNCH_INPUT,
    duration: 10,
    deadline: 180,
    reward: "0.01",
    bond: "0.005",
    ask: "0.00036",
  },
  {
    owner: "juno",
    title: "Summarize the latency escalation",
    task: "incident-triage",
    input: INCIDENT_INPUT,
    duration: 12,
    deadline: 180,
    reward: "0.01",
    bond: "0.005",
    ask: "0.00031",
  },
];

function near(value) {
  return BigInt(Math.round(Number(value) * 1e6)) * 10n ** 18n;
}

function explorerTx(hash) {
  return `https://testnet.nearblocks.io/txns/${hash}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const setup = [];
const byAccount = new Map(
  Object.entries(roleKeys).map(([name, key]) => [key.accountId, name]),
);
const before = await view(contractId, "get_queue");
if (Array.isArray(before) && before.length > 0) {
  const stats = await view(contractId, "get_stats");
  assert(stats.running === 0, "a job is running; wait for it to finish before recording proof");
  console.log(`clearing ${before.length} queued job(s) from a previous calibration run…`);
  const nowSec = Math.floor(Date.now() / 1000);
  for (const job of before) {
    if (job.deadline_at < nowSec) {
      const result = await call(operator, contractId, "claim_timeout", { job_id: job.id });
      setup.push({ jobId: job.id, action: "claim_timeout", tx: result.tx_hash });
      console.log(`  timeout ${job.id} · ${result.tx_hash}`);
    } else {
      const ownerName = byAccount.get(job.owner);
      assert(ownerName, `no owner key for ${job.owner}`);
      const result = await call(
        accounts[ownerName],
        contractId,
        "cancel_job",
        { job_id: job.id },
      );
      setup.push({ jobId: job.id, action: "cancel_job", tx: result.tx_hash });
      console.log(`  cancel ${job.id} · ${result.tx_hash}`);
    }
  }
}
const remaining = await view(contractId, "get_queue");
assert(remaining.length === 0, `contract queue still has ${remaining.length} job(s)`);

const statsBefore = await view(contractId, "get_stats");
const txs = { submit: [], priority: null, start: null, complete: null, withdraw: null };
const jobs = {};

// Non-refundable storage deposits the contract charges (see get_storage_deposits).
const storage = await view(contractId, "get_storage_deposits");
const jobStorage = BigInt(storage.job);
const priorityStorage = (displaced: number) =>
  BigInt(storage.priority_base) + BigInt(storage.priority_per_displaced) * BigInt(displaced);

console.log(`contract ${contractId}`);
for (const seed of seedJobs) {
  const inputHash = sha256(seed.input);
  const reward = near(seed.reward);
  const bond = near(seed.bond);
  const result = await call(
    accounts[seed.owner],
    contractId,
    "submit_job",
    {
      title: seed.title,
      input_hash: inputHash,
      input_uri: `queue://demo/${seed.owner}`,
      duration_secs: seed.duration,
      deadline_secs: seed.deadline,
      reward: reward.toString(),
      ask_per_sec: near(seed.ask).toString(),
    },
    reward + bond + jobStorage,
  );
  jobs[seed.owner] = { id: result.result, ...seed, submit_tx: result.tx_hash };
  txs.submit.push({ owner: seed.owner, tx: result.tx_hash, jobId: result.result });
  console.log(`  ${seed.owner} job ${result.result} · ${result.tx_hash}`);
}

const artifactJob = {
  id: "J-ONCHAIN",
  seq: 1,
  title: "Board brief: checkout incident",
  task: "incident-triage",
  ownerId: "kestrel",
  ownerAccount: roleKeys.kestrel.accountId,
  brief: "Produce the incident brief before the board call.",
  input: INCIDENT_INPUT,
  durationSec: 12,
  submittedAt: Date.now(),
  deadlineAt: Date.now() + 45_000,
  rewardYocto: near("0.01").toString(),
  bondYocto: near("0.01").toString(),
  askPerSecYocto: "0",
  status: "queued",
  expedited: false,
  prioritySpendYocto: "0",
  movedCompensationYocto: "0",
  moves: [],
};
const artifact = buildArtifact(artifactJob);
const artifactPath = path.join(ROOT, "data", "onchain-artifact.md");
writeFileSync(artifactPath, artifact.markdown);
const artifactFileHash = sha256(artifact.markdown);

const urgentReward = near("0.005");
const urgentBond = near("0.005");
const submitted = await call(
  accounts.kestrel,
  contractId,
  "submit_job",
  {
    title: "Board brief: checkout incident",
    input_hash: sha256(INCIDENT_INPUT),
    input_uri: "queue://demo/kestrel",
    duration_secs: 12,
    deadline_secs: 45,
    reward: urgentReward.toString(),
    ask_per_sec: "0",
  },
  urgentReward + urgentBond + jobStorage,
);
const urgentId = submitted.result;
txs.submit.push({ owner: "kestrel", tx: submitted.tx_hash, jobId: urgentId });
console.log(`  kestrel urgent job ${urgentId} · ${submitted.tx_hash}`);

const latestStartAt = Math.floor(Date.now() / 1000) + 5;
const quote = await view(contractId, "quote_priority", {
  job_id: urgentId,
  latest_start_at: latestStartAt,
});
console.log(
  `  quote: index ${quote.insert_index}, displaced ${quote.displaced?.length}, total ${quote.total}`,
);
assert(quote.feasible === true, `quote infeasible: ${quote.reason}`);
assert(quote.displaced.length === 4, "expected four displaced jobs");
assert(BigInt(quote.total) > 0n, "expected a non-zero priority price");

const priority = await call(
  accounts.kestrel,
  contractId,
  "request_priority",
  {
    job_id: urgentId,
    latest_start_at: latestStartAt,
    max_spend: quote.total,
  },
  BigInt(quote.total) + priorityStorage(quote.displaced.length),
);
txs.priority = priority.tx_hash;
console.log(`  priority bought · ${priority.tx_hash}`);

const urgentAfterBuy = await view(contractId, "get_job", { job_id: urgentId });
assert(urgentAfterBuy.expedited === true, "job was not marked expedited");

const creditsAfterBuy = {};
for (const name of ["mira", "atlas", "vale", "juno"]) {
  creditsAfterBuy[name] = (await view(contractId, "get_credit", {
    account_id: roleKeys[name].accountId,
  })).toString();
}
assert(
  Object.values(creditsAfterBuy).every((value) => BigInt(value) > 0n),
  "displaced agents were not credited",
);

const started = await call(operator, contractId, "start_next", {});
txs.start = started.tx_hash;
assert(started.result === urgentId, `start_next started ${started.result}, expected ${urgentId}`);
console.log(`  worker started urgent · ${started.tx_hash}`);

await sleep(12_500);
const completed = await call(operator, contractId, "complete_job", {
  job_id: urgentId,
  artifact_hash: artifact.sha256,
});
txs.complete = completed.tx_hash;
console.log(`  artifact delivered · ${completed.tx_hash}`);

const finalJob = await view(contractId, "get_job", { job_id: urgentId });
assert(finalJob.status === "DONE", `final status is ${finalJob.status}`);
assert(finalJob.artifact_hash === artifact.sha256, "artifact hash mismatch");
const onTime = Number(finalJob.finished_at) <= Number(finalJob.deadline_at);
assert(onTime, "job finished after its deadline");

// ---------------------------------------------------------------------------
// The promise is kept on chain too. The worker now runs the four jobs that sold
// their slots; each must be DONE at or before its own deadline.
// ---------------------------------------------------------------------------
const artifactsDir = path.join(ROOT, "data", "onchain-artifacts");
mkdirSync(artifactsDir, { recursive: true });

function asJob(seed, id) {
  return {
    id: `J-ONCHAIN-${id}`,
    seq: Number(id),
    title: seed.title,
    task: seed.task,
    ownerId: seed.owner,
    ownerAccount: roleKeys[seed.owner].accountId,
    brief: seed.title,
    input: seed.input,
    durationSec: seed.duration,
    submittedAt: Date.now(),
    deadlineAt: Date.now() + seed.deadline * 1000,
    rewardYocto: near(seed.reward).toString(),
    bondYocto: near(seed.bond).toString(),
    askPerSecYocto: near(seed.ask).toString(),
    status: "queued",
    expedited: false,
    prioritySpendYocto: "0",
    movedCompensationYocto: "0",
    moves: [],
  };
}

/** Start the head of the queue, do the work, deliver, and require DONE on time. */
async function runHead(seed, id) {
  const started = await call(operator, contractId, "start_next", {});
  assert(started.result === id, `start_next started ${started.result}, expected ${id}`);
  const built = buildArtifact(asJob(seed, id));
  await sleep(seed.duration * 1000 + 500);
  const completed = await call(operator, contractId, "complete_job", {
    job_id: id,
    artifact_hash: built.sha256,
  });
  const done = await view(contractId, "get_job", { job_id: id });
  assert(done.status === "DONE", `${seed.owner} job ${id} ended ${done.status}`);
  const secondsEarly = Number(done.deadline_at) - Number(done.finished_at);
  assert(secondsEarly >= 0, `${seed.owner} job ${id} finished after its deadline`);
  assert(done.artifact_hash === built.sha256, `${seed.owner} job ${id} artifact hash mismatch`);
  const file = `data/onchain-artifacts/job-${id}-${seed.owner}.md`;
  writeFileSync(path.join(ROOT, file), built.markdown);
  console.log(`  ${seed.owner} job ${id} delivered ${secondsEarly}s early · ${completed.tx_hash}`);
  return {
    owner: seed.owner,
    jobId: id,
    startTx: started.tx_hash,
    completeTx: completed.tx_hash,
    artifactSha256: built.sha256,
    artifactFile: file,
    finishedAt: Number(done.finished_at),
    deadlineAt: Number(done.deadline_at),
    secondsEarly,
  };
}

const displacedDeliveries = [];
for (const name of ["mira", "atlas", "vale", "juno"]) {
  displacedDeliveries.push(await runHead(jobs[name], jobs[name].id));
}

// Every displaced agent pulls its pay out of the contract.
const withdrawals = [];
for (const name of ["mira", "atlas", "vale", "juno"]) {
  const result = await call(accounts[name], contractId, "withdraw_credit", {});
  withdrawals.push({ owner: name, tx: result.tx_hash, amount: String(result.result ?? creditsAfterBuy[name]) });
  console.log(`  ${name} withdrew credit · ${result.tx_hash}`);
}
txs.withdraw = withdrawals[0].tx;

const creditsFinal = {};
for (const name of ["mira", "atlas", "vale", "juno"]) {
  creditsFinal[name] = (await view(contractId, "get_credit", {
    account_id: roleKeys[name].accountId,
  })).toString();
}
const miraCreditAfter = creditsFinal.mira;
assert(
  Object.values(creditsFinal).every((value) => BigInt(value) === 0n),
  "a withdrawal did not clear its credit",
);

// ---------------------------------------------------------------------------
// The refusal. Orion holds a tight-deadline job. Kestrel queues a 60-second job
// behind it and tries to buy the slot in front. That jump would make Orion late,
// so the contract panics: the transaction fails, nothing moves, nobody is paid.
// ---------------------------------------------------------------------------
const orionSeed = {
  owner: "orion",
  title: "Reconcile the payout batch",
  task: "csv-audit",
  input: SETTLEMENT_CSV,
  duration: 8,
  deadline: 60,
  reward: "0.01",
  bond: "0.005",
  ask: "0.0005",
};
const rushSeed = {
  owner: "kestrel",
  title: "Quarterly investor report",
  task: "launch-brief",
  input: LAUNCH_INPUT,
  duration: 60,
  deadline: 240,
  reward: "0.005",
  bond: "0.005",
  ask: "0",
};
async function submit(seed) {
  const reward = near(seed.reward);
  const bond = near(seed.bond);
  const result = await call(
    accounts[seed.owner],
    contractId,
    "submit_job",
    {
      title: seed.title,
      input_hash: sha256(seed.input),
      input_uri: `queue://demo/${seed.owner}`,
      duration_secs: seed.duration,
      deadline_secs: seed.deadline,
      reward: reward.toString(),
      ask_per_sec: near(seed.ask).toString(),
    },
    reward + bond + jobStorage,
  );
  return { id: result.result, tx: result.tx_hash };
}
const orionJob = await submit(orionSeed);
console.log(`  orion tight job ${orionJob.id} · ${orionJob.tx}`);
const rushJob = await submit(rushSeed);
console.log(`  kestrel long job ${rushJob.id} · ${rushJob.tx}`);

const refusalDeposit = near("0.02");
let refusal = null;
for (let attempt = 0; attempt < 3 && !refusal; attempt += 1) {
  // Take the clock from the chain so the cutoff is in the future when the call lands.
  const probe = await view(contractId, "quote_priority", { job_id: rushJob.id, latest_start_at: 0 });
  const cutoff = Number(probe.now) + 6;
  const refusedQuote = await view(contractId, "quote_priority", {
    job_id: rushJob.id,
    latest_start_at: cutoff,
  });
  assert(refusedQuote.feasible === false, "the contract quoted a jump that should be infeasible");
  const balanceBefore = await nearBalance(roleKeys.kestrel.accountId);
  const refused = await callExpectingRefusal(
    accounts.kestrel,
    contractId,
    "request_priority",
    { job_id: rushJob.id, latest_start_at: cutoff, max_spend: refusalDeposit.toString() },
    refusalDeposit,
  );
  if (!/displaced job/.test(refused.error)) {
    console.log(`  refusal attempt ${attempt + 1} hit "${refused.error}"; retrying with a fresh cutoff`);
    continue;
  }
  await sleep(1500);
  const balanceAfter = await nearBalance(roleKeys.kestrel.accountId);
  const queueAfter = await view(contractId, "get_queue");
  const orionCredit = (await view(contractId, "get_credit", {
    account_id: roleKeys.orion.accountId,
  })).toString();
  const rushAfter = await view(contractId, "get_job", { job_id: rushJob.id });
  refusal = {
    tightJob: { id: orionJob.id, owner: roleKeys.orion.accountId, durationSecs: orionSeed.duration, deadlineSecs: orionSeed.deadline, submitTx: orionJob.tx },
    jumpingJob: { id: rushJob.id, owner: roleKeys.kestrel.accountId, durationSecs: rushSeed.duration, submitTx: rushJob.tx },
    latestStartAt: cutoff,
    quote: { feasible: refusedQuote.feasible, reason: refusedQuote.reason },
    tx: refused.tx_hash,
    contractError: refused.error,
    attachedYocto: refusalDeposit.toString(),
    queueOrderUnchanged: queueAfter.map((job) => job.id).join(",") === `${orionJob.id},${rushJob.id}`,
    jumpingJobExpedited: rushAfter.expedited === true,
    tightJobCreditYocto: orionCredit,
    // Only gas left the buyer: the attached deposit came back with the failed call.
    buyerSpentYocto: (balanceBefore - balanceAfter).toString(),
  };
  assert(refusal.queueOrderUnchanged, "the refused purchase reordered the queue");
  assert(!refusal.jumpingJobExpedited, "the refused job was marked expedited");
  assert(BigInt(orionCredit) === 0n, "the refused purchase credited the tight job");
  assert(balanceBefore - balanceAfter < near("0.01"), "the refused purchase kept the buyer's deposit");
  console.log(`  REFUSED by the contract · ${refused.tx_hash}`);
  console.log(`    "${refused.error}"`);
}
assert(refusal, "could not record a deadline refusal");

// Because the jump was refused, Orion still delivers on time. Then the long job runs in order.
const protectedDelivery = await runHead(orionSeed, orionJob.id);
const rushDelivery = await runHead(rushSeed, rushJob.id);

const finalQueue = await view(contractId, "get_queue");
const stats = await view(contractId, "get_stats");
assert(finalQueue.length === 0, `the queue still holds ${finalQueue.length} job(s)`);

function u128Delta(after, before) {
  return (BigInt(after) - BigInt(before)).toString();
}

const scenarioStats = {
  submitted: stats.submitted - statsBefore.submitted,
  completed: stats.completed - statsBefore.completed,
  missed: stats.missed - statsBefore.missed,
  cancelled: stats.cancelled - statsBefore.cancelled,
  moves: stats.moves - statsBefore.moves,
  totalPriority: u128Delta(stats.total_priority, statsBefore.total_priority),
  totalCompensation: u128Delta(stats.total_compensation, statsBefore.total_compensation),
  totalFees: u128Delta(stats.total_fees, statsBefore.total_fees),
};

const proof = {
  ok: true,
  deployed: true,
  network: "testnet",
  contractId,
  deployTx: deployInfo.deployTx ?? null,
  wasmSha256: deployInfo.wasmSha256 ?? null,
  generatedAt: new Date().toISOString(),
  explorer: "https://testnet.nearblocks.io",
  explorerLinks: {
    contract: `https://testnet.nearblocks.io/address/${contractId}`,
    priority: explorerTx(txs.priority),
    start: explorerTx(txs.start),
    complete: explorerTx(txs.complete),
    withdraw: explorerTx(txs.withdraw),
    refusal: explorerTx(refusal.tx),
  },
  transactions: [
    ...txs.submit.map((item) => ({
      hash: item.tx,
      label: `submit ${item.owner} job ${item.jobId}`,
    })),
    { hash: txs.priority, label: "priority purchase" },
    { hash: txs.start, label: "start urgent job" },
    { hash: txs.complete, label: "deliver artifact" },
    ...displacedDeliveries.flatMap((item) => [
      { hash: item.startTx, label: `start ${item.owner} job ${item.jobId}` },
      { hash: item.completeTx, label: `deliver ${item.owner} job ${item.jobId} on time` },
    ]),
    ...withdrawals.map((item) => ({ hash: item.tx, label: `withdraw ${item.owner} credit` })),
    { hash: refusal.tightJob.submitTx, label: `submit orion job ${refusal.tightJob.id} (tight deadline)` },
    { hash: refusal.jumpingJob.submitTx, label: `submit kestrel job ${refusal.jumpingJob.id} (60s)` },
    { hash: refusal.tx, label: "REFUSED jump: contract panics" },
    { hash: protectedDelivery.startTx, label: `start orion job ${protectedDelivery.jobId}` },
    { hash: protectedDelivery.completeTx, label: `deliver orion job ${protectedDelivery.jobId} on time` },
    { hash: rushDelivery.startTx, label: `start kestrel job ${rushDelivery.jobId}` },
    { hash: rushDelivery.completeTx, label: `deliver kestrel job ${rushDelivery.jobId} on time` },
  ],
  operator: operatorId,
  treasury: treasuryId,
  buyer: roleKeys.kestrel.accountId,
  artifact: {
    file: "data/onchain-artifact.md",
    sha256: artifact.sha256,
    fileSha256: artifactFileHash,
    bytes: Buffer.byteLength(artifact.markdown),
    checks: artifact.checks,
  },
  jobId: urgentId,
  queue: finalQueue.map((job) => ({
    id: job.id,
    owner: job.owner,
    status: job.status,
    deadline_at: job.deadline_at,
    duration_secs: job.duration_secs,
    expedited: job.expedited,
    ask_per_sec: job.ask_per_sec,
  })),
  quote,
  finalJob,
  stats,
  scenarioStats,
  statsBefore,
  historyNote: "scenarioStats is the delta for this run. The contract state was re-initialised once before this run (see docs/ONCHAIN.md), so stats and scenarioStats agree.",
  displacedDeliveries,
  withdrawals,
  refusal,
  refusalDeliveries: [protectedDelivery, rushDelivery],
  credits: {
    afterPurchase: creditsAfterBuy,
    final: creditsFinal,
  },
  txs,
  setup,
  verification: {
    displacedJobs: quote.displaced.length,
    allDisplacedPaid: Object.values(creditsAfterBuy).every((value) => BigInt(value) > 0n),
    deliveredOnTime: onTime,
    artifactHashMatches: finalJob.artifact_hash === artifact.sha256,
    withdrawClearedCredit: BigInt(miraCreditAfter) === 0n,
    allCreditsWithdrawn: Object.values(creditsFinal).every((value) => BigInt(value) === 0n),
    displacedDeliveredOnTime: displacedDeliveries.length === 4 && displacedDeliveries.every((item) => item.secondsEarly >= 0),
    jobsCompleted: stats.completed - statsBefore.completed,
    jobsMissed: stats.missed - statsBefore.missed,
    refusalRecorded: Boolean(refusal.tx) && refusal.quote.feasible === false,
    refusalMovedNothing: refusal.queueOrderUnchanged && !refusal.jumpingJobExpedited && refusal.tightJobCreditYocto === "0",
    protectedJobDeliveredOnTime: protectedDelivery.secondsEarly >= 0,
  },
};
writeJson("data/onchain-proof.json", proof);
console.log("\nONCHAIN PROOF");
console.log(`  contract   ${contractId}`);
console.log(`  job        ${urgentId} ${finalJob.status}`);
console.log(`  artifact   ${artifact.sha256}`);
console.log(`  priority   ${explorerTx(txs.priority)}`);
console.log(`  delivered  ${explorerTx(txs.complete)}`);
console.log(`  on time    ${stats.completed - statsBefore.completed} of ${stats.submitted - statsBefore.submitted} jobs, ${stats.missed - statsBefore.missed} missed`);
console.log(`  refused    ${explorerTx(refusal.tx)}`);
console.log("  saved      data/onchain-proof.json");
