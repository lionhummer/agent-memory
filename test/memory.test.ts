import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AgentMemory,
  InMemoryStore,
  type Context,
  type Extraction,
  type Message,
  type MemoryStore,
} from "../src/index.js";
const context: Context = {
  tenantId: "acme",
  userId: "alice",
  workspaceId: "engineering",
  projectId: "gateway",
  threadId: "t1",
  origin: "human",
};
const message = (
  id = "u1",
  kind: Message["author"]["kind"] = "human",
  content = "Use Postgres",
): Message => ({
  id,
  author: { kind, id: kind === "human" ? "alice" : "agent" },
  content,
  timestamp: "2026-01-01T00:00:00Z",
});
const decision = (sources = ["u1"]): Extraction => ({
  facts: [
    {
      category: "decision",
      content: "We use Postgres",
      sourceMessageIds: sources,
    },
  ],
});
function fixture(extraction: Extraction = decision()) {
  const store = new InMemoryStore();
  let calls = 0;
  const engine = new AgentMemory({
    store,
    extract: async () => {
      calls++;
      return extraction;
    },
  });
  return { engine, store, calls: () => calls };
}
const ingest = (
  engine: AgentMemory,
  id = "op1",
  c = context,
  m = [message()],
) => engine.ingest({ operationId: id, context: c, messages: m });
test("recalls across threads in project but isolates users, projects and tenants", async () => {
  const { engine } = fixture();
  await ingest(engine);
  assert.equal((await engine.list({ ...context, threadId: "t2" })).length, 1);
  for (const c of [
    { ...context, userId: "bob" },
    { ...context, tenantId: "other" },
    { ...context, projectId: "other" },
    { ...context, workspaceId: "other" },
  ])
    assert.equal((await engine.list(c)).length, 0);
});
test("successful replay avoids model call; operation ID cannot alias different input", async () => {
  const f = fixture();
  await ingest(f.engine);
  assert.equal((await ingest(f.engine)).duplicate, true);
  assert.equal(f.calls(), 1);
  await assert.rejects(
    ingest(f.engine, "op1", context, [message("u1", "human", "Use SQLite")]),
    /reused/,
  );
});
test("assistant and parent-agent instructions do not become user commitments", async () => {
  const f = fixture(decision(["a1"]));
  assert.equal(
    (await ingest(f.engine, "op", context, [message("a1", "agent")])).stored
      .length,
    0,
  );
  const other = fixture();
  assert.equal(
    (await ingest(other.engine, "op", { ...context, origin: "agent" }))
      .rejected[0]?.reason,
    "human-attribution-required",
  );
});
test("unknown references and another person's statements fail attribution", async () => {
  const f = fixture(decision(["missing"]));
  assert.equal((await ingest(f.engine)).rejected[0]?.reason, "unknown-source");
  const g = fixture();
  const m = message();
  m.author.id = "bob";
  assert.equal((await ingest(g.engine, "op", context, [m])).stored.length, 0);
});
test("group conversations cannot write personal facts with default policies", async () => {
  const f = fixture({
    facts: [
      {
        category: "preference",
        content: "Likes terse replies",
        sourceMessageIds: ["u1"],
      },
    ],
  });
  assert.equal(
    (await ingest(f.engine, "op", { ...context, origin: "group" })).stored
      .length,
    0,
  );
});
test("correction keeps source history and hides superseded fact", async () => {
  const store = new InMemoryStore();
  let replaces: string[] = [];
  const engine = new AgentMemory({
    store,
    extract: async () => ({
      facts: [
        {
          category: "decision",
          content: replaces.length ? "We use SQLite" : "We use Postgres",
          sourceMessageIds: ["u1"],
          replaces,
        },
      ],
    }),
  });
  const initial = await ingest(engine);
  replaces = initial.stored;
  await ingest(engine, "op2");
  const live = await engine.list(context);
  assert.equal(live.length, 1);
  assert.equal(live[0]?.content, "We use SQLite");
  assert.deepEqual(live[0]?.supersedes, initial.stored);
  assert.equal(
    (await engine.list(context, { includeHistory: true })).length,
    2,
  );
});
test("replacement cannot cross category or project", async () => {
  const store = new InMemoryStore();
  let replaces: string[] = [];
  const engine = new AgentMemory({
    store,
    extract: async () => ({
      facts: [
        {
          category: "decision",
          content: "Use SQLite",
          sourceMessageIds: ["u1"],
          replaces,
        },
      ],
    }),
  });
  replaces = (await ingest(engine)).stored;
  const result = await ingest(engine, "op2", {
    ...context,
    projectId: "other",
  });
  assert.equal(result.rejected[0]?.reason, "replacement-not-live-in-scope");
  assert.equal((await engine.list(context)).length, 1);
});
test("scope policy is application controlled and requires relevant IDs", async () => {
  const f = fixture();
  const c: Context = {
    tenantId: "acme",
    userId: "alice",
    threadId: "t1",
    origin: "human",
  };
  assert.equal(
    (await ingest(f.engine, "op", c)).rejected[0]?.reason,
    "scope-context-required",
  );
});
test("recall fits exact rendered budget and reports semantic fallback", async () => {
  const f = fixture();
  await ingest(f.engine);
  const result = await f.engine.recall({
    context,
    query: "Postgres",
    tokenBudget: 10,
  });
  assert.equal(result.items.length, 0);
  assert.ok(result.tokens <= 10);
  const engine = new AgentMemory({
    store: f.store,
    extract: async () => decision(),
    embeddingTimeoutMs: 5,
    embed: async () => new Promise(() => {}),
  });
  const fallback = await engine.recall({ context, query: "Postgres" });
  assert.equal(fallback.retrieval, "lexical");
  assert.equal(fallback.embeddingFailure, "TIMEOUT");
  assert.equal(fallback.items.length, 1);
});
test("matching vectors select semantic retrieval; malformed vectors fall back", async () => {
  const f = fixture();
  await ingest(f.engine);
  const e = new AgentMemory({
    store: f.store,
    extract: async () => decision(),
    embed: async (texts) => texts.map(() => [1, 0]),
  });
  assert.equal(
    (await e.recall({ context, query: "database" })).retrieval,
    "semantic",
  );
  const bad = new AgentMemory({
    store: f.store,
    extract: async () => decision(),
    embed: async () => [[1], [1, 2]],
  });
  assert.equal(
    (await bad.recall({ context, query: "x" })).embeddingFailure,
    "MODEL_OUTPUT",
  );
});
test("expiry hides memories without destroying audit history", async () => {
  const engine = new AgentMemory({
    store: new InMemoryStore(),
    now: () => new Date("2026-02-01"),
    extract: async () => ({
      facts: [{ ...decision().facts[0]!, expiresAt: "2026-01-15T00:00:00Z" }],
    }),
  });
  await ingest(engine);
  assert.equal((await engine.list(context)).length, 0);
  assert.equal(
    (await engine.list(context, { includeHistory: true })).length,
    1,
  );
});
test("concurrent ingestions retain both updates", async () => {
  const store = new InMemoryStore();
  const engine = new AgentMemory({ store, extract: async () => decision() });
  await Promise.all([ingest(engine, "a"), ingest(engine, "b")]);
  assert.equal((await engine.list(context)).length, 2);
});
test("concurrent replay stores only once", async () => {
  const f = fixture();
  const results = await Promise.all([ingest(f.engine), ingest(f.engine)]);
  assert.equal(results.filter((r) => r.duplicate).length, 1);
  assert.equal((await f.engine.list(context)).length, 1);
});
test("model failure does not mark an extraction window processed", async () => {
  let fail = true;
  const engine = new AgentMemory({
    store: new InMemoryStore(),
    extract: async () => {
      if (fail) throw new Error("provider down");
      return decision();
    },
  });
  await assert.rejects(ingest(engine), /provider down/);
  fail = false;
  assert.equal((await ingest(engine)).duplicate, false);
});
test("oversized input and malformed output never write", async () => {
  const f = fixture();
  await assert.rejects(
    ingest(f.engine, "op", context, [
      message("u1", "human", "x".repeat(200_000)),
    ]),
    /exceeds/,
  );
  assert.equal(f.calls(), 0);
  const bad = new AgentMemory({
    store: f.store,
    extract: async () =>
      ({ facts: [{ category: "alien" }] }) as unknown as Extraction,
  });
  await assert.rejects(ingest(bad), /Malformed/);
  assert.equal((await bad.list(context)).length, 0);
});
test("summary stays in exact thread/workspace/project context", async () => {
  const f = fixture({ facts: [], summary: "We shipped a gateway" });
  await ingest(f.engine);
  assert.equal(
    (await f.engine.recall({ context, query: "gateway" })).items.length,
    1,
  );
  assert.equal(
    (
      await f.engine.recall({
        context: { ...context, projectId: "other" },
        query: "gateway",
      })
    ).items.length,
    0,
  );
});
test("consolidator cannot delete unseen facts or rewrite protected decisions", async () => {
  const f = fixture();
  await ingest(f.engine);
  const e = new AgentMemory({
    store: f.store,
    extract: async () => decision(),
    consolidate: async () => [{ type: "delete", ids: ["invented"] }],
  });
  await assert.rejects(
    e.consolidate({
      operationId: "maintenance-1",
      context,
      category: "decision",
    }),
    /disabled/,
  );
  const entity = new AgentMemory({
    store: f.store,
    policies: {
      entity: {
        scope: "project",
        requireHuman: false,
        entityKeyRequired: true,
        upsert: false,
      },
    },
    extract: async () => ({
      facts: [
        {
          category: "entity",
          content: "Postgres database",
          entityKey: "postgres",
          sourceMessageIds: ["u1"],
        },
      ],
    }),
    consolidate: async () => [{ type: "delete", ids: ["invented"] }],
  });
  await ingest(entity, "entity");
  await assert.rejects(
    entity.consolidate({
      operationId: "maintenance-1",
      context,
      category: "entity",
    }),
    /supplied/,
  );
});
test("consolidation preserves source lineage and merges matching entities", async () => {
  const engine = new AgentMemory({
    store: new InMemoryStore(),
    policies: {
      entity: {
        scope: "project",
        requireHuman: false,
        entityKeyRequired: true,
        upsert: false,
      },
    },
    extract: async () => ({
      facts: [
        {
          category: "entity",
          content: "Postgres database",
          entityKey: "postgres",
          sourceMessageIds: ["u1"],
        },
      ],
    }),
    consolidate: async (facts) => [
      {
        type: "merge",
        ids: facts.map((f) => f.id),
        content: "Postgres is our database",
      },
    ],
  });
  await ingest(engine, "a");
  await ingest(engine, "b");
  assert.equal(
    (
      await engine.consolidate({
        operationId: "maintenance-1",
        context,
        category: "entity",
      })
    ).merged,
    1,
  );
  const live = await engine.list(context);
  assert.equal(live.length, 1);
  assert.equal(live[0]?.supersedes.length, 2);
});
test("cancelled calls do not start extraction", async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    f.engine.ingest({
      operationId: "op",
      context,
      messages: [message()],
      signal: controller.signal,
    }),
    /aborted/,
  );
  assert.equal(f.calls(), 0);
});
test("uncertain CAS is reported instead of claiming no effect", async () => {
  const store: MemoryStore = {
    load: async () => ({
      revision: 0,
      state: { memories: [], summaries: [], operations: [] },
    }),
    compareAndSwap: async () => new Promise(() => {}),
  };
  const e = new AgentMemory({
    store,
    extract: async () => decision(),
    timeoutMs: 10,
  });
  await assert.rejects(
    ingest(e),
    (err: unknown) =>
      err instanceof Error && "code" in err && err.code === "INDETERMINATE",
  );
});

test("consolidation replay does not call the model or rewrite again", async () => {
  let calls = 0;
  const engine = new AgentMemory({
    store: new InMemoryStore(),
    policies: {
      entity: {
        scope: "project",
        requireHuman: false,
        entityKeyRequired: true,
        upsert: false,
      },
    },
    extract: async () => ({
      facts: [
        {
          category: "entity",
          content: "Database",
          entityKey: "db",
          sourceMessageIds: ["u1"],
        },
      ],
    }),
    consolidate: async (facts) => {
      calls++;
      return [
        { type: "merge", ids: facts.map((f) => f.id), content: "Our database" },
      ];
    },
  });
  await ingest(engine, "a");
  await ingest(engine, "b");
  const input = {
    operationId: "maintenance-1",
    context,
    category: "entity" as const,
  };
  await engine.consolidate(input);
  assert.deepEqual(await engine.consolidate(input), { merged: 0, deleted: 0 });
  assert.equal(calls, 1);
});
test("identity entity-key drift cannot fork a user's identity", async () => {
  let entityKey = "self";
  const engine = new AgentMemory({
    store: new InMemoryStore(),
    extract: async () => ({
      facts: [
        {
          category: "identity",
          content: "Alice is an engineer",
          entityKey,
          sourceMessageIds: ["u1"],
        },
      ],
    }),
  });
  await ingest(engine, "a");
  entityKey = "alice";
  await ingest(engine, "b");
  assert.equal((await engine.list(context)).length, 1);
  assert.equal(
    (await engine.list(context, { includeHistory: true })).length,
    2,
  );
});
