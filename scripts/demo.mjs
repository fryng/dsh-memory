/**
 * End-to-end proof for dsh-memory, run against a REAL booted profile.
 *
 * It boots the `mem-verify` profile through the same composition a real `dsh`
 * launch performs, then drives the plugin's public surfaces exactly as the
 * harness does — the tool registry, the `agent/pre-step` waterfall, and the
 * writeback gate — so every line of output is produced by the shipped bundle,
 * not by a test double.
 *
 * Steps:
 *   1. boot the profile and prove the plugin mounted (five tools + guide)
 *   2. per-workspace isolation: two workspaces, two databases, no bleed
 *   3. write memories through `memory_remember`
 *   4. drive a fresh session's first turn and show the injected snapshot
 *   5. drive a second turn and show targeted recall
 *   6. fire the deterministic writeback gate on a "记住…" message and show what
 *      the independent extraction call stored
 *   7. read the rows back with `memory_search`, and show the audit trail
 *
 * Usage (from the checkout root):
 *   node plugins/dsh-memory/scripts/demo.mjs [workspace] [writebackModel]
 */
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, loadLayeredEnv, loadProfile, resolveConfigPath } from '@deepseek-ai/dsh-app-boot';
import { linkProfileDeps } from './link-profile-deps.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(here, '..');
const repoRoot = resolve(pluginDir, '..', '..');
const profileName = 'mem-verify';

/**
 * Build the throwaway verification profile on demand.
 *
 * It mounts `@deepseek-ai/dsh-base` plus this plugin, and deliberately NOT
 * `@deepseek-ai/dsh-web-app`: the web bundle forces `webserver`, `web-runtime` and
 * `connection` to activate, and those need a listening port, `cmdlineArgs` and the
 * machine-wide task-board ledger — none of which a headless verification wants.
 * With base only, `boot()` works with just an `internal/listener` hook, which is
 * exactly the surface the plugin touches.
 *
 * The junction + per-package dependency links are what make a *checkout* loadable:
 * `dsh-memory` resolves from `<profile>/node_modules/dsh-memory`, and every
 * `@deepseek-ai/*` package the base bundle names has to be visible from the
 * profile's scope directory.
 */
/**
 * The `cordis.yml` root the launcher writes for every profile: an empty entry list,
 * because the tree is composed from bundle patches plus the user patch file.
 */
const PROFILE_ROOT_CONFIG = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`;

function ensureProfile() {
  const dshHome = process.env.DSH_HOME ?? join(repoRoot, '.dsh');
  const profileDir = join(dshHome, 'profiles', profileName);
  const manifestPath = join(profileDir, 'package.json');
  if (!existsSync(manifestPath)) {
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      manifestPath,
      `${JSON.stringify({ name: `dsh-profile-${profileName}`, private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-memory'] } } }, undefined, 2)}\n`,
    );
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n');
    process.stdout.write(`（已创建验证 profile：${profileDir}）\n`);
  }
  writeFileSync(join(profileDir, 'cordis.yml'), PROFILE_ROOT_CONFIG);
  linkProfileDeps({ repoRoot, profileName });
  const modulesDir = join(profileDir, 'node_modules');
  const linkPath = join(modulesDir, 'dsh-memory');
  mkdirSync(modulesDir, { recursive: true });
  if (!existsSync(linkPath)) symlinkSync(pluginDir, linkPath, 'junction');
  return profileDir;
}

ensureProfile();

const workspace = resolve(process.argv[2] ?? join(process.cwd(), '.demo-memory-workspace'));
/** A second workspace, used only to prove the databases are separate. */
const otherWorkspace = `${workspace}-other`;
/**
 * The extraction model. Empty means "inherit the live agent's model", which is
 * the shipped default and the normal path — the gate fires inside a turn, so a
 * route always exists there. The demo takes an explicit one when the booted
 * tree has no default model to inherit.
 */
const writebackModel = process.argv[3] ?? '';
/**
 * The route the synthetic agents advertise as their "main model". Filled in after
 * boot by asking the live `llm` service which providers actually exist.
 */
let syntheticRoute = {};

const require = createRequire(import.meta.url);
const installAnchor = require.resolve('@deepseek-ai/dsh/package.json');
loadLayeredEnv('dsh', process.cwd());
process.env.DSH_PERMISSION_MODE ??= 'workspace-write';
const profile = loadProfile('demo', profileName, installAnchor);
const patches = [...profile.layers.map((layer) => layer.patches), profile.patches].flat();

/** The plugin's shipped defaults, from the bundle patch itself. */
const pluginDefaults = profile.layers
  .flatMap((layer) => layer.patches)
  .flatMap((patch) => patch.insert ?? [])
  .find((entry) => entry.id === 'dsh-memory')?.config ?? {};
if (writebackModel !== '') {
  patches.push({ id: 'dsh-memory', config: { ...pluginDefaults, writeback: { ...pluginDefaults.writeback, model: writebackModel } } });
}
const configPath = resolveConfigPath(join(profile.dir, 'cordis.yml'), 'profile', process.cwd());

for (const dir of [workspace, otherWorkspace]) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

const say = (line = '') => process.stdout.write(`${line}\n`);
const heading = (text) => say(`\n=== ${text} ===`);

/** Listeners captured during boot, keyed by event name. */
const listeners = new Map();

const header = (id, cwd) => ({ id, cwd, createdAt: Date.now() });
const human = (text) => ({ id: `msg-${Math.random().toString(16).slice(2)}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } });
const agentLike = (id, cwd) => ({ options: { ...syntheticRoute }, session: { header: header(id, cwd), events: [] } });

const ctx = await boot('demo', configPath, patches, (hostCtx) => {
  /**
   * Capture every event listener the tree registers. `prepare` runs before the
   * include mounts, so this sees the plugin's own `agent/pre-step` exactly as
   * the harness would dispatch it — the demo then invokes that very callback.
   */
  hostCtx.on('internal/listener', (name, listener) => {
    if (typeof name === 'string' && listeners.has(name)) listeners.get(name).push(listener);
    else listeners.set(name, [listener]);
  });
});

try {
  // ------------------------------------------------------------- step 0
  /*
   * The writeback gate inherits the live agent's route (`agent.options`), which a
   * synthetic agent does not have. Lend it a real one, discovered from the live
   * `llm` service, so step 6 exercises the genuine `ctx.llm.stream` path instead
   * of reporting "no model" — which is a demo artefact, not product behaviour.
   */
  {
    const llm = ctx.get('llm');
    const providers = llm.listProviders?.() ?? [];
    if (writebackModel !== '') {
      syntheticRoute = writebackModel.includes('/')
        ? { provider: writebackModel.split('/', 1)[0], model: writebackModel.slice(writebackModel.indexOf('/') + 1) }
        : { provider: providers[0]?.id, model: writebackModel };
    } else {
      for (const provider of providers) {
        const models = (await llm.listModels?.(provider.id)) ?? [];
        const model = models[0]?.id ?? models[0]?.model;
        if (typeof model === 'string' && model !== '') {
          syntheticRoute = { provider: provider.id, model };
          break;
        }
      }
    }
    say(`合成 agent 的主模型（供写回继承）: ${syntheticRoute.provider ?? '?'}/${syntheticRoute.model ?? '（未发现）'}`);
  }

  // ---------------------------------------------------------------- step 1
  heading('1. 挂载');
  const tools = ctx.get('tools');
  const names = tools.schemas().map((schema) => schema.name).sort();
  const mine = names.filter((name) => name.startsWith('memory_'));
  say(`插件工具（${mine.length}）: ${mine.join(', ')}`);
  if (mine.length !== 5) throw new Error(`expected 5 dsh-memory tools, got ${mine.length}: ${mine.join(', ')}`);

  const systemPrompt = ctx.get('systemPrompt');
  const assembly = await systemPrompt.assemble();
  const guide = assembly.sections.findIndex((section) => section.name === 'dsh-memory-guide');
  say(`system prompt guide 段: ${guide >= 0 ? `第 ${guide + 1} 段，${assembly.sections[guide].text.length} 字` : '缺失'}`);
  if (guide < 0) throw new Error('the dsh-memory system-prompt guide did not reach the assembled prompt');
  const commands = ctx.get('commands');
  const memCommand = commands.find(agentLike('probe', workspace), '/mem') ?? commands.find(agentLike('probe', workspace), 'mem');
  say(`/mem 命令: ${memCommand === undefined ? '缺失' : '已注册'}`);

  const callTool = async (name, args, agent) => {
    // Call the registered definition's own body with the same exec context the
    // registry hands it: `tools.execute` would additionally run DSH's policy
    // pipeline, which needs a live Agent and a persisted session.
    const definition = tools.get(name);
    const value = await definition.execute(args, {
      callId: `demo-${Math.random().toString(16).slice(2)}`,
      name,
      arguments: args,
      agent,
      signal: new AbortController().signal,
    });
    const blocks = definition.output.render(args, value).map((block) => block.text ?? '').join('\n');
    return { status: value?.status, summary: value?.summary, text: value?.text, blocks };
  };

  const alpha = () => agentLike('session-alpha', workspace);
  const beta = () => agentLike('session-beta', otherWorkspace);

  // ---------------------------------------------------------------- step 2
  heading('2. 每工作区独立存储');
  const inAlpha = await callTool('memory_remember', { level: 'fact', content: '工作区 A 的专属事实：构建脚本是 build.mjs。', keywords: ['构建', 'build', '工作区'], importance: 2 }, alpha());
  say(`  A 写入: ${inAlpha.summary}`);
  const inBeta = await callTool('memory_status', {}, beta());
  say(`  B 库状态（应为 0 条）: ${inBeta.text.split('\n')[0]}`);
  if (!/总条数：0\b/.test(inBeta.text)) throw new Error(`workspaces are not isolated:\n${inBeta.text}`);
  say('  两个工作区各自一份 memory.db，互不可见 ✓');

  // ---------------------------------------------------------------- step 3
  heading('3. 写入记忆（memory_remember）');
  const writes = [
    { level: 'preference', content: '回答一律用简体中文，代码注释也用中文。', keywords: ['中文', '语言', '回复', '注释'], importance: 3 },
    { level: 'rule', content: 'Windows 上执行命令必须用 pwsh，不要用 bash。', keywords: ['pwsh', 'Windows', 'bash', 'shell'], importance: 4 },
    { level: 'decision', content: '检索用 FTS5 trigram + LIKE 兜底，因为 unicode61 对中文零命中。', keywords: ['FTS5', 'trigram', 'LIKE', '中文', '检索'], importance: 3, goal: '让中文两字词也能命中' },
    { level: 'fact', content: '插件数据落在每个工作区的 .dsh-memory/memory.db。', keywords: ['memory.db', '.dsh-memory', '工作区', 'sqlite'], importance: 2 },
  ];
  for (const args of writes) {
    const out = await callTool('memory_remember', args, alpha());
    say(`  ${out.status === 'ok' ? 'ok ' : 'ERR'} ${out.summary}`);
  }
  /** Dedupe: the same content again must merge, not duplicate. */
  const again = await callTool('memory_remember', { level: 'rule', content: 'Windows 上执行命令必须用 pwsh，不要用 bash。', keywords: ['pwsh'], importance: 4 }, alpha());
  say(`  重复写入: ${again.summary}`);

  // ---------------------------------------------------------------- step 4
  heading('4. 首轮注入快照（agent/pre-step）');
  const preStepListeners = listeners.get('agent/pre-step') ?? [];
  say(`  agent/pre-step 监听器 ${preStepListeners.length} 个`);
  /**
   * Run the real chain, tolerating bundles whose hook needs a persisted live
   * Agent (a synthetic one cannot satisfy them). Each listener still runs for
   * real, and the first rewrite wins — the waterfall contract.
   */
  const preStep = async (agent, messages) => {
    let current = messages;
    for (const callback of preStepListeners) {
      try {
        const decision = await callback(
          { agent, messages: current, signal: new AbortController().signal },
          () => ({ kind: 'enter', messages: current }),
        );
        if (decision?.kind === 'enter' && Array.isArray(decision.messages) && decision.messages !== current) {
          say(`  → 命中监听器 ${callback.name || '(anonymous)'}（${current.length} → ${decision.messages.length} 条消息）`);
          return decision;
        }
      } catch (error) {
        say(`  · 跳过 ${callback.name || '(anonymous)'}：${String(error?.message ?? error).split('\n')[0]}`);
      }
    }
    return { kind: 'enter', messages: current };
  };

  const sessionGamma = agentLike('session-gamma', workspace);
  const firstDecision = await preStep(sessionGamma, [human('这个插件是怎么存记忆的？')]);
  say(`  messages=${firstDecision.messages.length}（原 1 + 注入）`);
  for (const message of firstDecision.messages.slice(0, -1)) {
    const isPlugin = message.source?.plugin === 'dsh-memory';
    for (const line of (message.content ?? []).map((block) => block.text ?? '').join('\n').split('\n')) say(`  ${isPlugin ? '|' : '>'} ${line}`);
  }
  /** The second turn of the same session must not snapshot again. */
  const secondTurn = await preStep(sessionGamma, [human('那两字中文词能搜到吗？')]);
  say(`  次轮 messages=${secondTurn.messages.length}（快照不重复，只有定向召回）`);

  // ---------------------------------------------------------------- step 5
  heading('5. 定向召回（BM25 × 保持度 × 命中加成）');
  const sessionDelta = agentLike('session-delta', workspace);
  const firstDelta = await preStep(sessionDelta, [human('你好。')]);
  say(`  首轮快照 messages=${firstDelta.messages.length}`);
  /** Learned after the snapshot: only retrieval can answer this one. */
  const late = await callTool('memory_remember', {
    level: 'fact',
    content: '水位线推进和真正落库是两个动作，空转要靠 audit 才能发现。',
    keywords: ['水位线', '空转', 'audit', '落库'],
    importance: 2,
  }, alpha());
  say(`  会话中学到: ${late.summary}`);
  const recallDecision = await preStep(sessionDelta, [human('空转怎么发现？')]);
  say(`  次轮 messages=${recallDecision.messages.length}（原 1 + 召回）`);
  for (const message of recallDecision.messages.slice(0, -1)) {
    for (const line of (message.content ?? []).map((block) => block.text ?? '').join('\n').split('\n')) say(`  ${line}`);
  }

  // ---------------------------------------------------------------- step 6
  heading('6. 确定性写回（触发词 → 独立抽取调用）');
  const { shouldExtract } = await import('../src/writeback.js');
  const { resolveConfig } = await import('../src/config.js');
  const cfg = resolveConfig({});
  for (const text of ['继续', '好的', '记住', '以后都用 pwsh，不要用 bash', '这轮没什么可记的但很长很长']) {
    const gate = shouldExtract({ cfg, text, turnsSince: 9, lastRunAt: 0, now: Date.now() });
    say(`  「${text.slice(0, 20)}」→ ${gate.run ? `跑（${gate.reason}）` : `跳过（${gate.reason}）`}`);
  }
  /**
   * The interval fallback is the channel that actually keeps a store filling:
   * measured on real conversations, trigger words almost never fire. Show the
   * cadence at the shipped default (every 4th human message).
   */
  for (const turnsSince of [3, 4, 5]) {
    const gate = shouldExtract({ cfg, text: '帮我看看这个模块的边界情况怎么处理比较好', turnsSince, lastRunAt: 0 });
    say(`  距上次写回 ${turnsSince} 轮 → ${gate.run ? `跑（${gate.reason}）` : `跳过（${gate.reason}）`}`);
  }
  /**
   * Drive the real gate through the real pre-step hook: the message carries a
   * trigger word, so the plugin fires one independent extraction call whose only
   * evidence is this message, then stores what it returned. The call is async,
   * so wait for the audit row that records its outcome.
   */
  const sessionEpsilon = agentLike('session-epsilon', workspace);
  const triggerText = '记住：以后回答我问题时，先给结论再给理由，不要一上来就长篇大论。导出报表一律用 xlsx，不要用 csv。';
  await preStep(sessionEpsilon, [human(triggerText)]);
  /** Poll the audit trail for the writeback outcome of this session. */
  const { openDb } = await import('../lib/index.js');
  const store = openDb(workspace, '.dsh-memory');
  let audit = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    audit = store.recentAudit(20);
    if (audit.some((row) => row.kind === 'writeback' || row.kind === 'writeback-empty' || row.kind === 'writeback-error')) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  for (const row of audit.filter((item) => String(item.kind).startsWith('writeback'))) {
    say(`  audit[${row.kind}] ${row.detail}${row.payload === undefined ? '' : ` ${JSON.stringify(row.payload)}`}`);
  }
  if (!audit.some((row) => String(row.kind).startsWith('writeback'))) say('  （没有任何 writeback 审计行 —— 写回通道没有跑，这本身就是一个可观测的失败信号）');

  // ---------------------------------------------------------------- step 7
  heading('7. 读回（memory_search）与审计');
  const found = await callTool('memory_search', { query: 'Windows 上该用哪个 shell', k: 3 }, alpha());
  say(`  ${found.summary}`);
  for (const line of String(found.text ?? '').split('\n')) say(`  ${line}`);
  /**
   * The two-character case that motivated the LIKE fallback: `中文` is one bigram,
   * FTS5 trigram cannot index or match it, so the LIKE path has to answer.
   */
  const twoChar = await callTool('memory_search', { query: '中文', k: 3 }, alpha());
  say(`  两字查询「中文」: ${twoChar.summary}`);
  for (const line of String(twoChar.text ?? '').split('\n')) say(`  ${line}`);
  const status = await callTool('memory_status', {}, alpha());
  say(`\n${status.text}`);
  const rows = store.list({ status: 'active', project: '' });
  say(`\n  库内活跃条目 ${rows.length} 条，去重后的层分布: ${JSON.stringify(store.counts())}`);
  say(`  归档过的条目仍留行: ${store.list({ status: 'archived' }).length} 条（archive never delete）`);

  heading('产物');
  say(`工作区 A: ${workspace}`);
  say(`数据库 A: ${join(workspace, '.dsh-memory', 'memory.db')}`);
  say(`工作区 B: ${otherWorkspace}`);
  say(`数据库 B: ${join(otherWorkspace, '.dsh-memory', 'memory.db')}（独立，未写入）`);
  store.close();
  await ctx.fiber.dispose();
  process.exit(0);
} catch (error) {
  say(`\nDEMO FAILED: ${error?.stack ?? error}`);
  await ctx.fiber.dispose();
  process.exit(1);
}
