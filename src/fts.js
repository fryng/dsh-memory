/**
 * FTS5 query building for Chinese text.
 *
 * Three hard facts drove this file, all measured against node:sqlite (SQLite
 * 3.51.2) rather than assumed:
 *
 *  1. `tokenize='unicode61'` finds nothing in Chinese — `MATCH '记忆库'` returns
 *     zero rows on a table that visibly contains that word. `trigram` on the
 *     same data returns the row. So the index is trigram.
 *  2. A trigram index cannot match a 2-character query (`"记忆"` → 0 rows,
 *     `"记忆库"` → 1 row). Chinese speech is full of two-character words, so a
 *     pure-FTS design silently loses the most common query shape. The LIKE
 *     fallback below is not defensive padding; it is required for the index to
 *     be usable at all.
 *  3. Raw MATCH text containing a `.` (`memory.db`) is a syntax error under
 *     unicode61 and returns nothing under trigram. Every term is therefore
 *     quoted as an FTS5 phrase with `"` doubled.
 */
import { tokenize } from './ranking.js';

/** Below this length trigram cannot match, so the caller must use LIKE. */
export const TRIGRAM_MIN_CHARS = 3;

/**
 * Escape one term as an FTS5 phrase.
 * @param {string} term
 * @returns {string}
 */
export function quoteTerm(term) {
  return `"${String(term).replace(/"/g, '""')}"`;
}

/**
 * Split a raw query into FTS-usable terms.
 *
 * Chinese is segmented into overlapping trigrams (the index's own unit), Latin
 * into whole words. Terms shorter than {@link TRIGRAM_MIN_CHARS} characters are
 * dropped here — they are handled by the LIKE pass instead.
 *
 * @param {string} query
 * @returns {string[]}
 */
export function ftsTerms(query) {
  if (typeof query !== 'string' || query.trim() === '') return [];
  const terms = new Set();
  // Latin / numeric tokens of 3+ characters. A dotted token (`memory.db`) is kept
  // whole AND split, so both an exact file name and its parts can match: the
  // trigram index contains `.db` as a real trigram, so the whole phrase is a
  // legitimate FTS5 phrase.
  for (const match of query.toLowerCase().matchAll(/[a-z0-9][a-z0-9_.\-/]*/g)) {
    const token = match[0].replace(/[._\-/]+$/, '');
    if (token.length >= TRIGRAM_MIN_CHARS) terms.add(token);
    for (const part of token.split(/[._\-/]+/)) {
      if (part.length >= TRIGRAM_MIN_CHARS) terms.add(part);
    }
  }
  // CJK runs → overlapping trigrams.
  for (const run of cjkRuns(query)) {
    if (run.length < TRIGRAM_MIN_CHARS) continue;
    for (let i = 0; i + TRIGRAM_MIN_CHARS <= run.length; i += 1) {
      terms.add(run.slice(i, i + TRIGRAM_MIN_CHARS));
    }
    // A long run also contributes its opening 3 + closing 3 so a query like
    // 「记忆库是怎么存的」 still matches on its rarest edges.
    if (run.length > 6) {
      terms.add(run.slice(0, 3));
      terms.add(run.slice(-3));
    }
  }
  return [...terms];
}

/** Raw CJK runs (no stop characters removed — trigrams must align with the index). */
function cjkRuns(text) {
  const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
  const runs = [];
  let run = '';
  for (const ch of String(text)) {
    if (CJK.test(ch)) {
      run += ch;
    } else if (run !== '') {
      runs.push(run);
      run = '';
    }
  }
  if (run !== '') runs.push(run);
  return runs;
}

/**
 * Build the MATCH expression: every term quoted, joined with OR.
 *
 * OR (not AND) on purpose — a four-term query that requires all four matches
 * nothing, while OR plus BM25 ranking surfaces the best partial match, which is
 * what a recall hint needs.
 *
 * @param {string} query
 * @returns {string|undefined} undefined when nothing is FTS-matchable
 */
export function buildMatchExpression(query) {
  const terms = ftsTerms(query);
  if (terms.length === 0) return undefined;
  return terms.map(quoteTerm).join(' OR ');
}

/**
 * Terms the LIKE fallback should try: the query's own tokens, including short
 * ones the trigram index cannot serve.
 *
 * Raw CJK runs are included whole, without the stop-character filter that
 * {@link tokenize} applies. That filter is right for ranking (a bigram like `的实`
 * matches almost every sentence) but wrong for an escape hatch: 「中文」 tokenizes
 * to a single leftover character and would yield no term at all, so the two-char
 * query this fallback exists for would still return nothing.
 *
 * @param {string} query
 * @returns {string[]}
 */
export function likeTerms(query) {
  if (typeof query !== 'string' || query.trim() === '') return [];
  const out = new Set();
  for (const run of cjkRuns(query)) {
    if (run.length >= 2) out.add(run);
  }
  for (const token of tokenize(query)) {
    if (token.length >= 2) out.add(token);
  }
  // Whole Latin words, so `pnpm-lock` still probes `pnpm`.
  for (const match of query.toLowerCase().matchAll(/[a-z0-9_]{2,}/g)) out.add(match[0]);
  return [...out].slice(0, 12);
}
