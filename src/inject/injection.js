/**
 * Injection builders — the read channel's rendering half.
 *
 * Two surfaces with different jobs:
 *
 *  1. **First-turn snapshot** (once per session, inserted before the first real
 *     user message): the standing context — who the user is, hard rules, active
 *     decisions, project state. Hard character budget. Written once so the
 *     conversation prefix stays stable and the provider's prompt cache survives.
 *  2. **Per-message recall** (message 2 onward): BM25 top-K over "global +
 *     current project", skipping what this session already saw, and only above a
 *     relevance floor — unrelated chatter must get nothing appended.
 *
 * The fixed system-prompt section lives in `system-prompt.js` and is
 * deliberately NOT rebuilt per turn: it is the one part of the prompt that must
 * never change, or every request misses the cache.
 */
import { GLOBAL_PROJECT, LEVELS, LEVEL_HINTS } from '../config.js';
import { RECALL_MARKER, SNAPSHOT_MARKER } from './message.js';

/** Order sections appear in the snapshot; also the priority when the budget is tight. */
const LEVEL_ORDER = ['rule', 'preference', 'decision', 'fact', 'project', 'lesson'];

const LABELS = {
  zh: {
    title: '本工作区长期记忆',
    about: '用户档案',
    rule: '准则与红线',
    preference: '偏好',
    decision: '已有取舍',
    fact: '已知事实',
    project: '项目状态',
    lesson: '踩过的坑',
    more: (n) => `…另有 ${n} 条省略`,
    recallTitle: '相关记忆（仅供参考）',
    empty: '（本工作区暂无记忆）',
  },
  en: {
    title: 'Workspace long-term memory',
    about: 'User profile',
    rule: 'Rules and red lines',
    preference: 'Preferences',
    decision: 'Decisions made',
    fact: 'Known facts',
    project: 'Project state',
    lesson: 'Lessons learned',
    more: (n) => `…${n} more omitted`,
    recallTitle: 'Relevant memory (context only)',
    empty: '(no memory stored for this workspace yet)',
  },
};

function labels(lang) {
  return LABELS[lang] ?? LABELS.zh;
}

function clip(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length <= max ? value : `${value.slice(0, Math.max(1, max - 1))}…`;
}

function projectTag(entry) {
  if (entry.project === undefined || entry.project === '' || entry.project === GLOBAL_PROJECT) return '';
  return `[${entry.project}] `;
}

/**
 * Render one entry as a bullet. The level tag is dropped for entries already
 * under a level heading, and kept for the mixed recall block.
 */
function bullet(entry, { maxChars = 140, withLevel = false } = {}) {
  const tag = withLevel ? `(${entry.level}) ` : '';
  const goal = typeof entry.goal === 'string' && entry.goal !== '' ? ` —— 目标：${clip(entry.goal, 60)}` : '';
  return `- ${tag}${projectTag(entry)}${clip(entry.content, maxChars)}${goal}`;
}

/**
 * Accumulate sections under a hard character budget.
 *
 * Sections are pushed in priority order; once the budget would be exceeded the
 * current section is truncated rather than dropped wholesale, so a full store
 * still contributes some of its tail instead of an empty block. A section that
 * cannot fit a meaningful fragment is skipped.
 *
 * @returns {number} how many of `lines` were rendered (for seen-tracking, so a
 *   truncated line is not recorded as injected — that would suppress it forever)
 */
function pushSection(sections, name, lines, budget, lang) {
  if (lines.length === 0) return 0;
  const text = lines.join('\n');
  const remaining = budget.max - budget.used;
  if (remaining < 80) return 0;
  if (text.length <= remaining) {
    sections.push({ name, text });
    budget.used += text.length;
    return lines.length;
  }
  let used = 0;
  let shown = 0;
  for (const line of lines) {
    if (used + line.length + 1 > remaining - 20) break;
    used += line.length + 1;
    shown += 1;
  }
  if (shown === 0) return 0;
  sections.push({ name, text: `${lines.slice(0, shown).join('\n')}\n${labels(lang).more(lines.length - shown)}` });
  budget.used = budget.max;
  return shown;
}

/**
 * Build the first-turn snapshot.
 *
 * @param {object} input
 * @param {import('../store/memory-repo.js').MemoryRepo} input.repo
 * @param {string} input.lang
 * @param {string} input.project
 * @param {number} [input.budgetChars]
 * @param {number} [input.now]
 * @returns {{text: string, sections: Array<{name: string, text: string}>, injectedIds: string[], total: number}|undefined}
 */
export function buildSnapshot(input) {
  const { repo, project } = input;
  const lang = input.lang === 'en' ? 'en' : 'zh';
  const L = labels(lang);
  const grouped = repo.byLevel(project);

  const active = [...grouped.values()].reduce((sum, rows) => sum + rows.length, 0);
  if (active === 0) return undefined;

  const budget = { max: input.budgetChars ?? 2400, used: 0 };
  const sections = [];
  const injectedIds = [];

  const emit = (level, title) => {
    const rows = (grouped.get(level) ?? [])
      .slice()
      .sort((a, b) => (b.importance - a.importance) || (b.updated_at - a.updated_at));
    if (rows.length === 0) return;
    const lines = rows.map((row) => bullet(row, { maxChars: 140 }));
    const shown = pushSection(sections, title, lines, budget, lang);
    for (const row of rows.slice(0, shown)) injectedIds.push(row.id);
  };

  for (const level of LEVEL_ORDER) {
    const title = L[level] ?? level;
    emit(level, title);
  }

  if (sections.length === 0) return undefined;
  const total = [...grouped.values()].reduce((sum, rows) => sum + rows.length, 0);
  const text = [
    SNAPSHOT_MARKER,
    `## ${L.title}`,
    ...sections.map((section) => `### ${section.name}\n${section.text}`),
    '',
    '_这是本工作区的长期记忆快照，仅供上下文参考；与用户当前要求冲突时以用户为准。_',
  ].join('\n');
  return { text, sections, injectedIds: unique(injectedIds), total };
}

/** How many of `lines` actually made it into the last section. */
function unique(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * Build the per-message recall block.
 *
 * @param {object} input
 * @param {import('../store/memory-repo.js').MemoryRepo} input.repo
 * @param {string} input.query
 * @param {string} input.project
 * @param {string} input.lang
 * @param {Set<string>} input.seenIds
 * @param {number} [input.topK]
 * @param {number} [input.minRelevance]
 * @param {number} [input.budgetChars]
 * @param {number} [input.now]
 * @returns {{text: string, ids: string[]}|undefined}
 */
export function buildRecall(input) {
  const { repo, project, seenIds } = input;
  const lang = input.lang === 'en' ? 'en' : 'zh';
  const L = labels(lang);
  const hits = repo.recall({
    query: input.query,
    project,
    topK: input.topK ?? 3,
    excludeIds: seenIds ?? new Set(),
    minRelevance: input.minRelevance ?? 0.15,
    now: input.now,
  });
  if (hits.length === 0) return undefined;

  const budget = { max: input.budgetChars ?? 900, used: 0 };
  const lines = [];
  for (const hit of hits) {
    const line = bullet(hit, { maxChars: 120, withLevel: true });
    if (budget.used + line.length > budget.max) break;
    budget.used += line.length + 1;
    lines.push(line);
  }
  if (lines.length === 0) return undefined;
  const ids = hits.slice(0, lines.length).map((hit) => hit.id);
  const text = [
    RECALL_MARKER,
    `### ${L.recallTitle}`,
    ...lines,
    lang === 'en'
      ? '_Context only — if it contradicts the user, follow the user._'
      : '_仅为上下文参考；若与用户当前要求冲突，以用户为准。_',
  ].join('\n');
  return { text, ids };
}

/**
 * Does this turn need a snapshot? Synchronous so the hot path does not await.
 *
 * @param {{decision: object, agent: object, firstServed: Set<string>, armedReinject: Set<string>}} input
 */
export function snapshotNeeded(input) {
  const { decision, agent, firstServed, armedReinject } = input;
  if (decision === undefined || decision.kind !== 'enter') return false;
  const header = agent?.session?.header;
  const sessionId = typeof header?.id === 'string' ? header.id : undefined;
  if (sessionId === undefined) return false;
  if (armedReinject.has(sessionId)) return true;
  return !firstServed.has(sessionId);
}

/** Count human messages already in the session (0 means this is the first turn). */
export function countPriorHumanMessages(agent) {
  const messages = agent?.session?.messages;
  if (!Array.isArray(messages)) return 0;
  let count = 0;
  for (const message of messages) {
    if (message?.source?.kind === 'user') count += 1;
  }
  return count;
}

export { LEVELS, LEVEL_HINTS };
