import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Coins, Loader2, Wallet } from "lucide-react";
import type { QueueState } from "@queue/core";
import { api, apiErrorMessage } from "../lib/api";
import { formatNearSafe } from "../lib/format";
import { AgentAvatar } from "./AgentAvatar";

interface CreditsProps {
  state: QueueState;
  refresh: () => Promise<unknown>;
}

interface CreditEntry {
  agentId: string;
  amountYocto: bigint;
}

export function Credits({ state, refresh }: CreditsProps) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<{ agentId: string; message: string } | null>(null);
  const [claimed, setClaimed] = useState<{ agentId: string; amountYocto: string } | null>(
    null,
  );

  const entries = useMemo<CreditEntry[]>(() => {
    const parsed: CreditEntry[] = [];
    for (const [agentId, amount] of Object.entries(state.credits)) {
      try {
        const value = BigInt(amount);
        if (value > 0n) parsed.push({ agentId, amountYocto: value });
      } catch {
        // Ignore malformed credit values rather than inventing a balance.
      }
    }
    return parsed.sort((left, right) =>
      left.amountYocto === right.amountYocto
        ? left.agentId.localeCompare(right.agentId)
        : left.amountYocto > right.amountYocto
          ? -1
          : 1,
    );
  }, [state.credits]);

  const total = entries.reduce((sum, entry) => sum + entry.amountYocto, 0n);
  const local = state.network.mode !== "testnet";

  const withdraw = async (agentId: string) => {
    setPendingId(agentId);
    setError(null);
    setClaimed(null);
    try {
      const result = await api.withdraw(agentId);
      setClaimed({ agentId, amountYocto: result.amountYocto });
      await refresh();
    } catch (caught) {
      setError({ agentId, message: apiErrorMessage(caught) });
    } finally {
      setPendingId(null);
    }
  };

  return (
    <section className="panel credits-panel" aria-labelledby="credits-heading">
      <header className="panel-head credits-head">
        <div>
          <span className="panel-kicker">Pull payments</span>
          <h3 id="credits-heading">
            Credits <span className="serif-accent">owed</span>
          </h3>
        </div>
        <span className="settlement-badge" data-local={local}>
          <Wallet size={13} aria-hidden="true" />
          {local ? "Local ledger" : "Testnet"}
        </span>
      </header>

      <p className="panel-intro">
        Agents displaced by a paid jump are owed their published ask times the
        delay. They withdraw it themselves.
      </p>

      <div className="credits-total">
        <span>Total held</span>
        <strong>{entries.length > 0 ? formatNearSafe(total.toString()) : "—"}</strong>
      </div>

      <AnimatePresence initial={false}>
        {claimed ? (
          <motion.p
            className="success-banner"
            initial={{ opacity: 0, y: -5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            role="status"
          >
            <Check size={14} aria-hidden="true" />
            {formatNearSafe(claimed.amountYocto)} claimed{" "}
            {local ? "to the local ledger" : "on testnet"}.
          </motion.p>
        ) : null}
      </AnimatePresence>

      {entries.length === 0 ? (
        <div className="credits-empty">
          <span className="credits-empty-icon" aria-hidden="true">
            <Coins size={20} />
          </span>
          <h4>No credits held.</h4>
          <p>
            Run the scenario and displace an agent; their compensation appears
            here, claimable by that agent.
          </p>
        </div>
      ) : (
        <ul className="credit-list">
          {entries.map((entry) => {
            const agent = state.agents.find((candidate) => candidate.id === entry.agentId);
            const name = agent?.name ?? entry.agentId;
            const isPending = pendingId === entry.agentId;
            const rowError = error?.agentId === entry.agentId ? error.message : null;
            return (
              <li key={entry.agentId} className="credit-row">
                <AgentAvatar name={name} color={agent?.color} size="sm" />
                <div className="credit-copy">
                  <strong>{name}</strong>
                  <span>
                    {agent?.handle ?? `@${entry.agentId}`}
                    <span className="dot-sep">·</span>
                    {agent?.role ?? "slot holder"}
                  </span>
                  {rowError ? (
                    <p className="form-error credit-error" role="alert">
                      {rowError}
                    </p>
                  ) : null}
                </div>
                <div className="credit-amount">
                  <strong>{formatNearSafe(entry.amountYocto.toString())}</strong>
                  <button
                    type="button"
                    className="button button-small button-ink"
                    onClick={() => void withdraw(entry.agentId)}
                    disabled={isPending}
                    aria-label={`Withdraw ${formatNearSafe(entry.amountYocto.toString())} for ${name}`}
                  >
                    {isPending ? (
                      <Loader2 className="spin" size={13} aria-hidden="true" />
                    ) : null}
                    {isPending ? "Claiming" : "Withdraw"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <footer className="credits-foot">
        <span className="mini-label">Settlement</span>
        <p>
          {local
            ? "Withdrawals here are local ledger entries, not NEAR transactions."
            : "Withdrawals settle on NEAR testnet. Real hashes appear in the ledger when returned by the API."}
        </p>
      </footer>
    </section>
  );
}
