import { AgentMemory } from "../src/index.js";
import { SqliteStore } from "../src/sqlite.js";
const store = new SqliteStore(process.env.MEMORY_DB ?? "example.sqlite");
try {
  const memory = new AgentMemory({
    store,
    extract: async ({ messages }) => ({
      facts: [
        {
          category: "preference",
          content: "Prefers concise responses",
          sourceMessageIds: messages.map((m) => m.id),
        },
      ],
    }),
  });
  const context = {
    tenantId: "demo",
    userId: "alice",
    threadId: "chat",
    origin: "human" as const,
  };
  console.log(
    await memory.ingest({
      operationId: "preference-v1",
      context,
      messages: [
        {
          id: "m1",
          author: { kind: "human", id: "alice" },
          content: "Keep your replies concise",
          timestamp: "2026-01-01T00:00:00Z",
        },
      ],
    }),
  );
  console.log(await memory.recall({ context, query: "response style" }));
} finally {
  store.close();
}
