/**
 * Panel state.
 *
 * One small observable store, deliberately framework-free: the settings slot
 * gives the component a `useXxx(selector)` hook backed by
 * `useSyncExternalStore`, so the contract is exactly `getSnapshot()` +
 * `subscribe(fn)`. `getSnapshot` returns the SAME object until something
 * actually changes — returning a fresh object every call makes React re-render
 * forever, which is the classic way a panel like this locks up the page.
 */
import { fetchItems, fetchWorkspaces, mutate as mutateRemote } from './api.js';

/** Editor buffers are per open card; keyed by memory id. */
const EMPTY_FILTER = Object.freeze({ status: 'active', level: '', query: '' });

function initialState() {
  return {
    /** 'boot' → 'workspaces' → 'items' → 'ready'; 'error' when the Host refused a read. */
    phase: 'boot',
    workspaces: [],
    dataDir: '.dsh-memory',
    /** Selected workspace path (the Host's canonical realpath). */
    selected: '',
    items: [],
    total: 0,
    stats: { active: 0, archived: 0, levels: {}, projects: [] },
    filter: EMPTY_FILTER,
    /** Memory id currently being saved/archived/restored. */
    busyId: '',
    /** Transient confirmation chip, cleared by the panel after a beat. */
    toast: '',
    /** Why the last read failed, already localized by the store's owner. */
    error: '',
    /** Set when the selected workspace has no database file on disk yet. */
    missing: false,
  };
}

export function createPanelStore({ t }) {
  let state = initialState();
  const listeners = new Set();
  /** Per-id editor drafts: `{content, keywords, importance}` while editing. */
  let drafts = new Map();
  let draftListeners = new Set();

  const emit = () => {
    for (const listener of listeners) listener();
  };
  const emitDrafts = () => {
    for (const listener of draftListeners) listener();
  };

  /** Replace state, keeping the previous snapshot when nothing actually changed. */
  const set = (patch) => {
    let changed = false;
    for (const key of Object.keys(patch)) {
      if (state[key] !== patch[key]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    state = { ...state, ...patch };
    emit();
  };

  const message = (error) => {
    const kind = typeof error?.kind === 'string' ? error.kind : 'unknown';
    if (kind === 'forbidden') return t('errorForbidden');
    if (kind === 'timeout') return t('errorTimeout');
    if (kind === 'unavailable') return t('errorUnavailable');
    if (kind === 'rejected') {
      const detail = typeof error?.message === 'string' && error.message !== 'rejected' ? error.message : '';
      return detail === '' ? t('loadFailed') : detail;
    }
    return t('loadFailed');
  };

  const selectedEntry = () => state.workspaces.find((entry) => entry.path === state.selected);

  /** Read the workspace list, then the selected workspace's first page. */
  async function bootstrap(preferredPath) {
    set({ phase: 'boot', error: '', missing: false });
    let payload;
    try {
      payload = await fetchWorkspaces();
    } catch (error) {
      set({ phase: 'error', error: message(error) });
      return;
    }
    const workspaces = Array.isArray(payload.items) ? payload.items : [];
    const dataDir = typeof payload.dataDir === 'string' ? payload.dataDir : '.dsh-memory';
    const remembered = state.selected !== '' ? state.selected : '';
    const wanted = [preferredPath, remembered, workspaces.find((entry) => entry.exists)?.path, workspaces[0]?.path]
      .filter((entry) => typeof entry === 'string' && entry !== '');
    const selected = wanted.find((path) => workspaces.some((entry) => entry.path === path)) ?? '';
    set({ workspaces, dataDir, selected });
    if (selected === '') {
      set({ phase: 'ready', items: [], total: 0 });
      return;
    }
    await loadItems();
  }

  /** The current page for the selected workspace + filter. */
  async function loadItems() {
    if (state.selected === '') return;
    const entry = selectedEntry();
    // A workspace registered but never used has no database yet; saying "no
    // memory" there would read like a bug rather than a fresh store.
    const missing = entry !== undefined && entry.exists === false;
    set({ phase: 'items', missing });
    try {
      const payload = await fetchItems({
        path: state.selected,
        status: state.filter.status,
        level: state.filter.level,
        query: state.filter.query,
        limit: 200,
        offset: 0,
      });
      set({
        phase: 'ready',
        items: Array.isArray(payload.items) ? payload.items : [],
        total: typeof payload.total === 'number' ? payload.total : 0,
        stats: payload.stats ?? { active: 0, archived: 0, levels: {}, projects: [] },
        // The host answers `exists: false` for a workspace it deliberately did
        // not open, so trust that over the (possibly stale) chip data.
        missing: payload.exists === false || missing,
      });
    } catch (error) {
      set({ phase: 'error', error: message(error) });
    }
  }

  /** Re-read counts only, so the workspace chips stay truthful after a mutation. */
  async function refreshCounts() {
    try {
      const payload = await fetchWorkspaces();
      const workspaces = Array.isArray(payload.items) ? payload.items : state.workspaces;
      set({ workspaces });
    } catch {
      // A failed count refresh must not blank the list the user is reading.
    }
  }

  const toast = (text) => {
    set({ toast: text });
  };

  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /** Draft editors: a second, tiny store so typing does not re-render the list. */
    getDrafts: () => drafts,
    subscribeDrafts: (listener) => {
      draftListeners.add(listener);
      return () => {
        draftListeners.delete(listener);
      };
    },
    openDraft(item) {
      const next = new Map(drafts);
      next.set(item.id, {
        content: item.content,
        keywords: item.keywords,
        importance: item.importance,
      });
      drafts = next;
      emitDrafts();
    },
    closeDraft(id) {
      if (!drafts.has(id)) return;
      const next = new Map(drafts);
      next.delete(id);
      drafts = next;
      emitDrafts();
    },
    editDraft(id, patch) {
      const current = drafts.get(id);
      if (current === undefined) return;
      const next = new Map(drafts);
      next.set(id, { ...current, ...patch });
      drafts = next;
      emitDrafts();
    },

    bootstrap,
    reload: loadItems,
    refresh: async () => {
      await refreshCounts();
      await loadItems();
    },
    select(path) {
      if (state.selected === path) return;
      set({ selected: path, items: [], total: 0, phase: 'items', error: '', missing: false });
      void loadItems();
    },
    setFilter(patch) {
      const filter = { ...state.filter, ...patch };
      set({ filter });
      void loadItems();
    },

    async save(item) {
      const draft = drafts.get(item.id);
      if (draft === undefined) return;
      const patch = {};
      if (draft.content !== item.content) patch.content = draft.content;
      if (draft.keywords !== item.keywords) patch.keywords = draft.keywords;
      if (draft.importance !== item.importance) patch.importance = draft.importance;
      if (Object.keys(patch).length === 0) {
        this.closeDraft(item.id);
        return;
      }
      set({ busyId: item.id });
      try {
        await mutateRemote({ path: state.selected, op: 'update', id: item.id, patch });
        this.closeDraft(item.id);
        toast(t('saved'));
        await this.refresh();
      } catch (error) {
        toast(message(error));
      } finally {
        set({ busyId: '' });
      }
    },

    async archive(item) {
      set({ busyId: item.id });
      try {
        await mutateRemote({ path: state.selected, op: 'archive', id: item.id });
        this.closeDraft(item.id);
        toast(t('archived'));
        await this.refresh();
      } catch (error) {
        toast(message(error));
      } finally {
        set({ busyId: '' });
      }
    },

    async restore(item) {
      set({ busyId: item.id });
      try {
        await mutateRemote({ path: state.selected, op: 'restore', id: item.id });
        toast(t('restored'));
        await this.refresh();
      } catch (error) {
        toast(message(error));
      } finally {
        set({ busyId: '' });
      }
    },

    clearToast() {
      if (state.toast !== '') set({ toast: '' });
    },
  };
}
