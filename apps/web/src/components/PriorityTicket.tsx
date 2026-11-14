import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, FormEvent } from "react";
import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleAlert,
  Loader2,
  ShieldCheck,
  Ticket,
  X,
} from "lucide-react";
import {
  formatClock,
  formatNear,
  parseNear,
  projectSchedule,
  type QueueState,
  type Quote,
} from "@queue/core";
import { api, apiErrorMessage } from "../lib/api";
import { clamp, formatAskPerSec, formatNearSafe, slackSeconds } from "../lib/format";
import { AgentAvatar } from "./AgentAvatar";
import { PurchaseReceipt, latestPurchase } from "./PurchaseReceipt";

interface PriorityTicketProps {
  state: QueueState;
  selectedJobId: string | null;
  /** True once the viewer picked a job themselves; until then a recent purchase shows as a receipt. */
  userPicked?: boolean;
  onSelectJob: (id: string) => void;
  refresh: () => Promise<unknown>;
}

function editableNear(yocto: string): string {
  try {
    return formatNear(yocto, { minDecimals: 0, maxDecimals: 12, symbol: false });
  } catch {
    return "";
  }
}

function agentFor(state: QueueState, ownerId: string) {
  return state.agents.find((agent) => agent.id === ownerId);
}

export function PriorityTicket({
  state,
  selectedJobId,
  userPicked = false,
  onSelectJob,
  refresh,
}: PriorityTicketProps) {
  const candidates = state.queue.filter(
    (job) => job.status === "queued" && !job.expedited,
  );
  const job = candidates.find((entry) => entry.id === selectedJobId) ?? candidates[0] ?? null;
  const baseline = projectSchedule(state.queue, state.running, state.now);
  const baselineStart = job
    ? baseline.find((slot) => slot.jobId === job.id)?.startAt ?? null
    : null;
  const maxLatestSec = job
    ? Math.max(
        1,
        Math.floor((job.deadlineAt - state.now) / 1000) - job.durationSec,
      )
    : 1;
  const expired = Boolean(job && job.deadlineAt <= state.now);

  const [latestStart, setLatestStart] = useState(5);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quotePending, setQuotePending] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [maxSpend, setMaxSpend] = useState("");
  const [maxSpendTouched, setMaxSpendTouched] = useState(false);
  const [buying, setBuying] = useState(false);
  const [buyError, setBuyError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ totalYocto: string; displaced: number } | null>(
    null,
  );

  const effectiveLatest = clamp(latestStart, 1, maxLatestSec);

  const queueSignature = useMemo(
    () =>
      [
        ...state.queue.map(
          (entry) =>
            `${entry.id}:${entry.status}:${entry.durationSec}:${entry.deadlineAt}:${entry.askPerSecYocto}`,
        ),
        state.running ? `run:${state.running.id}:${state.running.startedAt ?? 0}` : "run:none",
      ].join("|"),
    [state.queue, state.running],
  );

  useEffect(() => {
    if (!job) return;
    setLatestStart(Math.max(1, Math.min(5, maxLatestSec)));
    setMaxSpendTouched(false);
    setMaxSpend("");
    setQuote(null);
    setQuoteError(null);
    setBuyError(null);
    // Reset only when the selected job changes, not on every clock tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id]);

  useEffect(() => {
    if (latestStart > maxLatestSec) setLatestStart(maxLatestSec);
  }, [latestStart, maxLatestSec]);

  useEffect(() => {
    if (!job || expired) {
      setQuote(null);
      setQuotePending(false);
      setQuoteError(null);
      return;
    }
    let cancelled = false;
    setQuotePending(true);
    setQuoteError(null);

    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const next = await api.getQuote(job.id, effectiveLatest);
          if (cancelled || next.jobId !== job.id) return;
          setQuote(next);
        } catch (caught) {
          if (cancelled) return;
          setQuote(null);
          setQuoteError(apiErrorMessage(caught));
        } finally {
          if (!cancelled) setQuotePending(false);
        }
      })();
    }, 260);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [job, effectiveLatest, queueSignature, expired]);

  useEffect(() => {
    if (!quote || maxSpendTouched) return;
    setMaxSpend(editableNear(quote.totalYocto));
  }, [quote, maxSpendTouched]);

  const maxSpendValid = useMemo(() => {
    if (!quote) return false;
    try {
      return parseNear(maxSpend) >= BigInt(quote.totalYocto);
    } catch {
      return false;
    }
  }, [maxSpend, quote]);

  const maxSpendError = useMemo(() => {
    if (!quote) return null;
    let total = 0n;
    try {
      total = BigInt(quote.totalYocto);
    } catch {
      return null;
    }
    if (quote.displaced.length === 0 || total <= 0n) return null;
    if (!maxSpend.trim()) {
      return maxSpendTouched ? "Enter a max spend before buying." : null;
    }
    if (maxSpendValid) return null;
    return `Enter at least ${formatNearSafe(quote.totalYocto)}.`;
  }, [maxSpend, maxSpendTouched, maxSpendValid, quote]);

  const needsPurchase = useMemo(() => {
    if (!quote) return false;
    try {
      return quote.displaced.length > 0 && BigInt(quote.totalYocto) > 0n;
    } catch {
      return false;
    }
  }, [quote]);

  const buy = async (event: FormEvent) => {
    event.preventDefault();
    if (!job || !quote || !needsPurchase) return;
    setBuying(true);
    setBuyError(null);
    setSuccess(null);
    try {
      const result = await api.buyPriority(job.id, effectiveLatest, maxSpend.trim());
      setSuccess({
        totalYocto: result.priority?.totalYocto ?? quote.totalYocto,
        displaced: result.priority?.displaced.length ?? quote.displaced.length,
      });
      await refresh();
    } catch (caught) {
      setBuyError(apiErrorMessage(caught));
    } finally {
      setBuying(false);
    }
  };

  const feePercent = `${(state.service.feeBps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
  const quoteHasStart = Boolean(quote && quote.insertIndex >= 0 && quote.projectedStartAt > 0);
  const moveSeconds =
    quote && quoteHasStart && baselineStart !== null
      ? Math.max(0, Math.round((baselineStart - quote.projectedStartAt) / 1000))
      : null;
  const projectedSlack =
    quote && quoteHasStart ? slackSeconds(job?.deadlineAt ?? 0, quote.projectedFinishAt) : null;

  const purchase = userPicked ? null : latestPurchase(state);
  if (purchase) {
    const next = candidates[0];
    return (
      <section
        className="panel priority-panel"
        id="priority-ticket"
        aria-labelledby="priority-heading"
      >
        <header className="panel-head priority-head">
          <div>
            <span className="panel-kicker">Buy an earlier slot</span>
            <h3 id="priority-heading">
              Priority <span className="serif-accent">receipt</span>
            </h3>
          </div>
          <span className="ticket-stub" aria-hidden="true">
            <Ticket size={15} />
          </span>
        </header>
        <PurchaseReceipt
          state={state}
          urgent={purchase.urgent}
          displaced={purchase.displaced}
          onQuoteAnother={next ? () => onSelectJob(next.id) : null}
        />
      </section>
    );
  }

  return (
    <section
      className="panel priority-panel"
      id="priority-ticket"
      aria-labelledby="priority-heading"
    >
      <header className="panel-head priority-head">
        <div>
          <span className="panel-kicker">Buy an earlier slot</span>
          <h3 id="priority-heading">
            Priority <span className="serif-accent">ticket</span>
          </h3>
        </div>
        <span className="ticket-stub" aria-hidden="true">
          <Ticket size={15} />
        </span>
      </header>

      <AnimatePresence initial={false}>
        {success ? (
          <motion.p
            className="success-banner"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            role="status"
          >
            <Check size={14} aria-hidden="true" />
            Priority purchased for {formatNearSafe(success.totalYocto)}
            {success.displaced > 0
              ? ` · ${success.displaced} agent${success.displaced === 1 ? "" : "s"} paid`
              : ""}
          </motion.p>
        ) : null}
      </AnimatePresence>

      {!job ? (
        <div className="ticket-empty">
          <span className="ticket-empty-icon" aria-hidden="true">
            <Ticket size={22} />
          </span>
          <h4>No ticket available.</h4>
          <p>
            Every queued job already holds priority, or the queue is empty. New
            work can be quoted the moment it arrives.
          </p>
        </div>
      ) : (
        <>
          <div className="ticket-controls">
            <div className="field">
              <label htmlFor="ticket-job">Job to expedite</label>
              <div className="select-wrap">
                <select
                  id="ticket-job"
                  value={job.id}
                  onChange={(event) => {
                    setQuote(null);
                    setQuoteError(null);
                    setSuccess(null);
                    onSelectJob(event.target.value);
                  }}
                  disabled={buying}
                >
                  {candidates.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.id} — {entry.title}
                    </option>
                  ))}
                </select>
                <ChevronDown size={15} aria-hidden="true" />
              </div>
            </div>

            {!expired ? (
              <div className="latest-control">
                <div className="latest-head">
                  <label htmlFor="latest-start">Latest start</label>
                  <output htmlFor="latest-start" className="latest-value mono">
                    +{effectiveLatest}s · {formatClock(state.now + effectiveLatest * 1000)}
                  </output>
                </div>
                <input
                  id="latest-start"
                  type="range"
                  min={1}
                  max={Math.max(1, maxLatestSec)}
                  step={1}
                  value={effectiveLatest}
                  onChange={(event) => setLatestStart(Number(event.target.value))}
                  disabled={buying}
                  style={
                    {
                      "--range-progress": `${((effectiveLatest - 1) / Math.max(1, maxLatestSec - 1)) * 100}%`,
                    } as CSSProperties
                  }
                />
                <div className="latest-scale">
                  <span>now</span>
                  <span>deadline − duration</span>
                </div>
              </div>
            ) : null}
          </div>

          <div className="ticket-job-line">
            <AgentAvatar
              name={agentFor(state, job.ownerId)?.name ?? job.ownerId}
              color={agentFor(state, job.ownerId)?.color}
              size="sm"
            />
            <div>
              <strong>{job.title}</strong>
              <span>
                {job.id} · {job.durationSec}s · deadline {formatClock(job.deadlineAt)} UTC ·
                ask {formatAskPerSec(job.askPerSecYocto)}
              </span>
            </div>
          </div>

          {expired ? (
            <div className="ticket-expired" role="status">
              <CircleAlert size={15} aria-hidden="true" />
              <div>
                <strong>This deadline has already passed.</strong>
                <p>
                  The protocol cannot move a promise it already missed. Run the
                  live scenario to reset the market, or submit a new job.
                </p>
              </div>
            </div>
          ) : null}

          {quoteError ? (
            <div className="form-error quote-error" role="alert">
              <CircleAlert size={14} aria-hidden="true" />
              <span>{quoteError}</span>
            </div>
          ) : null}

          {quotePending && !quote ? (
            <div className="quote-loading" aria-live="polite">
              <Loader2 className="spin" size={15} aria-hidden="true" />
              Pricing the jump…
            </div>
          ) : null}

          {quote ? (
            <>
              <div className="quote-stats">
                <div>
                  <span>Projected start</span>
                  <strong>{quoteHasStart ? formatClock(quote.projectedStartAt) : "—"}</strong>
                  <small>
                    {!quote.feasible
                      ? "no feasible start"
                      : moveSeconds && moveSeconds > 0
                        ? `${moveSeconds}s earlier`
                        : "already fits the cutoff"}
                  </small>
                </div>
                <div>
                  <span>Deadline</span>
                  <strong>{formatClock(job.deadlineAt)}</strong>
                  <small>
                    {quoteHasStart && projectedSlack !== null
                      ? `${projectedSlack}s slack after the move`
                      : "no feasible finish"}
                  </small>
                </div>
                <div>
                  <span>Displaced</span>
                  <strong>
                    {quote.displaced.length}
                    <span className="quote-stat-unit">
                      {quote.displaced.length === 1 ? " agent" : " agents"}
                    </span>
                  </strong>
                  <small>
                    {quote.insertIndex >= 0
                      ? `insert at position ${String(quote.insertIndex + 1).padStart(2, "0")}`
                      : "no feasible insertion"}
                  </small>
                </div>
              </div>

              <p className={clsx("quote-reason", { "is-infeasible": !quote.feasible })}>
                {quote.feasible ? <ShieldCheck size={14} aria-hidden="true" /> : <X size={14} aria-hidden="true" />}
                {quote.reason}
              </p>

              {quote.displaced.length > 0 ? (
                <div className="displaced-block">
                  <div className="mini-label">
                    Displaced agents <span>paid for {job.durationSec}s of delay</span>
                  </div>
                  <ul className="displaced-list">
                    {quote.displaced.map((entry) => {
                      const agent = agentFor(state, entry.ownerId);
                      const tight = entry.slackSec <= 5;
                      return (
                        <li key={entry.jobId}>
                          <AgentAvatar
                            name={agent?.name ?? entry.ownerId}
                            color={agent?.color}
                            size="sm"
                          />
                          <div className="displaced-copy">
                            <strong>{agent?.name ?? entry.ownerId}</strong>
                            <span>
                              {entry.jobId} · {entry.title}
                            </span>
                          </div>
                          <div className="displaced-numbers">
                            <strong>+{formatNearSafe(entry.amountYocto)}</strong>
                            <span className={tight ? "tone-tight" : undefined}>
                              {entry.slackSec}s slack
                            </span>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : null}

              <div className="ticket-checks">
                <div className="mini-label">Checks</div>
                <ul>
                  {quote.checks.map((check) => (
                    <li key={check.key} data-ok={check.ok}>
                      {check.ok ? (
                        <Check size={13} aria-hidden="true" />
                      ) : (
                        <X size={13} aria-hidden="true" />
                      )}
                      <div>
                        <strong>{check.label}</strong>
                        <span>{check.detail}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>

              <form className="ticket-purchase" onSubmit={(event) => void buy(event)}>
                {needsPurchase ? (
                  <dl className="money-lines">
                    <div>
                      <dt>Compensation</dt>
                      <dd>{formatNearSafe(quote.compensationYocto)}</dd>
                    </div>
                    <div>
                      <dt>Protocol fee <span>{feePercent}</span></dt>
                      <dd>{formatNearSafe(quote.feeYocto)}</dd>
                    </div>
                    <div className="money-total">
                      <dt>Total attached</dt>
                      <dd>{formatNearSafe(quote.totalYocto)}</dd>
                    </div>
                  </dl>
                ) : null}

                {needsPurchase ? (
                  <div className="field max-spend-field">
                    <label htmlFor="max-spend">Max spend</label>
                    <div className="input-with-suffix">
                      <input
                        id="max-spend"
                        value={maxSpend}
                        onChange={(event) => {
                          setMaxSpend(event.target.value);
                          setMaxSpendTouched(true);
                        }}
                        inputMode="decimal"
                        autoComplete="off"
                        aria-invalid={Boolean(maxSpendError)}
                        aria-describedby="max-spend-hint max-spend-error"
                        disabled={buying}
                      />
                      <span>NEAR</span>
                    </div>
                    <p className="field-hint" id="max-spend-hint">
                      Attach at least the total. Any excess becomes a withdrawable credit.
                    </p>
                    {maxSpendError ? (
                      <p className="field-error" id="max-spend-error" role="alert">
                        {maxSpendError}
                      </p>
                    ) : null}
                  </div>
                ) : null}

                <button
                  type="submit"
                  className="button button-primary ticket-buy"
                  disabled={
                    buying ||
                    quotePending ||
                    !quote.feasible ||
                    !needsPurchase ||
                    !maxSpendValid ||
                    !maxSpend.trim()
                  }
                >
                  {buying ? (
                    <Loader2 className="spin" size={16} aria-hidden="true" />
                  ) : !quote.feasible ? (
                    <X size={16} aria-hidden="true" />
                  ) : needsPurchase ? (
                    <ArrowUpRight size={16} aria-hidden="true" />
                  ) : (
                    <Check size={16} aria-hidden="true" />
                  )}
                  {buying
                    ? "Buying the slot"
                    : !quote.feasible
                      ? "No feasible slot"
                      : needsPurchase
                        ? "Buy earlier slot"
                        : "No purchase needed"}
                </button>
                <p className="ticket-fine-print">
                  {!quote.feasible
                    ? "The cutoff cannot be met from this queue state. Move the latest start later, or choose another job."
                    : needsPurchase
                      ? "Excess becomes a withdrawable credit. Displaced agents receive pull-payment credits immediately; their new finishes are checked before purchase."
                      : "This job already starts before the requested cutoff. Keep its place, or tighten the cutoff to price a jump."}
                </p>

                {buyError ? (
                  <p className="form-error" role="alert">
                    {buyError}
                  </p>
                ) : null}
              </form>
            </>
          ) : null}
        </>
      )}
    </section>
  );
}
