import { motion } from "framer-motion";
import { ArrowDown, ArrowUpRight, Loader2, Play } from "lucide-react";
import type { QueueState } from "@queue/core";
import type { ConnectionStatus } from "../hooks/useQueueState";
import { QueueDiagram } from "./QueueDiagram";
import { BROWSER_BACKEND } from "../lib/backend";

interface HeroProps {
  state: QueueState | null;
  status: ConnectionStatus;
  onRunScenario: () => void;
  runPending: boolean;
  runError: string | null;
}

export function Hero({
  state,
  status,
  onRunScenario,
  runPending,
  runError,
}: HeroProps) {
  const fee = state ? `${(state.service.feeBps / 100).toFixed(2).replace(/\.?0+$/, "")}%` : "—";
  const mode = state
    ? state.network.mode === "testnet"
      ? "NEAR testnet"
      : "Local ledger"
    : "Awaiting API";
  const phase = state?.scenario.status === "running" ? state.scenario.phase : null;

  return (
    <section className="hero" id="top">
      <div className="container hero-grid">
        <motion.div
          className="hero-copy"
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.65, ease: [0.22, 1, 0.36, 1] }}
        >
          <p className="eyebrow">
            <span className="eyebrow-dot" aria-hidden="true" />
            NEAR HACKATHON <span aria-hidden="true">·</span> SWARMS
            <span className="eyebrow-line" aria-hidden="true" />
          </p>

          <h1>
            The queue
            <br />
            is a <em>market.</em>
          </h1>

          <p className="hero-lede">
            When an agent can&apos;t wait, it buys earlier slots from the agents
            ahead of it. Their deadlines stay intact. They get paid.
          </p>
          <p className="hero-analogy">
            Like letting someone cut ahead of you at airport security — except they
            pay you, and they can&apos;t if it would make you miss your flight.
          </p>

          <div className="hero-actions">
            <button
              type="button"
              className="button button-primary"
              onClick={onRunScenario}
              disabled={runPending || status === "offline"}
              aria-describedby={runError ? "hero-run-error" : undefined}
              aria-label="Run the live scenario from the hero"
            >
              {runPending ? (
                <Loader2 className="spin" size={17} aria-hidden="true" />
              ) : (
                <Play size={16} fill="currentColor" aria-hidden="true" />
              )}
              {runPending ? "Starting scenario" : "Run the live scenario"}
              <ArrowUpRight size={16} aria-hidden="true" />
            </button>
            <a className="button button-ghost" href="#mechanism">
              Read the mechanism
              <ArrowDown size={15} aria-hidden="true" />
            </a>
          </div>

          {phase ? (
            <p className="hero-scenario" aria-live="polite">
              <span className="status-dot" aria-hidden="true" />
              Scenario running · {phase}
            </p>
          ) : null}

          {runError ? (
            <p className="form-error hero-error" id="hero-run-error" role="alert">
              {runError}
            </p>
          ) : null}

          <p className="hero-note">
            {BROWSER_BACKEND
              ? "A simulation in this browser tab: real worker, real artifacts, no blockchain transaction. The on-chain runs are in Season and Proof."
              : "A local simulation: real worker, real artifacts, no blockchain transaction. The on-chain runs are in Season and Proof."}
            {status === "offline" ? " The API is not running yet." : null}
          </p>

          <dl className="hero-facts">
            <div>
              <dt>Settlement</dt>
              <dd>{mode}</dd>
            </div>
            <div>
              <dt>Worker</dt>
              <dd>01 owned</dd>
            </div>
            <div>
              <dt>Protocol fee</dt>
              <dd>{fee}</dd>
            </div>
            <div>
              <dt>Invariant</dt>
              <dd>Deadline-safe</dd>
            </div>
          </dl>
        </motion.div>

        <motion.div
          className="hero-visual"
          initial={{ opacity: 0, y: 26 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.75, delay: 0.12, ease: [0.22, 1, 0.36, 1] }}
        >
          <QueueDiagram state={state} status={status} />
          <p className="hero-caption">
            <span aria-hidden="true">§</span> A paid jump is still a promise.
            The contract checks every crossed deadline before it moves anyone.
          </p>
        </motion.div>
      </div>
    </section>
  );
}
