/**
 * Model-facing tools: `memory_remember`, `memory_search`, `memory_read`,
 * `memory_update`, `memory_status`.
 *
 * Every tool resolves the workspace and project from the executing agent, so a
 * call in any session reads and writes that session's own database. Nothing here
 * deletes: `memory_update` with `status: 'archived'` archives (the row stays, with
 * provenance), which is the only removal this plugin performs.
 */
import { LEVELS, LEVEL_HINTS, GLOBAL_PROJECT, PROJECT_SUBCATEGORIES } from './config.js';
import { normalizeProject } from './store/memory-repo.js';
import { tokenize } from './ranking.js';

/** A search hit must share at least something with the query. */
const MIN_SEARCH_RELEVANCE = 0.01;

/**
 * Tool results cross a lossless-JSON boundary: DSH rejects any result carrying
 * an `undefined` property (`value is not lossless JSON`), so every optional
 * string field is materialised as `''` rather than left absent.
 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    status: { type: 'string', description: 'ok=成功，error=失败，skipped=未执行' },
    summary: { type: 'string', description: '给模型看的一行结论' },
    text: { type: 'string', description: '详细内容（markdown）' },
  },
  required: ['status', 'summary', 'text'],
};

function renderValue(value) {
  const blocks = [{ type: 'text', text: `[${value?.status ?? 'ok'}] ${value?.summary ?? ''}`.trim() }];
  if (typeof value?.text === 'string' && value.text !== '') {
    blocks.push({ type: 'text', text: `\n${value.text}` });
  }
  return blocks;
}

function ok(summary, text = '') {
  return { status: 'ok', summary: String(summary), text: String(text) };
}

function error(summary, text = '') {
  return { status: 'error', summary: String(summary), text: String(text) };
}

/**
 * Workspace + project for one tool call.
 *
 * `session.header.cwd` is the workspace (that is what scopes the database);
 * `session.header.title` is the human-facing name, used as the project tag so
 * two workspaces with the same basename do not collide in the `project` column.
 */
export function scopeOf(exec) {
  const header = exec?.agent?.session?.header ?? {};
  const workspace = typeof header.cwd === 'string' && header.cwd !== '' ? header.cwd : undefined;
  const project = workspace === undefined
    ? GLOBAL_PROJECT
    : normalizeProject(
      typeof header.title === 'string' && header.title.trim() !== '' ? header.title : basename(workspace),
    );
  return { workspace, project, sessionId: typeof header.id === 'string' ? header.id : undefined };
}

function basename(workspace) {
  const parts = String(workspace).split(/[\\/]+/).filter((part) => part !== '');
  return parts.length === 0 ? GLOBAL_PROJECT : parts[parts.length - 1];
}

function formatEntry(entry, index) {
  const tags = [entry.level];
  if (entry.project !== '' && entry.project !== GLOBAL_PROJECT) tags.push(entry.project);
  if (entry.subcategory !== '') tags.push(entry.subcategory);
  const head = `${index === undefined ? '' : `${index}. `}[${entry.id}] (${tags.join('/')})`;
  const keywords = entry.keywords === '' ? '' : `\n   关键词：${entry.keywords.split(' ').join(' ')}`;
  const goal = entry.goal === '' ? '' : `\n   目标句：${entry.goal}`;
  const status = entry.status === 'active' ? '' : `\n   状态：${entry.status}`;
  const used = entry.use_count > 0 ? `\n   命中 ${entry.use_count} 次` : '';
  return `\n${head}\n   ${entry.content}${goal}${keywords}${status}${used}`;
}

/**
 * Build the tool definitions.
 *
 * @param {object} deps
 * @param {() => object|undefined} deps.cfg
 * @param {(workspace: string) => import('./store/memory-repo.js').MemoryRepo|undefined} deps.repoFor
 * @param {object} [deps.logger]
 */
export function createTools(deps) {
  const { cfg, repoFor } = deps;

  /**
   * Namespace for these tool names. Read at build time so the names are stable
   * for the lifetime of the registration — DSH rejects a duplicate tool name and
   * that error aborts the whole plugin tree.
   */
  const prefix = cfg()?.toolPrefix ?? '';

  const resolve = (exec) => {
    const scope = scopeOf(exec);
    if (scope.workspace === undefined) {
      return { error: error('无法确定当前工作区（session.header.cwd 缺失），本次调用未执行') };
    }
    const repo = repoFor(scope.workspace);
    if (repo === undefined) {
      return { error: error(`工作区 ${scope.workspace} 的记忆库不可用（请查看 DSH 日志）`) };
    }
    return { scope, repo, config: cfg() };
  };

  return [
    {
      name: `${prefix}memory_remember`,
      description:
        '把一条值得跨会话记住的信息写入本工作区的长期记忆库（本地 SQLite，按工作区隔离）。'
        + 'content 一句话直陈事实，不要写「用户问过…」。'
        + `level 取值：${LEVELS.map((level) => `${level}(${LEVEL_HINTS[level]})`).join(' / ')}。`
        + 'keywords 给 8-13 个检索关键词（反向思考：用户下一句话说什么词时希望这条被翻出来）。'
        + 'importance 1-4（4=红线/安全，3=用户强调，2=一般决策，1=琐碎）。'
        + '与已有条目高度相似时会自动合并而不是新增；比它更早的同类条目会被标为 superseded。'
        + '不要写入密钥、一次性进度或你自己的推理过程。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['content', 'level'],
        properties: {
          content: { type: 'string', description: '记忆内容，一句话直陈' },
          level: { type: 'string', enum: LEVELS, description: '记忆层级' },
          keywords: {
            type: 'array',
            items: { type: 'string' },
            description: '8-13 个检索关键词',
          },
          importance: { type: 'integer', minimum: 1, maximum: 4, description: '重要性 1-4' },
          project: { type: 'string', description: `归属项目，缺省=当前项目；跨项目通用信息写 ${GLOBAL_PROJECT}` },
          subcategory: {
            type: 'string',
            enum: PROJECT_SUBCATEGORIES,
            description: 'level=project 时建议填写',
          },
          goal: { type: 'string', description: 'level=topic/decision 时的目标句或理由' },
        },
      },
      output: { schema: OUTPUT_SCHEMA, render: (_args, value) => renderValue(value) },
      async execute(args, exec) {
        const ctxRes = resolve(exec);
        if (ctxRes.error !== undefined) return ctxRes.error;
        const { repo, scope } = ctxRes;
        try {
          const result = repo.remember(
            {
              level: args.level,
              content: args.content,
              keywords: args.keywords,
              importance: args.importance,
              project: args.project ?? scope.project,
              subcategory: args.subcategory,
              goal: args.goal,
            },
            { session: scope.sessionId, kind: 'tool' },
          );
          const warnings = repo.takeWarnings();
          const entry = repo.store.get(result.id);
          const verb = result.action === 'insert'
            ? '已写入新条目'
            : result.action === 'supersede'
              ? '已写入新条目（替代了同主题的旧条目）'
              : '已合并进既有条目';
          const text = [
            `${verb}：${args.level}/${result.id}`,
            entry === undefined ? '' : formatEntry(entry),
            warnings.length === 0 ? '' : `\n提示：\n- ${warnings.join('\n- ')}`,
          ].filter((line) => line !== '').join('\n');
          return ok(`${verb}（${args.level}/${result.id}）`, text);
        } catch (err) {
          return error(`写入失败：${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },
    {
      name: `${prefix}memory_search`,
      description:
        '在长期记忆库里检索（BM25 × 遗忘曲线 × 重要性加权）。默认只搜本工作区「全局 + 当前项目」范围内的 active 条目；'
        + '中文检索用 FTS5 trigram 加 LIKE 兜底，两字词也能搜到。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string', description: '检索词或一句话' },
          level: { type: 'string', enum: LEVELS, description: '只看某一层级（可选）' },
          status: { type: 'string', enum: ['active', 'stale', 'archived', 'superseded', 'all'], description: '缺省 active' },
          k: { type: 'integer', minimum: 1, maximum: 50, description: '返回条数，缺省 10' },
          project: { type: 'string', description: `限定项目，缺省=当前项目；写 ${GLOBAL_PROJECT} 只看全局` },
        },
      },
      output: { schema: OUTPUT_SCHEMA, render: (_args, value) => renderValue(value) },
      async execute(args, exec) {
        const ctxRes = resolve(exec);
        if (ctxRes.error !== undefined) return ctxRes.error;
        const { repo, scope } = ctxRes;
        try {
          const project = args.project ?? scope.project;
          const hits = repo.recall({
            query: args.query,
            project,
            topK: args.k ?? 10,
            minRelevance: MIN_SEARCH_RELEVANCE,
          });
          const filtered = hits
            .filter((hit) => args.level === undefined || hit.level === args.level)
            .filter((hit) => matchStatus(hit.status, args.status));
          if (filtered.length === 0) {
            return ok(`没有匹配「${args.query}」的记忆`, `工作区 ${repo.store.workspace}，项目 ${normalizeProject(project)}；可换关键词，或用 memory_status 看库里有什么。`);
          }
          const text = filtered.map((hit, index) => formatEntry(hit, index + 1)).join('\n');
          return ok(`命中 ${filtered.length} 条`, text);
        } catch (err) {
          return error(`检索失败：${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },
    {
      name: `${prefix}memory_read`,
      description: '按 id 读取一条记忆的完整内容与元数据（含关键词、状态、命中次数、来源审计）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: { id: { type: 'string', description: '记忆 id' } },
      },
      output: { schema: OUTPUT_SCHEMA, render: (_args, value) => renderValue(value) },
      async execute(args, exec) {
        const ctxRes = resolve(exec);
        if (ctxRes.error !== undefined) return ctxRes.error;
        const { repo } = ctxRes;
        const entry = repo.store.get(args.id);
        if (entry === undefined) return error(`记忆 ${args.id} 不存在`);
        return ok(`记忆 ${entry.id}`, formatEntry(entry));
      },
    },
    {
      name: `${prefix}memory_update`,
      description:
        '修正一条已有记忆（优先更新而不是新增）。可改 content/keywords/importance/project。'
        + 'status 语义：active=生效；stale=已完结（保留可查）；archived=作废（归档，不删除，历史可追溯）；superseded=被新条目替代。'
        + '发现记忆过时或写错时必须用它修正，不要让错的记忆继续生效。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: {
          id: { type: 'string', description: '记忆 id' },
          content: { type: 'string', description: '新的内容' },
          keywords: { type: 'array', items: { type: 'string' }, description: '新的关键词' },
          importance: { type: 'integer', minimum: 1, maximum: 4 },
          project: { type: 'string' },
          level: { type: 'string', enum: LEVELS, description: '仅用于记录审计（层级不可迁移）' },
          status: { type: 'string', enum: ['active', 'stale', 'archived', 'superseded'] },
          reason: { type: 'string', description: '为什么改（写进审计日志）' },
        },
      },
      output: { schema: OUTPUT_SCHEMA, render: (_args, value) => renderValue(value) },
      async execute(args, exec) {
        const ctxRes = resolve(exec);
        if (ctxRes.error !== undefined) return ctxRes.error;
        const { repo, scope } = ctxRes;
        const existing = repo.store.get(args.id);
        if (existing === undefined) return error(`记忆 ${args.id} 不存在`);
        try {
          const status = args.status;
          if (status === 'archived') {
            repo.archive(args.id, args.reason ?? 'memory_update archived', { session: scope.sessionId });
            return ok(`已归档 ${args.id}（数据保留，可追溯）`, formatEntry(repo.store.get(args.id)));
          }
          const patch = {};
          if (typeof args.content === 'string' && args.content.trim() !== '') {
            patch.content = args.content.trim();
            patch.content_hash = contentHashOf(patch.content);
          }
          if (Array.isArray(args.keywords)) patch.keywords = normalizeKeywordList(args.keywords);
          if (Number.isInteger(args.importance)) patch.importance = Math.min(4, Math.max(1, args.importance));
          if (typeof args.project === 'string' && args.project.trim() !== '') patch.project = normalizeProject(args.project);
          if (status !== undefined) patch.status = status;
          if (Object.keys(patch).length === 0) return ok('没有需要修改的字段，未做变更');
          repo.store.update(args.id, patch);
          repo.store.audit(
            'update',
            args.reason ?? 'memory_update',
            { id: args.id, level: existing.level, fields: Object.keys(patch) },
            scope.sessionId,
          );
          return ok(`已更新 ${args.id}`, formatEntry(repo.store.get(args.id)));
        } catch (err) {
          return error(`更新失败：${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },
    {
      name: `${prefix}memory_status`,
      description: '查看本工作区记忆库的概况：文件位置、各层级条数、最近的读写审计（诊断「记忆写没写进去」时先看这个）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          audit: { type: 'integer', minimum: 0, maximum: 50, description: '额外显示最近 N 条审计（缺省 8）' },
        },
      },
      output: { schema: OUTPUT_SCHEMA, render: (_args, value) => renderValue(value) },
      async execute(args, exec) {
        const ctxRes = resolve(exec);
        if (ctxRes.error !== undefined) return ctxRes.error;
        const { repo } = ctxRes;
        const stats = repo.stats();
        const lines = [
          `数据库：${stats.file}`,
          `工作区：${stats.workspace}`,
          `总条数：${stats.total}`,
          `各层级（active）：${LEVELS.map((level) => `${level}=${stats.byLevel[level] ?? 0}`).join('  ')}`,
        ];
        const limit = args.audit ?? 8;
        if (limit > 0) {
          const rows = repo.store.recentAudit(limit);
          lines.push('', `最近 ${rows.length} 条审计：`);
          for (const row of rows) {
            lines.push(`- ${new Date(row.at).toISOString()} ${row.kind} ${row.detail}`.trim());
          }
        }
        return ok(`记忆库共 ${stats.total} 条`, lines.join('\n'));
      },
    },
  ];
}

function normalizeKeywordList(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const keyword = String(raw).trim();
    if (keyword === '' || seen.has(keyword)) continue;
    seen.add(keyword);
    out.push(keyword);
    if (out.length >= 16) break;
  }
  return out.join(' ');
}

/** Same FNV-1a hash the store uses; kept local so this file has no store import. */
function contentHashOf(text) {
  let hash = 0x811c9dc5;
  const value = String(text ?? '');
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function matchStatus(actual, wanted) {
  if (wanted === undefined || wanted === 'all') return true;
  return (actual ?? 'active') === wanted;
}

export { tokenize };
