// Test tooling for lib/git-hardened.test.mjs and lib/git-hardened-mutation.test.mjs (imported only by tests).
// - loadHardened(): the lib as committed when this cell is qualified; otherwise a temp copy of lib/ whose ONLY change
//   is the current cell appended to QUALIFIED_CELLS (the qualification bootstrap: no production seam exists).
// - fixture repositories built with the real git (fixture setup only; never through the lib under test).
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { probeGit } from './git-capability.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const CELLS_ANCHOR = 'export const QUALIFIED_CELLS = Object.freeze([\n';

/** The cell this process runs in, exactly as createContext computes it. */
export function currentCell() {
  return { git: probeGit().raw, os: process.platform, arch: process.arch, node: +process.versions.node.split('.')[0] };
}
const cellLine = (c) => `  Object.freeze({ git: ${JSON.stringify(c.git)}, os: ${JSON.stringify(c.os)}, arch: ${JSON.stringify(c.arch)}, node: ${c.node} }),\n`;

/** Is the current cell listed in the committed lib? */
export async function cellQualified() {
  const real = await import(pathToFileURL(join(here, 'git-hardened.mjs')).href);
  const c = currentCell();
  return real.QUALIFIED_CELLS.some((q) => q.git === c.git && q.os === c.os && q.arch === c.arch && q.node === c.node);
}

/** The module under test (H) and ITS git-exec (X, whose GitError class it throws): the committed pair, or (unqualified cell) a copy with exactly the current cell added. */
export async function loadHardened() {
  const load = async (d) => ({ H: await import(pathToFileURL(join(d, 'git-hardened.mjs')).href), X: await import(pathToFileURL(join(d, 'git-exec.mjs')).href) });
  if (process.platform === 'win32' || await cellQualified()) return { ...await load(here), copied: false };
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'git-hardened-copy-')));
  for (const f of ['git-hardened.mjs', 'git-exec.mjs', 'git-capability.mjs']) cpSync(join(here, f), join(dir, f));
  const src = readFileSync(join(dir, 'git-hardened.mjs'), 'utf8').replace(/\r\n/g, '\n');
  if (src.split(CELLS_ANCHOR).length !== 2) throw new Error('QUALIFIED_CELLS anchor not found exactly once');
  writeFileSync(join(dir, 'git-hardened.mjs'), src.replace(CELLS_ANCHOR, CELLS_ANCHOR + cellLine(currentCell())));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  return { ...await load(dir), copied: true };
}

// ------------------------------------------------------------------ fixtures (real git, fixture setup only)

/** The ambient env without any GIT_* key, plus a fixed identity: fixture git never reads the user's config. */
export function fixtureEnv(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'f', GIT_AUTHOR_EMAIL: 'f@x', GIT_COMMITTER_NAME: 'f', GIT_COMMITTER_EMAIL: 'f@x',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z', ...extra };
}
export function sh(cwd, args, { input, env, allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd, env: env ?? fixtureEnv(), input, maxBuffer: 1 << 28 });
  if (!allowFail && r.status !== 0) throw new Error(`fixture git ${args.join(' ')} failed: ${r.stderr}`);
  return r;
}
export const out = (cwd, args, o) => sh(cwd, args, o).stdout.toString('latin1').trim();

/** A realpath'd temp dir removed after the test (u+w restored first, so read-only fixtures go too). */
export function tmp(t, prefix = 'gh-') {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => { spawnSync('chmod', ['-R', 'u+rwx', d]); rmSync(d, { recursive: true, force: true }); });
  return d;
}

/**
 * A committed repository: `files` maps a path to a string/Buffer (100644), {exec: content} (100755) or
 * {link: target} (120000). Returns {top, head}. `init` adds `git init` flags.
 */
export function makeRepo(t, files, { init = [], dir } = {}) {
  const top = dir ?? join(tmp(t), 'repo');
  mkdirSync(top, { recursive: true });
  sh(top, ['init', '-q', ...init]);
  // No background auto-gc or maintenance in fixtures (it races with the test and with cleanup).
  sh(top, ['config', 'gc.auto', '0']);
  sh(top, ['config', 'maintenance.auto', 'false']);
  writeTree(top, files);
  sh(top, ['add', '-A']);
  sh(top, ['commit', '-q', '-m', 'c1', '--allow-empty']);
  return { top, head: out(top, ['rev-parse', 'HEAD']) };
}
export function writeTree(top, files) {
  for (const [p, v] of Object.entries(files)) {
    const f = join(top, p);
    mkdirSync(dirname(f), { recursive: true });
    if (v && typeof v === 'object' && !Buffer.isBuffer(v) && 'link' in v) symlinkSync(v.link, f);
    else if (v && typeof v === 'object' && !Buffer.isBuffer(v) && 'exec' in v) { writeFileSync(f, v.exec); chmodSync(f, 0o755); } else writeFileSync(f, v);
  }
}
export function commitAll(top, msg = 'c') { sh(top, ['add', '-A']); sh(top, ['commit', '-q', '-m', msg, '--allow-empty']); return out(top, ['rev-parse', 'HEAD']); }
