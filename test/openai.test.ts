import { test } from "node:test";
import assert from "node:assert/strict";
import { createOpenAIExtractor } from "../src/openai.js";
const input = {
  context: {
    tenantId: "t",
    userId: "u",
    threadId: "thread",
    origin: "human" as const,
  },
  messages: [],
  existing: [],
};
test("provider adapter uses structured output and normalizes nullable optionals", async () => {
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(body.model, "test");
    assert.ok(init?.signal);
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                facts: [
                  {
                    category: "preference",
                    content: "Concise",
                    sourceMessageIds: ["m"],
                    entityKey: null,
                    replaces: [],
                    expiresAt: null,
                  },
                ],
                summary: "",
              }),
            },
          },
        ],
      }),
    );
  };
  const result = await createOpenAIExtractor({
    apiKey: "test-only",
    model: "test",
    fetch: fetcher,
  })(input, new AbortController().signal);
  assert.equal(Object.hasOwn(result.facts[0]!, "entityKey"), false);
});
test("provider HTTP failures do not echo sensitive response bodies", async () => {
  const fetcher: typeof fetch = async () =>
    new Response("private-provider-body", { status: 401 });
  await assert.rejects(
    createOpenAIExtractor({
      apiKey: "test-only",
      model: "test",
      fetch: fetcher,
    })(input, new AbortController().signal),
    (e: unknown) =>
      e instanceof Error &&
      e.message.includes("401") &&
      !e.message.includes("private-provider-body"),
  );
});
