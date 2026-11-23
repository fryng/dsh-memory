/**
 * The writeback channel: the reason a memory store is ever non-empty.
 *
 * Measured motivation (this is not a hunch): across three memory plugins in this
 * environment, the ones that relied on "the agent will call memory_remember when
 * it matters" produced 5 rows in weeks, while every unattended reflection/dream
 * loop produced zero rows while still reporting success. An explicit tool plus a
 * silent background writer is the only shape that fills a store, so this file
 * implements the writer half deterministically:
 *
 *   user message → cheap gate (trigger words / every-N-turns / cooldown)
 *                → one independent extraction call
 *                → validated JSON → the same `remember()` pipeline tools use
 *
 * Three design constraints:
 *
 *  1. **The gate is deterministic, the extraction is not.** Whether to spend a
 *     model call is decided by string matching and counters, so cost is bounded
 *     and auditable. What to extract is the model's job.
 *  2. **User messages only.** Extracting from assistant text is how a memory
 *     store starts remembering its own hallucinations as facts.
 *  3. **Silent failures are forbidden.** Every run writes an audit row, including
 *     `writeback-empty`, so "it ran and found nothing" and "it never ran" can be
 *     told apart — the exact confusion that made the previous plugin look healthy
 *     while doing nothing.
 */
import { LEVELS, PROJECT_SUBCATEGORY_SET } from './store/constants.js';
import { resolveSlotText } from './prompts.js';
import { generateText, DelegateError } from './llm.js';

/**
 * Signals that a user message very likely contains something durable.
 *
 * Kept as plain substrings, not a regex, so it is obvious what matches and cheap
 * to extend. Chinese has no word boundaries, so substring matching is both the
 * simplest and the most reliable option here.
 */
export const TRIGGER_WORDS = [
  '记住', '记得', '以后', '今后', '从现在起', '不要再', '别再', '不要用', '必须',
  '我喜欢', '我不喜欢', '我偏好', '我习惯', '我通常', '我的习惯', '我要求',
  '纠正', '更正', '搞错', '弄错', '说错', '不是这样', '应该是',
  '请务必', 'always use', 'never use', 'remember', 'from now on',
  'i prefer', 'i always', 'i never', 'do not use', "don't use",
];
// '注意' was dropped: now that trigger words are matched before the length
// floor, a bare 注意 / pay attention would fire an extraction on almost any
// short reply. Explicit instruction words only.

/**
 * Decide whether this user message is worth an extraction call.
 *
 * @param {object} input
 * @param {{mode: string, everyNUserTurns: number, minChars: number, cooldownSeconds: number}} input.cfg
 * @param {string} input.text the user message
 * @param {number} input.turnsSince how many human messages since the last extraction (0 = never)
 * @param {number|undefined} input.lastRunAt epoch ms of this session's last extraction
 * @param {number} [input.now]
 * @returns {{run: boolean, reason: string}}
 */
export function shouldExtract(input) {
  const { cfg, text } = input;
  const now = input.now ?? Date.now();
  if (cfg.mode === 'off') return { run: false, reason: 'writeback.mode=off' };
  const value = String(text ?? '').trim();
  if (value === '') return { run: false, reason: 'too-short' };

  const cooldownMs = Math.max(0, (cfg.cooldownSeconds ?? 30) * 1000);
  if (cooldownMs > 0 && Number.isFinite(input.lastRunAt) && now - input.lastRunAt < cooldownMs) {
    return { run: false, reason: 'cooldown' };
  }

  if (cfg.mode === 'always') return { run: true, reason: 'mode=always' };

  // Trigger words are checked BEFORE the length floor on purpose. "记住" alone is
  // two characters and would otherwise be rejected as too short — the shortest,
  // most explicit instruction to remember something was the one message the
  // gate silently dropped.
  const lowered = value.toLowerCase();
  const hit = TRIGGER_WORDS.find((word) => lowered.includes(word.toLowerCase()));
  if (hit !== undefined) return { run: true, reason: `trigger:${hit}` };

  // The interval fallback keeps the length floor: it fires on an ordinary turn
  // whose text has to carry enough substance on its own.
  if (value.length < (cfg.minChars ?? 8)) return { run: false, reason: 'too-short' };

  // "Due" rather than "on the Nth turn". A modulo test silently spends the slot
  // on whichever message happens to land there — measured: a 6-character reply
  // took turn 4 and the interval slipped to turn 8. Debting instead means a short
  // turn is skipped but the obligation survives to the next substantive one.
  const every = cfg.everyNUserTurns ?? 4;
  const turnsSince = Number.isFinite(input.turnsSince) ? Number(input.turnsSince) : 0;
  if (every > 0 && turnsSince >= every) {
    return { run: true, reason: `interval:${every}` };
  }
  return { run: false, reason: 'no-signal' };
}

/**
 * Pull the JSON object out of a model reply.
 *
 * Models wrap JSON in fences, add a sentence of preamble, or emit trailing
 * commas. Trying progressively more forgiving extractions beats failing the
 * whole run because of a ```json fence.
 * @param {string} text
 * @returns {object|undefined}
 */
export function parseJsonLoose(text) {
  if (typeof text !== 'string' || text.trim() === '') return undefined;
  const candidates = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced !== null) candidates.push(fenced[1]);
  candidates.push(text);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (trimmed === '') continue;
    for (const attempt of [trimmed, trimmed.replace(/,\s*([}\]])/g, '$1')]) {
      try {
        const parsed = JSON.parse(attempt);
        if (parsed !== null && typeof parsed === 'object') return parsed;
      } catch {
        // try the next recovery strategy
      }
    }
  }
  return undefined;
}

/**
 * Validate and normalise one extracted fact.
 *
 * An entry missing `content` is dropped rather than repaired: a memory with no
 * statement is not a memory, and guessing one is how a store fills with
 * plausible nonsense.
 *
 * @param {unknown} raw
 * @param {{project: string}} context
 * @returns {{level: string, content: string, keywords: string[], importance: number,
 *   subcategory: string|undefined}|undefined}
 */
export function normalizeFact(raw, context) {
  if (raw === null || typeof raw !== 'object') return undefined;
  const content = typeof raw.content === 'string' ? raw.content.trim() : '';
  if (content === '') return undefined;
  if (content.length > 400) return undefined;
  const level = LEVELS.includes(raw.level) ? raw.level : 'fact';
  const keywords = Array.isArray(raw.keywords)
    ? raw.keywords.map((k) => String(k).trim()).filter((k) => k !== '')
    : typeof raw.keywords === 'string'
      ? raw.keywords.split(/[,，\s]+/).filter((k) => k !== '')
      : [];
  const importance = Number.isInteger(raw.importance) && raw.importance >= 1 && raw.importance <= 4
    ? raw.importance
    : 2;
  const subcategory = level === 'project' && typeof raw.subcategory === 'string' && PROJECT_SUBCATEGORY_SET.has(raw.subcategory.trim())
    ? raw.subcategory.trim()
    : undefined;
  const project = typeof raw.project === 'string' && raw.project.trim() !== ''
    ? raw.project.trim()
    : context.project;
  return { level, content, keywords, importance, subcategory, project };
}

/**
 * Run one extraction over a user message and store what comes back.
 *
 * @param {object} input
 * @param {object} input.ctx cordis context (for `llm`)
 * @param {import('./store/memory-repo.js').MemoryRepo} input.repo
 * @param {object} input.cfg resolved plugin config
 * @param {string} input.sessionId
 * @param {string} input.query the user message
 * @param {string} input.project current project name
 * @param {{provider?: string, model?: string}|undefined} input.inheritedRoute
 * @param {AbortSignal} [input.signal]
 * @param {object} [input.logger]
 * @returns {Promise<{status: 'ok'|'empty'|'error', stored: number, reason: string}>}
 */
export async function runWriteback(input) {
  const { ctx, repo, cfg, sessionId, project, logger } = input;
  const lang = cfg.promptLang === 'en' ? 'en' : 'zh';
  const route = resolveWritebackRoute(cfg, input.inheritedRoute);

  let result;
  try {
    result = await generateText({
      ctx,
      route,
      system: resolveSlotText('extraction-system', lang),
      prompt: lang === 'en'
        ? `USER MESSAGE:\n"""\n${input.query}\n"""`
        : `【用户消息】\n"""\n${input.query}\n"""`,
      signal: input.signal,
      purpose: 'dsh-memory/writeback',
    });
  } catch (error) {
    const message = error instanceof DelegateError ? error.message : String(error);
    repo.store.audit('writeback-error', message, { project }, sessionId);
    return { status: 'error', stored: 0, reason: message };
  }

  const parsed = parseJsonLoose(result.text);
  const rawFacts = Array.isArray(parsed?.facts) ? parsed.facts : [];
  const facts = rawFacts
    .map((raw) => normalizeFact(raw, { project }))
    .filter((fact) => fact !== undefined)
    .slice(0, cfg.writeback.maxPerTurn ?? 3);

  if (facts.length === 0) {
    // The audit row is the point: without it a gate that fires and stores nothing
    // is indistinguishable from a gate that never fired.
    repo.store.audit('writeback-empty', 'extraction returned no storable fact', { project, chars: result.text.length }, sessionId);
    return { status: 'empty', stored: 0, reason: 'no-fact' };
  }

  let stored = 0;
  for (const fact of facts) {
    try {
      repo.remember(
        {
          level: fact.level,
          content: fact.content,
          keywords: fact.keywords,
          importance: fact.importance,
          project: fact.project,
          subcategory: fact.subcategory,
        },
        { session: sessionId, kind: 'writeback' },
      );
      stored += 1;
    } catch (error) {
      try {
        logger?.warn?.(`dsh-memory: 写入抽取结果失败：${error instanceof Error ? error.message : String(error)}`);
      } catch {
        // logging must not break the batch
      }
    }
  }
  repo.store.audit('writeback', `stored ${stored}/${facts.length}`, { project, stored }, sessionId);
  return { status: stored > 0 ? 'ok' : 'empty', stored, reason: stored > 0 ? 'stored' : 'all-failed' };
}

/**
 * Route for the extraction call: `writeback.model` when set, otherwise the live
 * agent's model (always present here — the channel runs inside a turn).
 */
export function resolveWritebackRoute(cfg, inherited) {
  const explicit = parseModelSpec(cfg?.writeback?.model ?? '');
  const out = {};
  if (explicit.provider !== undefined) out.provider = explicit.provider;
  else if (inherited?.provider !== undefined) out.provider = inherited.provider;
  if (explicit.model !== undefined) out.model = explicit.model;
  else if (inherited?.model !== undefined) out.model = inherited.model;
  return out;
}

/** `provider/model`; empty means inherit. */
function parseModelSpec(spec) {
  if (typeof spec !== 'string' || spec.trim() === '') return {};
  const idx = spec.indexOf('/');
  if (idx === -1) return { model: spec.trim() };
  const provider = spec.slice(0, idx).trim();
  const model = spec.slice(idx + 1).trim();
  return {
    ...(provider === '' ? {} : { provider }),
    ...(model === '' ? {} : { model }),
  };
}
