import type { QueueState } from "@queue/core";
import { ArrowUpRight } from "lucide-react";
import { BrandMark } from "./BrandMark";
import { BROWSER_BACKEND, REPO_URL, publicUrl, staticDataUrl } from "../lib/backend";

interface FooterProps {
  state: QueueState | null;
}

export function Footer({ state }: FooterProps) {
  const mode = state
    ? state.network.mode === "testnet"
      ? "NEAR testnet"
      : BROWSER_BACKEND
        ? "Local ledger in this tab"
        : "Local rehearsal"
    : "Awaiting API snapshot";
  return (
    <footer className="footer" id="footer">
      <div className="container">
        <div className="footer-top">
          <div className="footer-brand">
            <a className="brand brand-inverse" href="#top" aria-label="QUEUE, back to top">
              <BrandMark tone="lime" />
              <span className="brand-word">QUEUE</span>
            </a>
            <h2>
              The queue is a <em>market.</em>
            </h2>
            <p>
              A deadline-safe priority market for agent work on NEAR: a local
              console, a scripted proof, and a live season with model agents on testnet.
            </p>
            <span className="footer-mode">
              <span className="status-dot" aria-hidden="true" />
              {mode} · single worker
            </span>
          </div>

          <nav className="footer-nav" aria-label="Footer">
            <div>
              <span className="footer-nav-label">Console</span>
              <a href="#console">Operations floor</a>
              <a href="#console">Priority ticket</a>
              <a href="#console">Credits</a>
            </div>
            <div>
              <span className="footer-nav-label">Mechanism</span>
              <a href="#mechanism">How a jump works</a>
              <a href={publicUrl("docs/MECHANISM.md")} target="_blank" rel="noreferrer">
                MECHANISM.md <ArrowUpRight size={11} aria-hidden="true" />
              </a>
              {BROWSER_BACKEND ? (
                REPO_URL ? (
                  <a href={REPO_URL} target="_blank" rel="noreferrer">
                    Source code <ArrowUpRight size={11} aria-hidden="true" />
                  </a>
                ) : null
              ) : (
                <a href="/api/metrics">
                  Metrics <ArrowUpRight size={11} aria-hidden="true" />
                </a>
              )}
            </div>
            <div>
              <span className="footer-nav-label">Proof</span>
              <a href="#season">Live season</a>
              <a href="#proof">Deployment proof</a>
              {BROWSER_BACKEND ? (
                <>
                  <a href={staticDataUrl("onchain")} target="_blank" rel="noreferrer">
                    Proof record (JSON) <ArrowUpRight size={11} aria-hidden="true" />
                  </a>
                  <a href={staticDataUrl("season")} target="_blank" rel="noreferrer">
                    Season record (JSON) <ArrowUpRight size={11} aria-hidden="true" />
                  </a>
                </>
              ) : (
                <>
                  <a href="/api/onchain">
                    /api/onchain <ArrowUpRight size={11} aria-hidden="true" />
                  </a>
                  <a href="/api/health">
                    API health <ArrowUpRight size={11} aria-hidden="true" />
                  </a>
                </>
              )}
            </div>
          </nav>
        </div>

        <div className="footer-disclosure">
          <span className="footer-nav-label">Project disclosure</span>
          <p>
            Built at NEAR HACKATHON. Testnet only, not audited; nothing here is
            presented as a funding or revenue claim.
          </p>
        </div>

        <div className="footer-bottom">
          <span>© 2026 QUEUE · MIT License</span>
          <span>Built at NEAR HACKATHON · Testnet only</span>
        </div>
      </div>
    </footer>
  );
}
