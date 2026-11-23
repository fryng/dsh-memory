/**
 * Message construction for injection.
 *
 * Injected content rides the ordinary message list as a producer-owned
 * `plugin:dsh-memory` source with a `form` of `snapshot` or `recall`: the
 * transcript renders it as one collapsed row, the durable log records where it
 * came from, and the model sees plain text.
 *
 * Session format v4 rejects the retired bare `kind: 'plugin'` wrapper, so the
 * kind must spell out the producing plugin.
 */
import { randomUUID } from 'node:crypto';

/** Producer-owned source kind recorded on every injected message. */
export const PLUGIN_SOURCE_KIND = 'plugin:dsh-memory';

/** Marker embedded in every injected block; also identifies self-injection. */
export const SNAPSHOT_MARKER = '<!--dsh-memory:snapshot-->';
export const RECALL_MARKER = '<!--dsh-memory:recall-->';

/** Cap DSH applies to a one-line `notice` account. */
export const CONTEXT_SUMMARY_MAX_CHARS = 120;

function bound(summary) {
  const text = String(summary ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= CONTEXT_SUMMARY_MAX_CHARS ? text : `${text.slice(0, CONTEXT_SUMMARY_MAX_CHARS - 1)}…`;
}

/**
 * One plugin message carrying text the model should read.
 * @param {{text: string, sections?: Array<{name: string, text: string}>, summary?: string,
 *   form?: 'snapshot'|'recall'|'notice'}} input
 */
export function createPluginTextMessage(input) {
  const form = input.form ?? 'snapshot';
  const source = {
    kind: PLUGIN_SOURCE_KIND,
    plugin: 'dsh-memory',
    form,
    ...(form === 'notice'
      ? { summary: bound(input.summary ?? 'dsh-memory') }
      : form === 'snapshot'
        ? {
            sections:
              Array.isArray(input.sections) && input.sections.length > 0
                ? input.sections
                : [{ name: 'snapshot', text: input.text }],
          }
        : {}),
  };
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: input.text }],
    source,
  };
}
