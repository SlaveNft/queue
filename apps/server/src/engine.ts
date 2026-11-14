import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { LedgerEngine, type EngineOptions, type SnapshotStore } from "@queue/ledger";

export { QueueError, type CreateJobInput, type EngineHealth } from "@queue/ledger";

/** One-row SQLite snapshot: the API server's ledger survives a restart. */
export function sqliteStore(dbPath: string): SnapshotStore {
  if (dbPath !== ":memory:") {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS snapshot (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return {
    load() {
      const row = db.prepare("SELECT json FROM snapshot WHERE id = 1").get() as
        | { json?: string }
        | undefined;
      return row?.json ?? null;
    },
    save(json, updatedAtIso) {
      db.prepare(
        "INSERT INTO snapshot (id, json, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
      ).run(json, updatedAtIso);
    },
    close() {
      db.close();
    },
  };
}

export interface QueueEngineOptions extends Omit<EngineOptions, "store"> {
  dbPath?: string;
}

/**
 * The ledger engine (`packages/ledger`) with SQLite persistence. The console's
 * in-browser mode runs the same `LedgerEngine` with an in-memory store.
 */
export class QueueEngine extends LedgerEngine {
  constructor({ dbPath = ":memory:", ...options }: QueueEngineOptions = {}) {
    super({ ...options, store: sqliteStore(dbPath) });
  }
}
