/**
 * dsh-memory — per-workspace long-term memory for DSH.
 *
 * One SQLite database per workspace (`<workspace>/<dataDir>/memory.db`). Two
 * workspaces never share a memory pool, and removing a workspace removes its
 * memory with it. No network of its own: the only model call is one
 * `ctx.llm.stream()` per writeback trigger, against the user's own channel.
 *
 * Three read/inject surfaces, chosen so neither correctness nor the provider's
 * prompt cache has to be sacrificed:
 *
 *  1. a byte-stable system-prompt section (the manual: what memory is for);
 *  2. a first-turn snapshot (standing context, written once per session);
 *  3. per-message recall (BM25 top-K, deduped per session, only above a floor),
 *     re-armed after a compaction because the snapshot may have been collapsed
 *     away with the rest of the history.
 *
 * One write surface that actually fills the store: a deterministic gate over the
 * user's own message → one independent extraction call → the same validation and
 * dedup pipeline the tools use. The agent tools remain, but they are not the
 * plan — "the agent will remember to remember" is how a store stays empty.
 */
import { ConfigError, CONFIG_DEFAULTS, resolveConfig } from './config.js';
import { openDb } from './store/db.js';
import { MemoryRepo } from './store/memory-repo.js';
import { createTools } from './tools.js';
import { registerHostRoutes } from './host-routes.js';
import { registerSystemGuide } from './inject/system-prompt.js';
import { registerCommands } from './commands.js';
import { readService, inheritedFromAgent, describeRoute } from './llm.js';
import { buildSnapshot, buildRecall, countPriorHumanMessages } from './inject/injection.js';
import { createPluginTextMessage, SNAPSHOT_MARKER } from './inject/message.js';
import { runWriteback, shouldExtract } from './writeback.js';

export const name = 'dsh-memory';

/**
 * Required cordis services.
 *
 * `inject` is not decoration: cordis throws `cannot get property "x" without
 * inject` on the first undeclared read, which aborts the whole plugin tree and
 * the web server then refuses to start. `llm` is deliberately ABSENT — the
 * memory tools stay useful without a model runtime, so the writeback channel
 * degrades to "disabled" instead of unmounting the plugin.
 */
export const inject = ['tools', 'systemPrompt', 'commands'];

export { CONFIG_DEFAULTS };
export { Config, ConfigSchema, resolveConfig, LEVELS, ConfigError } from './config.js';
export { MemoryRepo, normalizeProject } from './store/memory-repo.js';
export { openDb, dbPath } from './store/db.js';
export { buildSnapshot, buildRecall } from './inject/injection.js';
export { runWriteback, shouldExtract, parseJsonLoose, normalizeFact } from './writeback.js';
export { rankEntries, tokenize } from './ranking.js';
export { buildMatchExpression, ftsTerms, likeTerms } from './fts.js';
export { registerHostRoutes, MEMORY_API_PREFIX } from './host-routes.js';

/** Workspace stores are opened lazily and kept for the process lifetime. */
function createStorePool({ config, logger }) {
  const stores = new Map();
  const repos = new Map();
  const warn = (message) => {
    try {
      logger?.warn?.(`dsh-memory: ${message}`);
    } catch {
      // logging must never break a store lookup
    }
  };
  return {
    get(workspace) {
      if (typeof workspace !== 'string' || workspace === '') return undefined;
      const cached = repos.get(workspace);
      if (cached !== undefined) return cached;
      try {
        const store = openDb(workspace, config.dataDir);
        const repo = new MemoryRepo(store, { logger });
        stores.set(workspace, store);
        repos.set(workspace, repo);
        return repo;
      } catch (error) {
        warn(`打开记忆库失败（${workspace}）：${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    },
    closeAll() {
      for (const store of stores.values()) {
        try {
          store.close();
        } catch {
          // closing is best-effort at teardown
        }
      }
      stores.clear();
      repos.clear();
    },
    /** Workspaces this process has already opened (read-only view for the manager). */
    opened() {
      return repos;
    },
  };
}

/** Every pool opened in this process, so a test or ops script can close them. */
const openPools = new Set();

/** Close every store this plugin opened. Returns how many pools were closed. */
export function closeAllStores() {
  let closed = 0;
  for (const pool of [...openPools]) {
    try {
      pool.closeAll();
      closed += 1;
    } catch {
      // a pool that refuses to close must not break teardown
    }
  }
  openPools.clear();
  return closed;
}

export function apply(ctx, rawConfig) {
  const warnings = [];
  let cfg;
  try {
    cfg = resolveConfig(rawConfig, { base: CONFIG_DEFAULTS, layerName: 'cordis.patch.yml', warnings });
  } catch (cfgError) {
    const detail = cfgError instanceof ConfigError ? cfgError.message : String(cfgError);
    // Loud and mounted-nowhere: a plugin that silently substitutes a default for
    // an operator's typo writes memory somewhere nobody expects.
    ctx.logger.error(`dsh-memory: 配置非法，插件未启用 —— ${detail}`);
    return;
  }
  for (const warning of warnings) ctx.logger.warn(`dsh-memory: ${warning}`);
  if (!cfg.enabled) {
    ctx.logger.info('dsh-memory: enabled=false，未挂载任何功能');
    return;
  }

  const pool = createStorePool({ config: cfg, logger: ctx.logger });
  openPools.add(pool);
  const repoFor = (workspace) => pool.get(workspace);
  ctx.effect(() => {
    openPools.delete(pool);
    pool.closeAll();
  });

  // ------------------------------------------------------------------ tools
  for (const tool of createTools({ cfg: () => cfg, repoFor, logger: ctx.logger })) {
    ctx.effect(() => ctx.tools.register(tool));
  }

  // ------------------------------------------------- fixed system-prompt part
  if (cfg.systemGuide) {
    ctx.effect(() => registerSystemGuide(ctx, cfg.promptLang));
  }

  // -------------------------------------------------------------- commands
  if (ctx.commands !== undefined) {
    ctx.effect(() => registerCommands({ ctx, cfg, repoFor, logger: ctx.logger }));
  }

  // ------------------------------------------------- settings-page HTTP API
  // `webServer` and `connection` are NOT in `inject`: a headless/base-only
  // profile has neither, and a static inject entry keeps the fiber PENDING
  // forever (apply never runs, nothing is logged). `ctx.inject` mounts the
  // routes only where a Host actually has them.
  if (cfg.manageUI) {
    ctx.inject(['webServer', 'connection'], (webCtx) => {
      webCtx.effect(
        () => registerHostRoutes({
          webCtx,
          ctx,
          cfg,
          repoFor,
          workspaces: () => pool.opened(),
          logger: ctx.logger,
        }),
        'dsh-memory: /api/dsh-memory routes',
      );
    });
  }

  /** Sessions that already received their first-turn snapshot. */
  const firstServed = new Set();
  /** Sessions whose snapshot must be rebuilt because history was collapsed. */
  const armedReinject = new Set();
  /** Sessions with a writeback call in flight (never two at once). */
  const writebackBusy = new Set();

  // ------------------------------------------------- compaction re-arming
  ctx.on('session/event', (session, event) => {
    try {
      const sessionId = session?.id ?? session?.header?.id;
      const workspace = session?.header?.cwd;
      const type = event?.type;
      if (typeof sessionId !== 'string' || typeof workspace !== 'string') return;
      if (session?.header?.origin === 'subagent') return;
      if (type === 'compaction/start' || type === 'compaction/summary') {
        // History is being collapsed: whatever we injected may be gone from the
        // surface, so the seen-set no longer describes it and the snapshot must
        // be rebuilt on the next step.
        repoFor(workspace)?.store.clearSeen(sessionId);
        armedReinject.add(sessionId);
        firstServed.delete(sessionId);
      } else if (type === 'compaction/end') {
        if (event?.data?.error === undefined) {
          armedReinject.add(sessionId);
          firstServed.delete(sessionId);
        }
      }
    } catch (err) {
      ctx.logger.warn(`dsh-memory: session/event 处理失败（已忽略）：${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // ------------------------------------------------------------ pre-step
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const decision = await next();
    let injected;
    try {
      injected = injectPreStep({ decision, agent, cfg, repoFor, firstServed, armedReinject, logger: ctx.logger });
    } catch (err) {
      // Fail open: a memory bug must never block a turn.
      try {
        ctx.logger.warn(`dsh-memory: 记忆注入失败（已放行原始消息）：${err instanceof Error ? err.message : String(err)}`);
      } catch {
        // even the log must not break the turn
      }
      return decision;
    }
    // Writeback runs AFTER injection and is never awaited: extraction is a side
    // channel, and a slow model call must not add latency to the user's turn.
    scheduleWriteback({ ctx, agent, messages, cfg, repoFor, writebackBusy, signal, logger: ctx.logger });
    return injected ?? decision;
  });

  ctx.effect(() => () => {
    firstServed.clear();
    armedReinject.clear();
    writebackBusy.clear();
  });

  ctx.logger.info(
    `dsh-memory: 已挂载（数据目录 ${cfg.dataDir}；语言 ${cfg.promptLang}；召回 topK ${cfg.hitTopK}；`
    + `写回模式 ${cfg.writeback.mode}；写回模型 ${cfg.writeback.model === '' ? '继承主模型' : cfg.writeback.model}）`,
  );
}

/**
 * The read half of `agent/pre-step`. Returns `decision` unchanged whenever there
 * is nothing to add, so a plugin failure can never alter a turn.
 *
 * @param {{decision: object, agent: object, cfg: object, repoFor: Function,
 *   firstServed: Set<string>, armedReinject: Set<string>, logger: object}} input
 */
export function injectPreStep(input) {
  const { decision, agent, cfg, repoFor, firstServed, armedReinject } = input;
  if (decision === undefined || decision.kind !== 'enter') return decision;
  if (!Array.isArray(decision.messages) || decision.messages.length === 0) return decision;
  const header = agent?.session?.header;
  if (header === undefined || header.origin === 'subagent') return decision;
  const workspace = header.cwd;
  if (typeof workspace !== 'string' || workspace === '') return decision;
  const sessionId = typeof header.id === 'string' ? header.id : undefined;
  if (sessionId === undefined) return decision;

  const humanMessages = decision.messages.filter((message) => message?.source?.kind === 'user');
  if (humanMessages.length === 0) return decision;
  const repo = repoFor(workspace);
  if (repo === undefined) return decision;
  const project = projectOf(header, workspace);

  // 1) Post-compaction re-injection wins: the snapshot the model was given was
  //    collapsed with the rest of the history, so it must be rebuilt in place.
  if (armedReinject.has(sessionId)) {
    armedReinject.delete(sessionId);
    return rebuildSnapshot({ decision, repo, cfg, project, sessionId, target: humanMessages[humanMessages.length - 1], logger: input.logger, reason: '压缩后已重注入记忆快照' });
  }

  // 2) First turn of the session: one stable snapshot before the first message.
  if (!firstServed.has(sessionId)) {
    firstServed.add(sessionId);
    if (countPriorHumanMessages(agent) === 0) {
      return rebuildSnapshot({ decision, repo, cfg, project, sessionId, target: humanMessages[0], logger: input.logger, reason: '首轮已注入记忆快照' });
    }
  }

  // 3) Later turns: top-K recall, skipping whatever this session already saw.
  const last = humanMessages[humanMessages.length - 1];
  const query = textOf(last);
  if (query.trim() === '') return decision;
  const recall = buildRecall({
    repo,
    project,
    lang: cfg.promptLang,
    query,
    seenIds: repo.store.seenSet(sessionId),
    topK: cfg.hitTopK,
    minRelevance: cfg.recallMinRelevance,
    budgetChars: cfg.recallBudgetChars,
  });
  if (recall === undefined) return decision;
  markSeen(repo, sessionId, recall.ids, input.logger);
  const rewritten = [...decision.messages];
  const at = rewritten.indexOf(last);
  rewritten.splice(at < 0 ? rewritten.length : at, 0, createPluginTextMessage({ text: recall.text, form: 'recall' }));
  return { ...decision, messages: rewritten };
}

/** Build a snapshot, splice it in before `target`, and record what was shown. */
function rebuildSnapshot(input) {
  const { decision, repo, cfg, project, sessionId, target, reason } = input;
  const snapshot = buildSnapshot({ repo, project, lang: cfg.promptLang, budgetChars: cfg.snapshotBudgetChars });
  if (snapshot === undefined) return decision;
  markSeen(repo, sessionId, snapshot.injectedIds, input.logger);
  const rewritten = [...decision.messages];
  const at = rewritten.indexOf(target);
  rewritten.splice(at < 0 ? rewritten.length : at, 0, createPluginTextMessage({
    text: snapshot.text,
    sections: snapshot.sections,
    form: 'snapshot',
  }));
  try {
    input.logger?.info?.(`dsh-memory: ${reason}（${snapshot.total} 条记忆，${snapshot.text.length} 字）`);
  } catch {
    // logging is best-effort
  }
  return { ...decision, messages: rewritten };
}

/**
 * Record shown ids and bump their use counters.
 *
 * Dedup is an optimisation, but a failure here must be visible: a silently
 * swallowed error means the same entry is re-injected on every single message.
 */
function markSeen(repo, sessionId, ids, logger) {
  if (!Array.isArray(ids) || ids.length === 0) return;
  try {
    repo.store.markSeen(sessionId, ids);
    repo.store.touchUsage(ids);
  } catch (err) {
    try {
      logger?.warn?.(`dsh-memory: 记录已注入条目失败：${err instanceof Error ? err.message : String(err)}`);
    } catch {
      // nothing left to do
    }
  }
}

/**
 * Fire-and-forget writeback for the latest human message.
 *
 * Gated by {@link shouldExtract} before any model call, so the cost is bounded
 * by strings and counters. The promise is intentionally not returned: extraction
 * is a side channel and must never delay or fail a turn.
 */
function scheduleWriteback(input) {
  const { ctx, agent, messages, cfg, repoFor, writebackBusy, signal, logger } = input;
  if (cfg.writeback.mode === 'off') return;
  const header = agent?.session?.header;
  if (header === undefined || header.origin === 'subagent') return;
  const workspace = header.cwd;
  const sessionId = typeof header.id === 'string' ? header.id : undefined;
  if (typeof workspace !== 'string' || workspace === '' || sessionId === undefined) return;
  if (writebackBusy.has(sessionId)) return;

  const human = (Array.isArray(messages) ? messages : []).filter((message) => message?.source?.kind === 'user');
  const last = human[human.length - 1];
  if (last === undefined) return;
  const text = textOf(last);

  const repo = repoFor(workspace);
  if (repo === undefined) return;

  // Two counters, both per session and persisted so a restart does not turn the
  // cadence into a burst:
  //  - `user_turns` counts every human message, including short ones — "效果怎么样"
  //    is still a turn;
  //  - `turns_since_writeback` is the interval debt. It survives short turns that
  //    the length floor skips, so a "好的" cannot spend the slot and push the next
  //    extraction out by a whole extra window.
  //
  // Each message is counted once: `agent/pre-step` runs per step, so a turn with
  // tool calls reaches here several times with the same message. Counting those
  // separately inflated the index and fired extraction early.
  let turnsSince;
  let lastRunAt;
  try {
    const counted = last.id === undefined ? undefined : repo.store.getState(sessionId, 'counted_message_id');
    if (counted === last.id) return;
    const total = Number(repo.store.getState(sessionId, 'user_turns') ?? '0') + 1;
    // Seed the debt from the turn total when the key is absent: sessions that were
    // already running before this counter existed should not be granted a fresh
    // full window (which reads as "the interval stopped working").
    const previousDebt = repo.store.getState(sessionId, 'turns_since_writeback') ?? repo.store.getState(sessionId, 'user_turns') ?? '0';
    turnsSince = Number(previousDebt) + 1;
    repo.store.setState(sessionId, 'user_turns', String(total));
    repo.store.setState(sessionId, 'turns_since_writeback', String(turnsSince));
    if (last.id !== undefined) repo.store.setState(sessionId, 'counted_message_id', last.id);
    lastRunAt = Number(repo.store.getState(sessionId, 'last_writeback_at') ?? 'NaN');
  } catch {
    return;
  }

  if (text === '') return;

  const gate = shouldExtract({ cfg: cfg.writeback, text, turnsSince, lastRunAt: Number.isFinite(lastRunAt) ? lastRunAt : undefined });
  if (!gate.run) return;

  try {
    repo.store.setState(sessionId, 'last_writeback_at', String(Date.now()));
    repo.store.setState(sessionId, 'turns_since_writeback', '0');
  } catch {
    // a counter write failing is not a reason to skip extraction
  }

  const project = projectOf(header, workspace);
  const inheritedRoute = inheritedFromAgent(agent);
  writebackBusy.add(sessionId);
  void runWriteback({
    ctx,
    repo,
    cfg,
    sessionId,
    query: text,
    project,
    inheritedRoute,
    signal,
    logger,
  })
    .then((result) => {
      if (result.status === 'ok') {
        try {
          logger?.info?.(`dsh-memory: 写回 ${result.stored} 条记忆（触发条件 ${gate.reason}；模型 ${describeRoute(inheritedRoute)}）`);
        } catch {
          // logging is best-effort
        }
      }
    })
    .catch((err) => {
      try {
        logger?.warn?.(`dsh-memory: 写回失败（已忽略）：${err instanceof Error ? err.message : String(err)}`);
      } catch {
        // nothing left to do
      }
    })
    .finally(() => {
      writebackBusy.delete(sessionId);
    });
}

/** Project tag for a session: its title, else the workspace basename. */
function projectOf(header, workspace) {
  const title = typeof header?.title === 'string' ? header.title.trim() : '';
  if (title !== '') return title;
  const parts = String(workspace).split(/[\\/]+/).filter((part) => part !== '');
  return parts.length === 0 ? '全局' : parts[parts.length - 1];
}

/** Concatenate the text blocks of one message. */
function textOf(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join(' ');
}

export { SNAPSHOT_MARKER };
export { scheduleWriteback };
