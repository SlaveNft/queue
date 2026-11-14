import type {
  Artifact,
  Job,
  PriorityRecord,
  QueueState,
  Quote,
  Scenario,
  TaskKind,
} from "@queue/core";
import { BROWSER_BACKEND, staticDataUrl } from "./backend";
import { localLedger } from "./localLedger";

const BASE = ((import.meta.env.VITE_API_BASE as string | undefined) ?? "").replace(
  /\/$/,
  "",
);

export class ApiError extends Error {
  readonly code?: string;
  readonly status?: number;

  constructor(message: string, options: { code?: string; status?: number } = {}) {
    super(message);
    this.name = "ApiError";
    this.code = options.code;
    this.status = options.status;
  }
}

export function apiUrl(path: string): string {
  return `${BASE}${path}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** In the hosted build the two proof payloads are static files; everything else runs in the tab. */
function requestUrl(path: string): string {
  if (!BROWSER_BACKEND) return apiUrl(path);
  if (path === "/api/season") return staticDataUrl("season");
  if (path === "/api/onchain") return staticDataUrl("onchain");
  throw new ApiError(`${path} is not available in the in-browser console.`, { code: "no_api" });
}

const UNREACHABLE = BROWSER_BACKEND
  ? "Could not load the published proof file. Check your connection and reload."
  : "Could not reach the QUEUE API. Check that the server is running on port 8789.";
const TIMED_OUT = BROWSER_BACKEND
  ? "The published proof file did not load in time. Reload to try again."
  : "The API did not answer in time. Check that the server is running.";

export function apiErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.name === "AbortError") {
    return TIMED_OUT;
  }
  if (error instanceof Error && error.message) return error.message;
  return "The request failed. Check the API and try again.";
}

function readError(payload: unknown, status: number): string {
  if (isRecord(payload) && typeof payload.error === "string" && payload.error.trim()) {
    return payload.error;
  }
  if (status === 404) return "The requested resource was not found.";
  if (status >= 500) return "The API hit an internal error. Try again.";
  return `The API rejected the request (${status}).`;
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  timeoutMs = 15_000,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(requestUrl(path), {
      credentials: "same-origin",
      ...init,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new ApiError(TIMED_OUT, { code: "timeout" });
    }
    throw new ApiError(UNREACHABLE, { code: "network" });
  } finally {
    clearTimeout(timer);
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(
      response.ok
        ? "The API returned an unreadable response."
        : `The API returned an unreadable error (${response.status}).`,
      { status: response.status },
    );
  }

  if (!response.ok || (isRecord(payload) && payload.ok === false)) {
    throw new ApiError(readError(payload, response.status), {
      status: response.status,
      code: isRecord(payload) && typeof payload.code === "string" ? payload.code : undefined,
    });
  }

  return payload as T;
}

export function isQueueState(value: unknown): value is QueueState {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    typeof value.sessionId === "string" &&
    Array.isArray(value.queue) &&
    Array.isArray(value.recent) &&
    isRecord(value.credits) &&
    isRecord(value.stats) &&
    Array.isArray(value.activity)
  );
}

/** Accept both `{state}` envelopes and a bare state payload from SSE. */
export function extractState(payload: unknown): QueueState | null {
  if (!isRecord(payload)) return null;
  const candidate = isRecord(payload.state) ? payload.state : payload;
  return isQueueState(candidate) ? candidate : null;
}

export interface NewJobInput {
  ownerId: string;
  task: TaskKind;
  title: string;
  brief: string;
  input: string;
  durationSec: number;
  deadlineInSec: number;
  rewardNear: string;
  bondNear: string;
  askPerSecNear: string;
}

const httpApi = {
  async getState(): Promise<QueueState> {
    const payload = await request<{ state: QueueState }>("/api/state", {}, 8_000);
    if (!isQueueState(payload.state)) {
      throw new ApiError("The API returned an unexpected state shape.", {
        code: "bad_state",
      });
    }
    return payload.state;
  },

  async getQuote(jobId: string, latestStartInSec: number): Promise<Quote> {
    const query = new URLSearchParams({
      jobId,
      latestStartInSec: String(Math.max(0, Math.round(latestStartInSec))),
    });
    const payload = await request<{ quote: Quote }>(`/api/quote?${query.toString()}`);
    return payload.quote;
  },

  async getArtifact(id: string): Promise<Artifact> {
    const payload = await request<{ artifact: Artifact }>(
      `/api/artifacts/${encodeURIComponent(id)}`,
    );
    return payload.artifact;
  },

  async getSeason(): Promise<Record<string, unknown>> {
    return request<Record<string, unknown>>("/api/season", {}, 8_000);
  },
  async getOnchain(): Promise<Record<string, unknown> | null> {
    const payload = await request<{
      ok?: boolean;
      deployed?: boolean;
      note?: string;
      deploy?: unknown;
      proof?: unknown;
    }>("/api/onchain", {}, 8_000);
    const deploy = isRecord(payload.deploy) ? payload.deploy : {};
    const proof = isRecord(payload.proof) ? payload.proof : {};
    const merged: Record<string, unknown> = { ...deploy, ...proof };

    // Only keep public proof fields. The deploy record can contain signing
    // material; it must never be retained by the browser console.
    const safe: Record<string, unknown> = {};
    const fields = [
      "deployed",
      "status",
      "state",
      "network",
      "contractId",
      "contract_id",
      "contractAccount",
      "contractAccountId",
      "address",
      "wasmSha256",
      "wasmHash",
      "wasm_hash",
      "codeHash",
      "code_hash",
      "deployTx",
      "deployTxHash",
      "txHash",
      "transactionHash",
      "note",
      "message",
      "generatedAt",
      "generated_at",
    ];
    for (const key of fields) {
      if (merged[key] !== undefined) safe[key] = merged[key];
    }
    if (typeof payload.deployed === "boolean") safe.deployed = payload.deployed;
    if (typeof payload.note === "string") safe.note = payload.note;
    if (typeof merged.explorer === "string") safe.explorer = merged.explorer;
    if (typeof merged.explorerUrl === "string") safe.explorerUrl = merged.explorerUrl;
    // What the scripted on-chain run paid for its priority purchase (yocto), so the
    // console can say whether its own receipt matches the chain to the yocto.
    const stats = isRecord(merged.scenarioStats) ? merged.scenarioStats : null;
    if (stats && typeof stats.totalPriority === "string" && /^\d+$/.test(stats.totalPriority)) {
      safe.onchainPrioritySpend = stats.totalPriority;
    }

    // The refusal is the strongest proof in the file: keep the public facts
    // (which jobs, which contract error, which failed tx) and nothing else.
    if (isRecord(merged.refusal)) {
      const refusal = merged.refusal;
      const tight = isRecord(refusal.tightJob) ? refusal.tightJob : null;
      const jumping = isRecord(refusal.jumpingJob) ? refusal.jumpingJob : null;
      const quote = isRecord(refusal.quote) ? refusal.quote : null;
      const publicJob = (job: Record<string, unknown> | null) =>
        job
          ? {
              id: job.id ?? job.jobId ?? job.job_id,
              owner: job.owner ?? job.account ?? job.ownerId,
              durationSecs: job.durationSecs ?? job.duration_secs,
              deadlineSecs: job.deadlineSecs ?? job.deadline_secs,
            }
          : null;
      safe.refusal = {
        tightJob: publicJob(tight),
        jumpingJob: publicJob(jumping),
        contractError: refusal.contractError ?? refusal.error ?? refusal.message,
        quoteReason: quote?.reason,
        tx: refusal.tx ?? refusal.txHash ?? refusal.transactionHash,
      };
    }

    const transactions = Array.isArray(merged.transactions)
      ? merged.transactions
      : Array.isArray(merged.txs)
        ? merged.txs
        : null;
    if (transactions) {
      safe.transactions = transactions
        .filter((entry) => typeof entry === "string" || isRecord(entry))
        .map((entry) => {
          if (typeof entry === "string") return entry;
          if (!isRecord(entry)) return null;
          const hash = [entry.hash, entry.txHash, entry.transactionHash, entry.tx_hash]
            .find((value) => typeof value === "string");
          if (typeof hash !== "string") return null;
          const label = [entry.label, entry.type, entry.kind, entry.action, entry.step]
            .find((value) => typeof value === "string");
          return typeof label === "string" ? { hash, label } : { hash };
        })
        .filter((entry) => entry !== null);
    }

    return Object.keys(safe).length > 0 ? safe : null;
  },

  async createJob(input: NewJobInput): Promise<Job> {
    const payload = await request<{ job: Job }>("/api/jobs", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return payload.job;
  },

  async buyPriority(
    id: string,
    latestStartInSec: number,
    maxSpendNear: string,
  ): Promise<{ quote: Quote; job: Job; priority?: PriorityRecord }> {
    const payload = await request<{
      quote: Quote;
      job: Job;
      priority?: PriorityRecord;
    }>(`/api/jobs/${encodeURIComponent(id)}/priority`, {
      method: "POST",
      body: JSON.stringify({ latestStartInSec, maxSpendNear }),
    });
    return payload;
  },

  async moveAsk(id: string, askPerSecNear: string): Promise<Job> {
    const payload = await request<{ job: Job }>(
      `/api/jobs/${encodeURIComponent(id)}/move-ask`,
      {
        method: "POST",
        body: JSON.stringify({ askPerSecNear }),
      },
    );
    return payload.job;
  },

  async cancelJob(id: string): Promise<Job> {
    const payload = await request<{ job: Job }>(
      `/api/jobs/${encodeURIComponent(id)}/cancel`,
      { method: "POST" },
    );
    return payload.job;
  },

  async startNext(): Promise<Job> {
    const payload = await request<{ job: Job }>("/api/operator/start", {
      method: "POST",
    });
    return payload.job;
  },

  async withdraw(agentId: string): Promise<{ amountYocto: string; credits: Record<string, string> }> {
    return request<{ amountYocto: string; credits: Record<string, string> }>(
      `/api/credits/${encodeURIComponent(agentId)}/withdraw`,
      { method: "POST" },
    );
  },

  async runScenario(): Promise<Scenario> {
    const payload = await request<{ scenario: Scenario }>("/api/demo/run", {
      method: "POST",
    });
    return payload.scenario;
  },

  async resetScenario(): Promise<QueueState> {
    const payload = await request<{ state?: QueueState }>("/api/demo/reset", {
      method: "POST",
    });
    if (isQueueState(payload.state)) return payload.state;
    return httpApi.getState();
  },
};

/** Run a ledger call in this tab and report its refusals the way the HTTP client does. */
async function local<T>(call: () => T): Promise<T> {
  try {
    return call();
  } catch (error) {
    if (error instanceof localLedger.QueueError) {
      throw new ApiError(error.message, { code: error.code, status: error.status });
    }
    throw new ApiError(error instanceof Error ? error.message : "The ledger refused the request.");
  }
}

/**
 * The same interface served by the in-tab ledger. Only the two proof payloads
 * (`getSeason`, `getOnchain`) still fetch, and they fetch static files.
 */
const browserApi: typeof httpApi = {
  ...httpApi,
  getState: () => local(() => localLedger.getState()),
  getQuote: (jobId, latestStartInSec) =>
    local(() => localLedger.getQuote(jobId, Math.max(0, Math.round(latestStartInSec)))),
  getArtifact: (id) => local(() => localLedger.getArtifact(id)),
  createJob: (input) => local(() => localLedger.createJob(input)),
  buyPriority: (id, latestStartInSec, maxSpendNear) =>
    local(() => localLedger.buyPriority(id, latestStartInSec, maxSpendNear)),
  moveAsk: (id, askPerSecNear) => local(() => localLedger.moveAsk(id, askPerSecNear)),
  cancelJob: (id) => local(() => localLedger.cancelJob(id)),
  startNext: () => local(() => localLedger.startNext()),
  withdraw: (agentId) => local(() => localLedger.withdraw(agentId)),
  runScenario: () => local(() => localLedger.runScenario()),
  resetScenario: () => local(() => localLedger.reset()),
};

export const api = BROWSER_BACKEND ? browserApi : httpApi;
