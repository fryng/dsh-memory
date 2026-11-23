/**
 * The fixed system-prompt section.
 *
 * Prompt-cache note (this is the whole reason the file is this small): the text
 * handed to `ctx.systemPrompt.section()` is byte-stable for the process
 * lifetime. It never interpolates the current memory, a timestamp, a count, or
 * anything else that changes between turns. Everything dynamic rides the
 * message list (see `injection.js`), which the harness already treats as durable
 * context. A section that changed every turn would invalidate the provider's
 * cached prefix on every single request — a silent slowdown that looks like
 * "the model got slower", not like a bug.
 *
 * `section()` accepts `string | ((context) => string)`; we deliberately pass a
 * string.
 */
import { resolveSlotText } from '../prompts.js';

export const SECTION_NAME = 'dsh-memory-guide';

/** After the persona (order 0) and after built-in sections (negative orders). */
export const SECTION_ORDER = 1000;

/**
 * Register the guide in the calling context's scope.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} lang
 * @returns {() => void} disposer (wrap in `ctx.effect` at the call site)
 */
export function registerSystemGuide(ctx, lang) {
  const text = resolveSlotText('system-guide', lang);
  return ctx.systemPrompt.section({ name: SECTION_NAME, order: SECTION_ORDER, text });
}
