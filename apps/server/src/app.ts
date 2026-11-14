import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { existsSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { formatNear } from "@queue/core";
import { clampLatestStart, nearToYocto } from "@queue/ledger";
import { QueueEngine, QueueError } from "./engine.js";
import { config, LIMITS, PROJECT_ROOT } from "./config.js";
import { readOnchainPayload, readSeasonPayload } from "./public-data.js";

const OWNER_IDS = ["kestrel", "mira", "atlas", "vale", "juno"] as const;

const createJobSchema = z.object({
  ownerId: z.enum(OWNER_IDS),
  task: z.enum(["incident-triage", "csv-audit", "launch-brief"]),
  title: z.string().min(LIMITS.titleMin).max(LIMITS.titleMax),
  brief: z.string().min(LIMITS.briefMin).max(LIMITS.briefMax),
  input: z.string().max(LIMITS.inputMax).default(""),
  durationSec: z.coerce.number().int().min(LIMITS.durationMinSec).max(LIMITS.durationMaxSec),
  deadlineInSec: z.coerce.number().int().min(LIMITS.deadlineMinSec).max(LIMITS.deadlineMaxSec),
  rewardNear: z.union([z.string(), z.number()]),
  bondNear: z.union([z.string(), z.number()]),
  askPerSecNear: z.union([z.string(), z.number()]).default("0.0004"),
});

const prioritySchema = z.object({
  latestStartInSec: z.coerce.number().min(0).max(3600).optional(),
  maxSpendNear: z.union([z.string(), z.number()]),
});

const askSchema = z.object({
  askPerSecNear: z.union([z.string(), z.number()]),
});

const money = nearToYocto;

function param(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new QueueError(`Missing ${name}.`, 400, "MISSING_PARAM");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Constant-time token comparison; CORS is not authentication. */
function tokensEqual(expected: string, supplied: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface AppDeps {
  engine: QueueEngine;
  version?: string;
  build?: string;
}

interface Counters {
  requests: number;
  mutations: number;
  errors: number;
  startedAt: number;
}

export function createApp({ engine, version = config.version, build = config.build }: AppDeps) {
  const app = express();
  const counters: Counters = {
    requests: 0,
    mutations: 0,
    errors: 0,
    startedAt: Date.now(),
  };
  const clients = new Set<Response>();
  const rate = new Map<string, { count: number; resetAt: number }>();

  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use((req, res, next) => {
    const requestId = req.header("x-request-id") || crypto.randomUUID();
    res.setHeader("x-request-id", requestId);
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
    // API answers are live state and proof files: a browser must never reuse a stale copy
    // (without this, a heuristic cache served the previous proof after a redeploy).
    if (req.path.startsWith("/api/")) res.setHeader("cache-control", "no-store");
    counters.requests += 1;
    const started = performance.now();
    res.on("finish", () => {
      if (config.logLevel === "debug") {
        console.log(
          JSON.stringify({
            level: "info",
            event: "http",
            method: req.method,
            path: req.path,
            status: res.statusCode,
            ms: Math.round(performance.now() - started),
            requestId,
          }),
        );
      }
    });
    next();
  });
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin) return callback(null, true);
        const allowed = new Set([
          "http://localhost:4178",
          "http://127.0.0.1:4178",
          "http://localhost:5173",
          "http://127.0.0.1:5173",
          ...(config.webOrigin ? [config.webOrigin] : []),
        ]);
        return callback(null, allowed.has(origin));
      },
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["content-type", "x-operator-token", "x-request-id"],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: "256kb", strict: true }));

  app.use((req, res, next) => {
    if (req.method === "GET") return next();
    const ip = req.ip || "unknown";
    const now = Date.now();
    const bucket = rate.get(ip);
    if (!bucket || bucket.resetAt < now) {
      rate.set(ip, { count: 1, resetAt: now + 60_000 });
      return next();
    }
    bucket.count += 1;
    if (bucket.count > 240) {
      res.setHeader("retry-after", "60");
      return res.status(429).json({ ok: false, error: "Too many mutations. Retry in a minute.", code: "RATE_LIMIT" });
    }
    return next();
  });

  const guardMutation = (req: Request, res: Response, next: NextFunction) => {
    if (config.readOnly) {
      return res.status(503).json({ ok: false, error: "The console is in read-only mode.", code: "READ_ONLY" });
    }
    if (config.operatorToken) {
      const token = req.header("x-operator-token") ?? "";
      if (!tokensEqual(config.operatorToken, token)) {
        return res.status(401).json({ ok: false, error: "Operator token required.", code: "UNAUTHORIZED" });
      }
    }
    counters.mutations += 1;
    return next();
  };

  app.get("/api/health", (_req, res) => {
    const health = engine.health();
    const ok = health.db === "ok";
    res.status(ok ? 200 : 503).json({
      ok,
      version,
      build,
      mode: "local",
      uptimeSec: Math.floor((Date.now() - counters.startedAt) / 1000),
      ...health,
    });
  });

  app.get("/api/version", (_req, res) => {
    res.json({
      ok: true,
      version,
      build,
      node: process.version,
      mode: "local",
      schemaVersion: 1,
    });
  });

  app.get("/api/state", (_req, res) => {
    // Reads must not mutate: recycling only runs from the interval in index.ts.
    res.json({ ok: true, state: engine.getState() });
  });

  app.get("/api/quote", (req, res) => {
    const jobId = String(req.query.jobId || "");
    if (!jobId) throw new QueueError("jobId is required.", 400, "MISSING_JOB_ID");
    const seconds =
      req.query.latestStartInSec === undefined
        ? undefined
        : Number(req.query.latestStartInSec);
    if (seconds !== undefined && !Number.isFinite(seconds)) {
      throw new QueueError("latestStartInSec must be a number.", 400, "BAD_CUTOFF");
    }
    const latestStartAt = clampLatestStart(engine, jobId, seconds);
    res.json({ ok: true, quote: engine.quote(jobId, latestStartAt) });
  });

  app.post("/api/jobs", guardMutation, (req, res) => {
    const body = createJobSchema.parse(req.body);
    const job = engine.createJob({
      ownerId: body.ownerId,
      task: body.task,
      title: body.title,
      brief: body.brief,
      input: body.input,
      durationSec: body.durationSec,
      deadlineInSec: body.deadlineInSec,
      rewardYocto: money(body.rewardNear, "rewardNear"),
      bondYocto: money(body.bondNear, "bondNear"),
      askPerSecYocto: money(body.askPerSecNear, "askPerSecNear"),
    });
    res.status(201).json({ ok: true, job });
  });

  app.post("/api/jobs/:id/priority", guardMutation, (req, res) => {
    const body = prioritySchema.parse(req.body);
    const jobId = param(req, "id");
    const latestStartAt = clampLatestStart(engine, jobId, body.latestStartInSec);
    const maxSpend = money(body.maxSpendNear, "maxSpendNear");
    const result = engine.buyPriority(jobId, latestStartAt, maxSpend);
    res.json({ ok: true, ...result, state: engine.getState() });
  });

  app.post("/api/jobs/:id/move-ask", guardMutation, (req, res) => {
    const body = askSchema.parse(req.body);
    const job = engine.setAsk(param(req, "id"), money(body.askPerSecNear, "askPerSecNear"));
    res.json({ ok: true, job });
  });

  app.post("/api/jobs/:id/cancel", guardMutation, (req, res) => {
    const job = engine.cancelJob(param(req, "id"));
    res.json({ ok: true, job });
  });

  app.post("/api/operator/start", guardMutation, (_req, res) => {
    const result = engine.startNext();
    res.json({ ok: true, ...result, state: engine.getState() });
  });

  app.post("/api/credits/:agentId/withdraw", guardMutation, (req, res) => {
    const result = engine.withdraw(param(req, "agentId"));
    res.json({ ok: true, ...result, state: engine.getState() });
  });

  app.post("/api/demo/run", guardMutation, (_req, res) => {
    const scenario = engine.runScenario();
    res.status(202).json({ ok: true, scenario, state: engine.getState() });
  });

  app.post("/api/demo/reset", guardMutation, (_req, res) => {
    const state = engine.reset();
    res.json({ ok: true, state });
  });

  app.get("/api/artifacts/:id", (req, res) => {
    res.json({ ok: true, artifact: engine.getArtifact(req.params.id) });
  });

  app.get("/api/jobs/:id/artifact", (req, res) => {
    const artifact = engine.getArtifactForJob(req.params.id);
    if (!artifact) throw new QueueError("No artifact for this job yet.", 404, "ARTIFACT_NOT_FOUND");
    res.json({ ok: true, artifact });
  });

  app.get("/api/onchain", (_req, res) => {
    res.json(readOnchainPayload(PROJECT_ROOT));
  });

  app.get("/api/season", (_req, res) => {
    res.json(readSeasonPayload(PROJECT_ROOT));
  });

  app.get("/api/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const send = () => {
      try {
        res.write(`event: snapshot\ndata: ${JSON.stringify(engine.getState())}\n\n`);
      } catch {
        clients.delete(res);
      }
    };
    const heartbeat = setInterval(() => {
      try {
        res.write(`: heartbeat ${Date.now()}\n\n`);
      } catch {
        clearInterval(heartbeat);
        clients.delete(res);
      }
    }, 15_000);
    // A fresh snapshot keeps `now`, countdowns and projected starts honest even
    // when nobody is mutating the queue.
    const clockTick = setInterval(send, 5_000);
    const unsubscribe = engine.subscribe(send);
    clients.add(res);
    send();
    req.on("close", () => {
      clearInterval(heartbeat);
      clearInterval(clockTick);
      unsubscribe();
      clients.delete(res);
    });
  });

  app.get("/api/metrics", (_req, res) => {
    const state = engine.getState();
    const lines = [
      "# HELP queue_http_requests_total Total HTTP requests.",
      "# TYPE queue_http_requests_total counter",
      `queue_http_requests_total ${counters.requests}`,
      "# HELP queue_mutations_total Total state mutations.",
      "# TYPE queue_mutations_total counter",
      `queue_mutations_total ${counters.mutations}`,
      "# HELP queue_jobs_queued Jobs waiting in the queue.",
      "# TYPE queue_jobs_queued gauge",
      `queue_jobs_queued ${state.queue.length}`,
      "# HELP queue_jobs_completed_total Completed jobs.",
      "# TYPE queue_jobs_completed_total counter",
      `queue_jobs_completed_total ${state.stats.completed}`,
      "# HELP queue_priority_paid_yocto Total priority spend.",
      "# TYPE queue_priority_paid_yocto counter",
      `queue_priority_paid_yocto ${state.stats.totalPriorityYocto}`,
      "# HELP queue_uptime_seconds Process uptime.",
      "# TYPE queue_uptime_seconds gauge",
      `queue_uptime_seconds ${Math.floor((Date.now() - counters.startedAt) / 1000)}`,
      "",
    ];
    res.setHeader("content-type", "text/plain; version=0.0.4; charset=utf-8");
    res.send(lines.join("\n"));
  });

  const webDist = path.join(PROJECT_ROOT, "apps", "web", "dist");
  if (existsSync(webDist)) {
    app.use(express.static(webDist, { maxAge: "1h", index: false }));
    app.get(/^(?!\/api).*/, (_req, res) => {
      res.sendFile(path.join(webDist, "index.html"));
    });
  }

  app.use((req, _res, next) => {
    next(new QueueError(`No route for ${req.method} ${req.path}.`, 404, "NOT_FOUND"));
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    counters.errors += 1;
    if (error instanceof z.ZodError) {
      const first = error.issues[0];
      res.status(400).json({
        ok: false,
        error: first ? `${first.path.join(".") || "body"}: ${first.message}` : "Invalid request.",
        code: "VALIDATION",
      });
      return;
    }
    if (error instanceof QueueError) {
      res.status(error.status).json({ ok: false, error: error.message, code: error.code });
      return;
    }
    if (isRecord(error) && (error.type === "entity.too.large" || error.status === 413)) {
      res.status(413).json({
        ok: false,
        error: "Request body is too large; the limit is 256kb.",
        code: "BODY_TOO_LARGE",
      });
      return;
    }
    if (error instanceof SyntaxError && "body" in error) {
      res.status(400).json({ ok: false, error: "Invalid JSON body.", code: "BAD_JSON" });
      return;
    }
    console.error(
      JSON.stringify({
        level: "error",
        event: "request_failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    res.status(500).json({ ok: false, error: "Internal server error.", code: "INTERNAL" });
  });

  return app;
}

export function onchainLabel(proof: unknown): string {
  if (!proof || typeof proof !== "object") return "not deployed";
  const record = proof as Record<string, unknown>;
  return typeof record.contractId === "string" ? record.contractId : "not deployed";
}

export function formatQuoteTotal(totalYocto: string): string {
  return formatNear(totalYocto);
}
