import { DatabaseSync } from "node:sqlite";
import { emptyState } from "./store.js";
import type { MemoryStore, Snapshot, State } from "./types.js";
/** Node's built-in SQLite adapter. Stores one JSON state per tenant/user.
 * Intended for small deployments; implement indexed storage for large histories.
 * Call close() after all engine operations finish. */
export class SqliteStore implements MemoryStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS agent_memory_v1 (key TEXT PRIMARY KEY, revision INTEGER NOT NULL, state TEXT NOT NULL)",
    );
  }
  async load(key: string): Promise<Snapshot> {
    const row = this.db
      .prepare("SELECT revision, state FROM agent_memory_v1 WHERE key = ?")
      .get(key);
    if (!row) return { revision: 0, state: emptyState() };
    return {
      revision: Number(row.revision),
      state: JSON.parse(String(row.state)) as State,
    };
  }
  async compareAndSwap(
    key: string,
    expectedRevision: number,
    state: State,
  ): Promise<boolean> {
    const serialized = JSON.stringify(state);
    if (expectedRevision === 0) {
      return (
        this.db
          .prepare(
            "INSERT INTO agent_memory_v1 (key, revision, state) VALUES (?, 1, ?) ON CONFLICT(key) DO NOTHING",
          )
          .run(key, serialized).changes === 1
      );
    }
    return (
      this.db
        .prepare(
          "UPDATE agent_memory_v1 SET revision = revision + 1, state = ? WHERE key = ? AND revision = ?",
        )
        .run(serialized, key, expectedRevision).changes === 1
    );
  }
  close(): void {
    this.db.close();
  }
}
