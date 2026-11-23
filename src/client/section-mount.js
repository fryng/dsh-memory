/**
 * Registration glue: stylesheet, dictionaries, the panel store, and the
 * `settings.section` entry.
 *
 * Kept separate from `index.js` so the entry file stays a two-line contract
 * (`inject` + `apply`) and this file can be read as the actual mount logic.
 */
import { installStyles } from './css.js';
import { NS, dictFor } from './locale.js';
import { createPanelStore } from './store.js';
import { MemorySection } from './section.jsx';

/** After the shipped sections (general 0, models 10, plugins 15, presets 20, account). */
const SECTION_ORDER = 25;

/**
 * Mount the section.
 * @param {object} ctx browser plugin context with `slots` and `locale`
 */
export function apply(ctx) {
  installStyles(typeof document === 'undefined' ? undefined : document);

  // `bind` is cached per namespace by the locale service, so this reference is
  // stable across renders and remains a valid translation function after a
  // language switch (it re-reads the active locale on every call).
  const t = ctx.locale.bind(NS);

  ctx.effect(() => ctx.locale.register(NS, { zh: dictFor('zh'), en: dictFor('en') }), 'dsh-memory: section dictionaries');

  // One store per mount. It holds no timers and no subscriptions of its own, so
  // an unload needs no teardown beyond dropping the reference.
  const store = createPanelStore({ t });

  // The drafts hook object is hoisted: `inject` is evaluated on every render,
  // and a fresh hook object each time would defeat the framework's memoized
  // hook wiring even though the functions inside are stable.
  const draftsHook = { getSnapshot: store.getDrafts, subscribe: store.subscribeDrafts };

  /** Evaluated per render: the hooks and callbacks the component receives. */
  const injected = () => ({
    hooks: {
      memoryPanel: store,
      memoryDrafts: draftsHook,
    },
    bootstrap: () => store.bootstrap(),
    reload: () => store.reload(),
    refresh: () => store.refresh(),
    select: (path) => store.select(path),
    setFilter: (patch) => store.setFilter(patch),
    openDraft: (item) => store.openDraft(item),
    editDraft: (id, patch) => store.editDraft(id, patch),
    closeDraft: (id) => store.closeDraft(id),
    save: (item) => store.save(item),
    archive: (item) => store.archive(item),
    restore: (item) => store.restore(item),
    clearToast: () => store.clearToast(),
  });

  ctx.effect(
    () =>
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'memory',
            order: SECTION_ORDER,
            label: () => ctx.locale.bind(NS)('nav'),
            locale: NS,
            inject: injected,
          },
          MemorySection,
        ),
      ),
    'dsh-memory: settings section',
  );
}
