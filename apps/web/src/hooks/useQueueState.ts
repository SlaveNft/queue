import { useCallback, useEffect, useRef, useState } from "react";
import type { QueueState } from "@queue/core";
import {
  api,
  apiErrorMessage,
  apiUrl,
  extractState,
} from "../lib/api";
import { BROWSER_BACKEND } from "../lib/backend";
import { localLedger } from "../lib/localLedger";

export type ConnectionStatus = "loading" | "live" | "polling" | "offline";

export interface QueueStore {
  state: QueueState | null;
  status: ConnectionStatus;
  error: string | null;
  updatedAt: number | null;
  refresh: () => Promise<QueueState | null>;
  reconnect: () => void;
}

const POLL_MS = 4_000;
const STALE_MS = 8_000;

export function useQueueState(): QueueStore {
  const [state, setState] = useState<QueueState | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [generation, setGeneration] = useState(0);

  const sourceRef = useRef<EventSource | null>(null);
  const pollRef = useRef<number | null>(null);
  const sseOpenRef = useRef(false);
  const lastUpdateRef = useRef(0);

  const applyState = useCallback((next: QueueState) => {
    setState(next);
    const at = Date.now();
    lastUpdateRef.current = at;
    setUpdatedAt(at);
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const refresh = useCallback(async (): Promise<QueueState | null> => {
    try {
      const next = await api.getState();
      applyState(next);
      setError(null);
      setStatus((current) =>
        current === "offline" || current === "loading"
          ? BROWSER_BACKEND
            ? "live"
            : "polling"
          : current,
      );
      return next;
    } catch (caught) {
      setError(apiErrorMessage(caught));
      setStatus("offline");
      return null;
    }
  }, [applyState]);

  const reconnect = useCallback(() => {
    setError(null);
    setStatus((current) => (current === "offline" ? "loading" : current));
    setGeneration((value) => value + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    sseOpenRef.current = false;

    const poll = async () => {
      try {
        const next = await api.getState();
        if (cancelled) return;
        applyState(next);
        setError(null);
        setStatus("polling");
      } catch (caught) {
        if (cancelled) return;
        setError(apiErrorMessage(caught));
        setStatus("offline");
      }
    };

    const startPolling = () => {
      if (cancelled || pollRef.current !== null) return;
      pollRef.current = window.setInterval(() => void poll(), POLL_MS);
    };

    const loadInitial = async () => {
      try {
        const next = await api.getState();
        if (cancelled) return;
        applyState(next);
        setError(null);
        setStatus((current) => (current === "loading" ? "polling" : current));
      } catch (caught) {
        if (cancelled) return;
        setError(apiErrorMessage(caught));
        setStatus("offline");
        startPolling();
      }
    };

    if (BROWSER_BACKEND) {
      // The ledger lives in this tab: subscribe to it instead of opening a stream.
      applyState(localLedger.getState());
      setError(null);
      setStatus("live");
      const unsubscribe = localLedger.subscribe((next) => {
        if (!cancelled) applyState(next);
      });
      // Keep `now`, countdowns and projected starts honest while nothing changes.
      const clockTick = window.setInterval(() => {
        if (!cancelled) applyState(localLedger.getState());
      }, 5_000);
      return () => {
        cancelled = true;
        unsubscribe();
        window.clearInterval(clockTick);
      };
    }

    void loadInitial();

    try {
      const source = new EventSource(apiUrl("/api/events"));
      sourceRef.current = source;

      const onSnapshot = (event: MessageEvent<string>) => {
        if (cancelled) return;
        try {
          const payload: unknown = JSON.parse(event.data);
          const next = extractState(payload);
          if (!next) return;
          applyState(next);
          setError(null);
          setStatus("live");
        } catch {
          // Ignore malformed frames; the next snapshot will correct the view.
        }
      };

      source.addEventListener("snapshot", onSnapshot as EventListener);
      source.addEventListener("message", onSnapshot as EventListener);
      source.addEventListener("open", () => {
        if (cancelled) return;
        sseOpenRef.current = true;
        setStatus("live");
        setError(null);
      });
      source.addEventListener("error", () => {
        sseOpenRef.current = false;
        source.close();
        if (sourceRef.current === source) sourceRef.current = null;
        if (cancelled) return;
        setStatus((current) => (current === "offline" ? "offline" : "polling"));
        startPolling();
      });
    } catch {
      startPolling();
    }

    // Safety net: a proxied SSE stream can go silent without an error event
    // (for example when the API restarts behind Vite). If no snapshot has
    // arrived for a while, fetch one, so the console never freezes on an old
    // state.
    const watchdog = window.setInterval(() => {
      if (Date.now() - lastUpdateRef.current <= STALE_MS) return;
      // Refresh the data only; the connection pill keeps its SSE/polling state.
      api
        .getState()
        .then((next) => {
          if (!cancelled) applyState(next);
        })
        .catch(() => undefined);
    }, STALE_MS);

    return () => {
      cancelled = true;
      window.clearInterval(watchdog);
      stopPolling();
      sourceRef.current?.close();
      sourceRef.current = null;
      sseOpenRef.current = false;
    };
  }, [generation, applyState, stopPolling]);

  return { state, status, error, updatedAt, refresh, reconnect };
}
