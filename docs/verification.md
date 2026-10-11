# Verification for 0.1.0

31 regression tests cover scoped attribution, history, expiry, protected consolidation, replay, CAS contention, uncertain commits, caller mutation, timer limits, numeric embedding overflow, provider response handling, and SQLite persistence across connections.

`npm run eval` seeds 32 facts using ground-truth extraction, issues 32 lexical queries in their matching projects, and checks denied tenant/user/workspace/project contexts. It verifies top-one retrieval, rendered budgets, and zero scope leakage on this synthetic fixture. It makes zero provider requests and is not an extraction accuracy, semantic paraphrase, or long-conversation benchmark.

CI runs Node 22 and 24, typechecks tests/examples/evaluation, builds declarations, checks formatting, runs deterministic examples and the evaluation, and inspects npm package contents. The optional model example requires environment credentials; no live-model evaluation has been performed for this release.

Snapshots retain complete per-user history. Large-scale storage, retention, model-quality evaluation, and host authorization require separate application-level validation.
