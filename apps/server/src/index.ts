import { createApp } from "./app.js";
import { config } from "./config.js";
import { QueueEngine } from "./engine.js";

const engine = new QueueEngine({ dbPath: config.dbPath });
const app = createApp({ engine });

const server = app.listen(config.port, config.host, () => {
  console.log(
    JSON.stringify({
      level: "info",
      event: "server_started",
      port: config.port,
      host: config.host,
      mode: "local",
      version: config.version,
      db: config.dbPath,
      url: `http://localhost:${config.port}`,
    }),
  );
});

server.requestTimeout = 30_000;
server.headersTimeout = 35_000;
server.keepAliveTimeout = 5_000;

const recycleTimer = setInterval(() => {
  try {
    const expired = engine.sweepExpired();
    if (expired > 0) {
      console.log(JSON.stringify({ level: "info", event: "queued_timeout", jobs: expired }));
    }
    if (engine.maybeRecycle()) {
      console.log(JSON.stringify({ level: "info", event: "standby_recycled" }));
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "recycle_failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}, 5_000);
recycleTimer.unref();

let closing = false;
function shutdown(signal: string): void {
  if (closing) return;
  closing = true;
  console.log(JSON.stringify({ level: "info", event: "shutdown", signal }));
  clearInterval(recycleTimer);
  server.close(() => {
    engine.close();
    process.exit(0);
  });
  setTimeout(() => {
    engine.close();
    process.exit(1);
  }, 8_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  console.error(
    JSON.stringify({
      level: "error",
      event: "unhandled_rejection",
      reason: reason instanceof Error ? reason.message : String(reason),
    }),
  );
});
