/**
 * Memory repository: the write pipeline and the read pipeline over one Store.
 *
 * The split matters. Writes go through {@link MemoryRepo.remember}, which
 * decides insert-vs-merge-vs-supersede and records why; reads go through
 * {@link MemoryRepo.recall}, which decides what a turn should see. Keeping them
 * apart means a retrieval bug cannot corrupt stored beliefs, and a dedup change
 * cannot alter ranking.
 */
import { LEVELS, GLOBAL_PROJECT, GLOBAL_PROJECT_ALIASES } from '../config.js';
import { contentHash, jaccard, rankEntries, tokenize } from '../ranking.js';
import { buildMatchExpression, likeTerms } from '../fts.js';

/** Above this token-set overlap an incoming memory is treated as a duplicate. */
export const DEDUPE_THRESHOLD = 0.72;

/**
 * Normalise a project name.
 *
 * `''` means "applies everywhere" and is stored as {@link GLOBAL_PROJECT} so a
 * recall scoped to a project still sees it via the `project = '' OR project = ?`
 * clause — one canonical spelling instead of three aliases in the data.
 * @param {string|undefined} value
 */
export function normalizeProject(value) {
  if (typeof value !== 'string') return GLOBAL_PROJECT;
  const trimmed = value.trim();
  if (trimmed === '') return GLOBAL_PROJECT;
  if (GLOBAL_PROJECT_ALIASES.has(trimmed.toLowerCase()) || GLOBAL_PROJECT_ALIASES.has(trimmed)) {
    return GLOBAL_PROJECT;
  }
  return trimmed;
}

/** Keywords are stored space-separated: one column, `LIKE` and FTS both usable. */
export function normalizeKeywords(value) {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,，\s]+/)
      : [];
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

function keywordsToArray(value) {
  return typeof value === 'string' && value !== '' ? value.split(' ') : [];
}

export class MemoryRepo {
  /**
   * @param {import('./db.js').Store} store
   * @param {{logger?: object}} [deps]
   */
  constructor(store, deps = {}) {
    this.store = store;
    this.logger = deps.logger;
    /** Warnings accumulated during the last write, drained by the tool layer. */
    this.warnings = [];
  }

  /** Drain accumulated warnings (they are surfaced to the calling tool). */
  takeWarnings() {
    const out = this.warnings;
    this.warnings = [];
    return out;
  }

  #warn(message) {
    this.warnings.push(message);
    try {
      this.logger?.warn?.(`dsh-memory: ${message}`);
    } catch {
      // logging is best-effort
    }
  }

  /**
   * Write one memory, merging or superseding as needed.
   *
   * @param {{level: string, content: string, keywords?: string[]|string, importance?: number,
   *   confidence?: number, project?: string, subcategory?: string, goal?: string}} input
   * @param {{session?: string, kind?: string, at?: number}} source
   * @returns {{id: string, action: 'insert'|'merge'|'supersede', mergedInto?: string}}
   */
  remember(input, source = {}) {
    const level = String(input.level ?? '');
    if (!LEVELS.includes(level)) {
      throw new Error(`未知记忆层级 ${JSON.stringify(level)}（允许：${LEVELS.join(' / ')}）`);
    }
    const content = String(input.content ?? '').trim();
    if (content === '') throw new Error('content 不能为空');
    const project = normalizeProject(input.project);
    const keywords = normalizeKeywords(input.keywords ?? input.keywordList);
    const importance = clampInt(input.importance ?? 2, 1, 4);
    const confidence = clampNumber(input.confidence ?? 1, 0, 1);
    const hash = contentHash(content);

    const duplicates = this.store.findDuplicates({ hash, level, project });

    // 1) Same text, same level/project: bump instead of storing a second copy.
    //    Repeated statements are evidence, and evidence should raise importance.
    if (duplicates.exact !== undefined) {
      const existing = duplicates.exact;
      const nextImportance = Math.max(existing.importance, importance);
      this.store.update(existing.id, {
        importance: nextImportance,
        confidence: Math.max(existing.confidence, confidence),
        keywords: keywords === '' ? existing.keywords : mergeKeywordStrings(existing.keywords, keywords),
      });
      this.store.audit('reinforce', 'identical content restated', { id: existing.id, level }, source.session);
      return { id: existing.id, action: 'merge', mergedInto: existing.id };
    }

    // 2) Near-duplicate (same level + project, high token overlap): keep one row
    //    and rewrite it, recording that it superseded itself. This is what stops
    //    a store from filling with twelve paraphrases of the same rule.
    const incomingTokens = new Set(tokenize(`${content} ${keywords}`));
    let best;
    let bestScore = 0;
    for (const candidate of duplicates.candidates) {
      const tokens = new Set(tokenize(`${candidate.content} ${candidate.keywords}`));
      const score = jaccard(incomingTokens, tokens);
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    if (best !== undefined && bestScore >= DEDUPE_THRESHOLD) {
      this.store.update(best.id, {
        content,
        keywords: keywords === '' ? best.keywords : keywords,
        importance: Math.max(best.importance, importance),
        confidence,
        content_hash: hash,
      });
      this.store.audit('merge', `near-duplicate (jaccard ${bestScore.toFixed(2)}) rewritten in place`, { id: best.id, level }, source.session);
      return { id: best.id, action: 'merge', mergedInto: best.id };
    }

    // 3) A new memory that contradicts an old one at the same level: retire the
    //    old row (status stays in the table) and point the new row at it.
    const contradicted = findContradiction(duplicates.candidates, incomingTokens);
    const id = this.store.insert({
      level,
      content,
      keywords,
      importance,
      confidence,
      project,
      subcategory: String(input.subcategory ?? ''),
      goal: String(input.goal ?? ''),
      status: 'active',
      content_hash: hash,
      supersedes_id: contradicted?.id,
    });
    if (contradicted !== undefined) {
      this.store.update(contradicted.id, { status: 'superseded' });
      this.store.audit(
        'supersede',
        `superseded by ${id} (jaccard ${bestScore.toFixed(2)})`,
        { id: contradicted.id, level, newId: id },
        source.session,
      );
      return { id, action: 'supersede', mergedInto: undefined };
    }
    this.store.audit('insert', `${level}: ${content.slice(0, 60)}`, { id, level }, source.session);
    return { id, action: 'insert' };
  }

  /** Archive one row (the only form of removal this plugin performs). */
  archive(id, reason, source = {}) {
    const row = this.store.get(id);
    if (row === undefined) throw new Error(`记忆 ${id} 不存在`);
    this.store.archive(id, reason);
    this.store.audit('archive', reason ?? '', { id, level: row.level }, source.session);
    return row;
  }

  /**
   * Rank memories for an injecting turn.
   *
   * FTS and LIKE are unioned before ranking rather than ranked separately: FTS
   * catches long Chinese phrases and Latin words, LIKE catches the two-character
   * Chinese words a trigram index cannot see, and one BM25 pass over the union
   * keeps the ordering consistent between them.
   *
   * @param {{query: string, project?: string, topK?: number, excludeIds?: Set<string>,
   *   minRelevance?: number, now?: number}} input
   */
  recall(input) {
    const project = normalizeProject(input.project);
    const excludeIds = input.excludeIds ?? new Set();
    const matchExpression = buildMatchExpression(input.query ?? '');
    const ftsRows = matchExpression === undefined ? [] : this.store.searchFts(matchExpression, { project, limit: 80 });
    const likeRows = this.store.searchLike(likeTerms(input.query ?? ''), { project, limit: 80 });

    const byId = new Map();
    for (const row of [...ftsRows, ...likeRows]) if (!byId.has(row.id)) byId.set(row.id, row);
    if (byId.size === 0) return [];

    const ranked = rankEntries(input.query ?? '', [...byId.values()], {
      topK: input.topK,
      now: input.now,
      excludeIds,
      minRelevance: input.minRelevance,
    });
    return ranked.map((row) => ({ ...row.entry, score: row.score, relevance: row.relevance }));
  }

  /**
   * The candidate pool for a first-turn snapshot: everything active, ranked with
   * an empty query (importance × recency), which is what a "you should know
   * this" block wants.
   * @param {{project?: string, topK?: number, now?: number}} input
   */
  snapshotPool(input = {}) {
    const project = normalizeProject(input.project);
    const rows = this.store.list({ project });
    return rankEntries('', rows, { topK: input.topK, now: input.now });
  }

  /** Active rows grouped by level, used to build the snapshot's fixed sections. */
  byLevel(project) {
    const rows = this.store.list({ project: normalizeProject(project) });
    const grouped = new Map();
    for (const row of rows) {
      const bucket = grouped.get(row.level) ?? [];
      bucket.push(row);
      grouped.set(row.level, bucket);
    }
    return grouped;
  }

  /** Counts for the status command. */
  stats() {
    return {
      file: this.store.file,
      workspace: this.store.workspace,
      dataDir: this.store.dataDir,
      total: this.store.total(),
      byLevel: this.store.counts(),
    };
  }
}

function clampInt(value, min, max) {
  const n = Number.isFinite(value) ? Math.trunc(value) : min;
  return Math.min(max, Math.max(min, n));
}

function clampNumber(value, min, max) {
  const n = Number.isFinite(value) ? value : min;
  return Math.min(max, Math.max(min, n));
}

function mergeKeywordStrings(a, b) {
  const set = new Set([...keywordsToArray(a), ...keywordsToArray(b)]);
  return [...set].slice(0, 16).join(' ');
}

/**
 * Heuristic contradiction detection.
 *
 * Deliberately conservative: only a same-level, same-project pair with very
 * high overlap AND a differing negation/quantifier shape counts. A false
 * positive here silently retires a correct memory, which is worse than keeping
 * two rows the user can see and merge by hand.
 */
function findContradiction(candidates, incomingTokens) {
  const NEGATIONS = ['不要', '不能', '禁止', '避免', 'never', 'dont', 'avoid'];
  const hasNegation = (text) => NEGATIONS.some((word) => text.includes(word));
  for (const candidate of candidates) {
    const tokens = new Set(tokenize(`${candidate.content} ${candidate.keywords}`));
    const score = jaccard(incomingTokens, tokens);
    if (score < 0.6) continue;
    if (hasNegation(candidate.content) !== hasNegation([...incomingTokens].join(''))) return candidate;
  }
  return undefined;
}

export { keywordsToArray };
