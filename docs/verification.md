# Verification record

Verified locally on Node 22.19.

- Type checking, ESM/declaration build, formatting: passed.
- Twenty-five tests: passed, including real SQLite persistence and competing-connection CAS.
- Deterministic quickstart and SQLite examples: passed.
- Package export/build inspection and npm packaging dry run: passed.
- Provider adapter checked with injected HTTP responses; no live provider credentials required.

CI targets Node 22 and 24. Node 24 has not been verified on this local host. No live-model memory-quality benchmark or large-history performance qualification is claimed.
