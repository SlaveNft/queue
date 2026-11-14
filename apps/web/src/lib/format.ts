import {
  formatClock,
  formatNear,
  formatDuration,
  type FormatNearOptions,
  type Job,
} from "@queue/core";

export type DeadlineTone = "met" | "tight" | "late";

export function formatNearSafe(
  yocto: string | undefined,
  options: FormatNearOptions = {},
): string {
  if (!yocto) return "—";
  try {
    return formatNear(yocto, { minDecimals: 2, maxDecimals: 8, ...options });
  } catch {
    return "—";
  }
}

export function formatAskPerSec(yocto: string | undefined): string {
  if (!yocto) return "—";
  try {
    return `${formatNear(yocto, { minDecimals: 0, maxDecimals: 6, symbol: false })} NEAR/s`;
  } catch {
    return "—";
  }
}

export function initials(name: string): string {
  const clean = name.trim();
  if (!clean) return "··";
  return clean
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function formatRelative(at: number, now: number): string {
  const diff = Math.round((now - at) / 1000);
  if (!Number.isFinite(diff)) return "—";
  if (diff > 0 && diff < 5) return "just now";
  if (diff < 60 && diff >= 0) return `${diff}s ago`;
  if (diff < 0) {
    const ahead = Math.abs(diff);
    if (ahead < 60) return `in ${ahead}s`;
    if (ahead < 3600) return `in ${Math.round(ahead / 60)}m`;
    return `in ${formatDuration(ahead)}`;
  }
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86_400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86_400)}d ago`;
}

export function formatUtcStamp(ms: number): string {
  return `${formatClock(ms)} UTC`;
}

export function formatUtcDate(ms: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(ms));
}

export function deadlineTone(deadlineAt: number, finishAt: number): DeadlineTone {
  const slackSec = (deadlineAt - finishAt) / 1000;
  if (slackSec < 0) return "late";
  if (slackSec <= 5) return "tight";
  return "met";
}

export function slackSeconds(deadlineAt: number, finishAt: number): number {
  return Math.round((deadlineAt - finishAt) / 1000);
}

export function progressOf(job: Job, now: number): number {
  if (job.status === "done" || job.status === "failed") return 1;
  if (job.status !== "running" || !job.startedAt) return 0;
  const elapsed = now - job.startedAt;
  return Math.min(1, Math.max(0, elapsed / (job.durationSec * 1000)));
}

/**
 * Default ticket selection: an already-expedited job first, otherwise the
 * queued job with the least deadline slack. Pure so it can be unit tested.
 */
export function selectFocusJob(
  queue: Job[],
  running: Job | null,
  now: number,
): Job | null {
  const candidates = queue.filter((job) => job.status === "queued");
  if (candidates.length === 0) return null;

  const base = running
    ? Math.max(now, (running.startedAt ?? now) + running.durationSec * 1000)
    : now;
  let cursor = base;
  let mostUrgent: Job | null = null;
  let mostUrgentSlack = Number.POSITIVE_INFINITY;
  let expedited: Job | null = null;
  let expeditedSlack = Number.POSITIVE_INFINITY;

  for (const job of candidates) {
    const finishAt = cursor + job.durationSec * 1000;
    const slack = (job.deadlineAt - finishAt) / 1000;
    if (slack < mostUrgentSlack) {
      mostUrgentSlack = slack;
      mostUrgent = job;
    }
    if (job.expedited && slack < expeditedSlack) {
      expeditedSlack = slack;
      expedited = job;
    }
    cursor = finishAt;
  }

  return expedited ?? mostUrgent;
}

export function humanizeEventType(type: string): string {
  const map: Record<string, string> = {
    "job.submitted": "Job submitted",
    "job.ask_changed": "Ask changed",
    "priority.quoted": "Priority quoted",
    "priority.bought": "Priority bought",
    "slot.paid": "Slot compensated",
    "job.started": "Work started",
    "job.progress": "Worker progress",
    "job.completed": "Job delivered",
    "job.missed": "Deadline missed",
    "job.cancelled": "Job cancelled",
    "credit.withdrawn": "Credit claimed",
    "audit.passed": "Audit passed",
    "audit.failed": "Audit failed",
    "scenario.phase": "Scenario phase",
  };
  if (map[type]) return map[type];
  return type
    .replace(/[._]/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
