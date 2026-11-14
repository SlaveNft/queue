import {
  ArrowRight,
  Check,
  CircleCheck,
  CornerDownRight,
  ShieldCheck,
} from "lucide-react";

import { useOnchainTwin } from "../lib/onchain";
import { publicUrl } from "../lib/backend";
export function Mechanism() {
  const twin = useOnchainTwin();
  return (
    <section className="mechanism-section" id="mechanism" aria-labelledby="mechanism-heading">
      <div className="container">
        <header className="section-heading mechanism-heading">
          <div>
            <p className="section-kicker">
              <span>03</span> Mechanism
            </p>
            <h2 id="mechanism-heading">
              A jump is a <em>contract.</em>
            </h2>
          </div>
          <p className="section-lede">
            No discretionary reordering. No “VIP” lane. A job buys a prefix of
            the queue, pays every agent it crosses, and the contract refuses the
            purchase if a single deadline would break.
          </p>
        </header>

        <ol className="mechanism-steps">
          <li className="mechanism-step">
            <div className="step-number">01</div>
            <div className="step-copy">
              <span className="mini-label">Arrival</span>
              <h3>An urgent job arrives.</h3>
              <p>
                It declares a duration, a deadline, a reward and a bond. The bond
                is returned on delivery and makes a fake booking expensive.
              </p>
            </div>
            <div className="step-visual step-visual-ticket" aria-hidden="true">
              <div className="ticket-demo">
                <span className="ticket-demo-tag">Urgent · 12s</span>
                <strong>Checkout latency spike</strong>
                <div className="ticket-demo-grid">
                  <span>deadline</span>
                  <b>34s</b>
                  <span>reward</span>
                  <b>escrowed</b>
                  <span>bond</span>
                  <b>returned</b>
                </div>
                <span className="ticket-demo-edge" />
              </div>
            </div>
          </li>

          <li className="mechanism-step">
            <div className="step-number">02</div>
            <div className="step-copy">
              <span className="mini-label">Quote</span>
              <h3>Find the latest feasible jump.</h3>
              <p>
                The latest insertion index that satisfies the start cutoff — with
                every displaced finish still before its deadline — wins. Fewest
                moves, not highest bid.
              </p>
            </div>
            <div className="step-visual step-visual-jump" aria-hidden="true">
              <div className="jump-row">
                <span className="jump-label">before</span>
                <div className="jump-blocks">
                  <span>A</span>
                  <span>B</span>
                  <span>C</span>
                  <span>D</span>
                  <span className="jump-urgent">U</span>
                </div>
              </div>
              <CornerDownRight className="jump-arrow" size={18} />
              <div className="jump-row">
                <span className="jump-label">after</span>
                <div className="jump-blocks">
                  <span className="jump-urgent">U</span>
                  <span className="jump-delayed">A +12s</span>
                  <span className="jump-delayed">B +12s</span>
                </div>
              </div>
              <div className="jump-cutoff">
                <span className="jump-cutoff-line" />
                <span>latest-start line</span>
                <Check size={12} />
              </div>
            </div>
          </li>

          <li className="mechanism-step">
            <div className="step-number">03</div>
            <div className="step-copy">
              <span className="mini-label">Settlement</span>
              <h3>Pay every crossed promise.</h3>
              <p>
                Each displaced agent moves back by exactly the urgent duration and
                earns their published ask for that delay. The fee is explicit. A
                broken deadline aborts the whole purchase.
              </p>
            </div>
            <div className="step-visual step-visual-payment" aria-hidden="true">
              <div className="payment-row">
                <span>A</span>
                <span>ask × 12s</span>
                <Check size={13} />
              </div>
              <div className="payment-row">
                <span>B</span>
                <span>ask × 12s</span>
                <Check size={13} />
              </div>
              <div className="payment-row">
                <span>C</span>
                <span>ask × 12s</span>
                <Check size={13} />
              </div>
              <div className="payment-row payment-deadline">
                <span>promise</span>
                <span>finish ≤ deadline</span>
                <ShieldCheck size={13} />
              </div>
            </div>
          </li>
        </ol>

        <div className="formula-strip">
          <span className="formula-label">The whole price</span>
          <code>
            comp = <span>Σ</span> ask<sub>i</sub> × duration<sub>urgent</sub>
          </code>
          <span className="formula-aside">
            <ArrowRight size={14} aria-hidden="true" /> fee = feeBps × comp
          </span>
        </div>

        <div className="invariant-card">
          <span className="invariant-icon" aria-hidden="true">
            <ShieldCheck size={24} />
          </span>
          <div>
            <span className="mini-label">The invariant</span>
            <h3>No deadline is moved past its promise.</h3>
            <p>
              The TypeScript scheduler and the Rust contract implement the same
              rule. If compensation cannot be paid or a promise would break, the
              protocol returns a refusal — not a partial reorder.
            </p>
          </div>
          <div className="invariant-side">
            <div>
              <CircleCheck size={14} aria-hidden="true" />
              Every move checked before purchase
            </div>
            <div>
              <CircleCheck size={14} aria-hidden="true" />
              Fewest displacements wins
            </div>
            <div>
              <CircleCheck size={14} aria-hidden="true" />
              Compensation is pull-paid
            </div>
            {twin?.refusalTxUrl ? (
              <a href={twin.refusalTxUrl} className="text-link" target="_blank" rel="noreferrer">
                See the contract refuse a jump on testnet <ArrowRight size={13} aria-hidden="true" />
              </a>
            ) : null}
            <a
              href={publicUrl("docs/MECHANISM.md")}
              className="text-link"
              target="_blank"
              rel="noreferrer"
            >
              Read MECHANISM.md <ArrowRight size={13} aria-hidden="true" />
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
