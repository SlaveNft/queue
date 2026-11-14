import { Check, Clock3, ExternalLink, ShieldCheck, X } from "lucide-react";
import type { Job, QueueState } from "@queue/core";
import { formatNearSafe } from "../lib/format";
import { useOnchainTwin } from "../lib/onchain";
import { AgentAvatar } from "./AgentAvatar";

/**
 * The latest priority purchase, read from job state: who bought, what it cost,
 * and whether every agent it moved still made its own deadline. Shown in place
 * of the quote form until the viewer picks a job to quote.
 */
export function latestPurchase(state: QueueState): { urgent: Job; displaced: Job[] } | null {
  const jobs = [state.running, ...state.queue, ...state.recent].filter(
    (job): job is Job => Boolean(job),
  );
  const urgent = jobs
    .filter((job) => job.expedited && job.priorityId)
    .sort((a, b) => (b.priorityId ?? "").localeCompare(a.priorityId ?? ""))[0];
  if (!urgent) return null;
  const displaced = jobs
    .filter((job) => job.moves.some((move) => move.byJobId === urgent.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (displaced.length === 0) return null;
  return { urgent, displaced };
}

function promiseState(job: Job, now: number): { label: string; tone: "ok" | "wait" | "bad" } {
  if (job.status === "done" && job.finishedAt !== undefined) {
    return { label: `delivered ${Math.round((job.deadlineAt - job.finishedAt) / 1000)}s early`, tone: "ok" };
  }
  if (job.status === "missed" || job.status === "failed") return { label: "missed", tone: "bad" };
  if (job.status === "running") return { label: "running now", tone: "wait" };
  return { label: `waiting · deadline in ${Math.max(0, Math.round((job.deadlineAt - now) / 1000))}s`, tone: "wait" };
}

interface PurchaseReceiptProps {
  state: QueueState;
  urgent: Job;
  displaced: Job[];
  onQuoteAnother: (() => void) | null;
}

export function PurchaseReceipt({ state, urgent, displaced, onQuoteAnother }: PurchaseReceiptProps) {
  const buyer = state.agents.find((agent) => agent.id === urgent.ownerId);
  const paidTo = (job: Job) =>
    job.moves.filter((move) => move.byJobId === urgent.id).reduce((sum, move) => sum + BigInt(move.amountYocto), 0n);
  const compensation = displaced.reduce((sum, job) => sum + paidTo(job), 0n);
  const kept = displaced.filter((job) => job.status === "done").length;
  const broken = displaced.filter((job) => job.status === "missed" || job.status === "failed").length;
  const settled = kept + broken === displaced.length;
  const twin = useOnchainTwin();
  const sameAmount = twin?.prioritySpendYocto != null && twin.prioritySpendYocto === urgent.prioritySpendYocto;

  return (
    <div className="receipt">
      <div className="mini-label">
        Last purchase <span>{urgent.priorityId}</span>
      </div>
      <div className="ticket-job-line">
        <AgentAvatar name={buyer?.name ?? urgent.ownerId} color={buyer?.color} size="sm" />
        <div>
          <strong>{urgent.title}</strong>
          <span>
            {buyer?.name ?? urgent.ownerId} · {urgent.id} · {urgent.durationSec}s ·{" "}
            {urgent.status === "done" ? "delivered" : urgent.status}
          </span>
        </div>
      </div>

      <div className="displaced-block">
        <div className="mini-label">
          Agents it passed <span>each paid its own ask × {urgent.durationSec}s</span>
        </div>
        <ul className="displaced-list">
          {displaced.map((job) => {
            const agent = state.agents.find((entry) => entry.id === job.ownerId);
            const promise = promiseState(job, state.now);
            return (
              <li key={job.id}>
                <AgentAvatar name={agent?.name ?? job.ownerId} color={agent?.color} size="sm" />
                <div className="displaced-copy">
                  <strong>{agent?.name ?? job.ownerId}</strong>
                  <span>
                    {job.id} · {job.title}
                  </span>
                </div>
                <div className="displaced-numbers">
                  <strong>+{formatNearSafe(paidTo(job).toString())}</strong>
                  <span className={promise.tone === "bad" ? "tone-tight" : undefined}>
                    {promise.tone === "ok" ? (
                      <Check size={11} aria-hidden="true" />
                    ) : promise.tone === "bad" ? (
                      <X size={11} aria-hidden="true" />
                    ) : (
                      <Clock3 size={11} aria-hidden="true" />
                    )}{" "}
                    {promise.label}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <dl className="money-lines">
        <div>
          <dt>Paid to the agents it passed</dt>
          <dd>{formatNearSafe(compensation.toString())}</dd>
        </div>
        <div className="money-total">
          <dt>Paid by {buyer?.name ?? "the buyer"}</dt>
          <dd>{formatNearSafe(urgent.prioritySpendYocto)}</dd>
        </div>
      </dl>

      <p className={broken > 0 ? "quote-reason is-infeasible" : "quote-reason"}>
        <ShieldCheck size={14} aria-hidden="true" />
        {settled
          ? broken === 0
            ? `${kept} of ${displaced.length} crossed promises kept: every agent that sold its slot delivered before its own deadline.`
            : `${broken} of ${displaced.length} crossed promises broken.`
          : `${kept} of ${displaced.length} delivered so far; the rest are still inside their deadlines.`}
      </p>

      {twin?.priorityTxUrl ? (
        <div className="receipt-chain">
          <div className="mini-label">
            On NEAR testnet <span>same scenario, same amounts</span>
          </div>
          <p>
            {sameAmount
              ? `The same scenario, with the same amounts, was settled on testnet. This click is a local ledger entry; the tx is separate.${
                  twin.deliveredOnTime > 1 ? ` All ${twin.deliveredOnTime} jobs of that run were delivered on chain before their deadlines.` : ""
                }`
              : "This console is a local replay. The scripted run of the same scenario was settled by the contract on NEAR testnet. The click and the transaction are separate."}
          </p>
          <ul className="receipt-chain-links">
            <li>
              <a href={twin.priorityTxUrl} target="_blank" rel="noreferrer">
                Priority purchase tx <ExternalLink size={11} aria-hidden="true" />
              </a>
            </li>
            {twin.withdrawTxUrl ? (
              <li>
                <a href={twin.withdrawTxUrl} target="_blank" rel="noreferrer">
                  A displaced agent withdraws its pay <ExternalLink size={11} aria-hidden="true" />
                </a>
              </li>
            ) : null}
            {twin.refusalTxUrl ? (
              <li>
                <a href={twin.refusalTxUrl} target="_blank" rel="noreferrer">
                  A jump the contract refused <ExternalLink size={11} aria-hidden="true" />
                </a>
              </li>
            ) : null}
            <li>
              <a href={twin.contractUrl} target="_blank" rel="noreferrer" title={twin.contractId}>
                The contract <ExternalLink size={11} aria-hidden="true" />
              </a>
            </li>
          </ul>
        </div>
      ) : null}

      {onQuoteAnother ? (
        <button type="button" className="button button-ghost receipt-next" onClick={onQuoteAnother}>
          Quote another job
        </button>
      ) : null}
    </div>
  );
}
