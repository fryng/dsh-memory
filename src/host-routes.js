/**
 * Host half of the memory manager: three same-origin JSON routes.
 *
 * The browser half cannot read a SQLite file, and it must not be trusted with a
 * filesystem path anyway — so every read and every mutation goes through these
 * routes, which resolve a workspace against the Host's own registry and then
 * talk to the same `MemoryRepo` the tools and the injection pipeline use. One
 * write pipeline, three surfaces (tool, writeback, UI): a change made here is
 * visible to recall immediately, not on the next process start.
 *
 * Security note: `/api/*` has NO framework-level authentication. The only
 * generic `/api` gate is registered by `dsh-client-connection` as its own
 * prefix route, and an exact route wins the match table, so it never runs for
 * us. Each handler therefore calls `connection.requestRejection(req)` itself.
 */
import { existsSync } from 'node:fs';
import { dbPath } from './store/db.js';
import { contentHash } from './ranking.js';

/** Root-absolute prefix; the browser half drops the leading slash (see client/api.js). */
export const MEMORY_API_PREFIX = '/api/dsh-memory';

/** Mutations carry one memory; 64 KiB is far more than any single row needs. */
const BODY_LIMIT = 64 * 1024;

/** Fields the editor may change. Deliberately excludes id/level/status/use_count. */
const EDITABLE = ['content', 'keywords', 'importance', 'project', 'subcategory', 'goal'];

/**
 * Read and parse a JSON body.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<object|undefined>} undefined when the body is missing, too large, or not JSON
 */
async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    // Destroy the request instead of buffering an unbounded upload.
    if (size > BODY_LIMIT) {
      req.destroy();
      return undefined;
    }
    chunks.push(chunk);
  }
  if (size === 0) return undefined;
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return value !== null && typeof value === 'object' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read a service without tripping cordis' undeclared-inject guard.
 *
 * `ctx.get(name)` throws when the service is not declared in a static `inject`
 * list, and `workspaceRegistry` is exactly such a service: present on a full
 * Host, absent on a base-only profile, never worth a static inject.
 * @param {object} ctx
 * @param {string} name
 * @returns {any} the service, or undefined
 */
function readService(ctx, name) {
  try {
    const direct = ctx?.[name];
    if (direct !== undefined) return direct;
  } catch {
    // an undeclared property read throws; fall through to ctx.get
  }
  try {
    return ctx?.get?.(name, false);
  } catch {
    return undefined;
  }
}

/** Last path segment, used as a fallback workspace title. */
function basenameOf(path) {
  const parts = String(path).split(/[\\/]+/).filter((part) => part !== '');
  return parts.length === 0 ? String(path) : parts[parts.length - 1];
}

/**
 * Write a JSON response with the no-store headers every API route wants.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {object} body
 */
function writeJson(res, status, body) {
  if (res.headersSent) return;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

/** Uniform error envelope: the browser half renders `error` verbatim. */
function fail(res, status, error) {
  writeJson(res, status, { ok: false, error });
}

/** Keep only strings/numbers a row column can actually hold. */
function sanitizePatch(raw) {
  const patch = {};
  for (const key of EDITABLE) {
    const value = raw?.[key];
    if (value === undefined || value === null) continue;
    if (key === 'importance') {
      const n = Number(value);
      if (Number.isFinite(n)) patch.importance = Math.min(4, Math.max(1, Math.trunc(n)));
      continue;
    }
    if (typeof value === 'number') {
      patch[key] = String(value);
      continue;
    }
    if (typeof value !== 'string') continue;
    const trimmed = key === 'content' ? value.trim() : value.trim();
    if (key === 'content' && trimmed === '') continue;
    patch[key] = trimmed;
  }
  // The FTS mirror is external-content, so the hash must follow the text.
  if (typeof patch.content === 'string') patch.content_hash = contentHash(patch.content);
  return patch;
}

/**
 * Resolve the workspaces a user may manage.
 *
 * The registry is authoritative (canonical `realpath`, user-visible title); the
 * fallback covers a Host without it (base-only profiles, tests) by reusing the
 * workspaces the plugin already opened.
 * @param {object} ctx
 * @param {Map<string, object>} repos
 * @returns {Array<{id: string, title: string, path: string}>}
 */
function listWorkspaces(ctx, repos) {
  const registry = readService(ctx, 'workspaceRegistry');
  const out = [];
  const seen = new Set();
  const push = (path, title, id) => {
    if (typeof path !== 'string' || path === '' || seen.has(path)) return;
    seen.add(path);
    out.push({ id: typeof id === 'string' ? id : path, title: typeof title === 'string' && title !== '' ? title : path, path });
  };
  if (registry !== undefined && typeof registry.list === 'function') {
    for (const workspace of registry.list()) push(workspace?.path, workspace?.title, workspace?.id);
  }
  for (const path of repos.keys()) push(path, basenameOf(path), undefined);
  return out;
}

/**
 * Counts for one workspace without creating a database for it.
 * @returns {object|undefined}
 */
function summarize(repoFor, workspace, dataDir) {
  const file = dbPath(workspace.path, dataDir);
  if (!existsSync(file)) return undefined;
  const repo = repoFor(workspace.path);
  if (repo === undefined) return undefined;
  const stats = repo.store.stats();
  return { ...stats, file };
}

/**
 * Register the routes and return one disposer for all of them.
 * @param {{webCtx: object, ctx: object, cfg: object, repoFor: (path: string) => object|undefined,
 *   workspaces: () => Map<string, object>, logger?: object}} input
 * @returns {() => void}
 */
export function registerHostRoutes({ webCtx, ctx, cfg, repoFor, workspaces, logger }) {
  const connection = readService(ctx, 'connection');
  const releases = [];

  /** Same-origin + authenticated, or a rejection status. */
  const guard = (req, res) => {
    if (connection === undefined || typeof connection.requestRejection !== 'function') {
      fail(res, 503, '记忆管理器：本进程没有 connection 服务，无法校验请求来源');
      return false;
    }
    const rejection = connection.requestRejection(req);
    if (rejection !== undefined) {
      fail(res, rejection, rejection === 401 ? 'unauthorized' : 'forbidden');
      return false;
    }
    return true;
  };

  /** Resolve `path` from a body to a repo, or answer the request with an error. */
  const repoOfBody = (body, res) => {
    const workspace = listWorkspaces(ctx, workspaces()).find((entry) => entry.path === body?.path);
    if (workspace === undefined) {
      fail(res, 404, '记忆管理器：未知的工作区');
      return undefined;
    }
    const repo = repoFor(workspace.path);
    if (repo === undefined) {
      fail(res, 500, '记忆管理器：记忆库打开失败');
      return undefined;
    }
    return repo;
  };

  /**
   * Resolve a workspace for a read, WITHOUT opening a database.
   *
   * Browsing the manager must not be a write: opening a store runs the schema
   * migration and creates `<workspace>/.dsh-memory/memory.db`, so merely
   * clicking through the workspace tabs would leave an empty database in every
   * project the user owns. A read on a workspace with no library therefore
   * answers "empty" instead of materializing one.
   * @returns {{workspace: object, repo?: object} | undefined}
   */
  const readTargetOfBody = (body, res) => {
    const workspace = listWorkspaces(ctx, workspaces()).find((entry) => entry.path === body?.path);
    if (workspace === undefined) {
      fail(res, 404, '记忆管理器：未知的工作区');
      return undefined;
    }
    if (!existsSync(dbPath(workspace.path, cfg.dataDir))) return { workspace };
    const repo = repoFor(workspace.path);
    if (repo === undefined) {
      fail(res, 500, '记忆管理器：记忆库打开失败');
      return undefined;
    }
    return { workspace, repo };
  };

  // ---------------------------------------------------------------- workspaces
  releases.push(webCtx.webServer.register({
    kind: 'exact',
    path: `${MEMORY_API_PREFIX}/workspaces`,
    handler: async (req, res) => {
      if (!guard(req, res)) return;
      try {
        const items = listWorkspaces(ctx, workspaces()).map((workspace) => {
          const summary = summarize(repoFor, workspace, cfg.dataDir);
          return {
            id: workspace.id,
            title: workspace.title,
            path: workspace.path,
            exists: summary !== undefined,
            active: summary?.active ?? 0,
            archived: summary?.archived ?? 0,
            total: summary?.total ?? 0,
            levels: summary?.levels ?? {},
            projects: summary?.projects ?? [],
          };
        });
        writeJson(res, 200, { ok: true, dataDir: cfg.dataDir, items });
      } catch (error) {
        logger?.warn?.(`dsh-memory: 工作区列表失败 —— ${error instanceof Error ? error.message : String(error)}`);
        fail(res, 500, '记忆管理器：读取工作区失败');
      }
    },
  }));

  // --------------------------------------------------------------------- items
  releases.push(webCtx.webServer.register({
    kind: 'exact',
    path: `${MEMORY_API_PREFIX}/items`,
    handler: async (req, res) => {
      if (!guard(req, res)) return;
      const body = await readJson(req);
      if (body === undefined) return fail(res, 400, '请求体必须是 JSON');
      try {
        const target = readTargetOfBody(body, res);
        if (target === undefined) return undefined;
        if (target.repo === undefined) {
          // No library yet: answer empty rather than creating one. `exists`
          // is false so the panel can say "this workspace has no memory file".
          writeJson(res, 200, {
            ok: true,
            total: 0,
            items: [],
            stats: { total: 0, active: 0, archived: 0, levels: {}, projects: [] },
            exists: false,
          });
          return undefined;
        }
        const repo = target.repo;
        const { rows, total } = repo.store.page({
          status: body.status,
          level: body.level,
          project: body.project,
          query: body.query,
          limit: body.limit,
          offset: body.offset,
        });
        writeJson(res, 200, {
          ok: true,
          total,
          items: rows.map((row) => ({
            id: row.id,
            level: row.level,
            content: row.content,
            keywords: typeof row.keywords === 'string' ? row.keywords : '',
            importance: row.importance,
            confidence: row.confidence,
            project: row.project,
            subcategory: row.subcategory,
            goal: row.goal,
            status: row.status,
            useCount: row.use_count,
            lastUsedAt: row.last_used_at,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          })),
          stats: repo.store.stats(),
        });
      } catch (error) {
        logger?.warn?.(`dsh-memory: 记忆列表失败 —— ${error instanceof Error ? error.message : String(error)}`);
        fail(res, 500, '记忆管理器：读取记忆失败');
      }
    },
  }));

  // -------------------------------------------------------------------- mutate
  releases.push(webCtx.webServer.register({
    kind: 'exact',
    path: `${MEMORY_API_PREFIX}/mutate`,
    handler: async (req, res) => {
      if (!guard(req, res)) return;
      const body = await readJson(req);
      if (body === undefined) return fail(res, 400, '请求体必须是 JSON');
      const op = typeof body.op === 'string' ? body.op : '';
      if (!['update', 'archive', 'restore'].includes(op)) return fail(res, 400, '未知操作');
      const id = typeof body.id === 'string' ? body.id : '';
      if (id === '') return fail(res, 400, '缺少记忆 id');
      try {
        const repo = repoOfBody(body, res);
        if (repo === undefined) return undefined;
        const existing = repo.store.get(id);
        if (existing === undefined) return fail(res, 404, '这条记忆已不存在');
        if (op === 'archive') {
          // Soft delete: the row stays, status flips, audit records why. A UI
          // "delete" that destroys the only copy of a fact is not recoverable
          // from the GUI, and the store's invariant is archive-never-delete.
          repo.store.archive(id, '由记忆管理器归档');
        } else if (op === 'restore') {
          repo.store.restore(id);
        } else {
          const patch = sanitizePatch(body.patch);
          if (Object.keys(patch).length === 0) return fail(res, 400, '没有可保存的字段');
          repo.store.update(id, patch);
          repo.store.audit('update', '由记忆管理器编辑', { id, ...patch });
        }
        const row = repo.store.get(id);
        writeJson(res, 200, { ok: true, item: row === undefined ? null : { id: row.id, status: row.status } });
      } catch (error) {
        logger?.warn?.(`dsh-memory: 记忆变更失败 —— ${error instanceof Error ? error.message : String(error)}`);
        fail(res, 500, '记忆管理器：保存失败');
      }
    },
  }));

  return () => {
    for (const release of releases) {
      try {
        release();
      } catch {
        // a route already gone at teardown is not a failure
      }
    }
  };
}
