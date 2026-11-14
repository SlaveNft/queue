/** Exact NEAR <-> yoctoNEAR helpers. No floats in money paths. */

export const YOCTO_PER_NEAR = 10n ** 24n;

function groupWhole(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export interface FormatNearOptions {
  minDecimals?: number;
  maxDecimals?: number;
  symbol?: boolean;
}

/**
 * Format yoctoNEAR for display without floating point loss.
 * Defaults to 2–4 decimals, trailing zeros trimmed down to `minDecimals`.
 */
export function formatNear(
  yocto: string | bigint,
  options: FormatNearOptions = {},
): string {
  const { minDecimals = 2, maxDecimals = 4, symbol = true } = options;
  let value = typeof yocto === "bigint" ? yocto : BigInt(yocto || "0");
  const negative = value < 0n;
  if (negative) value = -value;

  const whole = value / YOCTO_PER_NEAR;
  const fraction = value % YOCTO_PER_NEAR;
  let fractionText = fraction.toString().padStart(24, "0").slice(0, maxDecimals);
  while (fractionText.length > minDecimals && fractionText.endsWith("0")) {
    fractionText = fractionText.slice(0, -1);
  }
  const body = fractionText
    ? `${groupWhole(whole.toString())}.${fractionText}`
    : groupWhole(whole.toString());
  const sign = negative ? "−" : "";
  return symbol ? `${sign}${body} NEAR` : `${sign}${body}`;
}

/** Parse a human NEAR amount into yocto. Throws on invalid input. */
export function parseNear(text: string | number): bigint {
  const raw = String(text).trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,24})?$/.test(raw)) {
    throw new Error("Enter a positive NEAR amount with at most 24 decimals.");
  }
  const [whole = "0", fraction = ""] = raw.split(".");
  return BigInt(whole) * YOCTO_PER_NEAR + BigInt(fraction.padEnd(24, "0"));
}

export function nearToYoctoString(text: string | number): string {
  return parseNear(text).toString();
}

export function yoctoToNearNumber(yocto: string | bigint): number {
  return Number(yocto) / 1e24;
}

export function addYocto(...values: Array<string | bigint>): bigint {
  return values.reduce<bigint>((sum, value) => sum + BigInt(value || "0"), 0n);
}

export function bpsOf(value: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new Error("bps must be an integer between 0 and 10000");
  }
  return (value * BigInt(bps)) / 10_000n;
}

export function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds));
  if (safe < 60) return `${safe}s`;
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  if (minutes < 60) return rest ? `${minutes}m ${String(rest).padStart(2, "0")}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours}h ${String(restMinutes).padStart(2, "0")}m` : `${hours}h`;
}

export function formatClock(ms: number, withSeconds = true): string {
  const date = new Date(ms);
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    ...(withSeconds ? { second: "2-digit" } : {}),
    hour12: false,
    timeZone: "UTC",
  }).format(date);
}

export function formatCountdown(msRemaining: number): string {
  const total = Math.max(0, Math.ceil(msRemaining / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function shortHash(hash: string, head = 8, tail = 6): string {
  if (!hash) return "—";
  if (hash.length <= head + tail + 1) return hash;
  return `${hash.slice(0, head)}…${hash.slice(-tail)}`;
}

export function shortAccount(account: string): string {
  if (account.length <= 24) return account;
  return `${account.slice(0, 12)}…${account.slice(-8)}`;
}

export const STATUS_LABELS: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  done: "Delivered",
  missed: "Missed",
  cancelled: "Cancelled",
  failed: "Failed",
};
