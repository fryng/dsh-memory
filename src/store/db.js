/**
 * SQLite storage for one workspace.
 *
 * Two invariants, both load-bearing:
 *  1. **Archive, never delete.** There is no `DELETE FROM memories` anywhere in
 *     this file. Retired entries flip to `status='archived'` with the original
 *     row intact, so a bad merge or an over-eager cleanup is always reversible,
 *     and "where did this belief come from" stays answerable.
 *  2. **Every mutation leaves an audit row.** A memory system whose writes are
 *     invisible cannot be debugged — the failure mode we are replacing
 *     ("reflection ran, wrote nothing, still reported success") is exactly what
 *     missing audit rows hide.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const SCHEMA_VERSION = 1;

/** 16 hex chars — short enough to read in a log, wide enough not to collide. */
export function newId() {
  return randomBytes(8).toString('hex');
}

/** `<workspace>/<dataDir>/memory.db` — one store per workspace, by construction. */
export function dbPath(workspace, dataDir) {
  return join(workspace, dataDir, 'memory.db');
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS schema_version (
     version INTEGER NOT NULL
   )`,
  /**
   * The single memory table.
   *
   * `level` is a column rather than a table per kind: every read path wants
   * "all active memories for this workspace, ranked", and a UNION across seven
   * tables (the shape the previous plugin used) makes that query both slower and
   * impossible to rank consistently.
   */
  `CREATE TABLE IF NOT EXISTS memories (
     id TEXT PRIMARY KEY,
     level TEXT NOT NULL,
     content TEXT NOT NULL,
     keywords TEXT NOT NULL DEFAULT '',
     importance INTEGER NOT NULL DEFAULT 2,
     confidence REAL NOT NULL DEFAULT 1.0,
     project TEXT NOT NULL DEFAULT '',
     subcategory TEXT NOT NULL DEFAULT '',
     goal TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT 'active',
     use_count INTEGER NOT NULL DEFAULT 0,
     last_used_at INTEGER,
     supersedes_id TEXT,
     content_hash TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status, project, level)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_hash ON memories(content_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at DESC)`,
  /**
   * Full-text index over `content` + `keywords`.
   *
   * external content (not a contentless table) so the indexed text is not
   * duplicated in a second copy; the three triggers below keep it in sync. The
   * `delete` row syntax on UPDATE/DELETE is what external-content FTS5 requires
   * — omitting it leaves ghost rows that match but join to nothing.
   */
  `CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
     content,
     keywords,
     content='memories',
     content_rowid='rowid',
     tokenize='trigram'
   )`,
  `CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
     INSERT INTO memory_fts(rowid, content, keywords) VALUES (new.rowid, new.content, new.keywords);
   END`,
  `CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
     INSERT INTO memory_fts(memory_fts, rowid, content, keywords)
     VALUES ('delete', old.rowid, old.content, old.keywords);
   END`,
  `CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
     INSERT INTO memory_fts(memory_fts, rowid, content, keywords)
     VALUES ('delete', old.rowid, old.content, old.keywords);
     INSERT INTO memory_fts(rowid, content, keywords) VALUES (new.rowid, new.content, new.keywords);
   END`,
  /** Append-only provenance: who wrote what, when, from which channel. */
  `CREATE TABLE IF NOT EXISTS audit_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at INTEGER NOT NULL,
     kind TEXT NOT NULL,
     session_id TEXT NOT NULL DEFAULT '',
     level TEXT NOT NULL DEFAULT '',
     memory_id TEXT NOT NULL DEFAULT '',
     detail TEXT NOT NULL DEFAULT '',
     payload TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC)`,
  /** What each session has already been shown, so a recall is not repeated. */
  `CREATE TABLE IF NOT EXISTS session_seen (
     session_id TEXT NOT NULL,
     memory_id TEXT NOT NULL,
     seen_at INTEGER NOT NULL,
     PRIMARY KEY (session_id, memory_id)
   )`,
  /** Per-session counters the writeback trigger needs (user turns, last write). */
  `CREATE TABLE IF NOT EXISTS session_state (
     session_id TEXT NOT NULL,
     key TEXT NOT NULL,
     value TEXT NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (session_id, key)
   )`,
];

/**
 * Open (and migrate) the workspace store.
 * @param {string} workspace absolute workspace path
 * @param {string} dataDir workspace-relative data directory
 * @returns {Store}
 */
export function openDb(workspace, dataDir) {
  const file = dbPath(workspace, dataDir);
  mkdirSync(dirname(file), { recursive: true });
  const handle = new DatabaseSync(file);
  // WAL so a tool call from one agent and an injection read from another do not
  // block each other; busy_timeout so a rare write-write race waits instead of
  // throwing SQLITE_BUSY into a turn.
  handle.exec('PRAGMA journal_mode = WAL');
  handle.exec('PRAGMA busy_timeout = 5000');
  handle.exec('PRAGMA foreign_keys = ON');
  migrate(handle);
  return new Store(handle, file, workspace, dataDir);
}

function migrate(handle) {
  for (const statement of SCHEMA) handle.exec(statement);
  const row = handle.prepare('SELECT version FROM schema_version LIMIT 1').get();
  if (row === undefined) {
    handle.prepare('INSERT INTO schema_version(version) VALUES (?)').run(SCHEMA_VERSION);
  } else if (row.version !== SCHEMA_VERSION) {
    // No migrations exist yet; refusing is better than silently running an old
    // schema against new code.
    throw new Error(`dsh-memory: 记忆库 schema 版本 ${row.version} 与插件要求 ${SCHEMA_VERSION} 不一致`);
  }
}

/** Column list shared by every SELECT so row shape never drifts between paths. */
const COLUMNS = `id, level, content, keywords, importance, confidence, project, subcategory, goal,
  status, use_count, last_used_at, supersedes_id, content_hash, created_at, updated_at`;

/**
 * Build a WHERE clause from a management-UI filter.
 *
 * Every branch is independent and optional, so the same helper serves the
 * "all rows" page, a level facet, and a text search. `project` intentionally
 * includes the global project: a workspace's stand-alone memories are visible
 * from every project, which is the same rule the retrieval path uses.
 * @param {{status?: string, level?: string, project?: string, query?: string}} filter
 * @returns {{clause: string, values: unknown[]}}
 */
function whereClause(filter) {
  const parts = [];
  const values = [];
  if (typeof filter.status === 'string' && filter.status !== '' && filter.status !== 'all') {
    parts.push('status = ?');
    values.push(filter.status);
  }
  if (typeof filter.level === 'string' && filter.level !== '') {
    parts.push('level = ?');
    values.push(filter.level);
  }
  if (typeof filter.project === 'string' && filter.project !== '') {
    parts.push("(project = '' OR project = '全局' OR project = ?)");
    values.push(filter.project);
  }
  if (typeof filter.query === 'string' && filter.query.trim() !== '') {
    const like = `%${filter.query.trim().replace(/[%_]/g, (c) => `\\${c}`)}%`;
    parts.push('(content LIKE ? OR keywords LIKE ?)');
    values.push(like, like);
  }
  return { clause: parts.length === 0 ? '' : `WHERE ${parts.join(' AND ')}`, values };
}

export class Store {
  /**
   * @param {DatabaseSync} handle
   * @param {string} file
   * @param {string} workspace
   * @param {string} dataDir
   */
  constructor(handle, file, workspace, dataDir) {
    this.handle = handle;
    this.file = file;
    this.workspace = workspace;
    this.dataDir = dataDir;
  }

  close() {
    try {
      this.handle.close();
    } catch {
      // closing twice, or closing a handle SQLite already dropped, is fine
    }
  }

  /** Run `fn` inside one transaction; rolls back on throw. */
  transaction(fn) {
    this.handle.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.handle.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.handle.exec('ROLLBACK');
      } catch {
        // a rollback that fails must not mask the original error
      }
      throw error;
    }
  }

  /** Append a provenance row. Never throws into the caller. */
  audit(kind, detail, payload, sessionId) {
    try {
      this.handle.prepare(
        'INSERT INTO audit_log(at, kind, session_id, level, memory_id, detail, payload) VALUES (?,?,?,?,?,?,?)',
      ).run(
        Date.now(),
        String(kind),
        String(sessionId ?? ''),
        String(payload?.level ?? ''),
        String(payload?.id ?? ''),
        String(detail ?? ''),
        typeof payload === 'string' ? payload : JSON.stringify(payload ?? {}),
      );
    } catch {
      // Auditing must never break a write that already succeeded.
    }
  }

  /**
   * Insert one memory row.
   * @param {object} entry
   * @returns {string} the new id
   */
  insert(entry) {
    const id = entry.id ?? newId();
    const now = Date.now();
    this.handle.prepare(
      `INSERT INTO memories(${COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      entry.level,
      entry.content,
      entry.keywords ?? '',
      entry.importance ?? 2,
      entry.confidence ?? 1.0,
      entry.project ?? '',
      entry.subcategory ?? '',
      entry.goal ?? '',
      entry.status ?? 'active',
      entry.use_count ?? 0,
      entry.last_used_at ?? null,
      entry.supersedes_id ?? null,
      entry.content_hash ?? '',
      entry.created_at ?? now,
      entry.updated_at ?? now,
    );
    return id;
  }

  /** One row by id, or undefined. */
  get(id) {
    return this.handle.prepare(`SELECT ${COLUMNS} FROM memories WHERE id = ?`).get(String(id));
  }

  /**
   * Update the mutable fields of one row. `updated_at` is always bumped, which
   * is what resets the forgetting curve — touching a memory is a use.
   * @param {string} id
   * @param {object} patch
   */
  update(id, patch) {
    const sets = [];
    const values = [];
    for (const key of ['content', 'keywords', 'importance', 'confidence', 'project', 'subcategory', 'goal', 'status', 'content_hash', 'supersedes_id', 'use_count', 'last_used_at']) {
      if (patch[key] === undefined) continue;
      sets.push(`${key} = ?`);
      values.push(patch[key]);
    }
    sets.push('updated_at = ?');
    values.push(patch.updated_at ?? Date.now(), String(id));
    this.handle.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  /** Permanently-traceable retirement: flip the status, keep the row. */
  archive(id, reason) {
    this.handle.prepare('UPDATE memories SET status = ?, updated_at = ? WHERE id = ?')
      .run('archived', Date.now(), String(id));
    this.audit('archive', reason ?? '', { id });
  }

  /**
   * Rows for injection/recall, newest-touched first.
   * @param {{status?: string, project?: string}} [filter]
   */
  list(filter = {}) {
    const status = filter.status ?? 'active';
    if (typeof filter.project === 'string' && filter.project !== '') {
      return this.handle.prepare(
        `SELECT ${COLUMNS} FROM memories WHERE status = ? AND (project = '' OR project = '全局' OR project = ?) ORDER BY updated_at DESC`,
      ).all(status, filter.project);
    }
    return this.handle.prepare(
      `SELECT ${COLUMNS} FROM memories WHERE status = ? ORDER BY updated_at DESC`,
    ).all(status);
  }

  /** Counts per level (active only) — used by `/mem` and by health checks. */
  counts() {
    const rows = this.handle.prepare(
      "SELECT level, COUNT(*) AS n FROM memories WHERE status = 'active' GROUP BY level",
    ).all();
    const out = {};
    for (const row of rows) out[row.level] = row.n;
    return out;
  }

  /** Total row count regardless of status. */
  total() {
    return this.handle.prepare('SELECT COUNT(*) AS n FROM memories').get()?.n ?? 0;
  }

  /**
   * One page of rows for the management UI.
   *
   * Kept separate from {@link list} on purpose: `list` feeds injection and must
   * stay a small, status-filtered scan, while this one answers "show me what is
   * in here" — every status, every level, arbitrary pages, optional substring.
   * @param {{status?: string, level?: string, project?: string, query?: string, limit?: number, offset?: number}} [filter]
   * @returns {{rows: object[], total: number}}
   */
  page(filter = {}) {
    const { clause, values } = whereClause(filter);
    const limit = Math.min(Math.max(Number(filter.limit) || 100, 1), 500);
    const offset = Math.max(Number(filter.offset) || 0, 0);
    const rows = this.handle.prepare(
      `SELECT ${COLUMNS} FROM memories ${clause} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
    ).all(...values, limit, offset);
    const total = this.handle.prepare(`SELECT COUNT(*) AS n FROM memories ${clause}`).get(...values)?.n ?? 0;
    return { rows, total };
  }

  /**
   * Everything the management header shows: totals per status, per level, and
   * how many distinct projects the workspace holds.
   * @returns {{total: number, active: number, archived: number, levels: object, projects: string[]}}
   */
  stats() {
    const byStatus = this.handle.prepare(
      'SELECT status, COUNT(*) AS n FROM memories GROUP BY status',
    ).all();
    const byLevel = this.handle.prepare(
      "SELECT level, COUNT(*) AS n FROM memories WHERE status = 'active' GROUP BY level",
    ).all();
    const projects = this.handle.prepare(
      "SELECT DISTINCT project FROM memories WHERE status = 'active' ORDER BY project",
    ).all();
    const status = {};
    for (const row of byStatus) status[row.status] = row.n;
    const levels = {};
    for (const row of byLevel) levels[row.level] = row.n;
    return {
      total: byStatus.reduce((sum, row) => sum + row.n, 0),
      active: status.active ?? 0,
      archived: status.archived ?? 0,
      levels,
      projects: projects.map((row) => row.project).filter((project) => typeof project === 'string'),
    };
  }

  /** Put an archived row back on active duty. */
  restore(id) {
    this.handle.prepare('UPDATE memories SET status = ?, updated_at = ? WHERE id = ?')
      .run('active', Date.now(), String(id));
    this.audit('restore', '从归档恢复', { id });
  }

  /**
   * FTS5 candidates for a MATCH expression.
   * @param {string} matchExpression already-quoted phrase OR-expression
   * @param {{limit?: number, status?: string, project?: string}} [options]
   */
  searchFts(matchExpression, options = {}) {
    const limit = options.limit ?? 50;
    const status = options.status ?? 'active';
    try {
      if (typeof options.project === 'string' && options.project !== '') {
        return this.handle.prepare(
          `SELECT ${COLUMNS}, bm25(memory_fts) AS score
             FROM memory_fts JOIN memories ON memories.rowid = memory_fts.rowid
            WHERE memory_fts MATCH ? AND memories.status = ? AND (memories.project = '' OR memories.project = '全局' OR memories.project = ?)
            ORDER BY score LIMIT ?`,
        ).all(matchExpression, status, options.project, limit);
      }
      return this.handle.prepare(
        `SELECT ${COLUMNS}, bm25(memory_fts) AS score
           FROM memory_fts JOIN memories ON memories.rowid = memory_fts.rowid
          WHERE memory_fts MATCH ? AND memories.status = ?
          ORDER BY score LIMIT ?`,
      ).all(matchExpression, status, limit);
    } catch {
      // A malformed expression must degrade to "no FTS hits", not fail the turn.
      return [];
    }
  }

  /**
   * LIKE candidates — the mandatory fallback for 2-character queries, which a
   * trigram index structurally cannot serve.
   * @param {string[]} terms
   * @param {{limit?: number, status?: string, project?: string}} [options]
   */
  searchLike(terms, options = {}) {
    if (!Array.isArray(terms) || terms.length === 0) return [];
    const limit = options.limit ?? 50;
    const status = options.status ?? 'active';
    const clauses = terms.map(() => '(content LIKE ? OR keywords LIKE ?)').join(' OR ');
    const values = [];
    for (const term of terms) {
      const like = `%${String(term).replace(/[%_]/g, (c) => `\\${c}`)}%`;
      values.push(like, like);
    }
    try {
      if (typeof options.project === 'string' && options.project !== '') {
        return this.handle.prepare(
          `SELECT ${COLUMNS} FROM memories
            WHERE status = ? AND (project = '' OR project = '全局' OR project = ?) AND (${clauses})
            ORDER BY updated_at DESC LIMIT ?`,
        ).all(status, options.project, ...values, limit);
      }
      return this.handle.prepare(
        `SELECT ${COLUMNS} FROM memories WHERE status = ? AND (${clauses}) ORDER BY updated_at DESC LIMIT ?`,
      ).all(status, ...values, limit);
    } catch {
      return [];
    }
  }

  /**
   * Look for an existing row that should be merged into rather than duplicated.
   * Exact hash first (cheap, catches re-wording-free repeats), then a level +
   * project candidate set the repo can compare by similarity.
   * @param {{hash: string, level: string, project: string}} input
   */
  findDuplicates(input) {
    const byHash = this.handle.prepare(
      "SELECT * FROM memories WHERE content_hash = ? AND status = 'active' LIMIT 1",
    ).get(input.hash);
    if (byHash !== undefined) return { exact: byHash, candidates: [] };
    const candidates = this.handle.prepare(
      "SELECT * FROM memories WHERE level = ? AND project = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 30",
    ).all(input.level, input.project);
    return { exact: undefined, candidates };
  }

  /** Record that these entries were shown in this session (recall dedup). */
  markSeen(sessionId, ids) {
    if (typeof sessionId !== 'string' || sessionId === '') return;
    const at = Date.now();
    const statement = this.handle.prepare(
      'INSERT OR IGNORE INTO session_seen(session_id, memory_id, seen_at) VALUES (?,?,?)',
    );
    for (const id of ids ?? []) statement.run(sessionId, String(id), at);
  }

  /** Ids already shown in this session. */
  seenSet(sessionId) {
    const rows = this.handle.prepare('SELECT memory_id FROM session_seen WHERE session_id = ?').all(String(sessionId));
    return new Set(rows.map((row) => row.memory_id));
  }

  /** A compaction collapsed history — the seen-set no longer describes the surface. */
  clearSeen(sessionId) {
    this.handle.prepare('DELETE FROM session_seen WHERE session_id = ?').run(String(sessionId));
  }

  /** Bump the use counter for entries that were actually injected. */
  touchUsage(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return;
    const now = Date.now();
    const statement = this.handle.prepare(
      'UPDATE memories SET use_count = use_count + 1, last_used_at = ? WHERE id = ?',
    );
    for (const id of ids) statement.run(now, String(id));
  }

  /** Read one session-scoped counter (writeback gating). */
  getState(sessionId, key) {
    const row = this.handle.prepare(
      'SELECT value FROM session_state WHERE session_id = ? AND key = ?',
    ).get(String(sessionId), String(key));
    return row?.value;
  }

  /** Write one session-scoped counter. */
  setState(sessionId, key, value) {
    this.handle.prepare(
      `INSERT INTO session_state(session_id, key, value, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(session_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(String(sessionId), String(key), String(value), Date.now());
  }

  /** Recent audit rows, newest first. */
  recentAudit(limit = 20) {
    return this.handle.prepare('SELECT * FROM audit_log ORDER BY at DESC LIMIT ?').all(limit);
  }
}
