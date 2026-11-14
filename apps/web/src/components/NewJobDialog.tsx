import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { AlertCircle, ChevronDown, Loader2, X } from "lucide-react";
import { formatNear, parseNear, type Agent, type Job, type TaskKind } from "@queue/core";
import { api, apiErrorMessage, type NewJobInput } from "../lib/api";
import { Dialog } from "./Dialog";

interface NewJobDialogProps {
  open: boolean;
  onClose: () => void;
  agents: Agent[];
  onCreated: (job: Job) => Promise<unknown> | unknown;
}

interface FormState {
  ownerId: string;
  task: TaskKind;
  title: string;
  brief: string;
  input: string;
  durationSec: string;
  deadlineInSec: string;
  rewardNear: string;
  bondNear: string;
  askPerSecNear: string;
}

const TASKS: Array<{
  value: TaskKind;
  label: string;
  hint: string;
  sample: { title: string; brief: string; input: string };
}> = [
  {
    value: "incident-triage",
    label: "Incident triage",
    hint: "Logs in, an incident note out.",
    sample: {
      title: "Triage the checkout latency spike",
      brief:
        "Triage the spike, identify the likely cause, and write an incident note with severity, owner and next action.",
      input:
        "2026-11-13T09:41:02Z checkout-api p99=1820ms errors=0.4%\n2026-11-13T09:42:10Z checkout-api p99=4120ms errors=2.8% db_pool=97%\n2026-11-13T09:43:18Z payments p99=5310ms retries=184 deadline_breaches=37\n2026-11-13T09:44:00Z deploy checkout@2026.11.13-rc3 rolled_back\n2026-11-13T09:44:20Z checkout-api p99=1710ms errors=0.3% db_pool=61%",
    },
  },
  {
    value: "csv-audit",
    label: "CSV audit",
    hint: "A transactions file in, an exception report out.",
    sample: {
      title: "Audit the November settlements CSV",
      brief:
        "Audit the file for duplicate invoices, mismatched totals and anything that needs an operator to follow up.",
      input:
        "invoice_id,account,amount_usd,status,created_at\nINV-1041,atlas,1200.00,paid,2026-11-02\nINV-1042,mira,840.50,paid,2026-11-03\nINV-1042,mira,840.50,paid,2026-11-03\nINV-1043,vale,560.00,pending,2026-11-04\nINV-1044,juno,1999.99,paid,2026-11-05\nINV-1045,kestrel,120.00,failed,2026-11-06",
    },
  },
  {
    value: "launch-brief",
    label: "Launch brief",
    hint: "Product facts in, a launch brief out.",
    sample: {
      title: "Draft the QUEUE launch brief",
      brief:
        "Write a concise launch brief for operators and agent teams. Lead with the deadline-safety promise, then explain how paid jumps work.",
      input:
        "Product: QUEUE, a paid slot market for agent work on NEAR\nProblem: one worker, FIFO, agents with hard deadlines\nMechanism: an urgent job buys an earlier slot; displaced jobs are paid their ask per second\nInvariant: no deadline is moved past its promise\nSettlement: local ledger or NEAR testnet\nAudience: infrastructure teams running agent fleets",
    },
  },
];

function defaultOwner(agents: Agent[]): string {
  return (
    agents.find((agent) => agent.role === "buyer")?.id ??
    agents.find((agent) => agent.role === "slot-holder")?.id ??
    agents[0]?.id ??
    ""
  );
}

function makeForm(agents: Agent[]): FormState {
  const sample = TASKS[0]?.sample;
  return {
    ownerId: defaultOwner(agents),
    task: "incident-triage",
    title: sample?.title ?? "",
    brief: sample?.brief ?? "",
    input: sample?.input ?? "",
    durationSec: "10",
    deadlineInSec: "45",
    rewardNear: "0.012",
    bondNear: "0.006",
    askPerSecNear: "0.0004",
  };
}

function parsePositive(value: string): bigint | null {
  try {
    const parsed = parseNear(value);
    return parsed > 0n ? parsed : null;
  } catch {
    return null;
  }
}

export function NewJobDialog({ open, onClose, agents, onCreated }: NewJobDialogProps) {
  const [form, setForm] = useState<FormState>(() => makeForm(agents));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(makeForm(agents));
    setErrors({});
    setServerError(null);
    setSubmitting(false);
    // Fresh defaults each time the drawer opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || agents.length === 0) return;
    if (!agents.some((agent) => agent.id === form.ownerId)) {
      setForm((current) => ({ ...current, ownerId: defaultOwner(agents) }));
    }
  }, [agents, form.ownerId, open]);

  const update = <Key extends keyof FormState>(key: Key, value: FormState[Key]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  const selectTask = (task: TaskKind) => {
    const next = TASKS.find((entry) => entry.value === task);
    if (!next) return;
    setForm((current) => ({
      ...current,
      task,
      title: next.sample.title,
      brief: next.sample.brief,
      input: next.sample.input,
    }));
    setErrors({});
  };

  const validate = (): { errors: Record<string, string>; input: NewJobInput | null } => {
    const next: Record<string, string> = {};
    const duration = Number(form.durationSec);
    const deadline = Number(form.deadlineInSec);
    const reward = parsePositive(form.rewardNear);
    const bond = parsePositive(form.bondNear);
    const ask = parsePositive(form.askPerSecNear);

    if (!form.ownerId) next.ownerId = "Choose an owner agent.";
    if (form.title.trim().length < 4) next.title = "Give the job a title of at least 4 characters.";
    if (form.title.trim().length > 90) next.title = "Keep the title under 90 characters.";
    if (form.brief.trim().length < 10) next.brief = "Describe the brief in at least 10 characters.";
    if (form.input.trim().length < 10) next.input = "The worker needs input to compute from.";
    if (!Number.isInteger(duration) || duration < 3 || duration > 120) {
      next.durationSec = "Duration must be a whole number from 3 to 120 seconds.";
    }
    if (!Number.isInteger(deadline) || deadline < 5 || deadline > 600) {
      next.deadlineInSec = "Deadline must be a whole number from 5 to 600 seconds.";
    } else if (Number.isFinite(duration) && deadline <= duration + 1) {
      next.deadlineInSec = "Leave at least 2 seconds between the duration and the deadline.";
    }
    if (!reward) next.rewardNear = "Enter a positive NEAR reward.";
    if (!bond) next.bondNear = "Enter a positive NEAR bond.";
    if (!ask) next.askPerSecNear = "Enter a positive ask per second.";
    if (Object.keys(next).length > 0) return { errors: next, input: null };

    return {
      errors: next,
      input: {
        ownerId: form.ownerId,
        task: form.task,
        title: form.title.trim(),
        brief: form.brief.trim(),
        input: form.input.trim(),
        durationSec: duration,
        deadlineInSec: deadline,
        rewardNear: form.rewardNear.trim(),
        bondNear: form.bondNear.trim(),
        askPerSecNear: form.askPerSecNear.trim(),
      },
    };
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setServerError(null);
    const result = validate();
    setErrors(result.errors);
    if (!result.input) {
      const firstKey = Object.keys(result.errors)[0];
      if (firstKey) {
        document.getElementById(`new-job-${firstKey}`)?.focus();
      }
      return;
    }
    setSubmitting(true);
    try {
      const job = await api.createJob(result.input);
      await onCreated(job);
      onClose();
    } catch (caught) {
      setServerError(apiErrorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const errorFor = (key: string) =>
    errors[key] ? (
      <p className="field-error" id={`new-job-${key}-error`} role="alert">
        {errors[key]}
      </p>
    ) : null;

  const owner = agents.find((agent) => agent.id === form.ownerId);
  const reward = parsePositive(form.rewardNear);
  const bond = parsePositive(form.bondNear);
  const escrow = reward && bond ? formatNear(reward + bond) : "—";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      labelledBy="new-job-dialog-title"
      className="new-job-dialog"
      dismissible={!submitting}
    >
      <header className="dialog-head">
        <div>
          <span className="panel-kicker">New work</span>
          <h2 id="new-job-dialog-title">
            Submit a <span className="serif-accent">job.</span>
          </h2>
          <p>
            The worker computes from the input you provide. Nothing here is a
            placeholder.
          </p>
        </div>
        <button
          type="button"
          className="icon-button dialog-close"
          onClick={onClose}
          aria-label="Close new job dialog"
          disabled={submitting}
        >
          <X size={18} aria-hidden="true" />
        </button>
      </header>

      <form className="new-job-form" onSubmit={(event) => void submit(event)} noValidate>
        {serverError ? (
          <div className="form-error server-error" role="alert">
            <AlertCircle size={15} aria-hidden="true" />
            <span>{serverError}</span>
          </div>
        ) : null}

        {Object.keys(errors).length > 0 ? (
          <p className="form-error form-summary" role="alert">
            Check the highlighted fields before submitting.
          </p>
        ) : null}

        <div className="form-grid two-col">
          <div className="field">
            <label htmlFor="new-job-ownerId">Owner agent</label>
            <div className="select-wrap">
              <select
                id="new-job-ownerId"
                value={form.ownerId}
                onChange={(event) => update("ownerId", event.target.value)}
                aria-invalid={Boolean(errors.ownerId)}
                aria-describedby={errors.ownerId ? "new-job-ownerId-error" : "new-job-ownerId-hint"}
              >
                {agents
                  .filter(
                    (agent) =>
                      agent.role === "buyer" || agent.role === "slot-holder",
                  )
                  .map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name} — {agent.role}
                    </option>
                  ))}
              </select>
              <ChevronDown size={15} aria-hidden="true" />
            </div>
            <p className="field-hint" id="new-job-ownerId-hint">
              {owner ? `${owner.accountId} · escrow is debited from this owner.` : "No agents loaded."}
            </p>
            {errorFor("ownerId")}
          </div>

          <div className="field">
            <label htmlFor="new-job-task">Task</label>
            <div className="select-wrap">
              <select
                id="new-job-task"
                value={form.task}
                onChange={(event) => selectTask(event.target.value as TaskKind)}
              >
                {TASKS.map((task) => (
                  <option key={task.value} value={task.value}>
                    {task.label}
                  </option>
                ))}
              </select>
              <ChevronDown size={15} aria-hidden="true" />
            </div>
            <p className="field-hint">
              {TASKS.find((task) => task.value === form.task)?.hint}
            </p>
          </div>
        </div>

        <div className="field">
          <label htmlFor="new-job-title">Title</label>
          <input
            id="new-job-title"
            data-autofocus
            value={form.title}
            onChange={(event) => update("title", event.target.value)}
            maxLength={110}
            aria-invalid={Boolean(errors.title)}
            aria-describedby={errors.title ? "new-job-title-error" : undefined}
          />
          {errorFor("title")}
        </div>

        <div className="field">
          <label htmlFor="new-job-brief">Brief</label>
          <textarea
            id="new-job-brief"
            rows={2}
            value={form.brief}
            onChange={(event) => update("brief", event.target.value)}
            aria-invalid={Boolean(errors.brief)}
            aria-describedby={errors.brief ? "new-job-brief-error" : undefined}
          />
          {errorFor("brief")}
        </div>

        <div className="field">
          <div className="label-row">
            <label htmlFor="new-job-input">Task input</label>
            <span className="char-count mono">{form.input.length} chars</span>
          </div>
          <textarea
            id="new-job-input"
            className="input-mono"
            rows={6}
            value={form.input}
            onChange={(event) => update("input", event.target.value)}
            aria-invalid={Boolean(errors.input)}
            aria-describedby={errors.input ? "new-job-input-error" : "new-job-input-hint"}
          />
          <p className="field-hint" id="new-job-input-hint">
            The artifact is computed from this. Try changing a line and running the
            job again.
          </p>
          {errorFor("input")}
        </div>

        <fieldset className="form-fieldset">
          <legend>Schedule &amp; price</legend>
          <div className="form-grid three-col">
            <div className="field">
              <label htmlFor="new-job-durationSec">Duration (s)</label>
              <input
                id="new-job-durationSec"
                inputMode="numeric"
                value={form.durationSec}
                onChange={(event) => update("durationSec", event.target.value)}
                aria-invalid={Boolean(errors.durationSec)}
                aria-describedby={errors.durationSec ? "new-job-durationSec-error" : undefined}
              />
              {errorFor("durationSec")}
            </div>
            <div className="field">
              <label htmlFor="new-job-deadlineInSec">Deadline in (s)</label>
              <input
                id="new-job-deadlineInSec"
                inputMode="numeric"
                value={form.deadlineInSec}
                onChange={(event) => update("deadlineInSec", event.target.value)}
                aria-invalid={Boolean(errors.deadlineInSec)}
                aria-describedby={errors.deadlineInSec ? "new-job-deadlineInSec-error" : undefined}
              />
              {errorFor("deadlineInSec")}
            </div>
            <div className="field">
              <label htmlFor="new-job-askPerSecNear">Ask / sec (NEAR)</label>
              <input
                id="new-job-askPerSecNear"
                inputMode="decimal"
                value={form.askPerSecNear}
                onChange={(event) => update("askPerSecNear", event.target.value)}
                aria-invalid={Boolean(errors.askPerSecNear)}
                aria-describedby={
                  errors.askPerSecNear ? "new-job-askPerSecNear-error" : "new-job-ask-hint"
                }
              />
              <p className="field-hint" id="new-job-ask-hint">
                Published price to move this job back one second.
              </p>
              {errorFor("askPerSecNear")}
            </div>
          </div>

          <div className="form-grid two-col">
            <div className="field">
              <label htmlFor="new-job-rewardNear">Reward (NEAR)</label>
              <div className="input-with-suffix">
                <input
                  id="new-job-rewardNear"
                  inputMode="decimal"
                  value={form.rewardNear}
                  onChange={(event) => update("rewardNear", event.target.value)}
                  aria-invalid={Boolean(errors.rewardNear)}
                  aria-describedby={errors.rewardNear ? "new-job-rewardNear-error" : undefined}
                />
                <span>NEAR</span>
              </div>
              {errorFor("rewardNear")}
            </div>
            <div className="field">
              <label htmlFor="new-job-bondNear">Bond (NEAR)</label>
              <div className="input-with-suffix">
                <input
                  id="new-job-bondNear"
                  inputMode="decimal"
                  value={form.bondNear}
                  onChange={(event) => update("bondNear", event.target.value)}
                  aria-invalid={Boolean(errors.bondNear)}
                  aria-describedby={errors.bondNear ? "new-job-bondNear-error" : undefined}
                />
                <span>NEAR</span>
              </div>
              {errorFor("bondNear")}
            </div>
          </div>

          <div className="escrow-line">
            <div>
              <span>Escrow attached</span>
              <strong>{escrow}</strong>
            </div>
            <p>
              Reward + bond. Cancelling while queued forfeits 25% of the bond;
              the rest returns.
            </p>
          </div>
        </fieldset>

        <footer className="dialog-foot">
          <div className="dialog-foot-note">
            <span className="status-dot" aria-hidden="true" />
            FIFO by default · {agents.length} agents loaded
          </div>
          <div className="dialog-actions">
            <button
              type="button"
              className="button button-ghost"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="button button-primary"
              disabled={submitting || agents.length === 0}
            >
              {submitting ? <Loader2 className="spin" size={15} aria-hidden="true" /> : null}
              {submitting ? "Submitting" : "Submit to queue"}
            </button>
          </div>
        </footer>
      </form>
    </Dialog>
  );
}
