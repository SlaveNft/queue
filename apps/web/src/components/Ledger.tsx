import { useMemo, useState } from "react";
import clsx from "clsx";
import { ChevronDown, ExternalLink, Landmark, ReceiptText } from "lucide-react";
import {
  formatClock,
  shortAccount,
  type LedgerEvent,
  type QueueState,
} from "@queue/core";
import { useUtcNow } from "../hooks/useUtcNow";
import { formatNearSafe, formatRelative, humanizeEventType } from "../lib/format";

interface LedgerProps {
  state: QueueState;
}

function metaEntries(meta: Record<string, unknown> | undefined): Array<[string, unknown]> {
  if (!meta) return [];
  return Object.entries(meta).filter(([, value]) => value !== undefined && value !== null);
}

function formatMetaValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "—";
  }
}

function explorerLink(state: QueueState, event: LedgerEvent): string | null {
  if (state.network.mode !== "testnet") return null;
  const meta = event.meta ?? {};
  const raw =
    (typeof meta.txHash === "string" && meta.txHash) ||
    (typeof meta.transactionHash === "string" && meta.transactionHash) ||
    (typeof meta.tx === "string" && meta.tx) ||
    "";
  if (raw.length < 20) return null;
  const base = (state.network.explorer ?? "https://testnet.nearblocks.io").replace(/\/$/, "");
  if (!/^https?:\/\//.test(base)) return null;
  return `${base}/txns/${encodeURIComponent(raw)}`;
}

export function Ledger({ state }: LedgerProps) {
  const clock = useUtcNow(5_000);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const events = useMemo(
    () => state.activity.slice().sort((left, right) => right.at - left.at),
    [state.activity],
  );
  const visible = showAll ? events : events.slice(0, 10);
  const local = state.network.mode !== "testnet";
  const contractUrl =
    !local && state.network.contractId
      ? `${(state.network.explorer ?? "https://testnet.nearblocks.io").replace(/\/$/, "")}/address/${encodeURIComponent(state.network.contractId)}`
      : null;

  return (
    <section className="panel ledger-panel" aria-labelledby="ledger-heading">
      <header className="panel-head ledger-head">
        <div>
          <span className="panel-kicker">Every move, recorded</span>
          <h3 id="ledger-heading">
            Settlement <span className="serif-accent">ledger</span>
          </h3>
        </div>
        <span className="settlement-badge" data-local={local}>
          <Landmark size={13} aria-hidden="true" />
          {local ? "Local ledger" : "NEAR testnet"}
        </span>
      </header>

      <div className="ledger-note" data-local={local}>
        <span className="ledger-note-mark" aria-hidden="true" />
        {local ? (
          <p>
            A <strong>local settlement ledger</strong>, not an on-chain
            transaction. Internal balances settle in the local store; no tx hash
            exists, so none is shown.
          </p>
        ) : (
          <p>
            Settled on <strong>NEAR testnet</strong>.
            {state.network.contractId ? (
              <>
                {" "}
                Contract{" "}
                {contractUrl ? (
                  <a href={contractUrl} target="_blank" rel="noreferrer">
                    {shortAccount(state.network.contractId)}
                    <ExternalLink size={11} aria-hidden="true" />
                  </a>
                ) : (
                  <span className="mono">{state.network.contractId}</span>
                )}
                . Transaction hashes are rendered only when the API returns one.
              </>
            ) : (
              " Contract proof is pending; amounts are shown without invented hashes."
            )}
          </p>
        )}
      </div>

      {visible.length === 0 ? (
        <div className="ledger-empty">
          <ReceiptText size={24} aria-hidden="true" />
          <h4>No settlements yet.</h4>
          <p>
            Submitted jobs, paid moves, deliveries and claims will appear here in
            ledger order.
          </p>
        </div>
      ) : (
        <div className="ledger-table-wrap">
          <table className="ledger-table">
            <caption className="sr-only">
              Settlement events from the latest ledger snapshot
            </caption>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Event</th>
                <th scope="col">Actor</th>
                <th scope="col" className="align-right">
                  Amount
                </th>
                <th scope="col">
                  <span className="sr-only">Details</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((event) => {
                const actor =
                  state.agents.find(
                    (agent) =>
                      agent.id === event.actor ||
                      agent.name.toLowerCase() === event.actor.toLowerCase() ||
                      agent.accountId === event.actor,
                  )?.name ?? event.actor;
                const meta = metaEntries(event.meta);
                const open = expanded === event.id;
                const txUrl = explorerLink(state, event);
                const canExpand = meta.length > 0;

                return (
                  <LedgerRow
                    key={event.id}
                    event={event}
                    actor={actor}
                    amount={event.amountYocto}
                    local={local}
                    open={open}
                    canExpand={canExpand}
                    txUrl={txUrl}
                    meta={meta}
                    clock={clock}
                    onToggle={() =>
                      setExpanded((current) => (current === event.id ? null : event.id))
                    }
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <footer className="ledger-foot">
        <span className="mono">
          {events.length} event{events.length === 1 ? "" : "s"} · snapshot{" "}
          {formatClock(state.now)} UTC
        </span>
        {events.length > 10 ? (
          <button
            type="button"
            className="text-button"
            onClick={() => setShowAll((value) => !value)}
            aria-expanded={showAll}
          >
            {showAll ? "Show latest 10" : `Show all ${events.length}`}
            <ChevronDown
              size={13}
              className={clsx("chevron", { "is-open": showAll })}
              aria-hidden="true"
            />
          </button>
        ) : null}
      </footer>
    </section>
  );
}

interface LedgerRowProps {
  event: LedgerEvent;
  actor: string;
  amount?: string;
  local: boolean;
  open: boolean;
  canExpand: boolean;
  txUrl: string | null;
  meta: Array<[string, unknown]>;
  clock: number;
  onToggle: () => void;
}

function LedgerRow({
  event,
  actor,
  amount,
  local,
  open,
  canExpand,
  txUrl,
  meta,
  clock,
  onToggle,
}: LedgerRowProps) {
  return (
    <>
      <tr className={clsx("ledger-row", { "is-open": open })} data-kind={event.type.split(".")[0]}>
        <td className="ledger-time">
          <span className="mono">{formatClock(event.at)}</span>
          <span className="ledger-relative">{formatRelative(event.at, clock)}</span>
        </td>
        <td className="ledger-event">
          <span className="event-dot" aria-hidden="true" />
          <div>
            <strong>{humanizeEventType(event.type)}</strong>
            <span>{event.summary}</span>
          </div>
        </td>
        <td className="ledger-actor">
          {actor}
          {event.jobId ? <span className="ledger-job">{event.jobId}</span> : null}
        </td>
        <td className="ledger-amount align-right">
          <span className="mono">{amount ? formatNearSafe(amount) : "—"}</span>
          {local && amount ? <span className="ledger-mode">local</span> : null}
          {txUrl ? (
            <a
              className="tx-link"
              href={txUrl}
              target="_blank"
              rel="noreferrer"
              aria-label={`View transaction for ${event.summary} on nearblocks`}
            >
              nearblocks
              <ExternalLink size={10} aria-hidden="true" />
            </a>
          ) : null}
        </td>
        <td className="ledger-expand">
          {canExpand ? (
            <button
              type="button"
              className="row-toggle"
              onClick={onToggle}
              aria-expanded={open}
              aria-label={`${open ? "Hide" : "Show"} metadata for ${humanizeEventType(event.type)}${
                event.jobId ? `, job ${event.jobId}` : ""
              }, ${actor}`}
            >
              <ChevronDown
                size={14}
                className={clsx("chevron", { "is-open": open })}
                aria-hidden="true"
              />
            </button>
          ) : null}
        </td>
      </tr>
      {open && canExpand ? (
        <tr className="ledger-meta-row">
          <td colSpan={5}>
            <dl className="ledger-meta">
              {meta.map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{formatMetaValue(value)}</dd>
                </div>
              ))}
            </dl>
          </td>
        </tr>
      ) : null}
    </>
  );
}
