# Design

## Data boundaries

A store key encodes tenant/user with JSON tuple encoding. The engine selects only live memories in the caller's user/workspace/project/thread contexts. Project records carry workspace identity too. Historical listing keeps scope checks while revealing superseded, deleted and expired records. Summaries remain in their exact conversation context.

Host-provided author identities and conversation origin are trusted inputs. Extraction-generated source IDs must refer to the supplied window. Human-required categories need a human-rooted window and at least one source from that user. Referencing a human source does not establish semantic truth; the model could misinterpret or falsely attribute content. This is provenance validation, not an entailment verifier.

## Ingestion

Validate messages and stable input identity, then load the user's snapshot. Completed operations short-circuit. Reject oversized windows; fit existing memories into the remaining extraction-input budget. Call the extractor under a deadline. Runtime-validate its output rather than relying on TypeScript or provider schema support alone.

Candidates are applied against the current snapshot. Policy determines category scope and upsert behavior. A replacement must target live records in the same exact scope/category. Facts, summary and processed-operation identity commit together through CAS. A concurrent writer causes a reapplication of candidates against a refreshed snapshot. The model is not called again during CAS retry. Replacements that became stale are reported as rejected candidates.

The fingerprint covers exact input JSON, including context and timestamps. It detects operation-ID misuse; it is not intended as a semantic content hash across differently ordered objects. Hosts should retain identical replay payloads.

## Storage contract

`load` returns an isolated snapshot. `compareAndSwap` atomically commits the whole state only when the expected revision matches; false means no commit. Implementations must not mutate engine-owned input after return. Revision zero represents absence. A timed-out CAS may still commit: surface uncertainty and reconcile with the same operation identity. A storage adapter must enforce tenant isolation and appropriate access controls in its own environment.

The supplied adapters preserve complete snapshots. InMemoryStore uses structured clones. SQLite uses insert-on-absence and revision-conditioned updates, avoiding a read-then-write race across connections. Versioned table naming leaves future migrations explicit. Snapshot persistence is deliberately limited in scale; no production volume guarantee is inferred from small tests.

## Recall

Scope/expiry filtering precedes ranking. Lexical relevance and recency bound the candidate pool. Optional batched embeddings are checked for count, matching dimensions and finite values. Invalid/timed-out embedding falls back visibly. Recent summaries are same-thread only. Rendered output is admitted item-by-item under the caller's token counter; source records are not mutated by recall.

## Consolidation

An optional consolidator receives a bounded category/scope chunk. Validate every action and target before modifying state. IDs cannot be reused among actions; merged entities require a matching key. Source lineage is preserved and the earliest source expiration is retained. Human-required categories cannot be destructively consolidated. A stable maintenance operation ID is committed with the actions, so replay avoids a new model call. One CAS commits all actions; a changed snapshot forces a new model pass rather than applying stale destructive instructions.

## Scope of version one

No background scheduler, automatic summary condensation, indexed vector search, shared cross-user workspace facts, human approval UI, archival policy, or accuracy benchmark is included. These remain host responsibilities or future extensions. Regression tests establish observable policy/concurrency behavior; they do not measure long-conversation recall quality.
