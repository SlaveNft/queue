import type { CSSProperties } from "react";
import clsx from "clsx";
import { motion } from "framer-motion";
import { CircleDot, Clock3 } from "lucide-react";
import {
  formatClock,
  formatDuration,
  projectSchedule,
  type QueueState,
} from "@queue/core";
import type { ConnectionStatus } from "../hooks/useQueueState";
import { formatNearSafe, initials } from "../lib/format";

interface QueueDiagramProps {
  state: QueueState | null;
  status: ConnectionStatus;
}

interface DiagramRow {
  id: string;
  title: string;
  owner: string;
  color: string;
  startAt: number;
  finishAt: number;
  deadlineAt?: number;
  durationSec: number;
  urgent: boolean;
  expedited: boolean;
  running: boolean;
  progress?: number;
  amountYocto?: string;
}

const PREVIEW_ROWS: DiagramRow[] = [
  {
    id: "preview-kestrel",
    title: "Checkout latency spike",
    owner: "Kestrel",
    color: "#FF5A36",
    startAt: 0,
    finishAt: 12_000,
    deadlineAt: 34_000,
    durationSec: 12,
    urgent: true,
    expedited: true,
    running: false,
  },
  {
    id: "preview-mira",
    title: "Incident triage",
    owner: "Mira",
    color: "#3157FF",
    startAt: 12_000,
    finishAt: 22_000,
    deadlineAt: 58_000,
    durationSec: 10,
    urgent: false,
    expedited: false,
    running: false,
  },
  {
    id: "preview-atlas",
    title: "Revenue audit",
    owner: "Atlas",
    color: "#7C8B5B",
    startAt: 22_000,
    finishAt: 31_000,
    deadlineAt: 70_000,
    durationSec: 9,
    urgent: false,
    expedited: false,
    running: false,
  },
  {
    id: "preview-vale",
    title: "Launch brief",
    owner: "Vale",
    color: "#B07A3A",
    startAt: 31_000,
    finishAt: 42_000,
    deadlineAt: 96_000,
    durationSec: 11,
    urgent: false,
    expedited: false,
    running: false,
  },
];

function liveRows(state: QueueState): DiagramRow[] {
  const slots = projectSchedule(state.queue, state.running, state.now);
  const rows: DiagramRow[] = [];

  if (state.running) {
    const progress = state.running.startedAt
      ? Math.min(
          1,
          Math.max(
            0,
            (state.now - state.running.startedAt) /
              (state.running.durationSec * 1000),
          ),
        )
      : 0;
    rows.push({
      id: state.running.id,
      title: state.running.title,
      owner:
        state.agents.find((agent) => agent.id === state.running?.ownerId)?.name ??
        state.running.ownerId,
      color:
        state.agents.find((agent) => agent.id === state.running?.ownerId)?.color ??
        "#FFFFFF",
      startAt: state.running.startedAt ?? state.now,
      finishAt:
        (state.running.startedAt ?? state.now) + state.running.durationSec * 1000,
      deadlineAt: state.running.deadlineAt,
      durationSec: state.running.durationSec,
      urgent: state.running.expedited && state.running.deadlineAt > state.now,
      expedited: state.running.expedited,
      running: true,
      progress,
    });
  }

  for (const [index, job] of state.queue.slice(0, 5).entries()) {
    const slot = slots[index];
    if (!slot) continue;
    const agent = state.agents.find((entry) => entry.id === job.ownerId);
    rows.push({
      id: job.id,
      title: job.title,
      owner: agent?.name ?? job.ownerId,
      color: agent?.color ?? "#FFFFFF",
      startAt: slot.startAt,
      finishAt: slot.finishAt,
      deadlineAt: job.deadlineAt,
      durationSec: job.durationSec,
      urgent:
        job.deadlineAt > state.now &&
        (job.expedited || slot.finishAt > job.deadlineAt),
      expedited: job.expedited,
      running: false,
      amountYocto:
        job.movedCompensationYocto && job.movedCompensationYocto !== "0"
          ? job.movedCompensationYocto
          : undefined,
    });
  }

  return rows;
}

export function QueueDiagram({ state, status }: QueueDiagramProps) {
  const hasState = Boolean(state);
  const stale = Boolean(state && status === "offline");

  let rows: DiagramRow[];
  let startAt: number;
  let spanMs: number;

  if (state) {
    rows = liveRows(state);
    startAt = state.now;
    const maxFinish = Math.max(
      ...rows.map((row) => row.finishAt),
      state.now + 20_000,
    );
    const nearDeadline = rows.reduce((latest, row) => {
      if (row.deadlineAt === undefined) return latest;
      const ahead = row.deadlineAt - state.now;
      return ahead > 0 && ahead <= 120_000
        ? Math.max(latest, row.deadlineAt)
        : latest;
    }, 0);
    spanMs = Math.min(
      180_000,
      Math.max(maxFinish, nearDeadline) - state.now + 3_000,
    );
  } else {
    rows = PREVIEW_ROWS;
    startAt = 0;
    spanMs = 48_000;
  }

  const label = hasState
    ? stale
      ? "Last snapshot"
      : "Live queue model"
    : "Illustrative schedule";
  const hiddenCount = state ? Math.max(0, state.queue.length - 5) : 0;

  return (
    <figure className="queue-diagram" aria-label={label}>
      <div className="diagram-head">
        <div>
          <span className="diagram-kicker">
            <Clock3 size={12} aria-hidden="true" /> One worker · FIFO
          </span>
          <h2>{label}</h2>
        </div>
        <span
          className="diagram-status"
          data-live={hasState && !stale}
          data-stale={stale}
        >
          <CircleDot size={11} aria-hidden="true" />
          {hasState ? (stale ? "Offline" : "Live") : "Preview"}
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="diagram-empty">
          <span className="diagram-empty-mark" aria-hidden="true" />
          <h3>The floor is clear.</h3>
          <p>
            No queued work in the latest snapshot. Submit a job to see projected
            starts and deadline ticks here.
          </p>
        </div>
      ) : (
        <>
          <div className="diagram-axis" aria-hidden="true">
            <span>{hasState ? formatClock(startAt) : "now"}</span>
            <span>{hasState ? formatClock(startAt + spanMs) : "window"}</span>
          </div>

          <ol className="diagram-rows">
            {rows.map((row, index) => {
          const left = Math.max(
            0,
            Math.min(96, ((row.startAt - (hasState ? startAt : 0)) / spanMs) * 100),
          );
          const width = Math.max(5, Math.min(100 - left, (row.durationSec * 1000 / spanMs) * 100));
          const deadline =
            row.deadlineAt !== undefined
              ? ((row.deadlineAt - (hasState ? startAt : 0)) / spanMs) * 100
              : null;
          const showDeadline = deadline !== null && deadline > 1 && deadline < 99;

          return (
            <li
              key={row.id}
              className={clsx("diagram-row", {
                "is-urgent": row.urgent,
                "is-running": row.running,
              })}
              data-index={index}
            >
              <div className="diagram-row-top">
                <span className="diagram-owner">
                  <span
                    className="minor-avatar"
                    style={{ "--avatar": row.color } as CSSProperties}
                    aria-hidden="true"
                  >
                    {initials(row.owner)}
                  </span>
                  <span className="diagram-owner-name">{row.owner}</span>
                </span>
                <span className="diagram-title">{row.title}</span>
                <span className="diagram-time">
                  {row.running
                    ? "running"
                    : hasState
                      ? formatClock(row.startAt)
                      : `T+${Math.round(row.startAt / 1000)}s`}
                  <span> · {formatDuration(row.durationSec)}</span>
                </span>
              </div>
              <div className="diagram-track">
                <motion.span
                  className="diagram-bar"
                  initial={{ scaleX: 0 }}
                  animate={{ scaleX: 1 }}
                  transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1], delay: index * 0.05 }}
                  style={{
                    left: `${left}%`,
                    width: `${width}%`,
                    backgroundColor: row.urgent ? "var(--urgent)" : row.color,
                    transformOrigin: "left center",
                  }}
                >
                  {row.running && row.progress !== undefined ? (
                    <span
                      className="diagram-progress"
                      style={{ width: `${row.progress * 100}%` }}
                    />
                  ) : null}
                  {row.urgent ? (
                    <motion.span
                      className="diagram-signal"
                      animate={{ opacity: [0.5, 1, 0.5] }}
                      transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
                    />
                  ) : null}
                </motion.span>
                {showDeadline ? (
                  <span
                    className={clsx("deadline-tick", { "is-urgent": row.urgent })}
                    style={{ left: `${deadline}%` }}
                    title={`Deadline ${formatClock(row.deadlineAt ?? 0)} UTC`}
                  >
                    {row.urgent ? <span className="deadline-label">deadline</span> : null}
                  </span>
                ) : null}
              </div>
              {row.amountYocto ? (
                <span className="diagram-payout">
                  +{formatNearSafe(row.amountYocto)} for the move
                </span>
              ) : null}
            </li>
          );
        })}
          </ol>
          {hiddenCount > 0 ? (
            <p className="diagram-more">
              +{hiddenCount} more job{hiddenCount === 1 ? "" : "s"} in the queue ·
              see the console for every position
            </p>
          ) : null}
        </>
      )}

      <figcaption className="diagram-caption">
        {stale
          ? "Connection lost. This is the last snapshot received from the server."
          : hasState
            ? rows.length === 0
              ? "No queued work in the latest snapshot. The console is ready for the next arrival."
              : "Projected from the latest snapshot. Each tick is a deadline the protocol refuses to break."
            : "A schematic of the market. Start the API to replace every bar with live data."}
      </figcaption>
    </figure>
  );
}
