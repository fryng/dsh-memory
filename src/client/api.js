/**
 * Browser side of the memory API.
 *
 * Paths are DOCUMENT-relative on purpose: the Host serves the app under a base
 * href of "./", so a root-absolute "/api/…" would resolve against the origin
 * root and miss a forward-mounted Host. The route keys are root-absolute, so
 * stripping the leading slash at this boundary is the documented bridge
 * between the two halves.
 */
const API_ROOT = '/api/dsh-memory';
const PREFIX = API_ROOT.slice(1);

/** Milliseconds before a hung Host read is abandoned rather than spinning forever. */
const REQUEST_TIMEOUT_MS = 15000;

export class ApiError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
  }
}

/** POST JSON and unwrap the `{ok, …}` envelope. */
async function post(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${PREFIX}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    if (controller.signal.aborted) throw new ApiError('timeout', 'timeout');
    throw new ApiError('unreachable', error instanceof Error ? error.message : String(error));
  }
  clearTimeout(timer);
  if (response.status === 401 || response.status === 403) throw new ApiError('forbidden', 'forbidden');
  if (response.status === 503) throw new ApiError('unavailable', 'unavailable');
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError('bad-response', 'bad response');
  }
  if (payload === null || typeof payload !== 'object') throw new ApiError('bad-response', 'bad response');
  if (payload.ok !== true) {
    throw new ApiError('rejected', typeof payload.error === 'string' ? payload.error : 'rejected');
  }
  return payload;
}

/** Workspaces with their memory counts. */
export function fetchWorkspaces() {
  return post('workspaces', {});
}

/**
 * One page of memories.
 * @param {{path: string, status?: string, level?: string, project?: string,
 *   query?: string, limit?: number, offset?: number}} request
 */
export function fetchItems(request) {
  return post('items', request);
}

/**
 * update / archive / restore one memory.
 * @param {{path: string, op: 'update'|'archive'|'restore', id: string, patch?: object}} request
 */
export function mutate(request) {
  return post('mutate', request);
}
