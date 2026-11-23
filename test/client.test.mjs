/**
 * Browser-half tests: the bundle shape, the store's re-render discipline, and a
 * real render of the panel against a stubbed seed `require`.
 *
 * The bundle is what the web shell actually loads, so it is tested as built
 * (`lib/client.js`) rather than by importing `src/client/*` — a passing source
 * test says nothing about whether `__ModuleLoader__.load` receives a factory.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(here, '..', 'lib', 'client.js');
const require_ = createRequire(import.meta.url);

const react = require_('react');
const server = require_('react-dom/server');

/** The icon set the panel imports; a plain span is enough to render. */
const ICONS = [
  'IconArchiveOutlineRegular',
  'IconCheckOutlineRegular',
  'IconCloseOutlineRegular',
  'IconDatabaseOutlineRegular',
  'IconEditOutlineRegular',
  'IconRefreshOutlineRegular',
  'IconSearchOutlineRegular',
  'IconUnarchiveOutlineRegular',
  'IconWarningOutlineRegular',
];

const primitives = Object.fromEntries(ICONS.map((name) => [name, (props) => react.createElement('span', { 'data-icon': name })]));

/**
 * Load the built bundle the way the shell does and hand back its exports.
 * @returns {{apply: Function, inject: string[], name: string}}
 */
function loadBundle() {
  const source = readFileSync(bundlePath, 'utf8');
  let captured;
  const windowLike = {
    __ModuleLoader__: {
      load(definition) {
        captured = definition;
      },
    },
  };
  const seed = { react, 'react/jsx-runtime': require_('react/jsx-runtime'), '@deepseek-ai/dsh-client-ui-primitives': primitives };
  const factoryRequire = (id) => {
    if (id in seed) return seed[id];
    throw new Error(`unexpected require("${id}") from the client bundle`);
  };
  // The bundle is a script, not a module: evaluate it with the loader stub in
  // scope. `new Function` keeps it isolated from this module's own bindings.
  const run = new Function('window', 'document', source);
  run(windowLike, undefined);
  assert.ok(captured !== undefined, 'the bundle must call window.__ModuleLoader__.load');
  assert.equal(captured.id, 'dsh-memory');
  return captured.factory(factoryRequire);
}

test('the built bundle registers a factory under the package id', () => {
  const exports_ = loadBundle();
  assert.equal(typeof exports_.apply, 'function');
  assert.deepEqual(exports_.inject, ['slots', 'locale']);
  assert.equal(exports_.name, 'dsh-memory-client');
});

test('the bundle requires only seed modules', () => {
  const source = readFileSync(bundlePath, 'utf8');
  const required = new Set([...source.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]));
  for (const id of required) {
    assert.ok(
      ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
        '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
        '@deepseek-ai/dsh-client-ui-primitives'].includes(id),
      `client bundle must not require "${id}" — the shell cannot resolve it`,
    );
  }
});

/** Minimal cordis-ish context capturing what `apply` registers. */
function fakeCtx() {
  const registered = { slots: [], dicts: [], effects: 0 };
  const t = (key) => `t:${key}`;
  const ctx = {
    locale: {
      bind: () => t,
      register: (ns, dicts) => {
        registered.dicts.push({ ns, dicts });
        return () => {};
      },
    },
    slots: {
      // `inject` is a nested effect: the framework runs the callback right away
      // when the dependent slot exists, so the fake must do the same.
      inject: (name, factory) => {
        registered.slots.push({ name });
        return factory();
      },
      register: (options, component) => {
        registered.entry = { options, component };
        return () => {};
      },
    },
    effect: (factory) => {
      registered.effects += 1;
      return factory();
    },
  };
  return { ctx, registered, t };
}

test('apply registers dictionaries and one settings.section entry', () => {
  const { ctx, registered } = fakeCtx();
  loadBundle().apply(ctx);
  assert.equal(registered.dicts.length, 1);
  assert.equal(registered.dicts[0].ns, 'dsh-memory');
  assert.ok(registered.dicts[0].dicts.zh.nav !== undefined);
  assert.ok(registered.dicts[0].dicts.en.nav !== undefined);
  assert.equal(registered.slots.length, 1);
  assert.equal(registered.slots[0].name, 'settings.section');
  assert.equal(registered.entry.options.id, 'memory');
  assert.equal(registered.entry.options.order, 25);
  assert.equal(typeof registered.entry.component, 'function');
  // The label is a thunk so a language switch is reflected without re-registering.
  assert.equal(typeof registered.entry.options.label, 'function');
});

test('the injected hooks expose getSnapshot/subscribe and render a snapshot', () => {
  const { ctx, registered } = fakeCtx();
  loadBundle().apply(ctx);
  const face = registered.entry.options.inject();
  assert.equal(typeof face.bootstrap, 'function');
  assert.equal(typeof face.hooks.memoryPanel.getSnapshot, 'function');
  assert.equal(typeof face.hooks.memoryPanel.subscribe, 'function');
  assert.equal(typeof face.hooks.memoryDrafts.getSnapshot, 'function');
  const snapshot = face.hooks.memoryPanel.getSnapshot();
  assert.equal(snapshot.phase, 'boot');
  assert.deepEqual(snapshot.items, []);
  // The same object must come back until something changes, or the panel
  // re-renders on every frame.
  assert.equal(face.hooks.memoryPanel.getSnapshot(), snapshot);
});

/** Render the panel against a fixed snapshot, with fetch stubbed per case. */
function renderPanel({ workspaces, items, stats, filter = {}, phase = 'ready', missing = false }) {
  const { ctx, registered, t } = fakeCtx();
  loadBundle().apply(ctx);
  const face = registered.entry.options.inject();
  // Seed the store directly through its public API surface: a fake Host means
  // fetch is never reached, and the render path is what is under test here.
  const store = face.hooks.memoryPanel;
  const snapshot = {
    ...store.getSnapshot(),
    phase,
    missing,
    workspaces,
    selected: workspaces.find((entry) => entry.exists)?.path ?? workspaces[0]?.path ?? '',
    items,
    total: items.length,
    stats,
    filter: { status: 'active', level: '', query: '', ...filter },
  };
  store.getSnapshot = () => snapshot;
  const Component = registered.entry.component;
  return server.renderToStaticMarkup(
    react.createElement(Component, { ...face, t, useMemoryPanel: () => snapshot, useMemoryDrafts: () => new Map() }),
  );
}

test('the panel renders workspaces, cards, level chips and the retention bar', () => {
  const html = renderPanel({
    workspaces: [
      { id: 'a', title: 'DeepSeek-Harness', path: 'E:\\DevTools\\DeepSeek-Harness', exists: true, active: 2, archived: 1, total: 3, levels: { rule: 1, fact: 1 }, projects: [] },
      { id: 'b', title: 'fresh', path: 'E:\\tmp\\fresh', exists: false, active: 0, archived: 0, total: 0, levels: {}, projects: [] },
    ],
    items: [
      { id: 'm1', level: 'rule', content: '一律用 pwsh，不要用 bash。', keywords: 'pwsh bash 命令行', importance: 4, project: '全局', subcategory: '', status: 'active', useCount: 3, updatedAt: Date.now() - 3600000, createdAt: Date.now() },
      { id: 'm2', level: 'fact', content: 'Node 版本是 v24.13.1。', keywords: 'node 版本', importance: 2, project: 'DeepSeek-Harness', subcategory: '', status: 'active', useCount: 0, updatedAt: Date.now() - 86400000 * 20, createdAt: Date.now() },
    ],
    stats: { active: 2, archived: 1, total: 3, levels: { rule: 1, fact: 1 }, projects: ['全局'] },
  });
  // workspace chips, one active
  assert.match(html, /DeepSeek-Harness/);
  assert.match(html, /data-active="true"/);
  // the two memories
  assert.match(html, /一律用 pwsh/);
  assert.match(html, /Node 版本是/);
  // level badge localized through the dictionary thunk
  assert.match(html, /t:levelRule/);
  // keyword chips deduplicated
  assert.match(html, /pwsh/);
  // retention bar exists and the fresh memory is weaker than the reinforced one
  const fills = [...html.matchAll(/dmx_barFill" style="width:(\d+)%/g)].map((match) => Number(match[1]));
  assert.equal(fills.length, 2);
  assert.ok(fills[0] > fills[1], `expected rule memory ${fills[0]}% to outlast fact memory ${fills[1]}%`);
});

test('the empty states are distinct: no database vs no match', () => {
  const missing = renderPanel({
    workspaces: [{ id: 'b', title: 'fresh', path: 'E:\\tmp\\fresh', exists: false, active: 0, archived: 0, total: 0, levels: {}, projects: [] }],
    items: [],
    stats: { active: 0, archived: 0, total: 0, levels: {}, projects: [] },
    missing: true,
  });
  assert.match(missing, /t:noBase/);
  const noMatch = renderPanel({
    workspaces: [{ id: 'a', title: 'ws', path: 'E:\\ws', exists: true, active: 1, archived: 0, total: 1, levels: { fact: 1 }, projects: [] }],
    items: [],
    stats: { active: 1, archived: 0, total: 1, levels: { fact: 1 }, projects: [] },
    filter: { query: '不存在的东西' },
  });
  assert.match(noMatch, /t:noMatch/);
});

test('no workspaces renders the guidance state, not a blank page', () => {
  const html = renderPanel({ workspaces: [], items: [], stats: { active: 0, archived: 0, total: 0, levels: {}, projects: [] }, phase: 'ready' });
  assert.match(html, /t:noWorkspace/);
});

test('the stylesheet resets box-sizing inside the panel', () => {
  // The settings shell does not inherit `border-box` into plugin stylesheets.
  // Without this reset the search input (width:100% plus horizontal padding)
  // overflows its flex track and paints over the status control beside it —
  // a defect that only shows up in a real browser, so pin it here.
  const source = readFileSync(bundlePath, 'utf8');
  const reset = /\.dmx_root,\.dmx_root \*,\.dmx_root \*::before,\.dmx_root \*::after\{box-sizing:border-box\}/;
  assert.match(source, reset);
});
