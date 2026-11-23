#!/usr/bin/env node
/**
 * dsh-memory installer / doctor.
 *
 * DSH resolves a profile bundle by package name out of
 * `<profile>/node_modules/<name>`, so "installing" this plugin means exactly two
 * things:
 *
 *   1. the package is resolvable at `<DSH_HOME>/profiles/<profile>/node_modules/dsh-memory`
 *      — either because npm put it there, or because this CLI linked/copied it;
 *   2. `dsh-memory` is listed in `<profile>/package.json` under
 *      `dsh.profile.bundles`, which is what makes DSH compose this package's
 *      `cordis.patch.yml` layer.
 *
 * Everything here is additive and idempotent. Nothing is deleted except by an
 * explicit `uninstall`, and even then the profile's package.json is backed up
 * first. The user's own `cordis.patch.yml` is never touched: overrides belong
 * where the user put them.
 *
 * Usage:
 *   dsh-memory install   [--profile web] [--dsh-home <path>] [--copy] [--print-only] [--force]
 *   dsh-memory status    [--profile web] [--dsh-home <path>]
 *   dsh-memory uninstall [--profile web] [--dsh-home <path>]
 *   dsh-memory doctor    [--profile web] [--dsh-home <path>]
 *   dsh-memory prune     [--root <path>] [--dry-run]
 */
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, platform } from 'node:os';
import { spawnSync } from 'node:child_process';

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_NAME = 'dsh-memory';
const PLUGIN_VERSION = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8')).version;

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    command: argv[0] && !argv[0].startsWith('-') ? argv[0] : 'install',
    profile: 'web',
    dshHome: undefined,
    copy: false,
    printOnly: false,
    force: false,
    dryRun: false,
    root: undefined,
  };
  const start = argv[0] && !argv[0].startsWith('-') ? 1 : 0;
  for (let i = start; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--profile': options.profile = argv[++i]; break;
      case '--dsh-home': options.dshHome = argv[++i]; break;
      case '--root': options.root = argv[++i]; break;
      case '--copy': options.copy = true; break;
      case '--link': options.copy = false; break;
      case '--print-only': options.printOnly = true; break;
      case '--force': options.force = true; break;
      case '--dry-run': options.dryRun = true; break;
      case '--help': case '-h': options.help = true; break;
      case '--version': case '-v': options.version = true; break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function usage() {
  return [
    `dsh-memory ${PLUGIN_VERSION} — installer`,
    '',
    'Commands:',
    '  install     link (or --copy) this package into a DSH profile and add it to dsh.profile.bundles',
    '  status      show whether the plugin is installed in a profile',
    '  uninstall   remove the link/copy and the bundle entry (profile package.json is backed up)',
    '  doctor      check every precondition (node version, build artifacts, profile, mount)',
    '  prune       delete empty .dsh-memory databases under --root (alias of scripts/prune-empty.mjs)',
    '',
    'Options:',
    '  --profile <name>    DSH profile name (default: web)',
    '  --dsh-home <path>   DSH_HOME; auto-detected from $DSH_HOME and the usual desktop locations',
    '  --copy              copy the package instead of linking it (for locked-down file systems)',
    '  --print-only        report the plan, change nothing',
    '  --force             reinstall over an existing, different dsh-memory entry',
    '  --root <path>       prune: directory to scan (default: current directory)',
    '  --dry-run           prune: list what would be deleted',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// DSH_HOME discovery
// ---------------------------------------------------------------------------

function candidateHomes() {
  const list = [];
  if (process.env.DSH_HOME) list.push({ path: process.env.DSH_HOME, from: 'DSH_HOME' });
  const appData = process.env.APPDATA;
  const localAppData = process.env.LOCALAPPDATA;
  if (platform() === 'win32') {
    if (appData) list.push({ path: join(appData, 'dsh-desktop', 'dsh-home'), from: '%APPDATA%' });
    if (appData) list.push({ path: join(appData, 'dsh-desktop'), from: '%APPDATA%' });
    if (localAppData) list.push({ path: join(localAppData, 'dsh-desktop', 'dsh-home'), from: '%LOCALAPPDATA%' });
  } else if (platform() === 'darwin') {
    list.push({ path: join(homedir(), 'Library', 'Application Support', 'dsh-desktop', 'dsh-home'), from: 'Application Support' });
    list.push({ path: join(homedir(), 'Library', 'Application Support', 'dsh-desktop'), from: 'Application Support' });
  } else {
    const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
    list.push({ path: join(configHome, 'dsh-desktop', 'dsh-home'), from: 'XDG_CONFIG_HOME' });
  }
  list.push({ path: join(homedir(), '.dsh'), from: '~/.dsh' });
  list.push({ path: join(process.cwd(), '.dsh'), from: 'cwd/.dsh' });
  return list;
}

function looksLikeHome(path) {
  return existsSync(join(path, 'profiles'));
}

function resolveDshHome(options) {
  if (options.dshHome) {
    const p = resolve(options.dshHome);
    if (!looksLikeHome(p)) {
      throw new Error(
        `${p} does not look like a DSH_HOME (no profiles/ directory).\n` +
        'Point --dsh-home at the directory that contains profiles/web.',
      );
    }
    return p;
  }
  const seen = new Set();
  for (const candidate of candidateHomes()) {
    const p = resolve(candidate.path);
    if (seen.has(p)) continue;
    seen.add(p);
    if (looksLikeHome(p)) return p;
  }
  throw new Error(
    'could not find DSH_HOME automatically.\n' +
    'Pass it explicitly: dsh-memory install --dsh-home <path-to-.dsh>\n' +
    'Candidates checked:\n' +
    candidateHomes().map((c) => `  - ${c.path} (${c.from})`).join('\n'),
  );
}

function profilePaths(dshHome, profileName) {
  const profileDir = join(dshHome, 'profiles', profileName);
  return {
    profileDir,
    profileJson: join(profileDir, 'package.json'),
    modulesDir: join(profileDir, 'node_modules'),
    target: join(profileDir, 'node_modules', PLUGIN_NAME),
  };
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function samePath(a, b) {
  try {
    return realpathSync(a).toLowerCase() === realpathSync(b).toLowerCase();
  } catch {
    return false;
  }
}

/** Returns 'link' | 'copy' | 'absent' for the profile's dsh-memory entry. */
function entryKind(target) {
  if (!existsSync(target)) return 'absent';
  try {
    return lstatSync(target).isSymbolicLink() ? 'link' : 'copy';
  } catch {
    return 'copy';
  }
}

function copyDir(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) copyDir(source, target);
    else if (entry.isFile()) copyFileSync(source, target);
  }
}

function copyPackage(from, to) {
  mkdirSync(to, { recursive: true });
  for (const file of ['package.json', 'cordis.patch.yml', 'LICENSE', 'README.md']) {
    if (existsSync(join(from, file))) copyFileSync(join(from, file), join(to, file));
  }
  for (const dir of ['lib', 'src', 'scripts']) {
    if (existsSync(join(from, dir))) copyDir(join(from, dir), join(to, dir));
  }
}

function backupProfileJson(profileJson) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${profileJson}.bak-${PLUGIN_NAME}-${stamp}`;
  copyFileSync(profileJson, backup);
  return backup;
}

function readBundles(profile) {
  const bundles = profile?.dsh?.profile?.bundles;
  return Array.isArray(bundles) ? bundles : [];
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

function preflight(options) {
  const problems = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const nodeMinor = Number(process.versions.node.split('.')[1]);
  if (!(nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 5))) {
    problems.push(`Node ${process.versions.node} — this plugin needs node:sqlite, i.e. Node >= 22.5 (DSH ships its own runtime, so this matters mainly when running the CLI or the tests).`);
  }
  for (const artifact of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml']) {
    if (!existsSync(join(PLUGIN_DIR, artifact))) problems.push(`missing build artifact: ${artifact} (run: npm run build)`);
  }
  if (problems.length > 0) {
    throw new Error(`preflight failed:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
}

function install(options) {
  preflight(options);
  const dshHome = resolveDshHome(options);
  const paths = profilePaths(dshHome, options.profile);
  if (!existsSync(paths.profileJson)) {
    throw new Error(`profile not found: ${paths.profileJson}\nAvailable profiles: ${availableProfiles(dshHome).join(', ') || '(none)'}`);
  }

  const steps = [];
  const kind = entryKind(paths.target);
  const alreadyThis = kind !== 'absent' && samePath(paths.target, PLUGIN_DIR);

  if (alreadyThis) {
    steps.push(`keep: ${paths.target} already provides this plugin`);
  } else if (kind !== 'absent' && !options.force) {
    steps.push(`keep: ${paths.target} exists (${kind}) and is a different installation — leaving it alone (use --force to replace it)`);
  } else if (options.printOnly) {
    steps.push(`plan: ${kind === 'absent' ? 'create' : 'replace'} ${paths.target} (${options.copy ? 'copy' : 'link'})`);
  } else {
    if (kind !== 'absent') rmSync(paths.target, { recursive: true, force: true });
    mkdirSync(paths.modulesDir, { recursive: true });
    if (options.copy) {
      copyPackage(PLUGIN_DIR, paths.target);
      steps.push(`copied ${PLUGIN_NAME}@${PLUGIN_VERSION} → ${paths.target}`);
    } else {
      symlinkSync(PLUGIN_DIR, paths.target, platform() === 'win32' ? 'junction' : 'dir');
      steps.push(`linked ${paths.target} → ${PLUGIN_DIR}`);
    }
  }

  const profile = readJson(paths.profileJson);
  const bundles = readBundles(profile);
  if (bundles.includes(PLUGIN_NAME)) {
    steps.push(`keep: dsh.profile.bundles already contains ${PLUGIN_NAME}`);
  } else {
    if (options.printOnly) {
      steps.push(`plan: append ${PLUGIN_NAME} to dsh.profile.bundles in ${paths.profileJson}`);
    } else {
      profile.dsh ??= {};
      profile.dsh.profile ??= {};
      profile.dsh.profile.bundles = [...bundles, PLUGIN_NAME];
      const backup = backupProfileJson(paths.profileJson);
      writeFileSync(paths.profileJson, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
      steps.push(`added ${PLUGIN_NAME} to dsh.profile.bundles (backup: ${backup})`);
    }
  }

  console.log(steps.map((step) => `- ${step}`).join('\n'));
  console.log('');
  console.log(`DSH_HOME: ${dshHome}`);
  console.log(`profile:  ${paths.profileDir}`);
  console.log('');
  console.log('Next: restart DSH, then check the plugin log line "dsh-memory 已挂载"');
  console.log('and open Settings → 记忆 (Memory). Verify from the CLI with:');
  console.log(`  dsh-memory status --profile ${options.profile} --dsh-home "${dshHome}"`);
}

function status(options) {
  const dshHome = resolveDshHome(options);
  const paths = profilePaths(dshHome, options.profile);
  const profileExists = existsSync(paths.profileJson);
  const kind = entryKind(paths.target);
  const bundles = profileExists ? readBundles(readJson(paths.profileJson)) : [];
  const built = existsSync(join(PLUGIN_DIR, 'lib', 'index.js')) && existsSync(join(PLUGIN_DIR, 'lib', 'client.js'));

  console.log(`plugin:            ${PLUGIN_NAME}@${PLUGIN_VERSION}`);
  console.log(`plugin dir:        ${PLUGIN_DIR}`);
  console.log(`build artifacts:   ${built ? 'ok' : 'missing (npm run build)'}`);
  console.log(`DSH_HOME:          ${dshHome}`);
  console.log(`profile:           ${paths.profileDir}${profileExists ? '' : ' (missing)'}`);
  console.log(`node_modules entry:${kind === 'absent' ? ' absent' : ` ${kind}${samePath(paths.target, PLUGIN_DIR) ? ' (points at the plugin running this CLI)' : ''}`}`);
  console.log(`profile bundles:   ${bundles.length === 0 ? '(none)' : bundles.join(', ')}`);
  const mounted = profileExists && kind !== 'absent' && bundles.includes(PLUGIN_NAME);
  console.log('');
  console.log(mounted ? 'status: mounted' : 'status: not mounted — run: dsh-memory install');
  if (!mounted) process.exitCode = 1;
}

function uninstall(options) {
  const dshHome = resolveDshHome(options);
  const paths = profilePaths(dshHome, options.profile);
  if (!existsSync(paths.profileJson)) throw new Error(`profile not found: ${paths.profileJson}`);
  const steps = [];

  // Only refuse when the profile's entry *is* this directory, not when it links
  // to it: a junction in another path is exactly what install creates, and it
  // must stay removable.
  const isSelf = resolve(paths.target).toLowerCase() === PLUGIN_DIR.toLowerCase();
  const kind = entryKind(paths.target);
  if (kind === 'absent') {
    steps.push(`keep: nothing at ${paths.target}`);
  } else if (isSelf) {
    steps.push(`keep: ${paths.target} is the plugin directory running this CLI — remove it manually if that is really what you want`);
  } else if (options.printOnly) {
    steps.push(`plan: remove ${paths.target} (${kind})`);
  } else if (kind === 'link') {
    unlinkSync(paths.target);
    steps.push(`removed link ${paths.target}`);
  } else {
    rmSync(paths.target, { recursive: true, force: true });
    steps.push(`removed copy ${paths.target}`);
  }

  const profile = readJson(paths.profileJson);
  const bundles = readBundles(profile);
  if (!bundles.includes(PLUGIN_NAME)) {
    steps.push(`keep: dsh.profile.bundles does not contain ${PLUGIN_NAME}`);
  } else if (options.printOnly) {
    steps.push(`plan: drop ${PLUGIN_NAME} from dsh.profile.bundles`);
  } else {
    profile.dsh.profile.bundles = bundles.filter((name) => name !== PLUGIN_NAME);
    const backup = backupProfileJson(paths.profileJson);
    writeFileSync(paths.profileJson, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
    steps.push(`dropped ${PLUGIN_NAME} from dsh.profile.bundles (backup: ${backup})`);
  }

  console.log(steps.map((step) => `- ${step}`).join('\n'));
  console.log('');
  console.log('Memory databases are untouched: they live in each workspace under .dsh-memory/.');
}

function doctor(options) {
  const lines = [];
  let failures = 0;
  const check = (label, fn) => {
    try {
      const detail = fn();
      lines.push(`ok   ${label}${detail ? ` — ${detail}` : ''}`);
    } catch (error) {
      failures += 1;
      lines.push(`FAIL ${label} — ${error.message}`);
    }
  };

  check('node >= 22.5', () => {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (!(major > 22 || (major === 22 && minor >= 5))) throw new Error(process.versions.node);
    return process.versions.node;
  });
  check('build artifacts', () => {
    for (const artifact of ['lib/index.js', 'lib/client.js']) {
      if (!existsSync(join(PLUGIN_DIR, artifact))) throw new Error(`missing ${artifact}`);
    }
    return 'lib/index.js, lib/client.js';
  });
  check('cordis.patch.yml', () => {
    if (!existsSync(join(PLUGIN_DIR, 'cordis.patch.yml'))) throw new Error('missing');
    return 'present';
  });
  check('DSH_HOME', () => resolveDshHome(options));
  let dshHome;
  try {
    dshHome = resolveDshHome(options);
  } catch {
    dshHome = undefined;
  }
  if (dshHome) {
    check(`profile "${options.profile}"`, () => {
      const paths = profilePaths(dshHome, options.profile);
      if (!existsSync(paths.profileJson)) {
        throw new Error(`missing ${paths.profileJson}; profiles: ${availableProfiles(dshHome).join(', ') || '(none)'}`);
      }
      return paths.profileDir;
    });
    check('package link/copy', () => {
      const paths = profilePaths(dshHome, options.profile);
      const kind = entryKind(paths.target);
      if (kind === 'absent') throw new Error(`nothing at ${paths.target}`);
      return `${kind}${samePath(paths.target, PLUGIN_DIR) ? ' (points at the plugin running this CLI)' : ''}`;
    });
    check('dsh.profile.bundles', () => {
      const paths = profilePaths(dshHome, options.profile);
      const bundles = readBundles(readJson(paths.profileJson));
      if (!bundles.includes(PLUGIN_NAME)) throw new Error(`${PLUGIN_NAME} not listed (bundles: ${bundles.join(', ') || 'none'})`);
      return `${bundles.length} bundle(s)`;
    });
  }

  console.log(lines.join('\n'));
  console.log('');
  console.log(failures === 0 ? 'doctor: all checks passed' : `doctor: ${failures} check(s) failed`);
  if (failures > 0) process.exitCode = 1;
}

function availableProfiles(dshHome) {
  const dir = join(dshHome, 'profiles');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'package.json')))
    .map((entry) => entry.name);
}

// ---------------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(usage()); return; }
  if (options.version) { console.log(PLUGIN_VERSION); return; }

  switch (options.command) {
    case 'install': return install(options);
    case 'status': return status(options);
    case 'uninstall': return uninstall(options);
    case 'doctor': return doctor(options);
    case 'prune': {
      const args = [join(PLUGIN_DIR, 'scripts', 'prune-empty.mjs')];
      if (options.root) args.push('--root', options.root);
      if (options.dryRun) args.push('--dry-run');
      const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
      if (result.status !== 0) process.exitCode = result.status ?? 1;
      return;
    }
    default:
      console.log(usage());
      process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`dsh-memory: ${error.message}`);
  process.exitCode = 1;
});
