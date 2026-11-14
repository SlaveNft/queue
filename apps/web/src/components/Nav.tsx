import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Menu, X } from "lucide-react";
import type { QueueState } from "@queue/core";
import { formatClock } from "@queue/core";
import type { ConnectionStatus } from "../hooks/useQueueState";
import { useUtcNow } from "../hooks/useUtcNow";
import { BrandMark } from "./BrandMark";

interface NavProps {
  state: QueueState | null;
  status: ConnectionStatus;
}

const LINKS = [
  { href: "#idea", label: "Watch" },
  { href: "#console", label: "Console" },
  { href: "#mechanism", label: "Mechanism" },
  { href: "#season", label: "Season" },
  { href: "#proof", label: "Proof" },
];

function statusLabel(status: ConnectionStatus, state: QueueState | null): string {
  if (status === "offline") return "API offline";
  if (status === "loading") return "Connecting";
  if (status === "polling") return "Polling";
  return state?.network.mode === "testnet" ? "NEAR testnet" : "Local ledger";
}

export function Nav({ state, status }: NavProps) {
  const now = useUtcNow();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header className="nav">
      <div className="nav-inner">
        <a className="brand" href="#top" aria-label="QUEUE, back to top">
          <BrandMark />
          <span className="brand-word">QUEUE</span>
          <span className="brand-note">slot market</span>
        </a>

        <nav className="nav-links" aria-label="Primary">
          {LINKS.map((link) => (
            <a key={link.href} href={link.href}>
              {link.label}
            </a>
          ))}
        </nav>

        <div className="nav-meta">
          <a
            className="network-pill"
            href="#console"
            data-status={status}
            aria-label={`Network status: ${statusLabel(status, state)}`}
          >
            <span className="status-dot" aria-hidden="true" />
            {statusLabel(status, state)}
          </a>
          <time
            className="nav-clock"
            dateTime={new Date(now).toISOString()}
            aria-label={`Current UTC time ${formatClock(now)}`}
          >
            {formatClock(now)}
            <span>UTC</span>
          </time>
          <button
            type="button"
            className="menu-button"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            aria-controls="mobile-menu"
            onClick={() => setOpen((value) => !value)}
          >
            {open ? <X size={18} aria-hidden="true" /> : <Menu size={18} aria-hidden="true" />}
          </button>
        </div>
      </div>

      <AnimatePresence>
        {open ? (
          <motion.div
            id="mobile-menu"
            className="mobile-menu"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
          >
            <nav aria-label="Mobile">
              {LINKS.map((link, index) => (
                <a
                  key={link.href}
                  href={link.href}
                  onClick={() => setOpen(false)}
                  style={{ animationDelay: `${index * 40}ms` }}
                >
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  {link.label}
                </a>
              ))}
            </nav>
            <div className="mobile-menu-meta">
              <span className="network-pill" data-status={status}>
                <span className="status-dot" aria-hidden="true" />
                {statusLabel(status, state)}
              </span>
              <span className="mono">
                {formatClock(now)} UTC
              </span>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </header>
  );
}
