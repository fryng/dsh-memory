/**
 * Mount this plugin into a DSH profile — the "developer checkout" path.
 *
 * DSH resolves a profile plugin by package name out of
 * `<profile>/node_modules/<name>`, so mounting a local checkout means:
 *
 *   1. a Windows directory junction `<profile>/node_modules/<name>` → this
 *      plugin's checkout, so `node build.mjs` is the whole iteration loop;
 *   2. `<name>` appended to `dsh.profile.bundles` in `<profile>/package.json`,
 *      which is what makes DSH compose this plugin's `cordis.patch.yml` layer.
 *
 * Additive and idempotent, and it NEVER deletes: an existing link is reported
 * and left alone, and the bundle list only ever gains the name at the end. The
 * user's own `cordis.patch.yml` is never touched — overrides stay where the
 * user put them.
 *
 * Usage:
 *   node scripts/mount.mjs [--profile web] [--dsh-home <path>] [--print-only]
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_NAME = 'dsh-memory';

function parseArgs(argv) {
  const options = { profile: 'web', dshHome: undefined, printOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--profile') options.profile = argv[++i];
    else if (arg === '--dsh-home') options.dshHome = argv[++i];
    else if (arg === '--print-only') options.printOnly = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  return options;
}

function usage() {
  return [
    '把本插件挂载进 DSH profile（开发者本地路径）：',
    '  node scripts/mount.mjs [--profile web] [--dsh-home <DSH_HOME>] [--print-only]',
    '',
    '默认 DSH_HOME 取环境变量 DSH_HOME，否则取插件所在仓库的 .dsh 目录。',
  ].join('\n');
}

const options = parseArgs(process.argv.slice(2));
if (options.help === true) {
  console.log(usage());
  process.exit(0);
}

const dshHome = options.dshHome
  ?? process.env.DSH_HOME
  ?? join(dirname(dirname(dirname(PLUGIN_DIR))), '.dsh');
const profileDir = join(dshHome, 'profiles', options.profile);
const modulesDir = join(profileDir, 'node_modules');
const linkPath = join(modulesDir, PLUGIN_NAME);
const profileJsonPath = join(profileDir, 'package.json');

const steps = [];

if (!existsSync(profileDir)) {
  throw new Error(`profile 目录不存在：${profileDir}`);
}
if (!existsSync(join(PLUGIN_DIR, 'lib', 'index.js'))) {
  throw new Error(`插件尚未构建：缺少 ${join(PLUGIN_DIR, 'lib', 'index.js')}，请先运行 node build.mjs`);
}

// 1) the junction -----------------------------------------------------------
if (existsSync(linkPath)) {
  const stat = lstatSync(linkPath);
  steps.push(`跳过：${linkPath} 已存在（${stat.isSymbolicLink() ? '链接/联接' : '实体目录'}），保持原样不动。`);
} else if (options.printOnly) {
  steps.push(`将创建目录联接：${linkPath} → ${PLUGIN_DIR}`);
} else {
  mkdirSync(modulesDir, { recursive: true });
  // 'junction' is the Windows-native directory link; elsewhere a directory
  // symlink has the same effect. Neither needs admin rights.
  symlinkSync(PLUGIN_DIR, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  steps.push(`已创建目录联接：${linkPath} → ${PLUGIN_DIR}`);
}

// 2) the bundle list --------------------------------------------------------
if (!existsSync(profileJsonPath)) {
  throw new Error(`profile 缺少 package.json：${profileJsonPath}`);
}
const raw = readFileSync(profileJsonPath, 'utf8');
const profile = JSON.parse(raw);
if (profile.dsh === undefined) profile.dsh = {};
if (profile.dsh.profile === undefined) profile.dsh.profile = {};
if (!Array.isArray(profile.dsh.profile.bundles)) profile.dsh.profile.bundles = [];
const bundles = profile.dsh.profile.bundles;

if (bundles.includes(PLUGIN_NAME)) {
  steps.push(`跳过：dsh.profile.bundles 已包含 ${PLUGIN_NAME}。`);
} else {
  bundles.push(PLUGIN_NAME);
  const next = `${JSON.stringify(profile, null, 2)}\n`;
  if (options.printOnly) {
    steps.push(`将把 ${PLUGIN_NAME} 追加到 dsh.profile.bundles：${profileJsonPath}`);
  } else {
    const backup = `${profileJsonPath}.bak-${PLUGIN_NAME}`;
    if (!existsSync(backup)) copyFileSync(profileJsonPath, backup);
    writeFileSync(profileJsonPath, next, 'utf8');
    steps.push(`已把 ${PLUGIN_NAME} 追加到 dsh.profile.bundles（原文件备份：${backup}）。`);
  }
}

console.log(steps.map((step) => `- ${step}`).join('\n'));
console.log('');
console.log('下一步：验证挂载是否生效');
console.log(`  dsh --profile ${options.profile} --dump-config | Select-String "${PLUGIN_NAME}"`);
console.log('  重启 dsh web 后，插件日志里应出现 "dsh-memory 已挂载" 一行。');
