import { Loader2, Play, RotateCcw } from "lucide-react";
import { Dialog } from "./Dialog";

type ConfirmAction = "run" | "reset";

interface ConfirmDialogProps {
  open: boolean;
  action: ConfirmAction;
  /** True when the server reports a scenario in progress. */
  running: boolean;
  onClose: () => void;
  onConfirm: () => void;
  pending: boolean;
  error: string | null;
}

const COPY: Record<
  ConfirmAction,
  {
    kicker: string;
    title: string;
    body: string;
    runningBody: string;
    confirm: string;
    pending: string;
    icon: "run" | "reset";
  }
> = {
  run: {
    kicker: "Starting a new run",
    title: "Replace the current state?",
    body:
      "Running the live scenario clears the current queue, credits and ledger, then plays the 18-second sequence from standby.",
    runningBody:
      "A scenario is already running. Starting again clears the current queue, credits and ledger, then replays the full 18-second sequence from standby.",
    confirm: "Run scenario",
    pending: "Starting",
    icon: "run",
  },
  reset: {
    kicker: "Reset the run",
    title: "Clear this run?",
    body:
      "Reset clears the current queue, credits and ledger, and returns the console to standby. This cannot be undone.",
    runningBody:
      "A scenario is running. Reset clears the current queue, credits and ledger, and stops the sequence immediately.",
    confirm: "Reset run",
    pending: "Resetting",
    icon: "reset",
  },
};

export function ConfirmDialog({
  open,
  action,
  running,
  onClose,
  onConfirm,
  pending,
  error,
}: ConfirmDialogProps) {
  const copy = COPY[action];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      labelledBy="confirm-scenario-title"
      className="confirm-dialog"
      dismissible={!pending}
    >
      <header className="dialog-head">
        <div>
          <span className="panel-kicker">{copy.kicker}</span>
          <h2 id="confirm-scenario-title">
            {copy.title.replace(/\?$/, "")}
            <span className="serif-accent">?</span>
          </h2>
        </div>
      </header>
      <p className="confirm-copy">{running ? copy.runningBody : copy.body}</p>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <footer className="dialog-actions confirm-actions">
        <button type="button" className="button button-ghost" onClick={onClose} disabled={pending}>
          Keep current state
        </button>
        <button type="button" className="button button-primary" onClick={onConfirm} disabled={pending}>
          {pending ? (
            <Loader2 className="spin" size={15} aria-hidden="true" />
          ) : copy.icon === "run" ? (
            <Play size={14} fill="currentColor" aria-hidden="true" />
          ) : (
            <RotateCcw size={14} aria-hidden="true" />
          )}
          {pending ? copy.pending : copy.confirm}
        </button>
      </footer>
    </Dialog>
  );
}
