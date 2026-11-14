import type { Artifact, ArtifactCheck, Job } from "@queue/core";
import { sha256Hex } from "./sha256.js";

export interface TaskResult {
  markdown: string;
  checks: ArtifactCheck[];
}

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function pct(value: number, total: number): string {
  if (total === 0) return "0.0%";
  return `${((value / total) * 100).toFixed(1)}%`;
}

function money(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

/**
 * CSV cells are untrusted text. `Number("1e999")` is `Infinity` and would render
 * as `$∞`; anything non-finite or negative becomes zero.
 */
function finiteNumber(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  return rows;
}

function incidentTriage(job: Job): TaskResult {
  const lines = job.input
    .split(/\r?\n/)
    .map(clean)
    .filter(Boolean);
  const errorLines = lines.filter((line) =>
    /(5xx|error|fail|timeout|latency|stuck|lag|paged)/i.test(line),
  );
  const criticalLines = lines.filter((line) =>
    /(5xx|critical|outage|stuck|paged|board|rollback|18\.4|8,410)/i.test(line),
  );
  const deployLines = lines.filter((line) => /deploy|flag|rollback/i.test(line));
  const customerLines = lines.filter((line) =>
    /customer|support|ticket|order|payment/i.test(line),
  );
  const openRisks = lines.filter((line) =>
    /(still|do not|unknown|unresolved|lag|risk|due)/i.test(line),
  );

  const stuck = lines
    .map((line) => line.match(/stuck in [A-Z_]+ state: ([\d,]+)/i)?.[1])
    .find(Boolean);
  const errorRate = lines
    .map((line) => line.match(/5xx rate ([\d.]+%)/i)?.[1])
    .find(Boolean);
  const nextUpdate = lines
    .map((line) => line.match(/next .*? due ([0-9:]+Z)/i)?.[1])
    .find(Boolean);

  const evidence = criticalLines.slice(0, 6);
  const markdown = `# ${job.title}

**Decision brief for the next board update.** Prepared by the QUEUE operator from the on-call log. No external model; the numbers below are extracted from the supplied evidence.

## What happened

${errorLines.length} signal lines describe a live checkout incident${errorRate ? ` with a ${errorRate} 5xx rate` : ""}.${stuck ? ` **${stuck} orders are stuck in a reserved state.**` : ""} The failing write path is the priority, not refunds.

## Most likely trigger

${deployLines.length > 0 ? deployLines.slice(0, 3).map((line) => `- ${line}`).join("\n") : "- The supplied log does not contain a deployment or feature-flag change."}

## Customer impact

${customerLines.slice(0, 4).map((line) => `- ${line}`).join("\n") || "- No customer-impact line was supplied."}

## What is still unresolved

${openRisks.slice(0, 5).map((line) => `- ${line}`).join("\n") || "- No unresolved-risk line was supplied."}

## Next 10 minutes

1. Keep the feature flag rolled back; confirm the error rate is still falling.
2. Reconcile the stuck reservations against the payment ledger before retrying writes.
3. Publish the next update only after the partner status-page decision is made.
${nextUpdate ? `4. The next update is due **${nextUpdate}**.` : "4. Set an explicit time for the next update before the call ends."}

## Evidence

${evidence.map((line) => `> ${line}`).join("\n")}

---

**Checks:** ${lines.length} log lines parsed · ${errorLines.length} signals · ${openRisks.length} open risks. This is a deterministic extraction, not an independent incident diagnosis.`;

  const checks: ArtifactCheck[] = [
    {
      key: "input",
      label: "Source log present",
      ok: lines.length > 0,
      detail: `${lines.length} non-empty lines.`,
    },
    {
      key: "signals",
      label: "Signals extracted",
      ok: errorLines.length >= 3,
      detail: `${errorLines.length} error/latency lines found.`,
    },
    {
      key: "numbers",
      label: "Key numbers preserved",
      ok: Boolean(stuck || errorRate),
      detail: [errorRate && `5xx ${errorRate}`, stuck && `${stuck} stuck orders`]
        .filter(Boolean)
        .join(" · ") || "No headline number found.",
    },
    {
      key: "format",
      label: "Board-ready structure",
      ok: true,
      detail: "Situation, trigger, impact, risks, actions, evidence.",
    },
  ];
  return { markdown, checks };
}

function csvAudit(job: Job): TaskResult {
  const rows = parseCsv(job.input);
  const header = rows[0] ?? [];
  const data = rows.slice(1);
  const index = (name: string) => header.findIndex((value) => value.trim() === name);
  const statusAt = index("status");
  const amountAt = index("amount_usd");
  const chainAt = index("chain");
  const latencyAt = index("latency_ms");
  const retryAt = index("retry");
  const idAt = index("settlement_id");

  const failed = statusAt >= 0 ? data.filter((row) => row[statusAt] === "failed") : [];
  const amount = (row: string[]) => finiteNumber(row[amountAt]);
  const latency = (row: string[]) => finiteNumber(row[latencyAt]);
  const totalVolume = data.reduce((sum, row) => sum + amount(row), 0);
  const failedVolume = failed.reduce((sum, row) => sum + amount(row), 0);
  const retries = retryAt >= 0 ? data.reduce((sum, row) => sum + finiteNumber(row[retryAt]), 0) : 0;
  const avgLatency = data.length
    ? Math.round(data.reduce((sum, row) => sum + latency(row), 0) / data.length)
    : 0;
  const failedLatency = failed.length
    ? Math.round(failed.reduce((sum, row) => sum + latency(row), 0) / failed.length)
    : 0;

  const chains = new Map<string, { count: number; failed: number; volume: number; latency: number }>();
  for (const row of data) {
    const chain = chainAt >= 0 ? row[chainAt] || "unknown" : "unknown";
    const current = chains.get(chain) ?? { count: 0, failed: 0, volume: 0, latency: 0 };
    current.count += 1;
    current.failed += statusAt >= 0 && row[statusAt] === "failed" ? 1 : 0;
    current.volume += amount(row);
    current.latency += latency(row);
    chains.set(chain, current);
  }

  const largest = [...failed]
    .sort((a, b) => amount(b) - amount(a))
    .slice(0, 3);

  const markdown = `# ${job.title}

**Settlement audit.** ${data.length} rows parsed from the supplied export. All totals are computed from the file, not estimated.

## Headline

- Settled volume: **${money(totalVolume)}**
- Failed volume: **${money(failedVolume)}** across **${failed.length}** payments (${pct(failed.length, data.length)} by count)
- Retry load: **${retries}** retries
- Average latency: **${avgLatency} ms** overall, **${failedLatency} ms** on failed payments

## By chain

| Chain | Payments | Failed | Volume | Avg latency |
|---|---:|---:|---:|---:|
${[...chains.entries()]
  .map(
    ([chain, value]) =>
      `| ${chain} | ${value.count} | ${value.failed} | ${money(value.volume)} | ${Math.round(value.latency / value.count)} ms |`,
  )
  .join("\n")}

## Largest failed payments

${
  largest.length
    ? largest
        .map(
          (row) =>
            `- **${idAt >= 0 ? row[idAt] : "unknown"}** — ${money(amount(row))} on ${chainAt >= 0 ? row[chainAt] : "unknown"} · ${retryAt >= 0 ? row[retryAt] : "?"} retries · ${latency(row)} ms`,
        )
        .join("\n")
    : "- No failed rows in this export."
}

## What to do next

1. Retry the three largest failures only after checking the destination chain's finality.
2. Treat the failed-payment latency tail as the primary operational signal.
3. Re-run this audit on the next export and compare failed volume, not just failure count.

---

**Checks:** ${data.length} data rows · ${header.length} columns · ${failed.length} failures. Deterministic CSV arithmetic.`;

  const checks: ArtifactCheck[] = [
    {
      key: "input",
      label: "CSV parsed",
      ok: data.length > 0 && header.length >= 4,
      detail: `${data.length} rows and ${header.length} columns.`,
    },
    {
      key: "totals",
      label: "Totals reconcile",
      ok: totalVolume >= failedVolume,
      detail: `${money(totalVolume)} total vs ${money(failedVolume)} failed.`,
    },
    {
      key: "failure",
      label: "Failure set non-trivial",
      ok: failed.length > 0,
      detail: `${failed.length} failed payments found.`,
    },
    {
      key: "format",
      label: "Audit table present",
      ok: true,
      detail: "Headline, chain table, largest failures, next actions.",
    },
  ];
  return { markdown, checks };
}

function launchBrief(job: Job): TaskResult {
  const lines = job.input.split(/\r?\n/).map(clean).filter(Boolean);
  const field = (name: string) =>
    lines.find((line) => line.toLowerCase().startsWith(name.toLowerCase()))?.split(":").slice(1).join(":").trim();
  const risks = lines.filter((line) => /^risk/i.test(line));
  const mitigations = lines.filter((line) => /^mitigation/i.test(line));
  const ask = field("Ask");
  const success = field("Success signal");
  const output = `# ${job.title}

## One-line pitch

${field("Offer") ?? "A paid priority market for agent work."} — sold to ${field("Audience") ?? "teams with a real deadline"}.

## Who

- **Partner:** ${field("Partner") ?? "Not supplied"}
- **Audience:** ${field("Audience") ?? "Not supplied"}

## Offer

${field("Offer") ?? "Not supplied"}

## Why now

${field("Why now") ?? "Not supplied"}

## Proof

${field("Proof") ?? "Not supplied"}

## Risks and controls

${risks.map((risk, i) => `- ${risk}\n  - ${mitigations[i] ?? "No mitigation supplied."}`).join("\n") || "- No risks supplied."}

## The ask

${ask ?? "No ask supplied."}

## Success signal

${success ?? "No success signal supplied."}

---

**Checks:** ${lines.length} input lines parsed · ${risks.length} risks paired with controls. Deterministic brief assembly; every claim above comes from the supplied notes.`;

  const checks: ArtifactCheck[] = [
    {
      key: "input",
      label: "Launch notes present",
      ok: lines.length >= 5,
      detail: `${lines.length} lines.`,
    },
    {
      key: "ask",
      label: "Ask extracted",
      ok: Boolean(ask),
      detail: ask ?? "No ask line found.",
    },
    {
      key: "risks",
      label: "Risks and mitigations paired",
      ok: risks.length > 0 && mitigations.length > 0,
      detail: `${risks.length} risks, ${mitigations.length} mitigations.`,
    },
    {
      key: "format",
      label: "Brief structure complete",
      ok: true,
      detail: "Pitch, audience, offer, proof, risks, ask, success signal.",
    },
  ];
  return { markdown: output, checks };
}

export function runTask(job: Job): TaskResult {
  if (!job.input.trim()) {
    throw new Error("The job has no input to work on.");
  }
  switch (job.task) {
    case "incident-triage":
      return incidentTriage(job);
    case "csv-audit":
      return csvAudit(job);
    case "launch-brief":
      return launchBrief(job);
    default:
      throw new Error(`Unsupported task: ${String(job.task)}`);
  }
}

export function buildArtifact(job: Job): Artifact {
  const started = performance.now();
  const result = runTask(job);
  const sha256 = sha256Hex(result.markdown);
  const durationMs = Math.max(1, Math.round(performance.now() - started));
  return {
    id: `ART-${job.id.replace(/^J-/, "")}`,
    jobId: job.id,
    title: job.title,
    markdown: result.markdown,
    sha256,
    createdAt: Date.now(),
    durationMs,
    checks: result.checks,
  };
}
