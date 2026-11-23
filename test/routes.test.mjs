/**
 * Host-side route tests for the settings-page memory manager.
 *
 * These drive real `node:http` request/response objects rather than mocks, so
 * the body reader, the JSON envelope and the status codes are all exercised —
 * the browser half is written against exactly this contract.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  registerHostRoutes,
  MEMORY_API_PREFIX,
  MemoryRepo,
  openDb,
  closeAllStores,
  resolveConfig,
} from '../lib/index.js';

const cfg = resolveConfig({});

/** A request-like readable carrying a JSON body. */
function makeRequest(body) {
  const text = body === undefined ? '' : JSON.stringify(body);
  const stream = Readable.from(text === '' ? [] : [Buffer.from(text, 'utf8')]);
  stream.headers = { 'content-type': 'application/json' };
  stream.method = 'POST';
  return stream;
}

/** A response-like collecting status, headers and text. */
function makeResponse() {
  const out = { status: 0, headers: {}, text: '' };
  return {
    out,
    headersSent: false,
    writeHead(status, headers) {
      out.status = status;
      Object.assign(out.headers, headers);
      this.headersSent = true;
    },
    end(text) {
      out.text = text ?? '';
    },
    json() {
      return JSON.parse(out.text);
    },
  };
}

/** Register routes against a fake Host and return a `call(path, body)` helper. */
function harness({ registry, rejection } = {}) {
  const routes = new Map();
  const webCtx = {
    webServer: {
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
    effect: (fn) => fn(),
  };
  const services = {
    connection: {
      requestRejection: () => rejection,
    },
  };
  if (registry !== undefined) services.workspaceRegistry = registry;
  const ctx = {
    get: (name) => services[name],
  };
  const repos = new Map();
  const repoFor = (workspace) => {
    if (workspace === undefined) return undefined;
    return repos.get(workspace);
  };
  const dispose = registerHostRoutes({
    webCtx,
    ctx,
    cfg,
    repoFor,
    workspaces: () => repos,
    logger: { warn: () => {} },
  });
  return {
    repos,
    routes,
    dispose,
    async call(suffix, body) {
      const route = routes.get(`${MEMORY_API_PREFIX}${suffix}`);
      assert.ok(route !== undefined, `route ${suffix} must be registered`);
      const res = makeResponse();
      await route.handler(makeRequest(body), res);
      return res;
    },
  };
}

/** Build a real workspace + repo and register it with a harness. */
async function seed(t, items) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-memory-routes-'));
  const store = openDb(dir, cfg.dataDir);
  t.after(() => {
    // Windows will not unlink a live WAL handle: close before removing.
    try {
      store.close();
    } catch {
      // already closed is fine
    }
    closeAllStores();
    rmSync(dir, { recursive: true, force: true });
  });
  const repo = new MemoryRepo(store, { logger: { warn: () => {} } });
  for (const item of items) repo.remember({ ...item, project: '全局' }, { kind: 'tool' });
  const registry = {
    list: () => [{ id: 'ws-1', title: '测试项目', path: dir, sessionIds: [] }],
  };
  const host = harness({ registry });
  host.repos.set(dir, repo);
  return { dir, repo, host };
}

test('workspaces reports each registered workspace with counts and file state', async (t) => {
  const { dir, host } = await seed(t, [
    { level: 'rule', content: '一律用 pwsh 执行命令。', keywords: 'pwsh' },
    { level: 'fact', content: 'Node 版本 v24.13.1。', keywords: 'node' },
  ]);
  const res = await host.call('/workspaces');
  assert.equal(res.out.status, 200);
  const payload = res.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.dataDir, cfg.dataDir);
  const entry = payload.items.find((item) => item.path === dir);
  assert.ok(entry !== undefined);
  assert.equal(entry.title, '测试项目');
  assert.equal(entry.exists, true);
  assert.equal(entry.active, 2);
  assert.equal(entry.archived, 0);
  assert.equal(entry.total, 2);
  assert.equal(entry.levels.rule, 1);
  assert.ok(String(res.out.headers['cache-control']).includes('no-store'));
});

test('workspaces marks a database-less workspace without creating one', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-memory-routes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = harness({ registry: { list: () => [{ id: 'ws-2', title: '空项目', path: dir }] } });
  const res = await host.call('/workspaces');
  const entry = res.json().items[0];
  assert.equal(entry.exists, false);
  assert.equal(entry.total, 0);
  // Reading must not create the file it is reporting on.
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(path.join(dir, cfg.dataDir, 'memory.db')), false);
});

test('items filters by status, level and free text', async (t) => {
  const { dir, host } = await seed(t, [
    { level: 'rule', content: '一律用 pwsh，不要用 bash。', keywords: 'pwsh bash' },
    { level: 'fact', content: 'Node 版本是 v24.13.1。', keywords: 'node 版本' },
  ]);
  const all = await host.call('/items', { path: dir, status: 'all' });
  assert.equal(all.json().items.length, 2);
  // A path that is not a registered workspace must be rejected, not guessed at.
  const stranger = await host.call('/items', { path: path.join(dir, 'elsewhere'), status: 'all' });
  assert.equal(stranger.out.status, 404);
  assert.equal(stranger.json().ok, false);
});

test('items answers with rows and stats for a real workspace', async (t) => {
  const { dir, host, repo } = await seed(t, [
    { level: 'rule', content: '一律用 pwsh，不要用 bash。', keywords: 'pwsh bash' },
    { level: 'fact', content: 'Node 版本是 v24.13.1。', keywords: 'node 版本' },
  ]);
  const all = await host.call('/items', { path: dir, status: 'all' });
  assert.equal(all.out.status, 200);
  const payload = all.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.items.length, 2);
  assert.equal(payload.total, 2);
  assert.equal(payload.stats.active, 2);
  // Rows are shaped for the panel, not the database.
  const row = payload.items[0];
  for (const key of ['id', 'level', 'content', 'keywords', 'importance', 'project', 'status', 'useCount', 'updatedAt']) {
    assert.ok(key in row, `missing ${key}`);
  }

  const rules = (await host.call('/items', { path: dir, level: 'rule' })).json();
  assert.equal(rules.items.length, 1);
  assert.equal(rules.items[0].level, 'rule');

  const zh = (await host.call('/items', { path: dir, query: '中文' })).json();
  assert.equal(zh.ok, true);
  const byText = (await host.call('/items', { path: dir, query: 'pwsh' })).json();
  assert.equal(byText.items.length, 1);
  // A two-character CJK query has no trigram, so it reaches the LIKE fallback.
  const shortCjk = (await host.call('/items', { path: dir, query: '版本' })).json();
  assert.equal(shortCjk.items.length, 1);

  const bad = await host.call('/items', { path: path.join(dir, 'nope') });
  assert.equal(bad.out.status, 404);

  const noBody = await host.call('/items');
  assert.equal(noBody.out.status, 400);
});

test('mutate edits, archives (never deletes) and restores', async (t) => {
  const { dir, host, repo } = await seed(t, [{ level: 'fact', content: '旧内容。', keywords: '旧' }]);
  const id = repo.store.page({}).rows[0].id;

  const edited = await host.call('/mutate', { path: dir, op: 'update', id, patch: { content: '新内容。', importance: 9 } });
  assert.equal(edited.out.status, 200);
  const after = repo.store.get(id);
  assert.equal(after.content, '新内容。');
  assert.equal(after.importance, 4, 'importance is clamped to 1..4');
  const audit = repo.store.recentAudit(5).map((row) => row.kind);
  assert.ok(audit.includes('update'));

  const archived = await host.call('/mutate', { path: dir, op: 'archive', id });
  assert.equal(archived.out.status, 200);
  assert.equal(archived.json().item.status, 'archived');
  assert.ok(repo.store.get(id) !== undefined, 'archive must keep the row');
  assert.equal(repo.store.page({ status: 'active' }).total, 0);

  const restored = await host.call('/mutate', { path: dir, op: 'restore', id });
  assert.equal(restored.json().item.status, 'active');
  assert.equal(repo.store.page({ status: 'active' }).total, 1);
});

test('mutate rejects unknown ops, missing ids and empty patches', async (t) => {
  const { dir, host, repo } = await seed(t, [{ level: 'fact', content: '内容。', keywords: 'k' }]);
  const id = repo.store.page({}).rows[0].id;
  assert.equal((await host.call('/mutate', { path: dir, op: 'destroy', id })).out.status, 400);
  assert.equal((await host.call('/mutate', { path: dir, op: 'update' })).out.status, 400);
  assert.equal((await host.call('/mutate', { path: dir, op: 'update', id: 'nope' })).out.status, 404);
  assert.equal((await host.call('/mutate', { path: dir, op: 'update', id, patch: {} })).out.status, 400);
  // A tool must not be able to blank a memory out through the editor.
  assert.equal((await host.call('/mutate', { path: dir, op: 'update', id, patch: { content: '   ' } })).out.status, 400);
});

test('items answers empty for a database-less workspace without creating one', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-memory-routes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = harness({ registry: { list: () => [{ id: 'ws-3', title: '空项目', path: dir }] } });
  const res = await host.call('/items', { path: dir, status: 'all' });
  assert.equal(res.out.status, 200);
  const payload = res.json();
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.items, []);
  assert.equal(payload.total, 0);
  assert.equal(payload.exists, false, 'panel needs exists=false to show the "no file" state');
  assert.equal(payload.stats.active, 0);
  // Browsing the manager must not materialize a database in every workspace.
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(path.join(dir, cfg.dataDir, 'memory.db')), false);
});

test('every route refuses a request that connection rejects', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-memory-routes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = harness({ registry: { list: () => [{ id: 'w', title: 'w', path: dir }] }, rejection: 403 });
  for (const suffix of ['/workspaces', '/items', '/mutate']) {
    const res = await host.call(suffix, { path: dir, op: 'archive', id: 'x' });
    assert.equal(res.out.status, 403, `${suffix} must be refused`);
    assert.equal(res.json().ok, false);
  }
});

test('the routes are the only three, and disposing removes them', () => {
  const host = harness({});
  assert.deepEqual([...host.routes.keys()].sort(), [
    `${MEMORY_API_PREFIX}/items`,
    `${MEMORY_API_PREFIX}/mutate`,
    `${MEMORY_API_PREFIX}/workspaces`,
  ]);
  host.dispose();
  assert.equal(host.routes.size, 0);
});
