import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Check,
  Copy,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  ServerOff,
  WifiOff,
} from "lucide-react";
import type { QueueState } from "@queue/core";
import { formatClock } from "@queue/core";
import type { ConnectionStatus } from "../hooks/useQueueState";
import { selectFocusJob } from "../lib/format";
import { Credits } from "./Credits";
import { Ledger } from "./Ledger";
import { PriorityTicket } from "./PriorityTicket";
import { QueueRail } from "./QueueRail";
import { WorkerPanel } from "./WorkerPanel";
import { BROWSER_BACKEND } from "../lib/backend";

interface LiveConsoleProps {
  state: QueueState | null;
  status: ConnectionStatus;
  error: string | null;
  updatedAt: number | null;
  refresh: () => Promise<QueueState | null>;
  reconnect: () => void;
  onRunScenario: () => void;
  onReset: () => void;
  runPending: boolean;
  resetPending: boolean;
  runError: string | null;
  resetError: string | null;
  onNewJob: () => void;
}

export function LiveConsole({
  state,
  status,
  error,
  updatedAt,
  refresh,
  reconnect,
  onRunScenario,
  onReset,
  runPending,
  resetPending,
  runError,
  resetError,
  onNewJob,
}: LiveConsoleProps) {
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  // A new session (reset or a fresh scenario) clears any manual pick, so the
  // ticket shows the new purchase receipt instead of a stale selection.
  const sessionId = state?.sessionId;
  useEffect(() => {
    setSelectedJobId(null);
  }, [sessionId]);
  const [copiedCommand, setCopiedCommand] = useState(false);

  const candidates =
    state?.queue.filter((job) => job.status === "queued" && !job.expedited) ?? [];
  const defaultJob = state ? selectFocusJob(candidates, state.running, state.now) : null;
  const effectiveSelected =
    candidates.find((job) => job.id === selectedJobId)?.id ?? defaultJob?.id ?? null;

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText("npm run dev");
      setCopiedCommand(true);
      window.setTimeout(() => setCopiedCommand(false), 2_000);
    } catch {
      setCopiedCommand(false);
    }
  };

  return (
    <section className="console-section" id="console" aria-labelledby="console-heading">
      <div className="container">
        <header className="section-heading console-heading">
          <div>
            <p className="section-kicker">
              <span>02</span> Operations console
            </p>
            <h2 id="console-heading">
              Watch a <em>promise</em> move.
            </h2>
            <p className="section-lede">
              The queue rail, the priority ticket and the worker all read one
              ledger snapshot. Buy a jump and watch every crossed deadline get
              paid — or refused.
            </p>
            <p className="section-lede console-host-note" role="note">
              <strong>This console is a simulation.</strong> It runs the
              contract's rules{" "}
              {BROWSER_BACKEND ? "in your browser tab" : "on the local API server"}{" "}
              and sends no blockchain transaction; the amounts are not real
              NEAR. The real transactions were made on NEAR testnet earlier:
              the <a href="#season">Season</a> and <a href="#proof">Proof</a>{" "}
              sections below link to each one.
            </p>
          </div>
          <div className="section-actions">
            <button
              type="button"
              className="button button-primary"
              onClick={onRunScenario}
              disabled={runPending || resetPending || status === "offline"}
            >
              {runPending ? (
                <Loader2 className="spin" size={16} aria-hidden="true" />
              ) : (
                <Play size={15} fill="currentColor" aria-hidden="true" />
              )}
              {runPending ? "Starting" : "Run scenario"}
            </button>
            <button
              type="button"
              className="button button-ghost"
              onClick={onReset}
              disabled={resetPending || runPending || !state}
            >
              {resetPending ? (
                <Loader2 className="spin" size={15} aria-hidden="true" />
              ) : (
                <RotateCcw size={14} aria-hidden="true" />
              )}
              {resetPending ? "Resetting" : "Reset"}
            </button>
            <button
              type="button"
              className="button button-ink"
              onClick={onNewJob}
              disabled={!state}
              aria-label="New job from the console header"
            >
              <Plus size={15} aria-hidden="true" />
              New job
            </button>
          </div>
        </header>

        {runError ? (
          <p className="form-error section-error" role="alert">
            {runError}
          </p>
        ) : null}
        {resetError ? (
          <p className="form-error section-error" role="alert">
            {resetError}
          </p>
        ) : null}

        {!state ? (
          status === "loading" ? (
            <ConsoleLoading />
          ) : (
            <ConsoleOffline
              error={error}
              copied={copiedCommand}
              onCopy={() => void copyCommand()}
              onRetry={reconnect}
            />
          )
        ) : (
          <div className="console-shell">
            <div className="console-topbar">
              <div className="console-identity">
                <span className="console-live-dot" data-status={status} aria-hidden="true" />
                <div>
                  <strong>Operations floor</strong>
                  <span>
                    {state.service.name} · {state.network.label}
                  </span>
                </div>
              </div>
              <div className="console-topbar-meta">
                <span className="console-session mono">
                  session {state.sessionId.slice(0, 8)}
                </span>
                <span className="console-status" data-status={status}>
                  {status === "live"
                    ? BROWSER_BACKEND
                      ? "In-tab live"
                      : "SSE live"
                    : status === "polling"
                      ? "Polling · 4s fallback"
                      : status === "offline"
                        ? "Offline"
                        : "Connecting"}
                </span>
                <span className="console-snapshot mono">
                  {formatClock(state.now)} UTC
                </span>
              </div>
            </div>

            {state.scenario.steps.length > 0 ? (
              <div className="scenario-strip" aria-label="Scenario progress">
                <div className="scenario-label">
                  <span
                    className="scenario-dot"
                    data-active={state.scenario.status === "running"}
                    aria-hidden="true"
                  />
                  <strong>{state.scenario.name}</strong>
                  <span>{state.scenario.status === "running" ? state.scenario.phase : state.scenario.status}</span>
                </div>
                <ol>
                  {state.scenario.steps.map((step) => (
                    <li key={step.key} data-done={step.done}>
                      <span className="scenario-step-mark" aria-hidden="true">
                        {step.done ? <Check size={10} /> : null}
                      </span>
                      {step.label}
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}

            <AnimatePresence initial={false}>
              {status === "offline" || status === "loading" ? (
                <motion.div
                  className="stale-banner"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  role="status"
                >
                  <WifiOff size={14} aria-hidden="true" />
                  <span>
                    {status === "offline" ? "Connection lost." : "Reconnecting."} Showing the
                    last snapshot
                    {updatedAt ? ` received at ${formatClock(updatedAt)}` : ""}.
                  </span>
                  <button type="button" className="text-button" onClick={reconnect}>
                    <RefreshCw size={12} aria-hidden="true" />
                    Retry
                  </button>
                </motion.div>
              ) : null}
            </AnimatePresence>

            <div className="console-grid">
              <div className="grid-queue">
                <QueueRail
                  state={state}
                  refresh={refresh}
                  onFocusJob={setSelectedJobId}
                  focusJobId={effectiveSelected}
                  onNewJob={onNewJob}
                />
              </div>
              <div className="grid-priority">
                <PriorityTicket
                  state={state}
                  selectedJobId={effectiveSelected}
                  userPicked={selectedJobId !== null}
                  onSelectJob={setSelectedJobId}
                  refresh={refresh}
                />
              </div>
              <div className="grid-worker">
                <WorkerPanel
                  state={state}
                  onRunScenario={onRunScenario}
                  runPending={runPending}
                />
              </div>
              <div className="grid-credits">
                <Credits state={state} refresh={refresh} />
              </div>
              <div className="grid-ledger">
                <Ledger state={state} />
              </div>
            </div>

            <footer className="console-foot">
              <span>
                {BROWSER_BACKEND
                  ? "Source of truth: the ledger engine in this tab. The view only renders its snapshots."
                  : "Source of truth: server snapshots. Actions never mutate the queue locally."}
              </span>
              <span className="mono">
                schema v{state.schemaVersion} · fee {state.service.feeBps} bps
              </span>
            </footer>
          </div>
        )}
      </div>
    </section>
  );
}

function ConsoleLoading() {
  return (
    <div className="console-shell console-loading" aria-busy="true" aria-live="polite">
      <div className="console-topbar">
        <div className="console-identity">
          <span className="console-live-dot" data-status="loading" aria-hidden="true" />
          <div>
            <strong>Operations floor</strong>
            <span>Connecting to the local API…</span>
          </div>
        </div>
        <span className="console-status" data-status="loading">
          Loading snapshot
        </span>
      </div>
      <div className="console-grid">
        <div className="panel skeleton-panel grid-queue">
          <span className="skeleton-line skeleton-short" />
          <span className="skeleton-line" />
          <span className="skeleton-line" />
        </div>
        <div className="panel skeleton-panel grid-priority">
          <span className="skeleton-line skeleton-short" />
          <span className="skeleton-line" />
        </div>
        <div className="panel skeleton-panel grid-worker">
          <span className="skeleton-line skeleton-short" />
          <span className="skeleton-line" />
        </div>
        <div className="panel skeleton-panel grid-credits">
          <span className="skeleton-line skeleton-short" />
        </div>
      </div>
    </div>
  );
}

function ConsoleOffline({
  error,
  copied,
  onCopy,
  onRetry,
}: {
  error: string | null;
  copied: boolean;
  onCopy: () => void;
  onRetry: () => void;
}) {
  return (
    <div className="console-offline">
      <div className="offline-main">
        <div className="offline-mark" aria-hidden="true">
          <ServerOff size={26} />
        </div>
        <div className="offline-copy">
          <p className="section-kicker">
            <span>Offline</span> No live data
          </p>
          <h3>API not running.</h3>
          <p>
            The console refuses to invent a queue. Start the API and the worker
            from the repository root, then reconnect. The scenario takes about 18
            seconds.
          </p>
          <div className="command-block">
            <code>npm run dev</code>
            <button
              type="button"
              className="copy-button"
              onClick={onCopy}
              aria-label="Copy npm run dev"
            >
              {copied ? (
                <Check size={14} aria-hidden="true" />
              ) : (
                <Copy size={14} aria-hidden="true" />
              )}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="offline-meta mono">
            Console :4178 · API :8789 · same-origin /api
          </p>
          {error ? <p className="form-error">{error}</p> : null}
          <button type="button" className="button button-ink" onClick={onRetry}>
            <RefreshCw size={14} aria-hidden="true" />
            Retry connection
          </button>
        </div>
      </div>
      <ol className="offline-steps" aria-label="How to start the console">
        <li>
          <span>01</span>
          <div>
            <strong>Start the stack</strong>
            <p>One command starts the API on 8789 and Vite on 4178.</p>
          </div>
        </li>
        <li>
          <span>02</span>
          <div>
            <strong>Run the scenario</strong>
            <p>
              Four agents queue work, one urgent job buys ahead, every promise is
              checked.
            </p>
          </div>
        </li>
        <li>
          <span>03</span>
          <div>
            <strong>Read the ledger</strong>
            <p>Compensation, fees, artifact hashes and credits stay explicit.</p>
          </div>
        </li>
      </ol>
    </div>
  );
}
