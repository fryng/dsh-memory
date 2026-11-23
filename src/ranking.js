/**
 * Ranking: BM25 over memory entries, multiplied by a forgetting-curve retention
 * factor and an importance weight, plus a small reinforcement term for entries
 * that have already proven useful.
 *
 * Pure functions, no I/O: retrieval behaviour is testable in isolation, and the
 * injected text is a deterministic function of the rows — which is what makes
 * "why did this get recalled" answerable after the fact.
 */

/** CJK ideographs, kana and Hangul are matched as character bigrams. */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const LATIN = /[a-z0-9_]+/g;

const LATIN_STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'is', 'are', 'was', 'be', 'for', 'with',
  'this', 'that', 'it', 'as', 'at', 'by', 'from', 'we', 'you', 'i', 'de', 'la', 'le', 'do', 'if',
]);

/**
 * Chinese function characters. Dropping them before bigramming matters for
 * recall quality: otherwise `的实` / `是的` become high-frequency "terms" that
 * match almost every sentence.
 */
const CJK_STOP = new Set([
  '的', '了', '是', '在', '和', '我', '你', '他', '她', '它', '这', '那', '有', '就', '都',
  '也', '还', '把', '被', '给', '对', '与', '或', '而', '但', '很', '要', '会', '能', '个',
  '吗', '呢', '吧', '啊', '呀', '哦', '嗯', '着', '过', '得', '地', '上', '下', '中', '里',
]);

/**
 * Tokenize mixed Chinese/English text: Latin words (lowercased) plus CJK
 * character bigrams. A single isolated CJK character becomes its own token so a
 * one-character query still has something to match.
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  if (typeof text !== 'string' || text === '') return [];
  const lower = text.toLowerCase();
  const tokens = [];
  for (const match of lower.matchAll(LATIN)) {
    const token = match[0];
    if (token.length >= 2 && !LATIN_STOP.has(token)) tokens.push(token);
    else if (token.length === 1 && /[0-9]/.test(token)) tokens.push(token);
  }
  const runs = [];
  let run = [];
  for (const ch of [...lower]) {
    if (CJK.test(ch)) {
      run.push(ch);
    } else if (run.length > 0) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length > 0) runs.push(run);
  for (const r of runs) {
    const kept = r.filter((ch) => !CJK_STOP.has(ch));
    if (kept.length === 0) continue;
    if (kept.length === 1) {
      tokens.push(kept[0]);
      continue;
    }
    for (let i = 0; i < kept.length - 1; i += 1) tokens.push(`${kept[i]}${kept[i + 1]}`);
  }
  return tokens;
}

/** Term-frequency map for one document. */
export function termFrequencies(tokens) {
  const tf = new Map();
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
  return tf;
}

/**
 * Ebbinghaus retention `R = exp(-Δt / S)` with stability stretched by
 * importance: `S = halfLife × (1 + 0.5 × (importance − 1))`.
 *
 * This is what keeps a month-old trivial observation from outranking a
 * week-old red line, without needing anyone to prune the table.
 *
 * @param {number} ageDays days since the entry was last touched
 * @param {number} importance 1..4
 * @param {number} halfLifeDays base stability in days
 */
export function ebbinghausWeight(ageDays, importance = 1, halfLifeDays = 4) {
  const age = Number.isFinite(ageDays) ? Math.max(0, ageDays) : 0;
  const imp = Number.isFinite(importance) ? Math.max(1, importance) : 1;
  const stability = halfLifeDays * (1 + 0.5 * (imp - 1));
  return Math.exp(-age / stability);
}

/** Normalised importance weight in (0, 1]: 1 → 0.5, 4 → 1.0. */
export function importanceWeight(importance) {
  const imp = Number.isFinite(importance) ? Math.min(4, Math.max(1, importance)) : 1;
  return 0.5 + 0.5 * ((imp - 1) / 3);
}

/**
 * Reinforcement: an entry that has been recalled and kept around gets a small
 * bounded bonus. Deliberately capped at 0.10 — feedback should nudge the order,
 * not dominate it, or the top of the list freezes and nothing new ever surfaces.
 */
export function reinforcementWeight(useCount) {
  const n = Number.isFinite(useCount) ? Math.max(0, useCount) : 0;
  return Math.min(0.1, n * 0.01);
}

/**
 * BM25 score of one document against query tokens.
 * @param {string[]} queryTokens
 * @param {Map<string, number>} tf
 * @param {number} docLength
 * @param {number} avgDocLength
 * @param {(token: string) => number} idf
 * @param {{k1?: number, b?: number}} [params]
 */
export function bm25Score(queryTokens, tf, docLength, avgDocLength, idf, params = {}) {
  const k1 = params.k1 ?? 1.2;
  const b = params.b ?? 0.75;
  const norm = avgDocLength > 0 ? 1 - b + (b * docLength) / avgDocLength : 1;
  let score = 0;
  for (const token of new Set(queryTokens)) {
    const f = tf.get(token);
    if (f === undefined || f === 0) continue;
    score += idf(token) * ((f * (k1 + 1)) / (f + k1 * norm));
  }
  return score;
}

/** Inverse document frequency with the standard BM25 +1 smoothing. */
export function inverseDocumentFrequency(docCount, documentFrequency) {
  return Math.log(1 + (docCount - documentFrequency + 0.5) / (documentFrequency + 0.5));
}

/** Jaccard similarity of two token sets — used for dedup-merge decisions. */
export function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** Stable 32-bit FNV-1a, used for content hashing / duplicate detection. */
export function contentHash(text) {
  let hash = 0x811c9dc5;
  const value = String(text ?? '');
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Rank candidate entries for a query.
 *
 * @param {string} query raw query text; an empty query falls back to
 *   recency × importance, which is what a first-turn snapshot wants.
 * @param {Array<object>} entries rows with
 *   `{id, level, content, keywords, importance, project, use_count, updated_at, created_at, status}`
 * @param {{topK?: number, now?: number, excludeIds?: Set<string>, halfLifeDays?: number,
 *   statusFilter?: string[]|null, minRelevance?: number}} [options]
 *   `statusFilter` defaults to `['active']`: retired rows are never injected or
 *   recalled, they stay in the table for provenance only.
 * @returns {Array<{entry: object, score: number, relevance: number, retention: number, weight: number}>}
 */
export function rankEntries(query, entries, options = {}) {
  const now = options.now ?? Date.now();
  const excludeIds = options.excludeIds ?? new Set();
  const statuses = options.statusFilter === undefined ? ['active'] : options.statusFilter;
  const pool = (Array.isArray(entries) ? entries : []).filter(
    (entry) => entry !== null
      && typeof entry === 'object'
      && !excludeIds.has(entry.id)
      && (statuses === null || statuses.includes(entry.status ?? 'active')),
  );
  if (pool.length === 0) return [];

  const docs = pool.map((entry) => {
    const text = `${entry.content ?? ''} ${keywordsOf(entry)}`;
    const tokens = tokenize(text);
    return { entry, tokens, tf: termFrequencies(tokens), length: Math.max(1, tokens.length) };
  });
  const avgDocLength = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length;

  const queryTokens = tokenize(query);
  const documentFrequency = new Map();
  for (const token of new Set(queryTokens)) {
    let df = 0;
    for (const doc of docs) if (doc.tf.has(token)) df += 1;
    documentFrequency.set(token, df);
  }
  const idf = (token) => inverseDocumentFrequency(docs.length, documentFrequency.get(token) ?? 0);

  const scored = docs.map((doc) => {
    const bm25 = queryTokens.length === 0 ? 0 : bm25Score(queryTokens, doc.tf, doc.length, avgDocLength, idf);
    const importance = Number.isFinite(doc.entry.importance) ? doc.entry.importance : 2;
    const touched = Number(doc.entry.updated_at ?? doc.entry.created_at ?? now);
    const ageDays = Math.max(0, (now - touched) / 86_400_000);
    const retention = ebbinghausWeight(ageDays, importance, options.halfLifeDays ?? 4);
    const weight = importanceWeight(importance);
    const reinforcement = reinforcementWeight(doc.entry.use_count);
    // With no query there is nothing to be relevant to: rank by what the entry
    // is worth on its own (importance × recency), which is exactly the
    // first-turn-snapshot ordering.
    const score = queryTokens.length === 0
      ? weight * retention + reinforcement
      : bm25 * retention * weight + reinforcement;
    return { entry: doc.entry, score, retention, weight };
  });

  scored.sort((a, b) => b.score - a.score || String(a.entry.id).localeCompare(String(b.entry.id)));
  const top = scored.filter((row) => row.score > 0);
  const best = top.length === 0 ? 1 : top[0].score;
  const withRelevance = top.map((row) => ({ ...row, relevance: best === 0 ? 0 : row.score / best }));
  const floor = options.minRelevance ?? 0;
  const kept = floor > 0 ? withRelevance.filter((row) => row.relevance >= floor) : withRelevance;
  return options.topK === undefined ? kept : kept.slice(0, options.topK);
}

function keywordsOf(entry) {
  const value = entry?.keywords;
  if (Array.isArray(value)) return value.join(' ');
  return typeof value === 'string' ? value : '';
}
