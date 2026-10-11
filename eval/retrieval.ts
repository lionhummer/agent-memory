/** Seeded lexical retrieval evaluation. Ground-truth extraction; no model call. */
import assert from "node:assert/strict";
import { AgentMemory, InMemoryStore, type Context } from "../src/index.js";
const words = [
  "cobalt",
  "saffron",
  "juniper",
  "quartz",
  "indigo",
  "marigold",
  "granite",
  "cypress",
];
const engine = new AgentMemory({
  store: new InMemoryStore(),
  now: () => new Date("2026-01-01"),
  extract: async ({ messages }) => ({
    facts: [
      {
        category: "decision",
        content: messages[0]!.content,
        sourceMessageIds: [messages[0]!.id],
      },
    ],
  }),
});
let queries = 0,
  hits = 0,
  leaks = 0;
for (let project = 0; project < 4; project++) {
  const context: Context = {
    tenantId: "synthetic",
    userId: "tester",
    workspaceId: "workspace",
    projectId: `project-${project}`,
    threadId: "seed",
    origin: "human",
  };
  for (const word of words)
    await engine.ingest({
      operationId: `${project}-${word}`,
      context,
      messages: [
        {
          id: word,
          author: { kind: "human", id: "tester" },
          content: `The ${word} service in project ${project} uses SQLite.`,
          timestamp: "2026-01-01T00:00:00Z",
        },
      ],
    });
  for (const word of words) {
    const result = await engine.recall({
      context: { ...context, threadId: "recall" },
      query: word,
      limit: 1,
      tokenBudget: 128,
    });
    queries++;
    if (result.items[0]?.content.includes(word)) hits++;
    assert.ok(result.tokens <= 128);
    if (result.items.some((i) => !i.content.includes(`project ${project}`)))
      leaks++;
  }
  for (const changed of [
    { tenantId: "other" },
    { userId: "other" },
    { workspaceId: "other" },
    { projectId: "missing" },
  ]) {
    const result = await engine.recall({
      context: { ...context, ...changed },
      query: "SQLite",
    });
    leaks += result.items.length;
  }
}
const report = {
  suite: "synthetic lexical retrieval",
  queries,
  top1Hits: hits,
  scopeLeaks: leaks,
  modelCalls: 0,
};
console.log(JSON.stringify(report, null, 2));
assert.equal(hits, queries);
assert.equal(leaks, 0);
