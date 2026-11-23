/**
 * Human-facing slash commands (`/mem`).
 *
 * One command, read-only, on purpose: an operator's actual question is "is this
 * thing writing anything?", and the answer lives in the audit log — not in a
 * second write path that would just add more surface.
 */
import { LEVELS } from './config.js';

/** Budget for a command reply; the composer shows it verbatim. */
const MAX_REPLY_CHARS = 4000;

/**
 * Register the commands.
 * @param {{ctx: object, cfg: object, repoFor: Function, logger: object}} input
 * @returns {() => void} disposer (wrap in `ctx.effect` at the call site)
 */
export function registerCommands(input) {
  const { ctx, cfg, repoFor } = input;
  const prefix = cfg?.toolPrefix ?? '';
  const disposer = ctx.commands.register({
    name: `${prefix}mem`,
    description: '查看当前工作区的记忆库概况与最近写入审计（只读）',
    input: { hint: '[审计条数，缺省 10]' },
    handler: (invocation) => runMem({ invocation, repoFor }),
  });
  return () => {
    try {
      disposer();
    } catch {
      // unregistering is best-effort at teardown
    }
  };
}

function runMem({ invocation, repoFor }) {
  const agent = invocation?.agent;
  const workspace = workspaceOf(agent);
  if (workspace === undefined) {
    return { kind: 'error', text: '无法确定当前会话的工作区路径。' };
  }
  const repo = repoFor(workspace);
  if (repo === undefined) {
    return { kind: 'error', text: `工作区 ${workspace} 的记忆库无法打开（请查看 DSH 日志）。` };
  }
  const stats = repo.stats();
  const lines = [
    `记忆库：${stats.file}`,
    `总条数：${stats.total}（active 分项：${LEVELS.map((level) => `${level}=${stats.byLevel[level] ?? 0}`).join('  ')}）`,
    '',
  ];

  const auditLimit = limitOf(invocation);
  const rows = repo.store.recentAudit(auditLimit);
  if (rows.length === 0) {
    lines.push('还没有任何写入记录。');
  } else {
    lines.push(`最近 ${rows.length} 条审计：`);
    for (const row of rows) {
      const when = new Date(row.at).toISOString().replace('T', ' ').slice(0, 19);
      lines.push(`- ${when}  ${row.kind}  ${row.detail}`);
    }
  }
  lines.push('', '写入通道：工具调用（memory_remember）、写回触发（用户消息含触发词/每 N 轮）。');
  const text = lines.join('\n');
  return { kind: 'ok', text: text.length <= MAX_REPLY_CHARS ? text : `${text.slice(0, MAX_REPLY_CHARS - 1)}…` };
}

function limitOf(invocation) {
  const raw = invocation?.input ?? invocation?.args ?? '';
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 10;
  return Math.min(50, parsed);
}

function workspaceOf(agent) {
  const header = agent?.session?.header;
  return typeof header?.cwd === 'string' && header.cwd !== '' ? header.cwd : undefined;
}
