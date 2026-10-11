# Release workflow

Run `npm ci`, `npm run check`, `npm run format:check`, `npm run eval`, both deterministic examples, and `npm pack --dry-run`. Inspect the package archive and install it into a clean temporary consumer. Confirm the Node 22/24 CI matrix passes for the release commit, then publish with `npm publish --access public` and verify the registry version before creating its matching GitHub release.

Authentication belongs in the local npm credential store or CI's protected registry workflow, never source. Source names, credentials, and personal transcripts must not appear in released files or Git history. Releases use MIT OR Apache-2.0.
