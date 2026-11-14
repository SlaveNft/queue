/**
 * Where the console's ledger runs.
 *
 * - `server` (default): the Express API in `apps/server`, reached over `/api`.
 * - `browser`: the same `LedgerEngine` (`packages/ledger`) inside this tab.
 *   The hosted build uses it, so the console needs no backend at all.
 *
 * The choice is made at build time (`VITE_QUEUE_BACKEND=browser`), so a hosted
 * page never tries to call an API that is not there.
 */
export const BROWSER_BACKEND = import.meta.env.VITE_QUEUE_BACKEND === "browser";

/** Static proof payloads written next to the hosted build by `scripts/build-pages.mjs`. */
export function staticDataUrl(name: "season" | "onchain"): string {
  return `${import.meta.env.BASE_URL}static/${name}.json`;
}

/** A file from `apps/web/public`, correct under any base path. */
export function publicUrl(path: string): string {
  return `${import.meta.env.BASE_URL}${path.replace(/^\//, "")}`;
}

/** Public source repository, when the build knows it (`VITE_QUEUE_REPO_URL`). */
export const REPO_URL = ((import.meta.env.VITE_QUEUE_REPO_URL as string | undefined) ?? "").replace(
  /\/$/,
  "",
);
