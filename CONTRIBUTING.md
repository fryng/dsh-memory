# Contributing

Thanks for looking. This is a single-purpose DSH plugin; the bar for changes is
"does it keep retrieval and writeback deterministic".

## Local loop

```bash
npm install
npm run build          # src/ -> lib/index.js + lib/client.js
npm test               # 48 cases: host 31 + client 9 + routes 8
node scripts/cli.mjs install --profile web   # mount this checkout into a profile
```

`npm run build -- --watch` is not wired; run `node build.mjs --watch` directly if
you want incremental rebuilds.

## Ground rules

- **No runtime dependencies.** The host half may only use Node builtins; the
  browser half may only `require` what the shell already provides (React and the
  DSH client packages, listed as externals in `build.mjs`).
- **Never add `DELETE` statements for memories.** Archiving flips `status`;
  rows and FTS content stay. Every mutation writes an audit row.
- **Keep the system prompt constant.** Anything that varies per turn or per
  workspace belongs in the message list (snapshot/recall), not in the guide
  section, or the provider's KV cache prefix is destroyed.
- **`src/config.js` is the only validation point.** The cordis schema stays
  permissive on purpose: a throw there takes the whole profile down.
- **Update tests with behaviour.** `test/memory.test.mjs` covers the store and
  writeback gate, `test/routes.test.mjs` the HTTP surface, `test/client.test.mjs`
  the panel renderer.

## Pull requests

- One topic per PR; describe the failure mode you observed, not just the diff.
- Include the commands you ran (`npm test`, plus a manual check in a real
  profile when the change touches injection, routes or the panel).
- Screenshots for UI changes, both light and dark theme.

## Publishing when `github.com:443` is blocked

`git push` speaks to `github.com:443`, which some networks reset while
`api.github.com` keeps working. `scripts/push-api.mjs` publishes the current
commit through the Git Data API instead:

```bash
node scripts/push-api.mjs --dry-run      # what would be sent
node scripts/push-api.mjs                # append a commit to origin/main
node scripts/push-api.mjs --tag v0.1.0   # ...and move the tag
```

It reads credentials from `GITHUB_TOKEN` or the git credential store, never
force-pushes a branch, and needs nothing beyond Node's built-in `fetch`.

## Reporting bugs

Please include: DSH version, OS, Node version (`node -v`), the output of
`node scripts/cli.mjs doctor`, and the relevant audit rows from
`memory_status` (or `/mem`).
