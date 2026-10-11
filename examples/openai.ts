import { AgentMemory, InMemoryStore } from "../src/index.js";
import { createOpenAIExtractor } from "../src/openai.js";
const apiKey = process.env.OPENAI_API_KEY,
  model = process.env.MEMORY_MODEL;
if (!apiKey || !model)
  throw new Error(
    "Set OPENAI_API_KEY and MEMORY_MODEL to a Chat Completions model supporting JSON schema",
  );
const memory = new AgentMemory({
  store: new InMemoryStore(),
  extract: createOpenAIExtractor({ apiKey, model }),
});
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
        id: "m1",
        author: { kind: "human", id: "alice" },
        content:
          "We are standardizing on Postgres for the gateway. This is our architectural decision.",
        timestamp: new Date().toISOString(),
      },
    ],
  }),
);
console.log(await memory.recall({ context, query: "database decision" }));
