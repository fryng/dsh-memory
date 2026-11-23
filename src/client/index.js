/**
 * Browser half of dsh-memory: one settings section, the memory manager.
 *
 * Mount contract (verified against the shipped settings sections): a client
 * plugin declares `inject = ['slots', 'locale']`, then registers a
 * `settings.section` entry whose `inject` face is evaluated per render and
 * returns hooks + callbacks. `hooks.<name>` becomes `props.use<Name>(selector)`
 * in the component, backed by `useSyncExternalStore(getSnapshot, subscribe)`.
 *
 * Two invariants worth stating because breaking either is silent:
 * 1. `getSnapshot` must return the same object until something changes, or the
 *    panel re-renders forever. The store only allocates on real transitions.
 * 2. Every registration goes through `ctx.effect`, so an unload takes the slot
 *    entry and the stylesheet's ownership with it.
 */
import { apply as mountSection } from './section-mount.js';

export const name = 'dsh-memory-client';

/**
 * `webServer`/`connection` are NOT listed: the browser half talks HTTP and
 * needs neither cordis service, and a static inject entry for a service a
 * profile lacks leaves the fiber PENDING forever (apply never runs, nothing
 * logs). This is the whole reason both halves use `ctx.inject` for the Host
 * routes instead.
 */
export const inject = ['slots', 'locale'];

export { mountSection as apply };
