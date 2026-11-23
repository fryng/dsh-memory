/**
 * Make a throwaway profile resolve plugins the way a real profile does, without
 * installing anything.
 *
 * Why this exists: a profile loads its bundles out of `<profile>/node_modules`,
 * and a bundle's own `cordis.patch.yml` names dozens of `@deepseek-ai/*` packages
 * that pnpm hoisted **nested** under each bundle (`node_modules/@deepseek-ai/dsh-base/node_modules/...`).
 * Node's resolver walks up parent directories, but those nested packages are not
 * in any ancestor's scope directory, so every one of them has to be visible from
 * `<profile>/node_modules`. A single junction of the whole `@deepseek-ai` scope is
 * not enough — it only exposes the scope's top level, which is exactly the hoisted
 * subset that omits the nested ones.
 *
 * So: collect every `@deepseek-ai/*` package reachable anywhere in the installation
 * tree (`<...>/node_modules/@deepseek-ai/<pkg>`), then link each one into the
 * profile's scope directory. First occurrence wins, deepest included. Additive and
 * idempotent: existing links are reported and left alone.
 *
 * Usage: node plugins/dsh-memory/scripts/link-profile-deps.mjs [--profile mem-verify] [--repo <path>]
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Every `@deepseek-ai/*` package in the installation tree, shallowest first. */
function discoverPackages(repoRoot) {
  const found = new Map();
  const queue = [join(repoRoot, 'node_modules')];
  const seen = new Set();
  while (queue.length > 0) {
    const modulesDir = queue.shift();
    if (seen.has(modulesDir) || !existsSync(modulesDir)) continue;
    seen.add(modulesDir);
    const scope = join(modulesDir, '@deepseek-ai');
    if (existsSync(scope)) {
      for (const name of readdirSync(scope)) {
        const packageDir = join(scope, name);
        if (!existsSync(join(packageDir, 'package.json'))) continue;
        if (!found.has(name)) found.set(name, packageDir);
        // Follow a bundle's own nested tree as well.
        const nested = join(packageDir, 'node_modules');
        if (existsSync(nested)) queue.push(nested);
      }
    }
    for (const entry of readdirSync(modulesDir)) {
      if (entry.startsWith('@') || entry.startsWith('.')) continue;
      const nested = join(modulesDir, entry, 'node_modules');
      if (existsSync(nested)) queue.push(nested);
    }
  }
  return found;
}

/**
 * Link every installation `@deepseek-ai/*` package into `<profile>/node_modules/@deepseek-ai`.
 * @returns {{profileDir: string, available: number, linked: string[], skipped: number}}
 */
export function linkProfileDeps({ repoRoot = resolve(here, '..', '..', '..'), profileName = 'mem-verify' } = {}) {
  const dshHome = process.env.DSH_HOME ?? join(repoRoot, '.dsh');
  const profileDir = join(dshHome, 'profiles', profileName);
  const scopeDir = join(profileDir, 'node_modules', '@deepseek-ai');
  if (!existsSync(profileDir)) throw new Error(`profile 目录不存在：${profileDir}`);

  const packages = discoverPackages(repoRoot);

  /**
   * An earlier version linked the whole `@deepseek-ai` scope as one junction,
   * which hides every nested package. Replace such a link with a real directory;
   * a real directory (from a previous run) is kept.
   */
  if (existsSync(scopeDir) && lstatSync(scopeDir).isSymbolicLink()) unlinkSync(scopeDir);
  mkdirSync(scopeDir, { recursive: true });

  const linked = [];
  let skipped = 0;
  for (const [name, target] of [...packages].sort(([left], [right]) => left.localeCompare(right))) {
    const linkPath = join(scopeDir, name);
    if (existsSync(linkPath)) {
      skipped += 1;
      continue;
    }
    symlinkSync(target, linkPath, 'junction');
    linked.push(name);
  }
  return { profileDir, available: packages.size, linked, skipped };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argOf = (flag, fallback) => {
    const index = process.argv.indexOf(flag);
    return index === -1 ? fallback : process.argv[index + 1];
  };
  const repoRoot = resolve(argOf('--repo', resolve(here, '..', '..', '..')));
  const result = linkProfileDeps({ repoRoot, profileName: argOf('--profile', 'mem-verify') });
  console.log(`- 可解析的 @deepseek-ai 包：${result.available}`);
  console.log(result.linked.length === 0 ? '- 没有需要新建的链接。' : `- 新建链接 ${result.linked.length} 个：\n${result.linked.map((name) => `    ${name}`).join('\n')}`);
  if (result.skipped > 0) console.log(`- 已存在跳过 ${result.skipped} 个。`);
  console.log(`\nprofile: ${result.profileDir}`);
}
