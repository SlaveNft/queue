import { useState } from "react";
import type { FormEvent } from "react";
import clsx from "clsx";
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  Loader2,
  PencilLine,
  Play,
  Plus,
  X,
} from "lucide-react";
import {
  STATUS_LABELS,
  formatClock,
  formatDuration,
  formatNear,
  parseNear,
  projectSchedule,
  type Job,
  type QueueState,
} from "@queue/core";
import { useUtcNow } from "../hooks/useUtcNow";
import { api, apiErrorMessage } from "../lib/api";
import {
  deadlineTone,
  formatAskPerSec,
  formatNearSafe,
  progressOf,
  slackSeconds,
} from "../lib/format";
import { AgentAvatar } from "./AgentAvatar";

interface QueueRailProps {
  state: QueueState;
  refresh: () => Promise<unknown>;
  onFocusJob: (id: string) => void;
  focusJobId: string | null;
  onNewJob: () => void;
}

function ownerOf(state: QueueState, job: Job) {
  return state.agents.find((agent) => agent.id === job.ownerId);
}

function statusLabel(job: Job): string {
  return STATUS_LABELS[job.status] ?? job.status;
}

export function QueueRail({
  state,
  refresh,
  onFocusJob,
  focusJobId,
  onNewJob,
}: QueueRailProps) {
  const clock = useUtcNow(1_000);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [askJobId, setAskJobId] = useState<string | null>(null);
  const [askValue, setAskValue] = useState("");
  const [askPending, setAskPending] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [cancelJobId, setCancelJobId] = useState<string | null>(null);
  const [cancelPending, setCancelPending] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const slots = projectSchedule(state.queue, state.running, state.now);
  const urgentJob =
    state.queue.find((job) => job.expedited && job.deadlineAt > state.now) ??
    state.queue.find((job, index) => {
      const slot = slots[index];
      return job.deadlineAt > state.now && slot ? slot.finishAt > job.deadlineAt : false;
    }) ??
    null;
  const maxDuration = Math.max(1, ...state.queue.map((job) => job.durationSec));
  const queuedSeconds = state.queue.reduce((sum, job) => sum + job.durationSec, 0);
  const allExpired =
    state.queue.length > 0 && state.queue.every((job) => job.deadlineAt <= state.now);

  const startHead = async () => {
    setStarting(true);
    setStartError(null);
    try {
      await api.startNext();
      await refresh();
    } catch (caught) {
      setStartError(apiErrorMessage(caught));
    } finally {
      setStarting(false);
    }
  };

  const beginAsk = (job: Job) => {
    setAskJobId(job.id);
    setAskValue(formatNear(job.askPerSecYocto, { minDecimals: 0, maxDecimals: 6, symbol: false }));
    setAskError(null);
    setCancelJobId(null);
    setCancelError(null);
  };

  const submitAsk = async (event: FormEvent, job: Job) => {
    event.preventDefault();
    setAskError(null);
    let amount: bigint;
    try {
      amount = parseNear(askValue);
    } catch (caught) {
      setAskError(caught instanceof Error ? caught.message : "Enter a valid ask.");
      return;
    }
    if (amount <= 0n) {
      setAskError("The ask must be greater than zero.");
      return;
    }
    setAskPending(true);
    try {
      await api.moveAsk(job.id, askValue.trim());
      setAskJobId(null);
      await refresh();
    } catch (caught) {
      setAskError(apiErrorMessage(caught));
    } finally {
      setAskPending(false);
    }
  };

  const cancelJob = async (job: Job) => {
    setCancelPending(true);
    setCancelError(null);
    try {
      await api.cancelJob(job.id);
      setCancelJobId(null);
      await refresh();
    } catch (caught) {
      setCancelError(apiErrorMessage(caught));
    } finally {
      setCancelPending(false);
    }
  };

  const running = state.running;
  const runningProgress = running ? progressOf(running, clock) : 0;
  const runningAgent = running ? ownerOf(state, running) : null;

  return (
    <section className="panel queue-panel" aria-labelledby="queue-heading">
      <header className="panel-head queue-head">
        <div>
          <span className="panel-kicker">Work in order</span>
          <h3 id="queue-heading">
            The queue <span className="count-mark">{state.queue.length}</span>
          </h3>
        </div>
        <div className="queue-head-actions">
          <span className="queue-workload mono">≈ {formatDuration(queuedSeconds)} queued</span>
          {!running && state.queue.length > 0 ? (
            <button
              type="button"
              className="button button-small button-ghost"
              onClick={() => void startHead()}
              disabled={starting || state.scenario.status === "running"}
              title={
                state.scenario.status === "running"
                  ? "The scenario starts the head itself."
                  : "Start the head of the queue"
              }
            >
              {starting ? (
                <Loader2 className="spin" size={14} aria-hidden="true" />
              ) : (
                <Play size={13} fill="currentColor" aria-hidden="true" />
              )}
              Start head
            </button>
          ) : null}
          <button
            type="button"
            className="button button-small button-ink"
            onClick={onNewJob}
            aria-label="New job from the queue panel"
          >
            <Plus size={14} aria-hidden="true" />
            New job
          </button>
        </div>
      </header>

      {startError ? (
        <p className="form-error panel-error" role="alert">
          {startError}
        </p>
      ) : null}

      {allExpired ? (
        <p className="queue-notice" role="status">
          <span className="status-dot" aria-hidden="true" />
          These queued deadlines have passed. Start the live scenario to reset
          the market; the protocol will not rewrite a missed promise.
        </p>
      ) : null}

      <LayoutGroup>
        <div className="queue-list">
          <AnimatePresence initial={false}>
            {running ? (
              <motion.article
                key={running.id}
                layout="position"
                className={clsx("queue-card queue-card-running", {
                  "is-urgent": running.expedited,
                })}
                data-urgent={running.expedited || undefined}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
              >
                <div className="job-topline">
                  <span className="job-position job-position-live">NOW</span>
                  <AgentAvatar
                    name={runningAgent?.name ?? running.ownerId}
                    color={runningAgent?.color}
                  />
                  <div className="job-copy">
                    <div className="job-title-row">
                      <h4 title={running.title}>{running.title}</h4>
                      <span className="badge badge-live">
                        <span className="status-dot" aria-hidden="true" />
                        Running
                      </span>
                      {running.expedited ? <span className="badge badge-urgent">Priority</span> : null}
                    </div>
                    <p className="job-owner">
                      {runningAgent?.name ?? running.ownerId}
                      <span> {runningAgent?.handle ?? `@${running.ownerId}`}</span>
                      <span className="dot-sep">·</span>
                      {runningAgent?.role ?? "owner"}
                    </p>
                  </div>
                  <span className="job-duration mono">{formatDuration(running.durationSec)}</span>
                </div>

                <div className="running-progress">
                  <div className="running-progress-meta">
                    <span>
                      Worker 01 · <span className="mono">{Math.round(runningProgress * 100)}%</span>
                    </span>
                    <span className="mono">
                      {runningProgress >= 1
                        ? "Finishing"
                        : `${Math.max(
                            0,
                            Math.ceil(
                              running.durationSec -
                                (clock - (running.startedAt ?? clock)) / 1000,
                            ),
                          )}s remaining`}
                    </span>
                  </div>
                  <div
                    className="progress-track"
                    role="progressbar"
                    aria-label={`${running.title} progress`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(runningProgress * 100)}
                  >
                    <motion.span
                      className="progress-fill"
                      animate={{ width: `${runningProgress * 100}%` }}
                      transition={{ duration: 0.4, ease: "linear" }}
                    />
                  </div>
                </div>

                <dl className="job-metrics">
                  <div>
                    <dt>Started</dt>
                    <dd>{running.startedAt ? formatClock(running.startedAt) : "—"}</dd>
                  </div>
                  <div>
                    <dt>Deadline</dt>
                    <dd>{formatClock(running.deadlineAt)}</dd>
                  </div>
                  <div>
                    <dt>Reward</dt>
                    <dd>{formatNearSafe(running.rewardYocto)}</dd>
                  </div>
                  <div>
                    <dt>Ask</dt>
                    <dd>{formatAskPerSec(running.askPerSecYocto)}</dd>
                  </div>
                </dl>
              </motion.article>
            ) : null}

            {state.queue.map((job, index) => {
              const slot = slots[index];
              const agent = ownerOf(state, job);
              const tone = slot ? deadlineTone(job.deadlineAt, slot.finishAt) : "met";
              const slack = slot ? slackSeconds(job.deadlineAt, slot.finishAt) : 0;
              const isUrgent = job.expedited || urgentJob?.id === job.id;
              const compensation =
                job.movedCompensationYocto && job.movedCompensationYocto !== "0"
                  ? job.movedCompensationYocto
                  : null;
              const isFocused = focusJobId === job.id;
              const askOpen = askJobId === job.id;
              const cancelOpen = cancelJobId === job.id;

              return (
                <motion.article
                  key={job.id}
                  layout="position"
                  className={clsx("queue-card", {
                    "is-urgent": isUrgent,
                    "is-displaced": Boolean(compensation),
                    "is-focused": isFocused,
                  })}
                  data-urgent={isUrgent || undefined}
                  data-displaced={compensation ? true : undefined}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.98 }}
                  transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                >
                  <div className="job-topline">
                    <span className="job-position">{String(index + 1).padStart(2, "0")}</span>
                    <AgentAvatar name={agent?.name ?? job.ownerId} color={agent?.color} />
                    <div className="job-copy">
                      <div className="job-title-row">
                        <h4 title={job.title}>{job.title}</h4>
                        {isUrgent ? (
                          <span className="badge badge-urgent">
                            {job.expedited ? "Priority" : "Urgent"}
                          </span>
                        ) : null}
                        {compensation ? (
                          <span className="badge badge-paid">
                            <Check size={11} aria-hidden="true" />
                            Paid
                          </span>
                        ) : null}
                        <span className="badge badge-status" data-status={job.status}>
                          {statusLabel(job)}
                        </span>
                      </div>
                      <p className="job-owner">
                        {agent?.name ?? job.ownerId}
                        <span> {agent?.handle ?? `@${job.ownerId}`}</span>
                        <span className="dot-sep">·</span>
                        {agent?.role ?? "owner"}
                        <span className="dot-sep">·</span>
                        {job.id}
                      </p>
                    </div>
                    <div className="job-duration-block">
                      <span className="job-duration mono">{formatDuration(job.durationSec)}</span>
                      <span className="duration-bar" aria-hidden="true">
                        <span style={{ width: `${(job.durationSec / maxDuration) * 100}%` }} />
                      </span>
                    </div>
                  </div>

                  <dl className="job-metrics">
                    <div>
                      <dt>Projected start</dt>
                      <dd>{slot ? formatClock(slot.startAt) : "—"}</dd>
                    </div>
                    <div>
                      <dt>Finish</dt>
                      <dd>{slot ? formatClock(slot.finishAt) : "—"}</dd>
                    </div>
                    <div>
                      <dt>Deadline</dt>
                      <dd className={`deadline-value tone-${tone}`}>
                        {formatClock(job.deadlineAt)}
                        <span className="metric-sub">
                          {tone === "late"
                            ? `${Math.abs(slack)}s over`
                            : `${slack}s slack`}
                        </span>
                      </dd>
                    </div>
                    <div>
                      <dt>Ask / sec</dt>
                      <dd>{formatAskPerSec(job.askPerSecYocto)}</dd>
                    </div>
                  </dl>

                  {compensation ? (
                    <p className="job-payout">
                      <span className="payout-mark" aria-hidden="true" />
                      Moved back {formatDuration(job.moves[0]?.delaySec ?? job.durationSec)} · paid{" "}
                      <strong>+{formatNearSafe(compensation)}</strong> by the urgent job
                    </p>
                  ) : null}

                  {job.expedited && job.prioritySpendYocto !== "0" ? (
                    <p className="job-payout job-payout-urgent">
                      Bought an earlier slot for {formatNearSafe(job.prioritySpendYocto)}
                      {job.priorityId ? ` · ${job.priorityId}` : ""}
                    </p>
                  ) : null}

                  <div className="job-actions">
                    {!job.expedited ? (
                      <button
                        type="button"
                        className={clsx("job-action", { "is-active": isFocused })}
                        onClick={() => onFocusJob(job.id)}
                        aria-pressed={isFocused}
                        aria-label={
                          isFocused
                            ? `In priority ticket: ${job.id}, ${job.title}`
                            : `Quote priority for ${job.id}: ${job.title}`
                        }
                      >
                        <ArrowUpRight size={13} aria-hidden="true" />
                        {isFocused ? "In priority ticket" : "Quote priority"}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="job-action"
                      onClick={() => beginAsk(job)}
                      aria-label={`Change ask for ${job.id}: ${job.title}`}
                    >
                      <PencilLine size={12} aria-hidden="true" />
                      Move ask
                    </button>
                    <button
                      type="button"
                      className="job-action job-action-danger"
                      onClick={() => {
                        setCancelJobId(job.id);
                        setCancelError(null);
                        setAskJobId(null);
                      }}
                      aria-label={`Cancel ${job.id}: ${job.title}`}
                    >
                      <X size={13} aria-hidden="true" />
                      Cancel
                    </button>
                  </div>

                  <AnimatePresence initial={false}>
                    {askOpen ? (
                      <motion.form
                        className="job-inline-form"
                        onSubmit={(event) => void submitAsk(event, job)}
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.2 }}
                      >
                        <label htmlFor={`ask-${job.id}`}>New ask per second</label>
                        <div className="inline-input-row">
                          <div className="input-with-suffix">
                            <input
                              id={`ask-${job.id}`}
                              value={askValue}
                              onChange={(event) => setAskValue(event.target.value)}
                              inputMode="decimal"
                              autoComplete="off"
                              autoFocus
                              aria-label={`New ask per second for ${job.id}: ${job.title}`}
                            />
                            <span>NEAR/s</span>
                          </div>
                          <button
                            type="submit"
                            className="button button-small button-primary"
                            disabled={askPending}
                            aria-label={`Save ask for ${job.id}: ${job.title}`}
                          >
                            {askPending ? <Loader2 className="spin" size={13} /> : null}
                            Save ask
                          </button>
                          <button
                            type="button"
                            className="button button-small button-ghost"
                            onClick={() => setAskJobId(null)}
                            disabled={askPending}
                            aria-label={`Close ask editor for ${job.id}: ${job.title}`}
                          >
                            Close
                          </button>
                        </div>
                        {askError ? (
                          <p className="form-error" role="alert">
                            {askError}
                          </p>
                        ) : null}
                      </motion.form>
                    ) : null}
                  </AnimatePresence>

                  <AnimatePresence initial={false}>
                    {cancelOpen ? (
                      <motion.div
                        className="job-inline-form cancel-confirm"
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.2 }}
                      >
                        <p>
                          Cancel this job?{" "}
                          {job.expedited
                            ? "It already bought priority: the full bond is forfeited."
                            : "25% of the bond is forfeited; 75% is refunded."}
                        </p>
                        <div className="inline-input-row">
                          <button
                            type="button"
                            className="button button-small button-danger"
                            onClick={() => void cancelJob(job)}
                            disabled={cancelPending}
                            aria-label={`Cancel job ${job.id}: ${job.title}`}
                          >
                            {cancelPending ? <Loader2 className="spin" size={13} /> : null}
                            Cancel job
                          </button>
                          <button
                            type="button"
                            className="button button-small button-ghost"
                            onClick={() => setCancelJobId(null)}
                            disabled={cancelPending}
                            aria-label={`Keep it: ${job.id}, ${job.title}`}
                          >
                            Keep it
                          </button>
                        </div>
                        {cancelError ? (
                          <p className="form-error" role="alert">
                            {cancelError}
                          </p>
                        ) : null}
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                </motion.article>
              );
            })}
          </AnimatePresence>
        </div>
      </LayoutGroup>

      {state.queue.length === 0 ? (
        <div className="queue-empty">
          <div className="queue-empty-graphic" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </div>
          <div>
            <h4>The queue is clear.</h4>
            <p>
              The worker has nothing scheduled. Submit a job, or let the scenario
              build the market for you.
            </p>
          </div>
          <button type="button" className="button button-small button-ghost" onClick={onNewJob}>
            Submit a job
            <ChevronRight size={14} aria-hidden="true" />
          </button>
        </div>
      ) : null}

      <footer className="panel-foot queue-foot">
        <span>
          <span className="legend-swatch legend-urgent" aria-hidden="true" /> Urgent
        </span>
        <span>
          <span className="legend-swatch legend-paid" aria-hidden="true" /> Moved &amp; paid
        </span>
        <span className="queue-foot-note">
          Positions update from the ledger snapshot.
        </span>
      </footer>
    </section>
  );
}
