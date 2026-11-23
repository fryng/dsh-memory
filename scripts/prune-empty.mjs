#!/usr/bin/env node
/**
 * Delete memory libraries that contain nothing at all.
 *
 * A library file is created the first time anything is written for a workspace.
 * An *empty* one (no memories, no audit rows) is therefore never useful: it only
 * makes the workspace look like it has memory. This script removes those
 * directories and leaves every library that holds at least one row untouched.
 *
 * Usage:
 *   node scripts/prune-empty.mjs --root E:/DevTools/DeepSeek-Harness [--dry-run]
 *
 * Candidates are the `.dsh-memory` directories directly under --root and one
 * level below it, which covers mirrored workspace layouts. Files locked by a
 * running dsh process are reported and skipped — close dsh, then rerun.
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DATA_DIR = '.dsh-memory';

/** @returns {{dir: string, rows: number} | undefined} */
function inspect(dir) {
  const file = join(dir, 'memory.db');
  if (!existsSync(file)) return undefined;
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const memories = db.prepare('SELECT COUNT(*) AS n FROM memories').get().n;
      const audit = db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;
      return { dir, rows: Number(memories) + Number(audit) };
    } finally {
      db.close();
    }
  } catch (error) {
    // A database we cannot read is not provably empty, so it is never pruned.
    process.stderr.write(`  skip ${dir} (${error instanceof Error ? error.message : String(error)})\n`);
    return { dir, rows: -1 };
  }
}

/** @returns {string[]} */
function candidates(root) {
  const found = [];
  const push = (base) => {
    const dir = join(base, DATA_DIR);
    if (existsSync(dir) && statSync(dir).isDirectory()) found.push(dir);
  };
  push(root);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    push(join(root, entry.name));
  }
  return found;
}

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const rootIndex = argv.indexOf('--root');
const root = resolve(rootIndex === -1 ? process.cwd() : argv[rootIndex + 1]);

let removed = 0;
let kept = 0;
let locked = 0;
for (const dir of candidates(root)) {
  const found = inspect(dir);
  if (found === undefined) continue;
  if (found.rows > 0) {
    kept += 1;
    continue;
  }
  if (found.rows < 0) {
    locked += 1;
    continue;
  }
  if (dryRun) {
    process.stdout.write(`would remove ${dir}\n`);
    removed += 1;
    continue;
  }
  try {
    rmSync(dir, { recursive: true, force: true });
    process.stdout.write(`removed ${dir}\n`);
    removed += 1;
  } catch (error) {
    // Windows keeps a handle on memory.db while a dsh process has it open.
    process.stdout.write(`locked  ${dir} (${error instanceof Error ? error.code ?? error.message : ''})\n`);
    locked += 1;
  }
}

process.stdout.write(
  `\n${dryRun ? 'would remove' : 'removed'} ${removed} · kept ${kept} with rows · ${locked} locked or unreadable\n`,
);
if (locked > 0) process.stdout.write('Close the dsh process that owns these files, then run again.\n');
