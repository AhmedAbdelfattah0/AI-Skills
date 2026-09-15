#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

function fail(message) {
  console.error(`candidate-id: ${message}`);
  process.exit(1);
}

function git(repo, args, encoding = 'utf8') {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: encoding === null ? undefined : encoding,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const stderr = encoding === null
      ? result.stderr.toString('utf8')
      : result.stderr;
    fail(stderr.trim() || `git ${args.join(' ')} failed`);
  }
  return result.stdout;
}

function parseArgs(argv) {
  let repo = process.cwd();
  let base;
  const excludes = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--repo') repo = argv[++index];
    else if (arg === '--base') base = argv[++index];
    else if (arg === '--exclude') excludes.add(argv[++index]);
    else fail(`unknown or incomplete argument: ${arg}`);
  }

  if (!base) fail('usage: candidate-id.mjs --repo <path> --base <ref> [--exclude <repo-relative-path>]');
  if ([repo, base, ...excludes].some((value) => value === undefined)) fail('an option is missing its value');
  return { repo: resolve(repo), base, excludes };
}

function splitNul(buffer) {
  const values = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    if (index > start) values.push(buffer.subarray(start, index));
    start = index + 1;
  }
  if (start < buffer.length) values.push(buffer.subarray(start));
  return values;
}

function toRepoPath(root, input) {
  const absolute = resolve(root, input);
  const rel = relative(root, absolute);
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..') return rel;
  return rel.split(sep).join('/');
}

const { repo, base, excludes: rawExcludes } = parseArgs(process.argv.slice(2));
const root = git(repo, ['rev-parse', '--show-toplevel']).trim();
const mergeBase = git(root, ['merge-base', 'HEAD', base]).trim();
const excludes = new Set([...rawExcludes].map((item) => toRepoPath(root, item)));

const tracked = splitNul(git(root, [
  'diff', '--name-only', '-z', '--no-renames', mergeBase, '--',
], null));
const untracked = splitNul(git(root, [
  'ls-files', '--others', '--exclude-standard', '-z', '--',
], null));

const pathMap = new Map();
for (const pathBuffer of [...tracked, ...untracked]) {
  const repoPath = pathBuffer.toString('utf8');
  if (!excludes.has(repoPath)) pathMap.set(repoPath, pathBuffer);
}

const entries = [...pathMap.entries()]
  .sort((left, right) => Buffer.compare(left[1], right[1]));
const hash = createHash('sha256');
hash.update('ship-ticket-candidate-v1\0');

const paths = [];
for (const [repoPath, pathBuffer] of entries) {
  const absolute = resolve(root, repoPath);
  let kind = 'deleted';
  let mode = '0';
  let content = Buffer.from('tombstone');

  try {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      kind = 'symlink';
      mode = '120000';
      content = Buffer.from(readlinkSync(absolute));
    } else if (stat.isFile()) {
      kind = 'file';
      mode = (stat.mode & 0o111) === 0 ? '100644' : '100755';
      content = readFileSync(absolute);
    } else if (stat.isDirectory()) {
      const submoduleStatus = git(absolute, ['status', '--porcelain']);
      if (submoduleStatus.trim()) fail(`dirty submodule cannot be identified safely: ${repoPath}`);
      kind = 'submodule';
      mode = '160000';
      content = Buffer.from(git(absolute, ['rev-parse', 'HEAD']).trim());
    } else {
      fail(`unsupported filesystem entry: ${repoPath}`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  hash.update(pathBuffer);
  hash.update('\0');
  hash.update(kind);
  hash.update('\0');
  hash.update(mode);
  hash.update('\0');
  hash.update(String(content.length));
  hash.update('\0');
  hash.update(content);
  hash.update('\0');
  paths.push({ path: repoPath, kind, mode });
}

console.log(JSON.stringify({
  version: 'ship-ticket-candidate-v1',
  merge_base: mergeBase,
  candidate_id: hash.digest('hex'),
  paths,
}, null, 2));
