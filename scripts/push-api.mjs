#!/usr/bin/env node
/**
 * Publish the current commit with the GitHub REST API instead of `git push`.
 *
 * Why this exists: on networks that reset `github.com:443` (the git smart-HTTP
 * endpoint), `git push` hangs or dies while `api.github.com` still works. The
 * Git Data API reaches the same repository over a different host, so the
 * working tree can be published from there.
 *
 *   node scripts/push-api.mjs --dry-run     # show what would be sent
 *   node scripts/push-api.mjs               # append a commit to the remote branch
 *   node scripts/push-api.mjs --tag v0.1.0  # ...and move that tag to it
 *
 * Credentials come from `GITHUB_TOKEN`, or from the same git credential store
 * `git push` would use. Nothing is written without them.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback = false) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : true;
};
const dryRun = flag('dry-run');
const branch = flag('branch', 'main');
const tagName = flag('tag', '');
const api = 'https://api.github.com';

function git(...argv) {
  return execFileSync('git', argv, { cwd: root, encoding: 'utf8' }).trim();
}

function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const url = git('remote', 'get-url', 'origin');
  const host = new URL(url.replace(/^git@([^:]+):/, 'https://$1/')).host;
  const out = execFileSync('git', ['credential', 'fill'], {
    cwd: root,
    input: `protocol=https\nhost=${host}\n\n`,
    encoding: 'utf8',
  });
  const line = out.split('\n').find((entry) => entry.startsWith('password='));
  return line ? line.slice('password='.length) : '';
}

function remoteSlug() {
  const url = git('remote', 'get-url', 'origin');
  const match = url.match(/github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) throw new Error(`cannot parse owner/repo from origin: ${url}`);
  return `${match[1]}/${match[2]}`;
}

const slug = remoteSlug();
const auth = token();
if (!auth) throw new Error('no credentials: set GITHUB_TOKEN or configure the git credential store');
const headers = { authorization: `token ${auth}`, 'user-agent': 'dsh-memory-publish', accept: 'application/vnd.github+json' };

async function call(method, url, body) {
  const response = await fetch(`${api}${url}`, {
    method,
    headers: body ? { ...headers, 'content-type': 'application/json' } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${url} -> ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

const files = git('ls-files').split('\n').filter(Boolean);
const message = git('log', '-1', '--pretty=%B');
console.log(`repo:    ${slug}`);
console.log(`branch:  ${branch}`);
console.log(`files:   ${files.length}`);
console.log(`message: ${message.split('\n')[0]}`);
if (dryRun) {
  console.log('dry run: nothing sent');
  process.exit(0);
}

let parent = null;
try {
  parent = (await call('GET', `/repos/${slug}/git/ref/heads/${branch}`)).object.sha;
} catch (error) {
  // 409 on an empty repository: the first commit has to come from the Contents API.
  if (!String(error.message).includes('-> 409') && !String(error.message).includes('-> 404')) throw error;
  console.log('empty repository: creating the first commit through the contents API');
  const first = files[0];
  const created = await call('PUT', `/repos/${slug}/contents/${encodeURI(first)}`, {
    message,
    content: readFileSync(path.join(root, first)).toString('base64'),
  });
  parent = created.commit.sha;
}
console.log(`parent:  ${parent}`);

const tree = [];
for (const [index, file] of files.entries()) {
  const content = readFileSync(path.join(root, file)).toString('base64');
  const blob = await call('POST', `/repos/${slug}/git/blobs`, { content, encoding: 'base64' });
  tree.push({ path: file, mode: '100644', type: 'blob', sha: blob.sha });
  if ((index + 1) % 10 === 0 || index + 1 === files.length) console.log(`  blobs: ${index + 1}/${files.length}`);
}

const { sha: treeSha } = await call('POST', `/repos/${slug}/git/trees`, { tree });
const { sha: commitSha } = await call('POST', `/repos/${slug}/git/commits`, { message, tree: treeSha, parents: [parent] });
await call('PATCH', `/repos/${slug}/git/refs/heads/${branch}`, { sha: commitSha, force: false });
console.log(`commit:  ${commitSha}`);

if (tagName) {
  await call('PATCH', `/repos/${slug}/git/refs/tags/${tagName}`, { sha: commitSha, force: true });
  console.log(`tag:     ${tagName} -> ${commitSha}`);
}
