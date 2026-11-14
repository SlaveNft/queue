import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * The public proof payloads behind `GET /api/onchain` and `GET /api/season`.
 * The API serves them live; the hosted console build writes the same two
 * payloads as static JSON (`scripts/build-pages.mjs`), so both read one source.
 */

/** The v1 testnet proof and the public part of the deploy record. Never returns key material. */
export function readOnchainPayload(root: string): Record<string, unknown> {
  const proofPath = path.join(root, "data", "onchain-proof.json");
  const deployPath = path.join(root, "data", "deploy.json");
  const read = (file: string) => {
    try {
      return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
    } catch {
      return null;
    }
  };
  const proof = read(proofPath);
  const rawDeploy = read(deployPath);
  const deploy = rawDeploy
    ? {
        network: rawDeploy.network,
        contractId: rawDeploy.contractId,
        ownerId: rawDeploy.ownerId,
        operatorId: rawDeploy.operatorId,
        treasuryId: rawDeploy.treasuryId,
        buyerId: rawDeploy.buyerId,
        agents: Object.fromEntries(
          Object.entries(rawDeploy.agents ?? {}).map(([name, value]) => {
            const agent = (value ?? {}) as Record<string, unknown>;
            return [
              name,
              { accountId: agent.accountId, publicKey: agent.publicKey },
            ];
          }),
        ),
        feeBps: rawDeploy.feeBps,
        wasmSha256: rawDeploy.wasmSha256,
        wasmBytes: rawDeploy.wasmBytes,
        deployTx: rawDeploy.deployTx,
        deployedAt: rawDeploy.deployedAt,
        contractBalanceYocto: rawDeploy.contractBalanceYocto,
        explorer: rawDeploy.explorer,
        rpc: rawDeploy.rpc,
      }
    : null;
  if (!proof && !deploy) {
    return {
      ok: true,
      deployed: false,
      note: "No testnet proof file yet. The local ledger is a rehearsal; deploy with `npm run deploy:testnet` to create real proof.",
    };
  }
  return { ok: true, deployed: true, deploy, proof };
}

/**
 * The v2 season on NEAR testnet: public contract metadata, the featured (or latest) run's
 * summary, its comparison with FIFO and a blind fee, and the agents' decisions with their reasons. Read-only;
 * the console reads live contract state directly from testnet RPC.
 */
export function readSeasonPayload(root: string): Record<string, unknown> {
  const base = path.join(root, "data", "season");
  const read = (file: string) => {
    try {
      return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
    } catch {
      return null;
    }
  };
  const net = read(path.join(base, "testnet.json"));
  if (!net) {
    return { ok: true, deployed: false };
  }
  const contract = {
    contractId: net.contractId,
    ownerId: net.ownerId,
    operatorId: net.operatorId,
    treasuryId: net.treasuryId,
    wasmSha256: net.wasmSha256,
    deployTx: net.deployTx,
    deployedAt: net.deployedAt,
    teeModel: net.teeModel ?? null,
    teeSigners: net.teeSigners ?? [],
    pinTx: net.pinTx ?? null,
    agents: Object.fromEntries(
      Object.entries(net.agents ?? {}).map(([id, value]) => {
        const a = (value ?? {}) as Record<string, unknown>;
        return [id, { accountId: a.accountId, functionCallKey: a.functionCallKey, methods: a.methods }];
      }),
    ),
  };
  let runs: string[] = [];
  try {
    runs = readdirSync(base)
      .filter((d) => d.startsWith("testnet") && existsSync(path.join(base, d, "summary.json")))
      .sort();
  } catch {
    runs = [];
  }
  const featured = read(path.join(base, "featured.json"))?.run;
  const isFeatured = typeof featured === "string" && runs.includes(featured);
  const run = isFeatured ? featured : runs[runs.length - 1];
  if (!run) {
    return { ok: true, deployed: true, contract, run: null };
  }
  const dir = path.join(base, run);
  let events: Array<Record<string, unknown>> = [];
  try {
    // Skip a malformed line (e.g. a truncated last line after a crash) instead of dropping the whole log.
    events = readFileSync(path.join(dir, "events.jsonl"), "utf8")
      .split("\n")
      .flatMap((line) => {
        if (!line.trim()) return [];
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
  } catch {
    events = [];
  }
  const keep = ["t", "who", "kind", "action", "job", "reason", "source", "ok", "tx", "error", "layer", "ask", "maxSpend", "within", "valueNear", "note"];
  const pick = (e: Record<string, unknown>) =>
    Object.fromEntries(keep.filter((k) => e[k] !== undefined).map((k) => [k, typeof e[k] === "string" ? String(e[k]).slice(0, 240) : e[k]]));
  // Lead with the market moves (purchases, ask changes, cancels, substantive refusals); the full log is in the repo.
  const acts = events.filter((e) => e.kind === "decision" && e.action !== "wait" && e.layer !== "runtime");
  const lead = (e: Record<string, unknown>) =>
    ["buy_priority", "set_ask", "cancel"].includes(String(e.action)) && !/balance too low/.test(String(e.error ?? ""));
  // Balance refusals are counted in the summary; one example is enough in the feed.
  const low = (e: Record<string, unknown>) => /balance too low/.test(String(e.error ?? ""));
  const rest = acts.filter((e) => !lead(e));
  const decisions = [...acts.filter(lead).slice(-40), ...rest.filter((e) => !low(e)).slice(-19), ...rest.filter(low).slice(-1)]
    .sort((a, b) => Number(a.t ?? 0) - Number(b.t ?? 0))
    .map(pick);
  const refusals = events.filter((e) => e.ok === false && e.layer === "contract" && e.tx).slice(-12).map(pick);
  const settlements = events.filter((e) => (e.kind === "complete_attested" || e.kind === "complete") && e.ok).slice(-12).map(pick);
  return {
    ok: true,
    deployed: true,
    contract,
    featured: isFeatured,
    // The 300-season simulator sweep (scripts/season/sweep.ts): the aggregate only, not the per-season rows.
    sweep: (() => {
      const sw = read(path.join(base, "sweep.json"));
      if (!sw?.all) return null;
      return {
        seasons: sw.all.seasons,
        jobs: sw.all.jobs,
        movedJobs: sw.all.movedJobs,
        movedJobsLate: sw.all.movedJobsLate,
        marketMinusFifoShare: sw.all.marketMinusFifo?.meanShare,
        ci95Share: sw.all.marketMinusFifo?.ci95Share,
        seasonsAheadOrLevel: (sw.all.marketMinusFifo?.seasonsAhead ?? 0) + (sw.all.marketMinusFifo?.seasonsLevel ?? 0),
        blindFeeBroken: sw.all.promisesBroken?.blindFee,
        marketNeverMovedLate: sw.all.promisesBroken?.marketOfThoseNeverMoved,
      };
    })(),
    run: {
      id: run,
      config: read(path.join(dir, "config.json")),
      // The run's own counts. `stats` in summary.json is the contract's lifetime counters, not this run's.
      summary: (() => {
        const sum = read(path.join(dir, "summary.json"));
        if (!sum) return null;
        const { stats: _lifetime, ...own } = sum;
        return own;
      })(),
      comparison: read(path.join(dir, "comparison.json")),
      decisions,
      refusals,
      // The refusal that protected another job's deadline, if an agent attempted such a jump in this run.
      safetyRefusal: events.filter((e) => e.ok === false && e.layer === "contract" && e.tx && /priority infeasible: displaced job/.test(String(e.error ?? ""))).map(pick).at(-1) ?? null,
      settlements,
    },
  };
}
