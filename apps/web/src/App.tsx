import { useCallback, useRef, useState } from "react";
import { MotionConfig } from "framer-motion";
import type { Job } from "@queue/core";
import { useQueueState } from "./hooks/useQueueState";
import { api, apiErrorMessage } from "./lib/api";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { Explainer } from "./components/Explainer";
import { Footer } from "./components/Footer";
import { Hero } from "./components/Hero";
import { LiveConsole } from "./components/LiveConsole";
import { Mechanism } from "./components/Mechanism";
import { Nav } from "./components/Nav";
import { NewJobDialog } from "./components/NewJobDialog";
import { Proof } from "./components/Proof";
import { Season } from "./components/Season";

type RunOrigin = "hero" | "console";
type ConfirmAction = "run" | "reset";


function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** True when a run/reset would destroy something the viewer can see. */
function stateIsDirty(state: ReturnType<typeof useQueueState>["state"]): boolean {
  if (!state) return false;
  return (
    state.queue.length > 0 ||
    Boolean(state.running) ||
    state.activity.length > 0 ||
    Object.values(state.credits).some((amount) => amount !== "0" && amount !== "")
  );
}

export default function App() {
  const queue = useQueueState();
  const [newJobOpen, setNewJobOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [runPending, setRunPending] = useState(false);
  const [resetPending, setResetPending] = useState(false);
  const [runError, setRunError] = useState<{ origin: RunOrigin; message: string } | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const confirmedOrigin = useRef<RunOrigin>("console");

  const scrollToConsole = useCallback(() => {
    document.getElementById("console")?.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "start",
    });
  }, []);

  const executeRun = useCallback(
    async (origin: RunOrigin, fromConfirm: boolean): Promise<boolean> => {
      setRunPending(true);
      setRunError(null);
      try {
        await api.runScenario();
        await queue.refresh();
        if (fromConfirm) setConfirmAction(null);
        return true;
      } catch (caught) {
        setRunError({ origin, message: apiErrorMessage(caught) });
        return false;
      } finally {
        setRunPending(false);
        // Only an explicit hero Run moves the page. Polls never scroll.
        if (origin === "hero") scrollToConsole();
      }
    },
    [queue.refresh, scrollToConsole],
  );

  const requestRun = useCallback(
    (origin: RunOrigin) => {
      setRunError(null);
      setResetError(null);
      confirmedOrigin.current = origin;
      // An untouched standby queue has nothing to lose: the first click runs at once.
      const needsConfirm =
        queue.state?.scenario.status === "running" ||
        (stateIsDirty(queue.state) && !queue.state?.untouched);
      if (needsConfirm) {
        setConfirmAction("run");
        return;
      }
      void executeRun(origin, false);
    },
    [executeRun, queue.state],
  );

  const requestReset = useCallback(() => {
    setRunError(null);
    setResetError(null);
    setConfirmAction("reset");
  }, []);

  const executeReset = useCallback(async () => {
    setResetPending(true);
    setResetError(null);
    try {
      await api.resetScenario();
      await queue.refresh();
      setConfirmAction(null);
    } catch (caught) {
      setResetError(apiErrorMessage(caught));
    } finally {
      setResetPending(false);
    }
  }, [queue.refresh]);

  const confirm = useCallback(() => {
    if (confirmAction === "run") {
      void executeRun(confirmedOrigin.current, true);
      return;
    }
    if (confirmAction === "reset") {
      void executeReset();
    }
  }, [confirmAction, executeRun, executeReset]);

  const onJobCreated = useCallback(
    async (_job: Job) => {
      await queue.refresh();
    },
    [queue.refresh],
  );

  const dialogError =
    confirmAction === "run" ? runError?.message ?? null : confirmAction === "reset" ? resetError : null;

  return (
    <MotionConfig reducedMotion="user">
      <a className="skip-link" href="#console">
        Skip to the operations console
      </a>
      <Nav state={queue.state} status={queue.status} />
      <main>
        <Hero
          state={queue.state}
          status={queue.status}
          onRunScenario={() => requestRun("hero")}
          runPending={runPending}
          runError={!confirmAction && runError?.origin === "hero" ? runError.message : null}
        />
        <Explainer />
        <LiveConsole
          state={queue.state}
          status={queue.status}
          error={queue.error}
          updatedAt={queue.updatedAt}
          refresh={queue.refresh}
          reconnect={queue.reconnect}
          onRunScenario={() => requestRun("console")}
          onReset={requestReset}
          runPending={runPending}
          resetPending={resetPending}
          runError={!confirmAction && runError?.origin === "console" ? runError.message : null}
          resetError={!confirmAction ? resetError : null}
          onNewJob={() => setNewJobOpen(true)}
        />
        <Mechanism />
        {/* Renders only when data/season/featured.json names a finished run. */}
        <Season />
        <Proof state={queue.state} />
      </main>
      <Footer state={queue.state} />

      <NewJobDialog
        open={newJobOpen}
        onClose={() => setNewJobOpen(false)}
        agents={queue.state?.agents ?? []}
        onCreated={onJobCreated}
      />
      <ConfirmDialog
        open={confirmAction !== null}
        action={confirmAction ?? "run"}
        running={queue.state?.scenario.status === "running"}
        onClose={() => {
          if (!runPending && !resetPending) setConfirmAction(null);
        }}
        onConfirm={confirm}
        pending={confirmAction === "run" ? runPending : resetPending}
        error={dialogError}
      />
    </MotionConfig>
  );
}
