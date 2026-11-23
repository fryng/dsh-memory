/**
 * End-to-end checks against the SHIPPED bundle.
 *
 * A test that imports `src/` proves the sources work; a test that imports
 * `lib/index.js` proves the thing DSH will actually load works. The second is the
 * one that catches a build-only breakage, so every check here goes through the
 * bundle.
 *
 * Every test gets its own temp workspace and a tracked store list. On Windows an
 * open SQLite handle keeps `-wal`/`-shm` files busy, so a cleanup that runs before
 * `close()` fails with EPERM — the harness below closes first, always.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  openDb,
  dbPath,
  MemoryRepo,
  resolveConfig,
  ConfigError,
  buildSnapshot,
  buildRecall,
  rankEntries,
  tokenize,
  buildMatchExpression,
  likeTerms,
  parseJsonLoose,
  normalizeFact,
  shouldExtract,
  injectPreStep,
  apply,
  scheduleWriteback,
} from '../lib/index.js';

/**
 * One temp workspace with lazily opened stores that are always closed before the
 * directory is removed.
 * @param {import('node:test').TestContext} t
 */
function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-test-'));
  const opened = [];
  t.after(() => {
    for (const store of opened) {
      try {
        store.close();
      } catch {
        // already closed
      }
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return {
    dir,
    open(dataDir = '.dsh-memory') {
      const store = openDb(dir, dataDir);
      opened.push(store);
      return { store, repo: new MemoryRepo(store) };
    },
  };
}

test('opens one database per workspace at the configured path', (t) => {
  const a = workspace(t);
  const b = workspace(t);
  const ra = a.open();
  const rb = b.open();
  ra.repo.remember({ level: 'fact', content: '工作区 A 的事实', project: '' });
  assert.equal(ra.repo.stats().total, 1);
  assert.equal(rb.repo.stats().total, 0, '另一个工作区必须看不到这条记忆');
  assert.ok(existsSync(dbPath(a.dir, '.dsh-memory')));
  assert.equal(ra.repo.stats().file, dbPath(a.dir, '.dsh-memory'));
});

test('dedupes an identical write instead of storing a copy', (t) => {
  const { repo, store } = workspace(t).open();
  const first = repo.remember({ level: 'rule', content: '提交前必须跑测试', project: 'p', importance: 2 });
  const second = repo.remember({ level: 'rule', content: '提交前必须跑测试', project: 'p', importance: 3 });
  assert.equal(first.action, 'insert');
  assert.equal(second.action, 'merge');
  assert.equal(second.id, first.id);
  assert.equal(repo.stats().total, 1);
  assert.equal(store.get(first.id).importance, 3, '重复陈述应当提升重要性');
});

test('merges a near-duplicate by rewriting the existing row', (t) => {
  const { repo, store } = workspace(t).open();
  const first = repo.remember({ level: 'preference', content: '用户偏好中文回复并且喜欢直接给结论', project: 'p' });
  const second = repo.remember({ level: 'preference', content: '用户偏好中文回复并且喜欢直接给结论，不喜欢长篇', project: 'p' });
  assert.equal(second.action, 'merge');
  assert.equal(second.id, first.id);
  assert.match(store.get(first.id).content, /不喜欢长篇/);
});

test('archives rather than deletes, and keeps the row readable', (t) => {
  const { repo, store } = workspace(t).open();
  const { id } = repo.remember({ level: 'fact', content: '临时事实', project: 'p' });
  repo.archive(id, 'test');
  const row = store.get(id);
  assert.equal(row.status, 'archived');
  assert.equal(row.content, '临时事实');
  assert.equal(repo.stats().total, 1, '归档不是删除');
  assert.equal(store.list({ status: 'active' }).length, 0);
});

test('every write leaves an audit row', (t) => {
  const { repo, store } = workspace(t).open();
  repo.remember({ level: 'fact', content: '审计测试', project: 'p' });
  const kinds = store.recentAudit(10).map((row) => row.kind);
  assert.ok(kinds.includes('insert'), `期望 insert 审计，实际 ${JSON.stringify(kinds)}`);
});

test('recall finds Chinese content, including a 2-character query', (t) => {
  const { repo } = workspace(t).open();
  repo.remember({ level: 'fact', content: '记忆库使用 trigram 分词才能检索中文', keywords: ['检索', '分词'], project: 'p' });
  repo.remember({ level: 'fact', content: 'pnpm 安装不要用 frozen-lockfile', keywords: ['pnpm'], project: 'p' });

  // A three-character Chinese phrase goes through FTS5 trigram.
  assert.equal(repo.recall({ query: '记忆库', project: 'p' }).length, 1);
  // A two-character word is structurally un-matchable by trigram; the LIKE
  // fallback is what makes it work at all.
  assert.equal(repo.recall({ query: '记忆', project: 'p' }).length, 1, '两字中文查询必须靠 LIKE 兜底命中');
  assert.equal(repo.recall({ query: 'pnpm', project: 'p' }).length, 1);
  // Latin substring through the LIKE pass.
  assert.equal(repo.recall({ query: 'lockfile', project: 'p' }).length, 1);
});

test('recall respects project scoping and never returns archived rows', (t) => {
  const { repo } = workspace(t).open();
  repo.remember({ level: 'rule', content: '全局准则必须服从测试', project: '' });
  repo.remember({ level: 'fact', content: '项目 p 的专属事实', project: 'p' });
  repo.remember({ level: 'fact', content: '项目 q 的专属事实', project: 'q' });

  const inP = repo.recall({ query: '专属事实', project: 'p' });
  assert.equal(inP.length, 1);
  assert.equal(inP[0].project, 'p');

  const { id } = repo.remember({ level: 'fact', content: '归档哨兵条目xyz', project: 'p' });
  assert.equal(repo.recall({ query: '归档哨兵条目', project: 'p' }).length, 1);
  repo.archive(id, 'test');
  assert.equal(repo.recall({ query: '归档哨兵条目', project: 'p' }).length, 0);
  assert.equal(repo.store.get(id).status, 'archived', '归档必须留行，只是把 status 置为 archived');
});

test('a global memory is visible from every project', (t) => {
  const { repo } = workspace(t).open();
  repo.remember({ level: 'rule', content: '全局准则：一律用 pwsh', project: '全局' });
  assert.equal(repo.recall({ query: '全局准则', project: 'p' }).length, 1);
  assert.equal(repo.recall({ query: '全局准则', project: 'q' }).length, 1);
});

test('snapshot is built under its character budget and marks what it showed', (t) => {
  const { repo } = workspace(t).open();
  for (let i = 0; i < 40; i += 1) {
    repo.remember({ level: 'fact', content: `第 ${i} 条事实：${'细节'.repeat(20)}`, project: 'p', importance: (i % 4) + 1 });
  }
  const snapshot = buildSnapshot({ repo, project: 'p', lang: 'zh', budgetChars: 800 });
  assert.ok(snapshot !== undefined);
  assert.ok(snapshot.text.length <= 1400, `快照超预算：${snapshot.text.length}`);
  assert.ok(snapshot.injectedIds.length > 0);
  assert.ok(snapshot.text.includes('第'), '快照必须含实际条目');
});

test('recall block respects the relevance floor', (t) => {
  const { repo } = workspace(t).open();
  repo.remember({ level: 'fact', content: '完全无关的内容：数据库连接池', project: 'p' });
  const miss = buildRecall({ repo, project: 'p', lang: 'zh', query: '量子力学', seenIds: new Set(), minRelevance: 0.15 });
  assert.equal(miss, undefined, '不相关的问题不应注入任何记忆');
});

test('seen-set suppresses a repeat recall in the same session', (t) => {
  const { repo, store } = workspace(t).open();
  repo.remember({ level: 'fact', content: '记忆库使用 trigram 分词', project: 'p' });
  const first = buildRecall({ repo, project: 'p', lang: 'zh', query: '记忆库', seenIds: new Set() });
  assert.ok(first !== undefined);
  store.markSeen('s1', first.ids);
  const second = buildRecall({ repo, project: 'p', lang: 'zh', query: '记忆库', seenIds: store.seenSet('s1') });
  assert.equal(second, undefined);
});

test('config validation rejects a bad value loudly instead of falling back', () => {
  assert.throws(() => resolveConfig({ dataDir: '../outside' }), ConfigError);
  assert.throws(() => resolveConfig({ dataDir: 'C:/absolute' }), ConfigError);
  assert.throws(() => resolveConfig({ hitTopK: 0 }), ConfigError);
  assert.throws(() => resolveConfig({ hitTopK: '3' }), ConfigError);
  assert.throws(() => resolveConfig({ promptLang: 'fr' }), ConfigError);
  assert.throws(() => resolveConfig({ writeback: { mode: 'sometimes' } }), ConfigError);
  assert.throws(() => resolveConfig({ toolPrefix: 'bad' }), ConfigError);
  assert.throws(() => resolveConfig({ recallMinRelevance: 5 }), ConfigError);
  const good = resolveConfig({ writeback: { mode: 'trigger' } });
  assert.equal(good.dataDir, '.dsh-memory');
  assert.equal(good.writeback.mode, 'trigger');
  assert.equal(good.hitTopK, 3);
});

test('config warns about unknown keys but still loads', () => {
  const warnings = [];
  resolveConfig({ hitTopK: 2, oops: true }, { warnings });
  assert.ok(warnings.some((w) => w.includes('oops')));
});

test('tokenizer handles mixed Chinese/English and drops stop characters', () => {
  const tokens = tokenize('用户的 lockfile 不要用 frozen');
  assert.ok(tokens.includes('用户'));
  assert.ok(tokens.includes('lockfile'));
  assert.ok(!tokens.includes('的'), '停用字不应成为词项');
});

test('ranking prefers importance and recency when the query is empty', () => {
  const now = Date.now();
  const rows = [
    { id: 'a', level: 'fact', content: '低重要性且很旧', keywords: '', importance: 1, updated_at: now - 40 * 86_400_000 },
    { id: 'b', level: 'rule', content: '高重要性且很新', keywords: '', importance: 4, updated_at: now },
  ];
  const ranked = rankEntries('', rows, { now });
  assert.equal(ranked[0].entry.id, 'b');
});

test('forgetting curve decays a stale low-importance entry', () => {
  const now = Date.now();
  const rows = [
    { id: 'old', level: 'fact', content: '同样内容的旧条目', keywords: '', importance: 1, updated_at: now - 60 * 86_400_000 },
    { id: 'new', level: 'fact', content: '同样内容的新条目', keywords: '', importance: 1, updated_at: now },
  ];
  const ranked = rankEntries('', rows, { now });
  assert.equal(ranked[0].entry.id, 'new');
});

test('FTS expression quotes terms so punctuation cannot break the query', () => {
  const expr = buildMatchExpression('memory.db 的 trigram');
  assert.ok(expr !== undefined);
  assert.ok(expr.includes('"memory.db"'), `期望带引号的 phrase，实际 ${expr}`);
  assert.ok(expr.includes('"trigram"'));
  // A query of only 2-character Chinese words has no trigram term at all — the
  // caller must fall back to LIKE, and `undefined` is how it says so.
  assert.equal(buildMatchExpression('记忆'), undefined);
});

test('the LIKE fallback terms include short Chinese words', () => {
  const terms = likeTerms('记忆 库');
  assert.ok(terms.includes('记忆'));
  // A two-character query whose every character is a stop character still has to
  // survive: 「中文」 is exactly the shape the fallback exists for.
  assert.deepEqual(likeTerms('中文'), ['中文']);
});

test('extraction JSON survives fences, preamble and trailing commas', () => {
  const fenced = parseJsonLoose('好的，结果如下：\n```json\n{"facts":[{"level":"fact","content":"x","keywords":["a"],"importance":2},]}\n```');
  assert.equal(fenced.facts.length, 1);
  assert.deepEqual(parseJsonLoose('{"facts":[]}'), { facts: [] });
  assert.equal(parseJsonLoose('不是 JSON'), undefined);
  assert.equal(parseJsonLoose(''), undefined);
});

test('extracted facts are validated, not repaired', () => {
  assert.equal(normalizeFact({ content: '' }, { project: 'p' }), undefined);
  assert.equal(normalizeFact({ level: 'fact' }, { project: 'p' }), undefined);
  const fact = normalizeFact({ level: 'nonsense', content: '内容', keywords: 'a b', importance: 9 }, { project: 'p' });
  assert.equal(fact.level, 'fact', '未知层级回落到 fact');
  assert.equal(fact.importance, 2, '越界重要性回落到 2');
  assert.equal(fact.project, 'p');
  assert.deepEqual(fact.keywords, ['a', 'b']);
});

test('the writeback gate fires on trigger words and stays quiet otherwise', () => {
  assert.equal(
    resolveConfig({}).writeback.everyNUserTurns,
    4,
    '默认间隔是 4 轮：实测触发词在真实对话里几乎不命中，间隔回退是主力通道',
  );
  const cfg = { mode: 'trigger', everyNUserTurns: 10, minChars: 8, cooldownSeconds: 30 };
  assert.equal(shouldExtract({ cfg, text: '以后请都用 pnpm 不要用 npm 了', turnsSince: 9 }).run, true);
  assert.equal(shouldExtract({ cfg, text: '帮我看看这个 bug 在哪', turnsSince: 9 }).run, false);
  assert.equal(shouldExtract({ cfg, text: '随便一段十个字以上的普通对话内容', turnsSince: 10 }).run, true, '每 N 轮兜底必须触发');
  assert.equal(shouldExtract({ cfg: { ...cfg, mode: 'off' }, text: '以后请都用 pnpm', turnsSince: 9 }).run, false);
  assert.equal(shouldExtract({ cfg: { ...cfg, mode: 'always' }, text: '一段足够长的普通对话内容', turnsSince: 9 }).run, true);
  assert.equal(
    shouldExtract({ cfg, text: '以后请都用 pnpm 不要用 npm 了', turnsSince: 9, lastRunAt: Date.now() }).run,
    false,
    '冷却期内不应重复调用',
  );
  // 触发词先于长度门槛：最短、最明确的记记忆指令不能被 too-short 丢掉。
  assert.equal(shouldExtract({ cfg, text: '记住', turnsSince: 9 }).run, true, '「记住」两个字也是明确指令');
  assert.deepEqual(
    shouldExtract({ cfg, text: '效果到底怎么样', turnsSince: 9 }),
    { run: false, reason: 'too-short' },
    '没有触发词的短句仍然被长度门槛挡住',
  );
  // 间隔回退是「欠账式」：到 4 轮就该跑，超过 4 轮仍然该跑（不能因为错过一次就再等一轮）。
  const every4 = { mode: 'trigger', everyNUserTurns: 4, minChars: 8, cooldownSeconds: 30 };
  assert.equal(shouldExtract({ cfg: every4, text: '一段完全普通的对话内容', turnsSince: 4 }).run, true);
  assert.equal(shouldExtract({ cfg: every4, text: '一段完全普通的对话内容', turnsSince: 3 }).run, false);
  assert.equal(
    shouldExtract({ cfg: every4, text: '一段完全普通的对话内容', turnsSince: 5 }).run,
    true,
    '欠账不该被抹掉：短句跳过的名额要留到下一轮有实质内容时补上',
  );
});

test('pre-step injection adds a snapshot on the first turn only once', (t) => {
  const { dir, open } = workspace(t);
  const { repo } = open();
  repo.remember({ level: 'rule', content: '必须用 pwsh 而不是 bash', project: 'p' });
  const cfg = resolveConfig({});
  const firstServed = new Set();
  const armedReinject = new Set();
  const agent = { session: { header: { id: 's1', cwd: dir, origin: 'user', title: 'p' }, messages: [] } };
  const decision = {
    kind: 'enter',
    messages: [{ id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] }],
  };
  const out = injectPreStep({ decision, agent, cfg, repoFor: () => repo, firstServed, armedReinject });
  assert.equal(out.messages.length, 2, '首轮应插入一条快照');
  assert.equal(out.messages[0].source.kind, 'plugin:dsh-memory');
  assert.equal(out.messages[0].source.form, 'snapshot');

  const again = injectPreStep({
    decision: { kind: 'enter', messages: [{ id: 'm2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '第二个问题' }] }] },
    agent,
    cfg,
    repoFor: () => repo,
    firstServed,
    armedReinject,
  });
  assert.equal(again.messages.length, 1, '第二轮没有相关记忆时不应注入任何内容');
});

test('an irrelevant later turn injects nothing', (t) => {
  const { dir, open } = workspace(t);
  const { repo } = open();
  repo.remember({ level: 'fact', content: '部署脚本在 scripts/deploy.ps1', project: 'p' });
  const cfg = resolveConfig({});
  const agent = { session: { header: { id: 's9', cwd: dir, origin: 'user', title: 'p' }, messages: [] } };
  const out = injectPreStep({
    decision: { kind: 'enter', messages: [{ id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '今天天气怎么样' }] }] },
    agent,
    cfg,
    repoFor: () => repo,
    firstServed: new Set(['s9']),
    armedReinject: new Set(),
  });
  assert.equal(out.messages.length, 1);
});

test('a compaction re-arms the snapshot', (t) => {
  const { dir, open } = workspace(t);
  const { repo } = open();
  repo.remember({ level: 'rule', content: '必须用 pwsh', project: 'p' });
  const cfg = resolveConfig({});
  const firstServed = new Set(['s1']);
  const armedReinject = new Set(['s1']);
  const agent = { session: { header: { id: 's1', cwd: dir, origin: 'user', title: 'p' }, messages: [] } };
  const out = injectPreStep({
    decision: { kind: 'enter', messages: [{ id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] }] },
    agent,
    cfg,
    repoFor: () => repo,
    firstServed,
    armedReinject,
  });
  assert.equal(out.messages.length, 2, '压缩后必须重注入');
  assert.equal(armedReinject.size, 0, '重注入后必须清掉标记');
});

test('subagent sessions are never injected', (t) => {
  const { dir, open } = workspace(t);
  const { repo } = open();
  repo.remember({ level: 'rule', content: '必须用 pwsh', project: 'p' });
  const out = injectPreStep({
    decision: { kind: 'enter', messages: [{ id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] }] },
    agent: { session: { header: { id: 's2', cwd: dir, origin: 'subagent' }, messages: [] } },
    cfg: resolveConfig({}),
    repoFor: () => repo,
    firstServed: new Set(),
    armedReinject: new Set(),
  });
  assert.equal(out.messages.length, 1);
});

test('a malformed config refuses to mount rather than half-loading', () => {
  const logged = [];
  const ctx = {
    logger: { error: (m) => logged.push(m), warn: () => {}, info: () => {} },
    effect: (fn) => {
      fn();
      return () => {};
    },
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    commands: { register: () => () => {} },
    on: () => () => {},
    // `ctx.inject` mirrors cordis: it runs the callback only when the named
    // services exist. These fakes have no webServer/connection, so the settings
    // API is correctly skipped.
    inject: () => () => {},
    get: () => undefined,
  };
  apply(ctx, { dataDir: 'C:/absolute/path' });
  assert.equal(logged.length, 1);
  assert.match(logged[0], /配置非法/);
});

test('apply registers five tools, the guide section and one command', () => {
  const tools = [];
  const sections = [];
  const commands = [];
  const ctx = {
    logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
    effect: (fn) => {
      fn();
      return () => {};
    },
    tools: { register: (def) => { tools.push(def); return () => {}; } },
    systemPrompt: { section: (input) => { sections.push(input); return () => {}; } },
    commands: { register: (def) => { commands.push(def); return () => {}; } },
    on: () => () => {},
    // `ctx.inject` mirrors cordis: it runs the callback only when the named
    // services exist. These fakes have no webServer/connection, so the settings
    // API is correctly skipped.
    inject: () => () => {},
    get: () => undefined,
  };
  apply(ctx, { enabled: true, promptLang: 'zh' });
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ['memory_read', 'memory_remember', 'memory_search', 'memory_status', 'memory_update'],
  );
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, 'dsh-memory-guide');
  assert.equal(typeof sections[0].text, 'string', 'section 文本必须是字符串，否则每轮都变');
  assert.equal(commands.length, 1);
  assert.equal(commands[0].name, 'mem');
});

test('toolPrefix namespaces every tool and command', () => {
  const tools = [];
  const commands = [];
  const ctx = {
    logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
    effect: (fn) => {
      fn();
      return () => {};
    },
    tools: { register: (def) => { tools.push(def); return () => {}; } },
    systemPrompt: { section: () => () => {} },
    commands: { register: (def) => { commands.push(def); return () => {}; } },
    on: () => () => {},
    // `ctx.inject` mirrors cordis: it runs the callback only when the named
    // services exist. These fakes have no webServer/connection, so the settings
    // API is correctly skipped.
    inject: () => () => {},
    get: () => undefined,
  };
  apply(ctx, { toolPrefix: 'mem_' });
  assert.ok(tools.every((tool) => tool.name.startsWith('mem_')));
  assert.equal(commands[0].name, 'mem_mem');
});

test('enabled=false mounts nothing at all', () => {
  let registrations = 0;
  const ctx = {
    logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
    effect: (fn) => {
      fn();
      return () => {};
    },
    tools: { register: () => { registrations += 1; return () => {}; } },
    systemPrompt: { section: () => { registrations += 1; return () => {}; } },
    commands: { register: () => { registrations += 1; return () => {}; } },
    on: () => () => {},
    // `ctx.inject` mirrors cordis: it runs the callback only when the named
    // services exist. These fakes have no webServer/connection, so the settings
    // API is correctly skipped.
    inject: () => () => {},
    get: () => undefined,
  };
  apply(ctx, { enabled: false });
  assert.equal(registrations, 0);
});

test('a short turn does not burn the interval slot (debting, not modulo)', async (t) => {
  const { dir, open } = workspace(t);
  const { repo } = open();
  const cfg = resolveConfig({});
  const header = { id: 's-debt', cwd: dir, origin: 'user', title: 'p' };
  const agent = { options: {}, session: { header, messages: [] } };
  const busy = new Set();
  /** A message the gate must skip: below minChars and carrying no trigger word. */
  const turn = (id, text) => ({
    id,
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  });
  const drive = async (id, text) => {
    const messages = [turn(id, text)];
    scheduleWriteback({ ctx: { logger: undefined }, agent, messages, cfg, repoFor: () => repo, writebackBusy: busy, logger: undefined });
    // The counter half runs synchronously; give the fire-and-forget extraction a
    // tick to settle so `busy` is release before the next drive.
    await new Promise((resolve) => setTimeout(resolve, 30));
  };

  // Turns 1-3: substantive, below the interval, no trigger word.
  await drive('m1', '帮我看看这个模块的边界情况怎么处理比较好');
  await drive('m2', '这段代码为什么要用 junction 而不是软链接');
  assert.equal(repo.store.getState('s-debt', 'turns_since_writeback'), '2');
  assert.equal(repo.store.getState('s-debt', 'last_writeback_at'), undefined, '还没到间隔，不应抽过');

  // Turn 4 is short: it counts as a turn, but must NOT spend the slot.
  await drive('m3', '好的');
  assert.equal(repo.store.getState('s-debt', 'turns_since_writeback'), '3');
  assert.equal(repo.store.getState('s-debt', 'last_writeback_at'), undefined, '短句不应把间隔名额用掉');

  // Turn 5 is substantive and the debt is now due, so extraction runs.
  await drive('m4', '那这样改完还需要重新打包桌面端安装包吗');
  assert.equal(repo.store.getState('s-debt', 'last_writeback_at') !== undefined, true, '欠到 4 轮后有实质内容就该抽');
  assert.equal(repo.store.getState('s-debt', 'turns_since_writeback'), '0', '跑过之后欠账清零');

  // The same message id must not be counted twice — agent/pre-step runs per step.
  await drive('m4', '那这样改完还需要重新打包桌面端安装包吗');
  assert.equal(repo.store.getState('s-debt', 'turns_since_writeback'), '0', '同一条消息在多个 step 到达只算一次');
});

test('a tool call resolves the workspace and writes into that workspace only', async (t) => {
  const { dir, open } = workspace(t);
  const ctx = {
    logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
    effect: (fn) => {
      fn();
      return () => {};
    },
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    commands: { register: () => () => {} },
    on: () => () => {},
    // `ctx.inject` mirrors cordis: it runs the callback only when the named
    // services exist. These fakes have no webServer/connection, so the settings
    // API is correctly skipped.
    inject: () => () => {},
    get: () => undefined,
  };
  apply(ctx, {});
  const { repo } = open();
  const pool = { get: () => repo };
  // Re-drive one tool through the same code path the harness uses.
  const { createTools } = await import('../src/tools.js');
  const tools = createTools({ cfg: () => resolveConfig({}), repoFor: pool.get });
  const remember = tools.find((tool) => tool.name === 'memory_remember');
  const exec = { agent: { session: { header: { id: 's', cwd: dir, title: 'proj' } } } };
  const written = await remember.execute({ level: 'fact', content: '工具写入的条目', keywords: ['工具'] }, exec);
  assert.equal(written.status, 'ok', JSON.stringify(written));
  assert.equal(repo.stats().total, 1);

  const search = tools.find((tool) => tool.name === 'memory_search');
  const found = await search.execute({ query: '工具写入' }, exec);
  assert.equal(found.status, 'ok');
  assert.match(found.text, /工具写入的条目/);

  // A tool result must not carry `undefined`: DSH rejects it as non-lossless JSON.
  for (const tool of tools) {
    const value = await tool.execute({ query: '不存在的东西', id: 'missing', content: 'x', level: 'fact' }, exec);
    assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
    for (const field of Object.keys(value)) {
      assert.notEqual(value[field], undefined, `${tool.name} 返回值含 undefined 字段 ${field}`);
    }
  }
});
