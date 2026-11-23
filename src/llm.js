/**
 * Reading optional cordis services, and the independent LLM call used by the
 * writeback channel.
 *
 * Why a raw `ctx.llm.stream()` and not the agent's own turn: an extraction
 * call must not enter the user's session. If it did, it would append events to
 * the transcript, show up in the GUI, count against the turn's context, and
 * destroy the prompt cache — all to produce one JSON string. A separate call
 * whose only product is text keeps the conversation untouched.
 */

export class DelegateError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'DelegateError';
    this.detail = detail;
  }
}

/**
 * Read an OPTIONAL cordis service without throwing.
 *
 * Two accessors exist and both are legitimate: `ctx.<name>` is the live service
 * in a cordis tree (and throws when the name is absent from the plugin's
 * `inject` list), while `ctx.get(name, false)` is cordis's documented
 * non-throwing lookup. A plain context object (a test double, or any host that
 * is not cordis) only has the property. Property-first under try/catch supports
 * all three without weakening the inject guard.
 *
 * @param {object} ctx
 * @param {string} name
 */
export function readService(ctx, name) {
  if (ctx === undefined || ctx === null) return undefined;
  try {
    const value = ctx[name];
    if (value !== undefined && value !== null) return value;
  } catch {
    // not declared in `inject` — fall through to the non-throwing lookup
  }
  if (typeof ctx.get === 'function') {
    try {
      return ctx.get(name, false);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Resolve the route for an extraction call.
 *
 * Unlike an unattended sweeper, this channel always runs INSIDE a live turn, so
 * the agent's own model is available and an empty `writeback.model` is fine.
 * The explicit setting still wins so an operator can point extraction at a
 * cheaper model without touching the main one.
 *
 * @param {{model: string}} cfg
 * @param {{provider?: string, model?: string}|undefined} inherited
 */
export function resolveRoute(cfg, inherited) {
  const explicit = parseModelSpec(cfg?.model ?? '');
  const out = {};
  if (explicit.provider !== undefined) out.provider = explicit.provider;
  else if (inherited?.provider !== undefined) out.provider = inherited.provider;
  if (explicit.model !== undefined) out.model = explicit.model;
  else if (inherited?.model !== undefined) out.model = inherited.model;
  return out;
}

/** `provider/model` spec; empty stays empty (= inherit). */
function parseModelSpec(spec) {  if (typeof spec !== 'string' || spec.trim() === '') return {};
  const idx = spec.indexOf('/');
  if (idx === -1) return { model: spec.trim() };
  const provider = spec.slice(0, idx).trim();
  const model = spec.slice(idx + 1).trim();
  return {
    ...(provider === '' ? {} : { provider }),
    ...(model === '' ? {} : { model }),
  };
}

/** Pull the live agent's model route, when there is an agent to read it from. */
export function inheritedFromAgent(agent) {
  const options = agent?.options ?? {};
  const provider = typeof options.provider === 'string' && options.provider !== '' ? options.provider : undefined;
  const model = typeof options.model === 'string' && options.model !== '' ? options.model : undefined;
  if (provider === undefined && model === undefined) return undefined;
  return { provider, model };
}

/** Human-readable route, for logs. */
export function describeRoute(route) {
  if (route === undefined || (route.provider === undefined && route.model === undefined)) return '(默认模型)';
  return `${route.provider ?? '(继承)'}/${route.model ?? '(继承)'}`;
}

/**
 * One independent model call that returns text.
 *
 * @param {{ctx: object, route: object, prompt: string, system?: string,
 *   signal?: AbortSignal, maxOutputChars?: number, purpose?: string}} input
 * @returns {Promise<{text: string, finish: string, usage: object|undefined}>}
 */
export async function generateText(input) {
  const { ctx, route } = input;
  const llm = readService(ctx, 'llm');
  if (llm === undefined || typeof llm.stream !== 'function') {
    throw new DelegateError('ctx.llm 不可用，无法执行记忆抽取调用');
  }
  if (route?.provider === undefined && route?.model === undefined) {
    throw new DelegateError('没有可用的记忆抽取模型：writeback.model 为空，且当前调用没有可继承的主模型');
  }
  const maxChars = input.maxOutputChars ?? 20_000;
  const options = {
    ...(route.provider === undefined ? {} : { provider: route.provider }),
    ...(route.model === undefined ? {} : { model: route.model }),
    messages: [{ role: 'user', content: [{ type: 'text', text: input.prompt }] }],
    ...(input.system === undefined ? {} : { system: input.system }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    purpose: input.purpose ?? 'dsh-memory/extract',
  };

  let text = '';
  let finish = 'stop';
  let usage;
  let failure;
  for await (const chunk of llm.stream(options)) {
    switch (chunk?.type) {
      case 'text-delta':
        if (typeof chunk.text === 'string') {
          text += chunk.text;
          if (text.length > maxChars) {
            throw new DelegateError(`记忆抽取输出超过 ${maxChars} 字符，已中止`, { chars: text.length });
          }
        }
        break;
      case 'usage':
        usage = chunk.usage ?? usage;
        break;
      case 'finish':
        finish = chunk.reason?.kind ?? 'stop';
        // `FinishReasonMap` attaches the failure at `reason.failure` for both
        // `error` and `aborted`; reading `reason.error` yields undefined, which
        // turns every real provider failure into "unknown".
        if (chunk.reason?.failure !== undefined) failure = chunk.reason.failure;
        break;
      default:
        break;
    }
  }
  if (finish === 'aborted') {
    throw new DelegateError(`记忆抽取被中断：${failure?.message ?? failure?.code ?? '未提供原因'}`, { finish });
  }
  if (finish === 'error') {
    throw new DelegateError(`记忆抽取失败：${failure?.message ?? failure?.code ?? '未提供原因'}`, { finish });
  }
  return { text, finish, usage };
}
