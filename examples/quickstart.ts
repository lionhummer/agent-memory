import { AgentMemory, InMemoryStore, type Extractor } from "../src/index.js";
// Deterministic demonstration: replace this callback with your model adapter.
const extract: Extractor = async ({ messages }) => ({
  facts: [
    {
      category: "decision",
      content: "We chose Postgres for the gateway",
      sourceMessageIds: messages
        .filter((m) => m.author.kind === "human")
        .map((m) => m.id),
    },
  ],
  summary: "Selected the gateway database",
});
const memory = new AgentMemory({ store: new InMemoryStore(), extract });
const context = {
  tenantId: "demo",
  userId: "alice",
  workspaceId: "engineering",
  projectId: "gateway",
  threadId: "planning",
  origin: "human" as const,
};
console.log(
  await memory.ingest({
    operationId: "window-1",
    context,
    messages: [
      {
        id: "message-1",
        author: { kind: "human", id: "alice" },
        content: "Use Postgres for our gateway",
        timestamp: new Date().toISOString(),
      },
    ],
  }),
);
console.log(
  await memory.recall({
    context: { ...context, threadId: "implementation" },
    query: "Which database did we choose?",
    tokenBudget: 500,
  }),
);
