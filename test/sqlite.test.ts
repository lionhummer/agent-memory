import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/sqlite.js";
test("SQLite persists state and arbitrates competing connections atomically", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-memory-")),
    path = join(dir, "memory.sqlite");
  let a: SqliteStore | undefined, b: SqliteStore | undefined;
  try {
    a = new SqliteStore(path);
    b = new SqliteStore(path);
    const state = {
      memories: [],
      summaries: [],
      operations: [{ id: "op", fingerprint: "hash" }],
    };
    assert.equal(await a.compareAndSwap("key", 0, state), true);
    assert.equal(await b.compareAndSwap("key", 0, state), false);
    assert.equal(await b.compareAndSwap("key", 1, state), true);
    assert.equal(await a.compareAndSwap("key", 1, state), false);
    a.close();
    a = new SqliteStore(path);
    assert.equal((await a.load("key")).revision, 2);
    assert.equal((await a.load("other")).revision, 0);
  } finally {
    a?.close();
    b?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
