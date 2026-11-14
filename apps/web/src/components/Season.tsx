import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, ExternalLink, Loader2, ShieldCheck, Zap } from "lucide-react";
import { api } from "../lib/api";

/**
 * The v2 market on NEAR testnet. Contract state is read straight from testnet RPC in the
 * browser (no server in the loop); the season's agent decisions and the FIFO comparison come
 * from the run's public log via /api/season.
 */

/** Public testnet RPCs, rotated on failure (free tiers rate-limit). */
const RPCS = ["https://rpc.testnet.fastnear.com", "https://near-testnet.drpc.org", "https://archival-rpc.testnet.fastnear.com"];
let rpcIndex = 0;
const EXPLORER = "https://testnet.nearblocks.io";
const YOCTO = 1e24;

type Rec = Record<string, unknown>;

async function viewCall<T>(contractId: string, method: string, args: Rec = {}): Promise<T> {
  let last: unknown;
  for (let i = 0; i < RPCS.length; i += 1) {
    const url = RPCS[(rpcIndex + i) % RPCS.length];
    try {
      const v = await viewOnce<T>(url, contractId, method, args);
      rpcIndex = (rpcIndex + i) % RPCS.length;
      return v;
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error("testnet RPC unavailable");
}

async function viewOnce<T>(url: string, contractId: string, method: string, args: Rec): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(6000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: contractId,
        method_name: method,
        args_base64: btoa(JSON.stringify(args)),
      },
    }),
  });
  const j = (await r.json()) as { result?: { result?: number[] }; error?: unknown };
  if (!j.result?.result) throw new Error(`RPC ${method} failed`);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result))) as T;
}

const near = (y: unknown, dp = 4) => (Number(String(y ?? "0")) / YOCTO).toFixed(dp);
const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0));
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const txUrl = (h: unknown) => `${EXPLORER}/txns/${str(h)}`;
const TX = /^[1-9A-HJ-NP-Za-km-z]{32,60}$/;

const ACTION_LABEL: Record<string, string> = {
  submit: "submitted a job",
  set_ask: "changed its ask",
  buy_priority: "bought priority",
  cancel: "cancelled",
};

interface Live {
  stats: Rec;
  queue: Rec[];
  activity: Rec[];
  at: number;
}

/** How the rule was tested; the methods, commands and results are in docs/TESTING.md. */
const TESTED = [
  { label: "Random histories", value: "600", note: "money, deadline and order rules hold after every step" },
  { label: "Replay against an independent model", value: "24,866 steps", note: "every quote, refusal and balance agrees with the contract" },
  { label: "Simulated seasons", value: "300", note: "0 of 3,464 jobs moved by a purchase ended late" },
  { label: "Mutation testing", value: "92 of 95", note: "code changes caught by a test; the other 3 change nothing" },
  { label: "Planted bugs", value: "8 of 8", note: "caught by each of the three test suites on its own" },
  { label: "Code on chain", value: "= this repo", note: "rebuilt byte for byte by npm run verify:v2-deployed" },
];

export function Season() {
  const [season, setSeason] = useState<Rec | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [probe, setProbe] = useState<{ state: "idle" | "running" | "done" | "error"; text?: string; detail?: string }>({ state: "idle" });

  useEffect(() => {
    let alive = true;
    api
      .getSeason()
      .then((s) => alive && setSeason(s))
      .catch(() => alive && setSeason({ deployed: false }));
    return () => {
      alive = false;
    };
  }, []);

  const contract = isRec(season?.contract) ? season.contract : null;
  const contractId = str(contract?.contractId);
  const run = isRec(season?.run) ? season.run : null;

  // One poll at a time: a stalled RPC must not stack requests or let an old reading overwrite a newer one.
  const polling = useRef(false);
  const poll = useCallback(async () => {
    if (!contractId || polling.current) return;
    polling.current = true;
    try {
      const [stats, queue, activity] = await Promise.all([
        viewCall<Rec>(contractId, "get_stats"),
        viewCall<Rec[]>(contractId, "get_queue"),
        viewCall<Rec[]>(contractId, "get_activity", { limit: 8 }),
      ]);
      setLive({ stats, queue, activity, at: Date.now() });
      setLiveError(null);
    } catch {
      setLiveError("Testnet RPC is busy; showing the last reading.");
    } finally {
      polling.current = false;
    }
  }, [contractId]);

  useEffect(() => {
    if (!contractId) return;
    void poll();
    const t = window.setInterval(() => void poll(), 10_000);
    return () => window.clearInterval(t);
  }, [contractId, poll]);

  /** A read-only quote for the most deadline-tight jump available right now. */
  const tryUnsafe = useCallback(async () => {
    if (!contractId) return;
    setProbe({ state: "running" });
    try {
      const queue = await viewCall<Rec[]>(contractId, "get_queue");
      if (queue.length < 2) {
        const refusal = Array.isArray(run?.refusals) ? (run.refusals as Rec[]).at(-1) : undefined;
        setProbe({
          state: "done",
          text: "The queue is too short to jump right now.",
          detail: refusal ? `Last real refusal in the season: “${str(refusal.error)}”` : undefined,
        });
        return;
      }
      // Ask for the front slot: start no later than the head's projected start (the earliest any job can start).
      const last = queue[queue.length - 1];
      const front = num(queue[0].projected_start_at);
      const q = await viewCall<Rec>(contractId, "get_quote", { job_id: num(last.id), latest_start_at: front });
      const displaced = Array.isArray(q.displaced) ? (q.displaced as Rec[]) : [];
      const reason = str(q.reason);
      const safety = /^priority infeasible: displaced job/.test(reason) || /^displaced job/.test(reason);
      setProbe({
        state: "done",
        text: q.feasible
          ? `Job #${str(last.id)} could jump to the front: ${displaced.length} job${displaced.length === 1 ? "" : "s"} would be paid ${near(q.total, 5)} NEAR and every deadline still met.`
          : safety
            ? `Refused: ${reason}`
            : `Not possible right now: ${reason}`,
        detail: q.feasible
          ? "Every job it would pass has enough slack, so the contract would accept this purchase. This is a read-only quote; nothing was bought."
          : safety
            ? "This is the contract's own answer to “move job #" + str(last.id) + " to the front”, read from testnet. A purchase with these terms fails on chain because a job it passes would miss its deadline."
            : "The contract's quote, read from testnet. This refusal is not about another job's deadline (for example the buyer's own deadline is already out of reach).",
      });
    } catch (e) {
      setProbe({ state: "error", text: e instanceof Error ? e.message : "quote failed" });
    }
  }, [contractId, run]);

  const comparison = isRec(run?.comparison) ? run.comparison : null;
  const summary = isRec(run?.summary) ? run.summary : null;
  const config = isRec(run?.config) ? run.config : null;
  // Market moves first: purchases, then ask changes and cancels, then the rest; newest first within each.
  const decisions = useMemo(() => {
    const all = Array.isArray(run?.decisions) ? (run.decisions as Rec[]) : [];
    const rank = (d: Rec) => (d.action === "buy_priority" ? 0 : d.action === "set_ask" || d.action === "cancel" ? 1 : 2);
    return [...all].sort((a, b) => rank(a) - rank(b) || num(b.t) - num(a.t)).slice(0, 14);
  }, [run]);
  const refusals = Array.isArray(run?.refusals) ? (run.refusals as Rec[]) : [];
  const market = isRec(comparison?.market) ? comparison.market : null;
  const fifo = isRec(comparison?.fifo) ? comparison.fifo : null;
  const blind = isRec(comparison?.blindFee) ? comparison.blindFee : null;
  const safety = isRec(run?.safetyRefusal) ? run.safetyRefusal : null;
  const sweep = isRec(season?.sweep) ? season.sweep : null;
  const model = str(config?.model);
  const agents = isRec(contract?.agents) ? Object.entries(contract.agents as Rec) : [];

  if (!season) return null;
  // Shown once a finished season is featured (data/season/featured.json).
  if (season.deployed === false || !contractId || season.featured !== true) return null;

  return (
    <section className="season-section" id="season" aria-labelledby="season-heading">
      <div className="container">
        <header className="section-heading">
          <div>
            <p className="section-kicker">
              <span>04</span> Live season · NEAR testnet
            </p>
            <h2 id="season-heading">Eight agents, one worker, real money rules.</h2>
          </div>
          <p className="section-lede">
            {model
              ? `Each agent is a ${model} model on NEAR AI with a private budget, deadlines and task values. It decides what to charge for being moved and when to pay to jump. `
              : "Agents decided with the deterministic fallback policy in this run (no model key was set); every decision is labelled. "}
            Each signs with its own function-call key that can call five contract methods and spend only its balance in the contract. The worker answers each job on NEAR AI, and every delivered job was settled through the contract's check of the model's signature over that job's exact request.
          </p>
        </header>

        {market && (
          <p className="season-headline" role="note">
            <ShieldCheck size={16} aria-hidden="true" /> {num(market.purchases)} paid priority purchases moved {num(market.movedJobs)} jobs back. Each was paid its own posted price ({num(market.paidToMovedNear).toFixed(4)} NEAR in total) and {num(market.jumpedAndLate) === 0 ? "none of them ended late" : `${num(market.jumpedAndLate)} ended late`}. {num(market.attested)} of {num(market.jobs)} jobs settled with a model-signed answer the contract verified.
          </p>
        )}

        {market && fifo && blind && (
          <div className="season-table-wrap">
            <table className="season-table">
              <caption>Market = what ran on chain. FIFO and blind fee replay the same {num(market.jobs)} jobs with each job's real service time and the measured worker gap; within half a second of that gap the three are within a job or two of each other, so on throughput the market is level with FIFO. “Late, though on time under FIFO” counts promises a rule breaks. npm run verify:season recomputes all of it from chain data.</caption>
              <thead>
                <tr>
                  <th scope="col">Same {num(market.jobs)} jobs</th>
                  <th scope="col">On time</th>
                  <th scope="col">Value on time</th>
                  <th scope="col">Paid to jobs moved back</th>
                  <th scope="col">Late, though on time under FIFO</th>
                </tr>
              </thead>
              <tbody>
                <tr className="season-row-featured">
                  <th scope="row">QUEUE market (what ran)</th>
                  <td><strong>{num(market.onTime)}</strong></td>
                  <td>{num(market.valueOnTime).toFixed(2)} Ⓝ</td>
                  <td>{num(market.paidToMovedNear).toFixed(4)} Ⓝ</td>
                  <td>{num(market.onTimeUnderFifoButLate)}</td>
                </tr>
                <tr>
                  <th scope="row">FIFO</th>
                  <td>{num(fifo.onTime)}</td>
                  <td>{num(fifo.valueOnTime).toFixed(2)} Ⓝ</td>
                  <td>—</td>
                  <td>—</td>
                </tr>
                <tr>
                  <th scope="row">Blind priority fee</th>
                  <td>{num(blind.onTime)}</td>
                  <td>{num(blind.valueOnTime).toFixed(2)} Ⓝ</td>
                  <td>0 (fee goes to the operator)</td>
                  <td>{num(blind.promisesBroken)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}

        {sweep && (
          <p className="season-sweep" role="note">
            <strong>Beyond one season:</strong> the same rules, checked step by step against the contract, were simulated for {num(sweep.seasons)} seasons ({num(sweep.jobs).toLocaleString("en-US")} jobs).{" "}
            <strong>{num(sweep.movedJobsLate)} of {num(sweep.movedJobs).toLocaleString("en-US")}</strong> jobs moved by a purchase ended late. The market delivered{" "}
            <strong>{(num(sweep.marketMinusFifoShare) * 100).toFixed(1)}% more</strong> jobs on time than FIFO
            {Array.isArray(sweep.ci95Share) ? ` (95% CI ${(num(sweep.ci95Share[0]) * 100).toFixed(2)}–${(num(sweep.ci95Share[1]) * 100).toFixed(2)}%)` : ""}
            {num(sweep.seasonsAheadOrLevel) ? `, ahead of or level with it in ${num(sweep.seasonsAheadOrLevel)} of ${num(sweep.seasons)} seasons` : ""}. A blind priority fee makes{" "}
            <strong>{(num(sweep.blindFeeBroken) / Math.max(1, num(sweep.marketNeverMovedLate))).toFixed(1)}× more</strong> jobs late than the market does
            ({((num(sweep.blindFeeBroken) / Math.max(1, num(sweep.jobs))) * 100).toFixed(1)}% against{" "}
            {((num(sweep.marketNeverMovedLate) / Math.max(1, num(sweep.jobs))) * 100).toFixed(1)}% of the jobs FIFO delivers on time), and pays none of them. Scripted agent policy; reproduce with npm run season:sweep.
          </p>
        )}

        <div className="season-tested" aria-label="How the rule was tested">
          <div className="season-tested-head">
            <span className="mini-label">Tested the way protocol teams test</span>
            <span className="season-tested-doc">every command is in docs/TESTING.md</span>
          </div>
          <dl className="season-tested-grid">
            {TESTED.map((item) => (
              <div key={item.label}>
                <dt>{item.label}</dt>
                <dd>{item.value}</dd>
                <p>{item.note}</p>
              </div>
            ))}
          </dl>
        </div>

        <div className="season-grid">
          <div className="season-card">
            <div className="season-card-head">
              <span className="mini-label">The season on chain</span>
              <a href={`${EXPLORER}/address/${contractId}`} target="_blank" rel="noreferrer">
                {contractId} <ExternalLink size={12} aria-hidden="true" />
              </a>
            </div>
            {market && summary && (
              <dl className="season-stats">
                <div><dt>Jobs run</dt><dd>{num(market.jobs)}</dd></div>
                <div><dt>On time</dt><dd>{num(market.onTime)}</dd></div>
                <div><dt>Model-signed, verified</dt><dd>{num(market.attested)}</dd></div>
                <div><dt>Paid purchases</dt><dd>{num(market.purchases)}</dd></div>
                <div><dt>Paid to moved jobs, NEAR</dt><dd>{num(market.paidToMovedNear).toFixed(4)}</dd></div>
                <div><dt>Refused by contract</dt><dd>{num(summary.contractRefusals)}</dd></div>
              </dl>
            )}
            <p className="season-note" role="note">Counted from the contract's own job records by npm run verify:season. The queue below is read live from testnet.</p>
            {liveError && (
              <p className={live ? "season-note" : "season-error"}>
                <CircleAlert size={14} aria-hidden="true" /> {liveError}
              </p>
            )}
            {live ? (
              <>
                <p className="mini-label season-sub">Queue now · {live.queue.length} waiting{num(live.stats.running) ? " · 1 running" : ""}</p>
                <ol className="season-queue">
                  {live.queue.slice(0, 6).map((j) => (
                    <li key={str(j.id)}>
                      <span>#{str(j.id)}</span>
                      <span className="season-owner">{str(j.owner).split(".")[0]}</span>
                      <span>{num(j.duration_secs)}s</span>
                      <span>slack {num(j.deadline_at) - num(j.projected_finish_at)}s</span>
                      <span>ask {near(j.ask_per_sec, 5)}/s</span>
                    </li>
                  ))}
                  {!live.queue.length && <li className="season-empty">Empty: the season has ended.</li>}
                </ol>
              </>
            ) : (
              !liveError && <p className="season-loading"><Loader2 className="spin" size={14} aria-hidden="true" /> Reading testnet…</p>
            )}
            <div className="season-probe">
              <button type="button" className="button button-ghost button-small" onClick={() => void tryUnsafe()} disabled={probe.state === "running"}>
                <Zap size={14} aria-hidden="true" /> Try an unsafe jump
              </button>
              <div aria-live="polite">
                {probe.text && <p className={probe.text.startsWith("Refused") ? "season-refused" : ""}>{probe.text}</p>}
                {probe.detail && <p className="season-note">{probe.detail}</p>}
              </div>
            </div>
          </div>

          <div className="season-card">
            <div className="season-card-head">
              <span className="mini-label">What the agents decided</span>
              {summary && <span className="season-note">{num(summary.decisionsByModel)} of {num(summary.decisions)} decisions by the model</span>}
            </div>
            <ul className="season-feed">
              {decisions.map((d, i) => (
                <li key={i} className={d.ok === false ? "is-refused" : ""}>
                  <div className="season-feed-top">
                    <strong>{str(d.who)}</strong> {ACTION_LABEL[str(d.action)] ?? str(d.action)}
                    {d.job != null && <> · #{str(d.job)}</>}
                    {d.ok === false && <span className="season-badge refused">{d.layer === "contract" ? "refused by contract" : "blocked by runtime limit"}</span>}
                    {d.source === "fallback" && <span className="season-badge">fallback</span>}
                    {TX.test(str(d.tx)) && (
                      <a href={txUrl(d.tx)} target="_blank" rel="noreferrer" aria-label={`Transaction for ${str(d.who)} ${str(d.action)}`}>
                        tx <ExternalLink size={11} aria-hidden="true" />
                      </a>
                    )}
                  </div>
                  {d.reason ? <p>“{str(d.reason)}”</p> : null}
                  {d.ok === false && d.error ? <p className="season-refused">{str(d.error)}</p> : null}
                </li>
              ))}
              {!decisions.length && <li className="season-empty">No decisions recorded yet.</li>}
            </ul>
            {refusals.length > 0 && (
              <p className="season-note">
                {(() => {
                  // The API sends only the latest refusals; the run's own count is in its summary.
                  const n = summary && num(summary.contractRefusals) > 0 ? num(summary.contractRefusals) : refusals.length;
                  return `${n} refusal${n === 1 ? "" : "s"} in this run ${n === 1 ? "is a failed transaction" : "are failed transactions"} on testnet; npm run verify:season re-checks each one over RPC.`;
                })()}
              </p>
            )}
          </div>
        </div>

        {safety && (
          <p className="season-headline season-episode" role="note">
            <CircleAlert size={16} aria-hidden="true" /> {str(safety.who)}'s model tried to jump a job whose deadline could not absorb the delay. The contract refused it on chain: “{str(safety.error)}”{" "}
            {TX.test(str(safety.tx)) && (
              <a href={txUrl(safety.tx)} target="_blank" rel="noreferrer">
                tx <ExternalLink size={11} aria-hidden="true" />
              </a>
            )}
          </p>
        )}

        {agents.length > 0 && (
          <p className="season-note season-agents">
            Agents: {agents.map(([id, a]) => `${id} (${str(isRec(a) ? a.accountId : "")})`).join(" · ")}. Keys limited to submit_job, set_move_ask, request_priority, cancel_job, withdraw_credit.
            {Array.isArray(contract?.teeSigners) && (contract.teeSigners as unknown[]).length > 0 && ` Pinned NEAR AI signing keys: ${(contract.teeSigners as unknown[]).length} (the contract verifies the signature, not the hardware quote).`}
          </p>
        )}
      </div>
    </section>
  );
}
