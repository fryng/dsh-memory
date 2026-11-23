/**
 * Prove dsh-memory mounts inside the REAL `web` profile — the same profile the
 * desktop app and `dsh web` use — rather than only inside a throwaway one.
 *
 * Why not `boot()` directly: the web bundle forces `webserver` / `web-runtime` /
 * `connection` to activate, and those need `cmdlineArgs`, `profileContext` and the
 * package resolution that only the real launcher (`runProfile`) provides. So this
 * script drives `runProfile` with a real argument vector and then reads the live
 * registry out of the returned context.
 *
 * The machine-wide task-board ledger is owned by the running desktop app, so that
 * one entry logs a warning and stays inactive; nothing else is touched.
 *
 * Usage (from the checkout root):
 *   node plugins/dsh-memory/scripts/verify-web-profile.mjs
 */
import { createRequire } from 'node:module';
import { runProfile } from '@deepseek-ai/dsh/lib/profile-boot.js';
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import { MEMORY_API_PREFIX } from '../src/host-routes.js';

const require = createRequire(import.meta.url);
const installAnchor = require.resolve('@deepseek-ai/dsh/package.json');
void installAnchor;

const say = (line = '') => process.stdout.write(`${line}\n`);
const environment = loadLayeredEnv('dsh', process.cwd());

const { ctx, shutdown } = await runProfile({
  environment,
  profile: 'web',
  patchFiles: [],
  args: ['--port', '57995', '--host', '127.0.0.1', '--no-open'],
});

/**
 * Authenticate like the browser does: the connection service mints the signed
 * session cookie from the process launch token, and the shell then sends that
 * cookie on every API call.
 * @param {object} connection
 * @param {string} origin
 * @returns {Promise<string>} the Cookie header value, or '' when unavailable
 */
async function mintCookie(connection, origin) {
  let tokenUrl;
  try {
    tokenUrl = connection.authenticatedUrl(`${origin}/`);
  } catch {
    return '';
  }
  const token = new URL(tokenUrl).searchParams.get('token');
  if (token === null) return '';
  const response = await fetch(`${origin}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
  const cookies = response.headers.getSetCookie?.() ?? [];
  if (cookies.length === 0) return '';
  return cookies.map((entry) => entry.split(';')[0]).join('; ');
}

let failed = false;
try {
  const tools = ctx.get('tools');
  const names = tools.schemas().map((schema) => schema.name).sort();
  const mine = names.filter((name) => name.startsWith('memory_'));
  say(`web profile 工具总数: ${names.length}`);
  say(`dsh-memory 工具（${mine.length}）: ${mine.join(', ') || '（无）'}`);
  if (mine.length !== 5) {
    failed = true;
    say(`  ✗ 期望 5 个 dsh-memory 工具，实际 ${mine.length}`);
  }

  const systemPrompt = ctx.get('systemPrompt');
  const assembly = await systemPrompt.assemble();
  const guide = assembly.sections.find((section) => section.name === 'dsh-memory-guide');
  say(`system prompt guide 段: ${guide === undefined ? '缺失' : `${guide.text.length} 字`}`);
  if (guide === undefined) {
    failed = true;
    say('  ✗ guide 段没有进入 web profile 的 system prompt');
  }

  // The browser half is only loaded if `dsh.client` was picked up and its bundle
  // composed into the boot graph — a package with the declaration but no
  // exported bundle throws at scan time, so reaching here already means the
  // manifest is valid; clientPath proves the bytes were found.
  const clientModules = ctx.get('clientModules');
  const bundlePath = clientModules?.clientPath?.('dsh-memory');
  say(`客户端 bundle: ${bundlePath ?? '未进入启动图'}`);
  if (bundlePath === undefined) {
    failed = true;
    say('  ✗ dsh-memory 的浏览器半边没有进入 __DSH_BOOT__ 启动图');
  } else {
    say(`  设置页入口: settings.section id=memory order=25（${bundlePath}）`);
  }

  // The three manager routes live behind `ctx.inject(['webServer','connection'])`.
  // Probe twice: unauthenticated (the fence must refuse) and authenticated (the
  // route must answer with the JSON envelope the browser half expects).
  const origin = ctx.get('webServer')?.getOrigin?.();
  say(`webServer 地址: ${origin ?? '（未暴露）'}`);
  if (origin !== undefined) {
    const cookie = await mintCookie(ctx.get('connection'), origin);
    say(`  会话 cookie: ${cookie === '' ? '未获得（只做拒绝性探测）' : '已获得'}`);
    for (const suffix of ['/workspaces', '/items', '/mutate']) {
      const anonymous = await fetch(`${origin}${MEMORY_API_PREFIX}${suffix}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      say(`  POST ${suffix}（无 cookie）→ ${anonymous.status}`);
      if (anonymous.status === 200) {
        failed = true;
        say(`  ✗ ${suffix} 在未认证请求下返回了 200`);
      }
      if (anonymous.status === 404) {
        failed = true;
        say(`  ✗ ${suffix} 路由不存在（ctx.inject 没有挂上）`);
      }
    }
    if (cookie !== '') {
      const authorized = await fetch(`${origin}${MEMORY_API_PREFIX}/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: '{}',
      });
      const payload = await authorized.json().catch(() => undefined);
      say(
        `  POST /workspaces（带 cookie）→ ${authorized.status} 工作区 ${payload?.items?.length ?? '?'} 个 · dataDir ${payload?.dataDir ?? '?'}`,
      );
      if (authorized.status !== 200 || payload?.ok !== true) {
        failed = true;
        say('  ✗ 已认证请求没有拿到工作区列表');
      }
    }
  }

  // The command registry is a separate optional service; report it, never fail on it.
  try {
    const commands = ctx.get('commands');
    say(`commands 服务: ${commands === undefined ? '未挂载' : '已挂载'}`);
  } catch (error) {
    say(`  （commands 服务不可读：${error?.message ?? error}）`);
  }

  say(failed ? '\nweb profile 挂载核验失败 ✗' : '\nweb profile 挂载核验通过 ✓');
} finally {
  await shutdown.shutdown(failed ? 1 : 0);
}
process.exit(failed ? 1 : 0);
