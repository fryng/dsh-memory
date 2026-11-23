# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-11-23

First public release. Extracted from the DSH (DeepSeek Harness) monorepo and
packaged as a standalone, installable profile bundle.

### Added

- Per-workspace SQLite store at `<workspace>/.dsh-memory/memory.db`
  (`node:sqlite`, single file, `memories` + `audit_log`).
- FTS5 `trigram` index with per-term phrase quoting and a `LIKE` fallback for
  one- and two-character queries, so Chinese retrieval is not a no-op.
- Three injection channels: constant system-prompt guide, first-turn snapshot,
  per-turn targeted recall — all dynamic content stays in the message list, so
  the provider KV prefix is untouched. Snapshots are re-injected after
  compaction; subagent sessions are skipped.
- Deterministic writeback gate: trigger words (`记住` / `以后` / `我喜欢` /
  `remember` / `always` …) or an interval fallback measured in *owed turns*
  rather than `turn % N`, with trigger-word priority over the length floor and
  message-id de-duplication.
- Independent extraction call (own model channel, never inside the user
  session) plus dedupe/merge, conflict supersede and per-step audit rows
  (`writeback`, `writeback-empty`, `writeback-error`).
- Five tools (`memory_remember`, `memory_search`, `memory_read`,
  `memory_update`, `memory_status`) and the `/mem` command, all optionally
  namespaced through `toolPrefix`.
- Settings → **记忆** panel: workspace switcher, level/status filters, inline
  editor, memory-strength bar, two-click archive confirmation, dark theme via
  `--dsw-alias-*` tokens.
- Three same-origin JSON routes (`/api/dsh-memory/workspaces|items|mutate`)
  guarded by `connection.requestRejection` plus same-origin and loopback checks.
- `scripts/cli.mjs` installer: `install` / `status` / `uninstall` / `doctor` /
  `prune`, with `DSH_HOME` auto-discovery and idempotent, backup-first profile
  edits.
- 48 unit tests (host 31, client 9, routes 8), a seven-step end-to-end demo and
  a real-web-profile verifier.

### Notes

- Requires DSH with profile bundles support. `node:sqlite` needs Node >= 22.5
  for the CLI, tests and demo; DSH ships its own runtime for the plugin.
- `react` / `react-dom` are devDependencies only (the shell supplies them at
  runtime). Without them the client tests skip the render cases and keep the
  two source-level assertions instead of failing the file.
- Archive never deletes: status changes only, no `DELETE` statements.
