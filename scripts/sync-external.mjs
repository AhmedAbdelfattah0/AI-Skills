#!/usr/bin/env node
// Refresh the skills listed in external-skills.json from their upstream repos.
// Each one is copied unmodified into skills/<name>/, with the upstream licence
// and an UPSTREAM.json recording the exact commit it came from. Dependency-free.
//
//   node scripts/sync-external.mjs           sync every external skill
//   node scripts/sync-external.mjs --check   exit 1 if any is behind upstream; write nothing

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
const { skills } = JSON.parse(readFileSync(join(ROOT, 'external-skills.json'), 'utf8'));

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const pinned = (dest) => {
  const f = join(dest, 'UPSTREAM.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')).commit : null;
};

let behind = 0;
for (const s of skills) {
  const dest = join(ROOT, 'skills', s.name);
  const tmp = mkdtempSync(join(tmpdir(), `ext-${s.name}-`));
  try {
    git(['clone', '--quiet', '--depth', '1', '--branch', s.ref, s.repo, tmp]);
    const commit = git(['rev-parse', 'HEAD'], tmp);
    if (pinned(dest) === commit) { console.log(`✅ ${s.name} up to date (${commit.slice(0, 7)})`); continue; }
    behind++;
    if (check) { console.log(`⬆️  ${s.name} behind upstream: ${pinned(dest)?.slice(0, 7) ?? 'none'} → ${commit.slice(0, 7)}`); continue; }
    const src = join(tmp, s.path);
    if (!existsSync(join(src, 'SKILL.md'))) throw new Error(`${s.repo}:${s.path} has no SKILL.md`);
    rmSync(dest, { recursive: true, force: true });
    cpSync(src, dest, { recursive: true });
    if (s.license) cpSync(join(tmp, s.license), join(dest, 'LICENSE'));
    writeFileSync(join(dest, 'UPSTREAM.json'), JSON.stringify(
      { repo: s.repo, ref: s.ref, path: s.path, commit, syncedAt: new Date().toISOString(),
        note: 'Vendored unmodified. Do not edit: scripts/sync-external.mjs overwrites this folder.' },
      null, 2) + '\n');
    console.log(`⬇️  ${s.name} synced to ${commit.slice(0, 7)}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
if (check && behind) process.exit(1);
