# Changelog

## 0.1.0 — 2026-10-11

Initial public release: scoped facts and summaries, trusted-source checks, correction lineage, bounded recall, CAS idempotency, SQLite persistence, and an injectable extraction/embedding/consolidation API.

Release hardening snapshots caller input before asynchronous extraction, rejects timer overflow, and prevents overflow in cosine ranking. Includes 31 regression tests and a reproducible synthetic lexical retrieval evaluation. No model accuracy claim is made.
