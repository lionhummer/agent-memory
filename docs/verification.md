# Verification record

Verified locally on Node 22.19.

- Type checking, ESM/declaration build, formatting: passed.
- Twenty-five tests: passed, including real SQLite persistence and competing-connection CAS.
- Deterministic quickstart and SQLite examples: passed.
- Package export/build inspection and npm packaging dry run: passed.
- Provider adapter checked with injected HTTP responses; no live provider credentials required.

GitHub CI passed on Node 22 and 24. Local verification used Node 22.19. No live-model memory-quality benchmark or large-history performance qualification is claimed.
