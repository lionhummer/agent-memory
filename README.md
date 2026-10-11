# Agent Memory

**A small TypeScript memory engine for facts that deserve to outlive a conversation.**

Keep session summaries separate from durable knowledge. Preserve where a fact came from, enforce user/workspace/project/thread boundaries in code, and assemble useful context within a caller-supplied token budget.

Bring your model, storage, and optional embeddings. No agent framework or hosted memory service is required.

> Development version: `@lionhummer/agent-memory` is a working local package name, not an npm release. Node 22.13+; ESM and TypeScript declarations. SQLite uses Node's built-in `node:sqlite`, which is experimental in Node 22. The core has no runtime npm dependencies.

## The problem

An agent says “we could migrate to SQLite.” A later conversation remembers “the user chose SQLite.” A parent agent instructs a worker to review a migration, and that instruction becomes a personal preference. Meanwhile, yesterday's debugging transcript crowds out the one architectural decision that matters.

This engine treats memory as a lifecycle:

1. A model proposes durable facts and a separate session summary.
2. Code validates source IDs, category policy, trusted authors, and scope.
3. Accepted facts are stored with provenance; corrections supersede prior versions.
4. Recall returns a bounded, inspectable context bundle.
5. Optional consolidation maintains unprotected categories through validated actions.

Source attribution reduces a class of memory errors. It does **not** prove that a cited message entails a proposed fact; evaluation and model quality still matter.

## Start in one minute

From this repository:

```sh
npm ci
npm run example
```

The quickstart is deterministic and needs no API key. It demonstrates storage and recall; it is not a model-quality benchmark.

For an adjacent application, build and install the local package:

```sh
npm run build
# Run in your application's directory:
npm install ../agent-memory
```

```ts
import { AgentMemory, InMemoryStore } from "@lionhummer/agent-memory";
import { createOpenAIExtractor } from "@lionhummer/agent-memory/openai";

const memory = new AgentMemory({
  store: new InMemoryStore(),
  extract: createOpenAIExtractor({
    apiKey: process.env.OPENAI_API_KEY!,
    model: process.env.MEMORY_MODEL!,
  }),
});

// IDs and authors come from your authenticated application, not model output.
const context = {
  tenantId: "acme",
  userId: "alice",
  workspaceId: "engineering",
  projectId: "gateway",
  threadId: "planning",
  origin: "human" as const,
};

const result = await memory.ingest({
  operationId: "planning-window-1",
  context,
  messages: [
    {
      id: "message-1",
      author: { kind: "human", id: "alice" },
      content: "We are standardizing on Postgres for the gateway.",
      timestamp: "2026-01-01T12:00:00Z",
    },
  ],
});
console.log(result.stored, result.rejected);

const recall = await memory.recall({
  context: { ...context, threadId: "implementation" },
  query: "What database did we choose?",
  tokenBudget: 1500,
});
console.log(recall.text); // Pass this into your next model request.
```

Choose a Chat Completions model supporting strict JSON schema for the supplied adapter. `MEMORY_MODEL` is explicit so your application controls provider selection and cost. Compatible endpoints can be configured; other providers can implement the `Extractor` callback directly.

## Examples

| Example                                | Command                  | Demonstrates                                              |
| -------------------------------------- | ------------------------ | --------------------------------------------------------- |
| [Quickstart](examples/quickstart.ts)   | `npm run example`        | Deterministic extraction and cross-thread project recall  |
| [SQLite](examples/sqlite.ts)           | `npm run example:sqlite` | Durable memory, replay detection, connection cleanup      |
| [Model extraction](examples/openai.ts) | `npm run example:openai` | Real JSON-schema extraction using environment credentials |

For the model example, set `OPENAI_API_KEY` and `MEMORY_MODEL` in your shell. It makes a paid provider request. No credential is required for tests or the other examples.

## Default memory policy

| Category     | Scope     | Human source required | Update behavior                             |
| ------------ | --------- | --------------------- | ------------------------------------------- |
| `identity`   | User      | Yes                   | Supersedes previous matching identity entry |
| `preference` | User      | Yes                   | Independent facts; explicit correction IDs  |
| `entity`     | Workspace | No                    | One growing entry per `entityKey`           |
| `decision`   | Project   | Yes                   | Independent facts; explicit correction IDs  |
| `procedure`  | Project   | Yes                   | Independent facts; explicit correction IDs  |

All data is first partitioned by **tenant and user**. Workspace/project scope broadens access only among that same user's matching contexts; this version does not share facts among different users. Projects require a workspace. Session summaries are restricted to their exact workspace/project/thread context.

For human-required categories, the extraction window must originate from a human conversation and at least one cited source must be authored by the context's user. Group and agent-origin windows cannot establish personal facts or commitments under the default policy. Roles such as `user` in a model API are not enough: your host must distinguish an actual human from a parent agent's instruction.

Policy controls scope, attribution requirements, entity keys, and upserts. Change it explicitly through `policies`; model output cannot override it. See [adaptation](docs/adapting.md).

## Corrections and history

A candidate's `replaces` array references current memory IDs. Replacement is permitted only for live records in the same category and exact scope. A correction creates a new record and marks the old records as superseded. `list(context, { includeHistory: true })` exposes source and replacement lineage in the caller's permitted scopes.

Entity/identity upserts also create versions. The model should return the complete revised entity description, not just a fragment. `expiresAt` hides expired records from recall without erasing history.

`consolidate({ operationId, context, category })` accepts a model-generated action list for a bounded chunk. Targets must be supplied, distinct records; merged entities must have matching keys. Human-required categories cannot be destructively consolidated: correct them through newly sourced ingestion. Consolidation fails with `CONFLICT` if the snapshot changed while the model worked.

## Idempotency and concurrency

`operationId` identifies one exact extraction window in a thread. Replaying a completed window avoids another model call and returns `duplicate: true`. Reusing that ID with different input is rejected. Scope context and message contents/timestamps must therefore remain stable on replay.

The store uses atomic compare-and-swap. Competing ingestions reapply already-generated candidates to a fresh snapshot; CAS retries do not repeat model extraction. Simultaneous copies of the same unprocessed window can each call the model, but only one stores that operation. This is storage idempotency, not exactly-once provider invocation.

Rejected candidates appear in `result.rejected`; do not discard that result. A successful window can store no facts. Extraction failure leaves the window unprocessed. Durable storage commit timeouts or cancellation return `INDETERMINATE`: retry with the same input and operation ID to reconcile, rather than inventing a new ID.

## Recall and cost

Recall shortlists at least 100 live facts by lexical relevance and recency, then optionally embeds the query and shortlisted facts together. It ranks by cosine similarity when embedding succeeds. Timeout, invalid vectors, or embedding failure fall back to lexical ranking and expose `embeddingFailure`. Recent same-thread summaries can also enter the result.

The returned `items` include score, reason, ID, kind and token estimate. The final rendered `text`, including headings/IDs/separators, fits `tokenBudget` according to your configured counter. Oversized items are skipped whole rather than silently truncated.

The default counter estimates one token per four characters. Supply your model's tokenizer for a strict provider-token budget. This limit covers returned memory text, not your system prompt, tools, raw messages, or provider wrapper.

The first version re-embeds shortlisted content on each recall and does not store vectors. Add caching in your embedder for recurring queries, or use lexical recall alone. It is not an indexed vector database for millions of facts.

## Storage

`InMemoryStore` is process-local and loses data on restart. `SqliteStore` is durable:

```ts
import { SqliteStore } from "@lionhummer/agent-memory/sqlite";

const store = new SqliteStore("agent-memory.sqlite");
// Pass store to AgentMemory. Close only after outstanding operations finish.
store.close();
```

SQLite stores one JSON snapshot per tenant/user and atomically updates its revision. It is suitable for small deployments and local agents. Reads and writes scale with that user's total retained state. History, summaries and operation IDs are retained; the engine currently has no automatic archival or pruning policy. For larger workloads implement `MemoryStore` with indexed persistence and deliberate retention. The adapter table is versioned as `agent_memory_v1`.

Your application owns authentication, authorization, scheduling, backups, and deletion/retention policy. The engine's scope checks do not replace those responsibilities.

## Configuration

| Option               | Default            | Purpose                                                               |
| -------------------- | ------------------ | --------------------------------------------------------------------- |
| `timeoutMs`          | 30,000             | Model/storage call deadline                                           |
| `embeddingTimeoutMs` | 500                | Recall embedding deadline before lexical fallback                     |
| `maxInputTokens`     | 32,000             | Extraction window plus included existing records; consolidation chunk |
| `maxContentTokens`   | 2,000              | Maximum fact/summary/merged content                                   |
| `maxCandidates`      | 50                 | Maximum proposed facts/consolidation actions                          |
| `maxRetries`         | 8                  | CAS attempts for ingestion                                            |
| `countTokens`        | Character estimate | Inject your tokenizer                                                 |
| `now`                | Current UTC time   | Deterministic clock for tests and expiry                              |

Oversized extraction windows are rejected rather than clipped. Split windows deliberately and give each a stable ID. Existing facts are supplied within the remaining budget; a model may not see the full history. A consolidation call handles one bounded chunk, so your host decides when to run another.

## Errors

| Code            | Meaning                                                          |
| --------------- | ---------------------------------------------------------------- |
| `INVALID`       | Invalid input, policy, limits, or reused operation ID            |
| `MODEL_OUTPUT`  | Malformed extraction, vectors, or consolidation actions          |
| `TIMEOUT`       | Read/model call deadline exceeded                                |
| `ABORTED`       | Cancelled before commit                                          |
| `CONFLICT`      | CAS retry limit or concurrent consolidation change               |
| `INDETERMINATE` | Storage commit may have happened; reconcile the stable operation |

Provider and store errors propagate; they are not converted into empty success. Embedding failure is the deliberate exception: recall returns a visible lexical fallback. Adapters should honor `AbortSignal`; racing a timeout cannot forcibly stop arbitrary user-supplied JavaScript or remote work.

## Development

```sh
npm ci
npm run check
npm run format:check
npm run example
npm run example:sqlite
npm pack --dry-run
```

Tests cover attribution, tenant/project boundaries, correction history, expiry, concurrent CAS, replay, bounded recall, embedding fallback, protected consolidation, and SQLite persistence. Provider-adapter tests use injected HTTP responses; no live model quality claim is made. CI targets Node 22 and 24.

Read [design](docs/design.md), [adaptation](docs/adapting.md), and [release preparation](RELEASE.md).
