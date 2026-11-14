import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  Check,
  ClipboardCheck,
  Copy,
  FileText,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  formatClock,
  formatDuration,
  type Artifact,
  type QueueState,
} from "@queue/core";
import { useUtcNow } from "../hooks/useUtcNow";
import { api, apiErrorMessage } from "../lib/api";
import {
  formatNearSafe,
  formatUtcStamp,
  humanizeEventType,
  progressOf,
} from "../lib/format";
import { AgentAvatar } from "./AgentAvatar";

interface WorkerPanelProps {
  state: QueueState;
  onRunScenario: () => void;
  runPending: boolean;
}

const MARKDOWN_COMPONENTS: Components = {
  h1: ({ children }) => <h2>{children}</h2>,
};

function startedLabel(at: number | undefined): string {
  return at ? `${formatClock(at)} UTC` : "—";
}

function computedLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  return ms >= 1_000 ? `${(ms / 1_000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

export function WorkerPanel({ state, onRunScenario, runPending }: WorkerPanelProps) {
  const clock = useUtcNow(500);
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [artifactLoading, setArtifactLoading] = useState(false);
  const [artifactError, setArtifactError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  const artifactJob = useMemo(() => {
    const withArtifacts = state.recent
      .filter((job) => Boolean(job.artifactId))
      .sort(
        (left, right) =>
          (right.finishedAt ?? right.submittedAt) - (left.finishedAt ?? left.submittedAt),
      );
    return withArtifacts[0] ?? null;
  }, [state.recent]);

  const displayJob = state.running ?? artifactJob;
  const artifactId = displayJob?.artifactId;
  const progress = displayJob ? progressOf(displayJob, clock) : 0;
  const elapsed =
    displayJob?.startedAt && displayJob.status === "running"
      ? Math.max(0, (clock - displayJob.startedAt) / 1_000)
      : null;
  const remaining =
    elapsed !== null && displayJob
      ? Math.max(0, Math.ceil(displayJob.durationSec - elapsed))
      : null;

  const events = useMemo(() => {
    if (!displayJob) return [];
    return state.activity
      .filter((event) => event.jobId === displayJob.id)
      .slice()
      .sort((left, right) => {
        if (left.at !== right.at) return left.at - right.at;
        return Number(left.id.replace(/\D/g, "")) - Number(right.id.replace(/\D/g, ""));
      })
      .slice(-6);
  }, [state.activity, displayJob]);

  const owner = displayJob
    ? state.agents.find((agent) => agent.id === displayJob.ownerId)
    : null;

  useEffect(() => {
    if (!artifactId) {
      setArtifact(null);
      setArtifactLoading(false);
      setArtifactError(null);
      return;
    }
    let cancelled = false;
    setArtifact(null);
    setArtifactLoading(true);
    setArtifactError(null);
    void (async () => {
      try {
        const next = await api.getArtifact(artifactId);
        if (!cancelled) setArtifact(next);
      } catch (caught) {
        if (!cancelled) setArtifactError(apiErrorMessage(caught));
      } finally {
        if (!cancelled) setArtifactLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [artifactId, retryKey]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2_200);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copyHash = async () => {
    if (!artifact) return;
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(artifact.sha256);
      setCopied(true);
    } catch {
      setCopyError("Clipboard access failed. Select the hash to copy it manually.");
    }
  };

  const statusText = state.running
    ? "Computing"
    : artifact
      ? "Delivered"
      : artifactLoading
        ? "Fetching"
        : "Idle";

  return (
    <section className="panel worker-panel" aria-labelledby="worker-heading">
      <header className="panel-head worker-head">
        <div>
          <span className="panel-kicker">The computation</span>
          <h3 id="worker-heading">
            Worker <span className="serif-accent">01</span>
          </h3>
        </div>
        <span className="worker-status" data-status={state.running ? "running" : "idle"}>
          <span className="status-dot" aria-hidden="true" />
          {statusText}
        </span>
      </header>

      {!displayJob ? (
        <div className="worker-empty">
          <div className="worker-empty-graphic" aria-hidden="true">
            <span className="worker-paper" />
            <span className="worker-scan" />
            <span className="worker-hash">a4f9…2c81</span>
          </div>
          <h4>The worker is idle.</h4>
          <p>
            Start a queued job, or run the live scenario. Execution is real: the
            worker computes the artifact from the submitted input and records a
            SHA-256 of the output.
          </p>
          <button
            type="button"
            className="button button-small button-ghost"
            onClick={onRunScenario}
            disabled={runPending || !state}
            aria-label="Run the live scenario from the worker panel"
          >
            {runPending ? (
              <Loader2 className="spin" size={14} aria-hidden="true" />
            ) : null}
            Run the live scenario
          </button>
        </div>
      ) : (
        <div className="worker-body">
          <div className="worker-now">
            <div className="worker-job-copy">
              <span className="mini-label">
                {state.running ? "Now on the worker" : "Last delivery"}
              </span>
              <h4>{displayJob.title}</h4>
              <p>
                <AgentAvatar
                  name={owner?.name ?? displayJob.ownerId}
                  color={owner?.color}
                  size="sm"
                />
                {owner?.name ?? displayJob.ownerId}
                <span> · {displayJob.id} · task {displayJob.task}</span>
              </p>
            </div>
            <div className="worker-percent" aria-label={`${Math.round(progress * 100)} percent complete`}>
              <strong>{Math.round(progress * 100)}%</strong>
              <span>
                {remaining !== null
                  ? `${remaining}s left`
                  : displayJob.status === "done"
                    ? "delivered"
                    : displayJob.status}
              </span>
            </div>
          </div>

          <div
            className="progress-track worker-progress"
            role="progressbar"
            aria-label={`${displayJob.title} worker progress`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
          >
            <motion.span
              className="progress-fill"
              animate={{ width: `${Math.max(2, progress * 100)}%` }}
              transition={{ duration: 0.4, ease: "linear" }}
            />
          </div>

          <dl className="worker-meta">
            <div>
              <dt>Started</dt>
              <dd>{startedLabel(displayJob.startedAt)}</dd>
            </div>
            <div>
              <dt>Deadline</dt>
              <dd>{formatClock(displayJob.deadlineAt)} UTC</dd>
            </div>
            <div>
              <dt>Quoted duration</dt>
              <dd>{formatDuration(displayJob.durationSec)}</dd>
            </div>
            <div>
              <dt>Reward</dt>
              <dd>{formatNearSafe(displayJob.rewardYocto)}</dd>
            </div>
          </dl>

          <div className="phase-log">
            <div className="mini-label">
              Phase log <span>{events.length ? "ledger events" : "awaiting events"}</span>
            </div>
            {events.length > 0 ? (
              <ol>
                {events.map((event) => (
                  <li key={event.id}>
                    <span className="phase-time mono">{formatClock(event.at)}</span>
                    <span className="phase-dot" aria-hidden="true" />
                    <div>
                      <strong>{humanizeEventType(event.type)}</strong>
                      <span>{event.summary}</span>
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="phase-empty">
                This job has no ledger events yet. The worker will log each phase
                as it runs.
              </p>
            )}
          </div>

          {state.running ? (
            <div className="artifact-placeholder">
              <div className="artifact-placeholder-head">
                <FileText size={15} aria-hidden="true" />
                Artifact pending
              </div>
              <p>
                The worker is computing from the submitted input. The Markdown
                artifact and its SHA-256 appear here when the job finishes.
              </p>
              <span className="skeleton-line" aria-hidden="true" />
              <span className="skeleton-line skeleton-short" aria-hidden="true" />
            </div>
          ) : artifactLoading ? (
            <div className="artifact-placeholder" aria-live="polite">
              <div className="artifact-placeholder-head">
                <Loader2 className="spin" size={15} aria-hidden="true" />
                Fetching artifact
              </div>
              <span className="skeleton-line" aria-hidden="true" />
              <span className="skeleton-line skeleton-short" aria-hidden="true" />
            </div>
          ) : artifactError ? (
            <div className="artifact-error" role="alert">
              <p>{artifactError}</p>
              <button
                type="button"
                className="button button-small button-ghost"
                onClick={() => setRetryKey((value) => value + 1)}
              >
                <RefreshCw size={13} aria-hidden="true" />
                Retry artifact
              </button>
            </div>
          ) : artifact ? (
            <article className="artifact-card" aria-labelledby="artifact-title">
              <header className="artifact-head">
                <div>
                  <span className="mini-label">Artifact · {artifact.id}</span>
                  <h4 id="artifact-title">{artifact.title}</h4>
                </div>
                <span className="artifact-time">
                  {formatUtcStamp(artifact.createdAt)}
                  <span> · computed in {computedLabel(artifact.durationMs)}</span>
                </span>
              </header>

              {artifact.checks.length > 0 ? (
                <ul className="artifact-checks">
                  {artifact.checks.map((check) => (
                    <li
                      key={check.key}
                      data-ok={check.ok}
                      title={check.detail}
                      aria-label={`${check.ok ? "Passed" : "Not met"}: ${check.label}. ${check.detail}`}
                    >
                      {check.ok ? (
                        <Check size={12} aria-hidden="true" />
                      ) : (
                        <X size={12} aria-hidden="true" />
                      )}
                      {check.label}
                    </li>
                  ))}
                </ul>
              ) : null}

              <div className="artifact-markdown">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={MARKDOWN_COMPONENTS}
                >
                  {artifact.markdown}
                </ReactMarkdown>
              </div>

              <footer className="artifact-hash">
                <span className="hash-icon" aria-hidden="true">
                  <ClipboardCheck size={15} />
                </span>
                <div>
                  <span className="mini-label">SHA-256 of output</span>
                  <code title={artifact.sha256}>{artifact.sha256}</code>
                </div>
                <button
                  type="button"
                  className="copy-button"
                  onClick={() => void copyHash()}
                  aria-label="Copy SHA-256 hash"
                >
                  {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </footer>
              {copyError ? (
                <p className="form-error" role="alert">
                  {copyError}
                </p>
              ) : null}
            </article>
          ) : (
            <div className="artifact-placeholder">
              <div className="artifact-placeholder-head">
                <FileText size={15} aria-hidden="true" />
                No artifact on this job
              </div>
              <p>
                The job did not return an artifact reference. Nothing is being
                fabricated to fill the space.
              </p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
