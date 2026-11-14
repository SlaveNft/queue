/**
 * Public on-chain proof: normalisation and grouping.
 *
 * The browser only ever receives the safe-listed fields from /api/onchain
 * (see lib/api.ts). This module keeps that contract explicit and testable.
 */

export interface ProofTx {
  hash: string;
  label?: string;
}

export interface ProofRefusal {
  tightJob?: {
    id?: string;
    owner?: string;
    durationSecs?: number;
    deadlineSecs?: number;
  };
  jumpingJob?: {
    id?: string;
    owner?: string;
    durationSecs?: number;
  };
  contractError?: string;
  quoteReason?: string;
  tx?: string;
}

export interface ContractProof {
  deployed: boolean;
  contractId?: string;
  wasmHash?: string;
  network?: string;
  generatedAt?: string;
  explorer: string;
  txs: ProofTx[];
  refusal?: ProofRefusal;
  note?: string;
}

export interface ProofGroup {
  key: string;
  label: string;
  txs: ProofTx[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pickString(source: Record<string, unknown> | null, keys: string[]): string | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function pickOptionalNumber(source: Record<string, unknown> | null, keys: string[]): number | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function pickId(source: Record<string, unknown> | null): string | undefined {
  if (!source) return undefined;
  const value = source.id ?? source.jobId ?? source.job_id;
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function normalizeRefusal(value: unknown): ProofRefusal | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const tight = asRecord(record.tightJob);
  const jumping = asRecord(record.jumpingJob);
  const quote = asRecord(record.quote);

  const refusal: ProofRefusal = {};
  const contractError = pickString(record, ["contractError", "error", "message"]);
  const quoteReason = pickString(quote, ["reason"]);
  const tx = pickString(record, ["tx", "txHash", "transactionHash"]);
  if (contractError) refusal.contractError = contractError;
  if (quoteReason) refusal.quoteReason = quoteReason;
  if (tx) refusal.tx = tx;

  if (tight) {
    const job: NonNullable<ProofRefusal["tightJob"]> = {};
    const id = pickId(tight);
    const owner = pickString(tight, ["owner", "account", "ownerId"]);
    const durationSecs = pickOptionalNumber(tight, ["durationSecs", "duration_secs"]);
    const deadlineSecs = pickOptionalNumber(tight, ["deadlineSecs", "deadline_secs"]);
    if (id) job.id = id;
    if (owner) job.owner = owner;
    if (durationSecs !== undefined) job.durationSecs = durationSecs;
    if (deadlineSecs !== undefined) job.deadlineSecs = deadlineSecs;
    if (Object.keys(job).length > 0) refusal.tightJob = job;
  }

  if (jumping) {
    const job: NonNullable<ProofRefusal["jumpingJob"]> = {};
    const id = pickId(jumping);
    const owner = pickString(jumping, ["owner", "account", "ownerId"]);
    const durationSecs = pickOptionalNumber(jumping, ["durationSecs", "duration_secs"]);
    if (id) job.id = id;
    if (owner) job.owner = owner;
    if (durationSecs !== undefined) job.durationSecs = durationSecs;
    if (Object.keys(job).length > 0) refusal.jumpingJob = job;
  }

  return Object.keys(refusal).length > 0 ? refusal : undefined;
}

export function normalizeProof(proof: Record<string, unknown> | null): ContractProof | null {
  if (!proof) return null;

  let contractId = pickString(proof, [
    "contractId",
    "contract_id",
    "contractAccount",
    "contractAccountId",
    "address",
  ]);
  if (!contractId) {
    const nested = asRecord(proof.contract);
    contractId = pickString(nested, ["id", "accountId", "contractId"]);
  }
  if (contractId && !/^[a-z0-9._-]{2,64}$/i.test(contractId)) {
    contractId = undefined;
  }

  const rawDeployed = proof.deployed ?? proof.isDeployed;
  const rawStatus = pickString(proof, ["status", "state"]);
  const deployed =
    rawDeployed === true ||
    (contractId !== undefined &&
      rawDeployed !== false &&
      !/pending|not[-\s]?deployed|local/i.test(rawStatus ?? ""));

  const wasmRaw = pickString(proof, [
    "wasmHash",
    "wasm_hash",
    "wasmSha256",
    "wasm_sha256",
    "codeHash",
    "code_hash",
  ]);
  const wasmHash =
    wasmRaw && wasmRaw.length >= 16 && !/^(pending|todo|local)$/i.test(wasmRaw)
      ? wasmRaw
      : undefined;

  const rawNetwork = proof.network;
  let network =
    typeof rawNetwork === "string"
      ? rawNetwork
      : pickString(asRecord(rawNetwork), ["id", "name", "networkId"]);
  if (!network && contractId?.endsWith(".testnet")) network = "testnet";

  const explorerRaw = pickString(proof, ["explorer", "explorerUrl", "explorerBase"]);
  let explorer = "https://testnet.nearblocks.io";
  if (explorerRaw && /^https?:\/\//.test(explorerRaw)) {
    try {
      const url = new URL(explorerRaw);
      explorer = /\/(address|txns)\//.test(url.pathname)
        ? url.origin
        : explorerRaw.replace(/\/$/, "");
    } catch {
      explorer = "https://testnet.nearblocks.io";
    }
  }

  const candidates: ProofTx[] = [];
  const pushHash = (hash: unknown, label?: unknown) => {
    if (typeof hash !== "string") return;
    const clean = hash.trim();
    if (!/^[A-Za-z0-9]{20,}$/.test(clean)) return;
    if (clean.toLowerCase() === "0".repeat(clean.length)) return;
    if (candidates.some((entry) => entry.hash === clean)) return;
    candidates.push({
      hash: clean,
      ...(typeof label === "string" && label.trim() ? { label: label.trim() } : {}),
    });
  };

  const rawTxs = [proof.txs, proof.transactions, proof.deployTxs].find(Array.isArray);
  const hasTxList = Array.isArray(rawTxs) && rawTxs.length > 0;

  // A deploy transaction is useful only as a fallback; when the proof ships a
  // labelled transaction list, that list is the 27-item count we show.
  if (!hasTxList) {
    for (const key of [
      "deployTx",
      "deployTxHash",
      "txHash",
      "transactionHash",
      "upgradeTxHash",
    ]) {
      pushHash(proof[key], key === "upgradeTxHash" ? "upgrade" : "deploy");
    }
  }

  if (hasTxList) {
    for (const entry of rawTxs) {
      if (typeof entry === "string") {
        pushHash(entry);
      } else {
        const record = asRecord(entry);
        if (!record) continue;
        const hash = pickString(record, ["hash", "txHash", "transactionHash", "tx_hash", "id"]);
        const label = pickString(record, ["label", "type", "kind", "action", "step"]);
        pushHash(hash, label);
      }
    }
  }

  if (!deployed) return null;

  const generatedAt = pickString(proof, ["generatedAt", "generated_at"]);
  const refusal = normalizeRefusal(proof.refusal);

  return {
    deployed,
    ...(contractId ? { contractId } : {}),
    ...(wasmHash ? { wasmHash } : {}),
    ...(network ? { network } : {}),
    ...(generatedAt ? { generatedAt } : {}),
    explorer,
    txs: candidates,
    ...(refusal ? { refusal } : {}),
    ...(pickString(proof, ["note", "message"])
      ? { note: pickString(proof, ["note", "message"]) }
      : {}),
  };
}

const GROUPS: Array<{ key: string; label: string; match: RegExp }> = [
  { key: "submissions", label: "Submissions", match: /^submit/i },
  { key: "priority", label: "Priority purchase", match: /^priority/i },
  { key: "workers", label: "Worker runs", match: /^(start|deliver)/i },
  { key: "credits", label: "Credits withdrawn", match: /^withdraw/i },
  { key: "refused", label: "Refused jump", match: /refused/i },
];

/**
 * Groups every transaction once, in a stable order, so 27 rows do not read as
 * an undifferentiated wall of links.
 */
export function groupProofTxs(txs: ProofTx[]): ProofGroup[] {
  const groups: ProofGroup[] = GROUPS.map((group) => ({ key: group.key, label: group.label, txs: [] }));
  const other: ProofGroup = { key: "other", label: "Other", txs: [] };

  for (const tx of txs) {
    const label = tx.label ?? "";
    const index = GROUPS.findIndex((group) => group.match.test(label));
    if (index === -1) other.txs.push(tx);
    else groups[index].txs.push(tx);
  }

  return [...groups, other].filter((group) => group.txs.length > 0);
}

/** Deliveries the proof itself reports, used only for a count. */
export function deliveredCount(txs: ProofTx[]): number {
  return txs.filter((tx) => /^deliver/i.test(tx.label ?? "")).length;
}

/** A display-safe UTC timestamp, or null when the value is not a date. */
export function formatGeneratedAt(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
