# Adaptation recipes

## Any model provider

Implement `Extractor`:

```ts
const extract: Extractor = async ({ context, messages, existing }, signal) => {
  const output = await yourModel.generate({
    prompt: buildYourPrompt(context, messages, existing),
    signal,
  });
  return parseYourStructuredOutput(output);
};
```

Return `{ facts, summary? }`. Each candidate has `category`, `content`, `sourceMessageIds`, and optional `entityKey`, `replaces`, `expiresAt`. The core runtime validates output and controls scope. The supplied OpenAI-compatible adapter is a reference for a real HTTP integration. Test prompt/model quality separately from engine invariants.

## Existing agent loop

Call `recall` before constructing the next provider request. Add `recall.text` as memory context. After a turn completes, enqueue a stable window for `ingest` in your own job runner. Preserve the exact window, author metadata, context, timestamp and operation ID on replay. Decide how much raw conversation remains in the prompt yourself: the package does not own or delete your message history.

A parent-agent instruction represented as a model's `user` role must carry `author.kind = "agent"` and `origin = "agent"`. In a group room use `origin = "group"`. Do not derive real authorship from model roles.

## Embeddings and tokenization

```ts
const memory = new AgentMemory({
  store,
  extract,
  embed: async (texts, signal) => embedBatchWithYourProvider(texts, signal),
  countTokens: (text) => tokenizer.encode(text).length,
});
```

Return one vector per input in the same order. Cache by embedding model/version and text hash if useful. The engine does not persist vectors or assume their dimension. Keep your callback cancellable and apply your provider's own timeout.

## Storage adapter

Implement `MemoryStore.load(key)` and `compareAndSwap(key, expectedRevision, state)`. A PostgreSQL implementation can use a transaction or revision-conditional update. A remote object store needs conditional writes/ETags with a consistent revision mapping. A plain read followed by an unconditional write is incorrect. Test two concurrent engine instances against the adapter, not just sequential CRUD.

Keys contain tenant and user IDs, not credentials. Keep persisted snapshots and logs access-controlled. Model adapters receive the selected context/messages: choose a provider consistent with your application's data policy.

## Custom categories' policy

The initial categories are fixed, but their policies are configurable. For an agent-local entity store:

```ts
policies: {
  entity: {
    scope: "thread",
    requireHuman: false,
    entityKeyRequired: true,
    upsert: true,
  },
}
```

Human-required policies remain suitable for preferences and architectural decisions. Turning that requirement off deliberately broadens what can become durable memory; document that choice in your host application.

## Maintenance

Call `consolidate` from your existing scheduler for unprotected categories. Supply a `Consolidator` that returns merge/delete actions referencing only supplied records. The default entity policy already maintains one entry per key, so consolidation is more useful with an append-only/custom policy or accumulated legacy records.

A `CONFLICT` during consolidation means the input snapshot changed: run a fresh pass. Do not replay the same destructive actions against newer state. For large histories, design archival and processed-operation retention together so replay cannot resurrect expired state.
