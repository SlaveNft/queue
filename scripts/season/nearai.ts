/**
 * NEAR AI Cloud client for the QUEUE season: agents' decisions, the worker's jobs, and
 * the TEE response signatures that `complete_job_attested` verifies on chain.
 *
 *   NEAR_AI_API_KEY   required for real models (read from queue/.env, never printed)
 *   NEAR_AI_MODEL     default Qwen/Qwen3.6-35B-A3B-FP8 (served by NEAR AI inside a TEE)
 *   NEAR_AI_BASE_URL  default https://cloud-api.near.ai/v1
 *
 * NEAR AI signs every chat completion inside its TEE. `GET /v1/signature/{chat_id}?model=..&signing_algo=ed25519`
 * returns `text` = "{model}:{sha256(request body)}:{sha256(response body)}" (provider TEE) or
 * "{sha256(request)}:{sha256(response)}" (gateway), an ed25519 `signature` over the UTF-8 bytes of `text`, and
 * `signing_address`, the 32-byte public key in hex. The key is bound to the TEE by `GET /v1/attestation/report`.
 */
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";

export interface NearAiConfig {
  apiKey?: string;
  model: string;
  baseUrl: string;
  timeoutMs: number;
}

export function nearAiConfig(env: Record<string, string | undefined> = process.env): NearAiConfig {
  return {
    apiKey: env.NEAR_AI_API_KEY || undefined,
    model: env.NEAR_AI_MODEL || "Qwen/Qwen3.6-35B-A3B-FP8",
    baseUrl: (env.NEAR_AI_BASE_URL || "https://cloud-api.near.ai/v1").replace(/\/$/, ""),
    timeoutMs: Number(env.NEAR_AI_TIMEOUT_MS || 60_000),
  };
}

export interface ResponseSignature {
  text: string;
  signature: string;
  signing_address: string;
  signing_algo: string;
}

export interface Completion {
  chatId: string;
  /** Exact request bytes sent, as a string. Its sha256 is what the job commits to. */
  requestBody: string;
  /** Exact response bytes received. */
  responseBody: string;
  content: string;
  latencyMs: number;
  /** Token counts reported by the API, so spend can be measured per call. */
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export const sha256hex = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const strip0x = (h: string) => h.replace(/^0x/i, "").toLowerCase();

/**
 * A NEAR AI failure with its HTTP status. `fatal` (401/402/403) means the key is wrong or out of credit:
 * stop calling for the rest of the run. `retryable` covers network errors, timeouts, 429 and 5xx.
 */
export class NearAiError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
  }
  get fatal() {
    return this.status === 401 || this.status === 402 || this.status === 403;
  }
  get retryable() {
    return this.status === null || this.status === 429 || this.status >= 500;
  }
}

async function http(url: string, init: RequestInit, timeoutMs: number) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ctl.signal });
    return { status: r.status, body: await r.text() };
  } catch (e) {
    throw new NearAiError(ctl.signal.aborted ? `timed out after ${timeoutMs} ms` : String((e as Error)?.message ?? e).slice(0, 160), null);
  } finally {
    clearTimeout(t);
  }
}

/** Build the exact request body once; the job's input_hash is sha256 of these bytes. */
export function requestBody(
  model: string,
  system: string,
  user: string,
  opts: { temperature?: number; maxTokens?: number; json?: boolean; thinking?: boolean } = {},
): string {
  return JSON.stringify({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: opts.temperature ?? 0.4,
    max_tokens: opts.maxTokens ?? 600,
    ...(opts.json ? { response_format: { type: "json_object" } } : {}),
    // Qwen3 models think by default; the reasoning eats max_tokens and adds seconds. Off: answers in ~0.5 s.
    ...(opts.thinking ? {} : { chat_template_kwargs: { enable_thinking: false } }),
  });
}

/** POST the exact bytes. Throws with a readable reason on any failure. */
export async function chat(cfg: NearAiConfig, body: string): Promise<Completion> {
  if (!cfg.apiKey) throw new Error("NEAR_AI_API_KEY not set");
  const t0 = Date.now();
  const res = await http(
    `${cfg.baseUrl}/chat/completions`,
    { method: "POST", headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" }, body },
    cfg.timeoutMs,
  );
  if (res.status !== 200) throw new NearAiError(`NEAR AI answered ${res.status}: ${res.body.slice(0, 200)}`, res.status);
  let j;
  try {
    j = JSON.parse(res.body);
  } catch {
    // A 200 with a broken body was already billed: retrying would bill it again. Not retryable.
    throw new NearAiError("NEAR AI answer is not JSON", 200);
  }
  return {
    chatId: j.id,
    requestBody: body,
    responseBody: res.body,
    content: j.choices?.[0]?.message?.content ?? "",
    latencyMs: Date.now() - t0,
    usage: j.usage ? { prompt_tokens: j.usage.prompt_tokens, completion_tokens: j.usage.completion_tokens } : undefined,
  };
}

/**
 * Chat with bounded retries: only network errors, timeouts, 429 and 5xx are retried, with backoff, and never past
 * `budgetMs` in total. A 4xx (bad request, no credit) is thrown at once: retrying it only spends money or time.
 * Note: a timed-out request may still be billed by the server, so `tries` stays small.
 */
export async function chatWithRetry(cfg: NearAiConfig, body: string, opts: { tries?: number; budgetMs?: number } = {}): Promise<Completion> {
  const tries = opts.tries ?? 2;
  const until = Date.now() + (opts.budgetMs ?? cfg.timeoutMs * tries);
  let last: unknown;
  for (let i = 0; i < tries; i += 1) {
    const left = until - Date.now();
    if (left < 1000) break;
    try {
      return await chat({ ...cfg, timeoutMs: Math.min(cfg.timeoutMs, left) }, body);
    } catch (e) {
      last = e;
      if (!(e instanceof NearAiError) || !e.retryable) throw e;
      await new Promise((r) => setTimeout(r, Math.min(800 * (i + 1), Math.max(0, until - Date.now()))));
    }
  }
  throw last ?? new NearAiError("no time left for the request", null);
}

/**
 * The TEE signature for a completion. Retries briefly (the signature can lag the answer by a moment), each attempt
 * capped at 10 s and the whole call at `budgetMs`, so a hung endpoint cannot freeze the worker.
 */
export async function signature(cfg: NearAiConfig, chatId: string, model = cfg.model, budgetMs = 25_000): Promise<ResponseSignature> {
  const q = new URLSearchParams({ model, signing_algo: "ed25519" });
  const until = Date.now() + budgetMs;
  let last = "";
  for (let i = 0; i < 4 && Date.now() < until; i += 1) {
    try {
      const s = await http(
        `${cfg.baseUrl}/signature/${encodeURIComponent(chatId)}?${q}`,
        { headers: { Authorization: `Bearer ${cfg.apiKey}` } },
        Math.max(1000, Math.min(10_000, until - Date.now())),
      );
      if (s.status === 200) return JSON.parse(s.body) as ResponseSignature;
      last = `${s.status}: ${s.body.slice(0, 160)}`;
      if (s.status === 401 || s.status === 402 || s.status === 403) throw new NearAiError(`signature endpoint: ${last}`, s.status);
    } catch (e) {
      if (e instanceof NearAiError && e.fatal) throw e;
      last = String((e as Error)?.message ?? e).slice(0, 160);
    }
    await new Promise((r) => setTimeout(r, Math.min(750 * (i + 1), Math.max(0, until - Date.now()))));
  }
  throw new NearAiError(`signature endpoint: ${last || "no time left"}`, null);
}

/**
 * The model's own signing keys from NEAR AI's attestation report (`model_attestations[].signing_address` for this
 * model; the gateway key is deliberately excluded). The report's Intel/NVIDIA quotes are saved with the season but
 * are not verified by this code: pinning trusts the report, and the docs say so.
 */
export async function attestedSigners(cfg: NearAiConfig, model = cfg.model): Promise<{ signers: string[]; raw: unknown }> {
  const q = new URLSearchParams({ model, signing_algo: "ed25519" });
  const r = await http(
    `${cfg.baseUrl}/attestation/report?${q}`,
    { headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {} },
    cfg.timeoutMs,
  );
  if (r.status !== 200) throw new Error(`attestation report ${r.status}: ${r.body.slice(0, 200)}`);
  const raw = JSON.parse(r.body) as { model_attestations?: Array<{ model_name?: string; signing_address?: string; signing_algo?: string }> };
  const found = new Set<string>();
  for (const m of raw.model_attestations ?? []) {
    if (m.model_name !== model || (m.signing_algo && m.signing_algo !== "ed25519")) continue;
    if (typeof m.signing_address === "string" && /^(0x)?[0-9a-f]{64}$/i.test(m.signing_address)) found.add(strip0x(m.signing_address));
  }
  return { signers: [...found], raw };
}

export function ed25519Verify(pubHex: string, message: string, sigHex: string): boolean {
  try {
    const raw = Buffer.from(strip0x(pubHex), "hex");
    if (raw.length !== 32) return false;
    const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    return edVerify(null, Buffer.from(message, "utf8"), key, Buffer.from(strip0x(sigHex), "hex"));
  } catch {
    return false;
  }
}

/**
 * Check a completion + signature exactly as the contract will. Returns the arguments for
 * `complete_job_attested` (model = null for the gateway form) or the list of problems.
 */
export function attestedArgs(
  c: Pick<Completion, "requestBody" | "responseBody">,
  sig: ResponseSignature,
  model: string,
  pinned?: string[],
): { ok: true; model: string | null; signer: string; signature: string } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const req = sha256hex(c.requestBody);
  const res = sha256hex(c.responseBody);
  let form: string | null | undefined;
  if (sig.text === `${model}:${req}:${res}`) form = model;
  else if (sig.text === `${req}:${res}`) problems.push("gateway receipt ({req}:{res}): it does not show which model ran, and the contract refuses it");
  else problems.push(`signed text is not over these exact bytes (got ${String(sig.text).slice(0, 90)})`);
  if (sig.signing_algo && sig.signing_algo !== "ed25519") problems.push(`signing_algo ${sig.signing_algo}, contract expects ed25519`);
  if (!ed25519Verify(sig.signing_address, sig.text, sig.signature)) problems.push("ed25519 signature does not verify");
  const signer = strip0x(sig.signing_address);
  if (pinned && !pinned.map(strip0x).includes(signer)) problems.push(`signer ${signer.slice(0, 16)}… is not pinned in the contract`);
  if (problems.length || form === undefined) return { ok: false, problems };
  return { ok: true, model: form, signer, signature: strip0x(sig.signature) };
}

/** First JSON object in a model answer (models sometimes wrap JSON in prose or fences). */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    /* fall through */
  }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      /* fall through */
    }
  }
  return undefined;
}
