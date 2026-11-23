/**
 * Configuration: defaults, layering, and STRICT validation.
 *
 * Rule (non-negotiable): an illegal value errors loudly. The plugin never
 * "helpfully" substitutes a different value for one an operator wrote — a
 * silent fallback is how a memory system ends up writing into the wrong
 * directory for months without anyone noticing.
 *
 * `Config`'s schema hook deliberately validates NOTHING: cordis calls it before
 * `apply()`, and throwing there fails the whole plugin tree (the web server
 * refuses to start) instead of reporting one bad key. {@link resolveConfig} is
 * the single validation point, and it has a logger.
 */

/**
 * Memory levels.
 *
 * Kept small on purpose. A seven-layer taxonomy mostly produces arguments about
 * which layer a sentence belongs in; these six each answer a different question
 * at recall time, which is what the injected text has to do.
 *
 * Defined in `store/constants.js` so the storage layer can import it without
 * pulling in the validators below.
 */
export { LEVELS, PROJECT_SUBCATEGORIES } from './store/constants.js';
import { LEVELS } from './store/constants.js';

/** Human-facing meaning of each level, used by the tool description and the prompt. */
export const LEVEL_HINTS = Object.freeze({
  fact: '客观事实（路径、版本、环境、外部约束）',
  preference: '用户偏好（语言、风格、工具选择、回复习惯）',
  rule: '必须遵守的准则 / 红线（含被明确纠正过的做法）',
  decision: '选型与取舍，含「为什么选 X 不选 Y」',
  lesson: '踩过的坑与纠正（这次错在哪、下次怎么避免）',
  project: '项目自身的结构与进展（架构、入口、待办）',
});

/**
 * Writeback modes.
 *
 * `trigger` exists because the alternative — relying on the agent to call
 * `memory_remember` spontaneously — produces a database that stays empty. An
 * independent extraction call, gated by deterministic signals, is the only
 * channel observed to fill a store without human nagging.
 */
export const WRITEBACK_MODES = ['off', 'trigger', 'always'];

export const CONFIG_DEFAULTS = Object.freeze({
  enabled: true,
  /**
   * Per-workspace data directory (relative to the workspace root).
   *
   * One database per workspace is the entire point of this plugin: memories of
   * two unrelated projects must never compete for the same recall budget, and
   * removing a workspace must remove its memory with it.
   */
  dataDir: '.dsh-memory',
  promptLang: 'zh',
  systemGuide: true,
  /** Namespace for tool/command names; empty means the documented names. */
  toolPrefix: '',
  /** Per-message recall width. */
  hitTopK: 3,
  /** Below this the recall block is skipped entirely (unrelated chatter gets nothing). */
  recallMinRelevance: 0.15,
  snapshotBudgetChars: 2400,
  recallBudgetChars: 900,
  /**
   * Expose the management UI: the Host routes the settings page talks to.
   *
   * On by default because without it the browser half shows an empty page with
   * no explanation. Turning it off removes only the routes; memory itself keeps
   * working through the tools and the injection channels.
   */
  manageUI: true,
  writeback: {
    mode: 'trigger',
    /**
     * Interval fallback: every Nth user message gets one extraction call.
     *
     * Measured on real conversations, the trigger words alone almost never fire
     * — people state what they want instead of saying 记住 / 以后. Ten was high
     * enough that a whole dense session produced zero entries; four keeps an
     * occupied session filling slowly without turning chatter into noise.
     */
    everyNUserTurns: 4,
    model: '',
    minChars: 8,
    maxPerTurn: 3,
    cooldownSeconds: 30,
  },
});

export const SUPPORTED_LANGS = ['zh', 'en'];

/** The canonical "applies everywhere" project name, and the spellings people type. */
export const GLOBAL_PROJECT = '全局';
export const GLOBAL_PROJECT_ALIASES = new Set(['全局', 'global', '__global__', '*']);

/** Argument schema of the Config type (documentation only — see the header). */
export const ConfigSchema = Object.freeze({
  type: 'object',
  properties: {
    enabled: { type: 'boolean', default: CONFIG_DEFAULTS.enabled, description: '总开关' },
    dataDir: { type: 'string', default: CONFIG_DEFAULTS.dataDir, description: '工作区内的数据目录（相对路径）' },
    promptLang: { type: 'string', enum: SUPPORTED_LANGS, default: CONFIG_DEFAULTS.promptLang },
    systemGuide: { type: 'boolean', default: CONFIG_DEFAULTS.systemGuide },
    toolPrefix: { type: 'string', default: CONFIG_DEFAULTS.toolPrefix },
    hitTopK: { type: 'integer', default: CONFIG_DEFAULTS.hitTopK },
    recallMinRelevance: { type: 'number', default: CONFIG_DEFAULTS.recallMinRelevance },
    snapshotBudgetChars: { type: 'integer', default: CONFIG_DEFAULTS.snapshotBudgetChars },
    recallBudgetChars: { type: 'integer', default: CONFIG_DEFAULTS.recallBudgetChars },
    manageUI: { type: 'boolean', default: CONFIG_DEFAULTS.manageUI, description: '启用设置页记忆管理器（Host 路由）' },
    writeback: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: WRITEBACK_MODES },
        everyNUserTurns: { type: 'integer' },
        model: { type: 'string' },
        minChars: { type: 'integer' },
        maxPerTurn: { type: 'integer' },
        cooldownSeconds: { type: 'integer' },
      },
    },
  },
});

/** Standard-Schema wrapper: accepts the layer verbatim (validation lives below). */
export const Config = Object.freeze({
  '~standard': {
    version: 1,
    vendor: 'dsh-memory',
    validate: (value) => ({ value }),
  },
});

const KNOWN_TOP_KEYS = new Set([
  'enabled',
  'dataDir',
  'promptLang',
  'systemGuide',
  'toolPrefix',
  'hitTopK',
  'recallMinRelevance',
  'snapshotBudgetChars',
  'recallBudgetChars',
  'manageUI',
  'writeback',
]);
const KNOWN_WRITEBACK_KEYS = new Set([
  'mode',
  'everyNUserTurns',
  'model',
  'minChars',
  'maxPerTurn',
  'cooldownSeconds',
]);

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function fail(path, detail) {
  throw new ConfigError(`dsh-memory: 配置项 ${path} 非法 —— ${detail}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Deep merge `override` over `base`; arrays are replaced wholesale. */
export function mergeConfigLayer(base, override) {
  if (!isPlainObject(override)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const prev = out[key];
    out[key] = isPlainObject(prev) && isPlainObject(value) ? mergeConfigLayer(prev, value) : value;
  }
  return out;
}

function collectUnknownKeys(object, known, path, warnings) {
  if (!isPlainObject(object)) return;
  for (const key of Object.keys(object)) {
    if (!known.has(key)) warnings.push(`未知配置键 ${path}.${key}（已忽略，请检查拼写）`);
  }
}

function requireBoolean(value, path) {
  if (typeof value !== 'boolean') fail(path, `期望布尔值，实际是 ${JSON.stringify(value)}`);
  return value;
}

function requireInteger(value, path, { min, max }) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    fail(path, `期望整数，实际是 ${JSON.stringify(value)}`);
  }
  if (min !== undefined && value < min) fail(path, `必须 ≥ ${min}，实际是 ${value}`);
  if (max !== undefined && value > max) fail(path, `必须 ≤ ${max}，实际是 ${value}`);
  return value;
}

function requireNumber(value, path, { min, max }) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, `期望数字，实际是 ${JSON.stringify(value)}`);
  if (min !== undefined && value < min) fail(path, `必须 ≥ ${min}，实际是 ${value}`);
  if (max !== undefined && value > max) fail(path, `必须 ≤ ${max}，实际是 ${value}`);
  return value;
}

/**
 * A tool prefix is either empty or a safe identifier fragment that already ends
 * in `_`, so `prefix + 'memory_search'` is always well-formed.
 */
const TOOL_PREFIX_PATTERN = /^[a-z][a-z0-9_]*_$/;

function requireToolPrefix(value, path) {
  if (typeof value !== 'string') fail(path, `期望字符串，实际是 ${JSON.stringify(value)}`);
  if (value === '') return '';
  if (!TOOL_PREFIX_PATTERN.test(value)) {
    fail(path, `须为空字符串或以 "_" 结尾的小写标识符（如 "mem_"），实际是 ${JSON.stringify(value)}`);
  }
  return value;
}

function requireEnum(value, path, allowed) {
  if (!allowed.includes(value)) {
    fail(path, `期望 ${allowed.map((v) => JSON.stringify(v)).join(' / ')}，实际是 ${JSON.stringify(value)}`);
  }
  return value;
}

/** A workspace-relative directory that cannot escape the workspace. */
function normalizeRelativeDir(value, path) {
  if (typeof value !== 'string' || value.trim() === '') fail(path, `期望相对目录名，实际是 ${JSON.stringify(value)}`);
  const trimmed = value.trim();
  if (/^([a-zA-Z]:[\\/]|[\\/])/.test(trimmed)) {
    fail(path, `必须是相对工作区的目录，实际是绝对路径 ${JSON.stringify(trimmed)}`);
  }
  const parts = trimmed.split(/[\\/]+/).filter((p) => p !== '' && p !== '.');
  if (parts.length === 0) fail(path, `目录名不能为空：${JSON.stringify(trimmed)}`);
  if (parts.includes('..')) fail(path, `不允许 \`..\` 片段（会逃出工作区）：${JSON.stringify(trimmed)}`);
  return parts.join('/');
}

/** `provider/model` spec; empty stays empty (= inherit). */
export function parseModelSpec(spec) {
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

/**
 * Resolve a raw config layer into the effective configuration.
 * @param {unknown} raw
 * @param {{base?: object, layerName?: string, warnings?: string[]}} [options]
 */
export function resolveConfig(raw, options = {}) {
  const warnings = options.warnings ?? [];
  const layerName = options.layerName ?? 'config';
  const merged = mergeConfigLayer(options.base ?? CONFIG_DEFAULTS, raw ?? {});
  if (isPlainObject(raw)) {
    collectUnknownKeys(raw, KNOWN_TOP_KEYS, layerName, warnings);
    collectUnknownKeys(raw.writeback, KNOWN_WRITEBACK_KEYS, `${layerName}.writeback`, warnings);
  }

  const cfg = {
    enabled: requireBoolean(merged.enabled, `${layerName}.enabled`),
    dataDir: normalizeRelativeDir(merged.dataDir, `${layerName}.dataDir`),
    promptLang: requireEnum(merged.promptLang, `${layerName}.promptLang`, SUPPORTED_LANGS),
    systemGuide: requireBoolean(merged.systemGuide, `${layerName}.systemGuide`),
    toolPrefix: requireToolPrefix(merged.toolPrefix, `${layerName}.toolPrefix`),
    hitTopK: requireInteger(merged.hitTopK, `${layerName}.hitTopK`, { min: 1, max: 20 }),
    recallMinRelevance: requireNumber(merged.recallMinRelevance, `${layerName}.recallMinRelevance`, { min: 0, max: 1 }),
    snapshotBudgetChars: requireInteger(merged.snapshotBudgetChars, `${layerName}.snapshotBudgetChars`, { min: 200, max: 20000 }),
    recallBudgetChars: requireInteger(merged.recallBudgetChars, `${layerName}.recallBudgetChars`, { min: 100, max: 8000 }),
    manageUI: requireBoolean(merged.manageUI, `${layerName}.manageUI`),
    writeback: {
      mode: requireEnum(merged.writeback?.mode, `${layerName}.writeback.mode`, WRITEBACK_MODES),
      everyNUserTurns: requireInteger(merged.writeback?.everyNUserTurns, `${layerName}.writeback.everyNUserTurns`, { min: 1, max: 100 }),
      model: (() => {
        const value = merged.writeback?.model;
        if (typeof value !== 'string') fail(`${layerName}.writeback.model`, `期望字符串，实际是 ${JSON.stringify(value)}`);
        return value.trim();
      })(),
      minChars: requireInteger(merged.writeback?.minChars, `${layerName}.writeback.minChars`, { min: 1, max: 500 }),
      maxPerTurn: requireInteger(merged.writeback?.maxPerTurn, `${layerName}.writeback.maxPerTurn`, { min: 1, max: 20 }),
      cooldownSeconds: requireInteger(merged.writeback?.cooldownSeconds, `${layerName}.writeback.cooldownSeconds`, { min: 0, max: 3600 }),
    },
  };
  return cfg;
}
