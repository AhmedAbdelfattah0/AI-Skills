#!/usr/bin/env node
/**
 * Base drift check (AIS-BENCH-1 Wave 2b). Lists the files changed between the base a plan was
 * written against and the tip of a target ref, and reports those that overlap the approved DAG's
 * node `writes`/`reads` (or an optional contract path list). Read-only git via execFile, no shell.
 * Dependency-free Node >= 18; no clock.
 *
 * CLI: base-drift.mjs check --repo <path> --base <sha-or-ref> --target <ref> --dag <dag.json> [--contract-paths <file>]
 * A path entry matches a changed file when equal or when the file is under it as a directory. Renames
 * count on both sides (source and destination).
 * Contract path list: one repo-relative path per line; blank lines and lines starting with # ignored.
 * Exit codes: 0 no overlap, 1 overlap (listed on stdout), 2 usage error, 3 git or input failure (bad ref, unreadable dag).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isEntrypoint } from './harness.mjs';

const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

/**
 * Files changed between `base` and `target` tip (two-dot diff), repo-relative. `--no-renames` lists a
 * rename as a deletion of its source plus an addition of its destination, so moving a declared path
 * out of its directory still reports the declared side. A ref starting with `-` is refused.
 */
export function changedFiles(repo, base, target) {
  for (const ref of [base, target]) if (String(ref).startsWith('-')) throw new Error(`refused ref: ${ref}`);
  const out = execFileSync('git', ['-C', resolve(repo), 'diff', '--name-only', '--no-renames', '-z', `${base}`, `${target}`, '--'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\0').filter(Boolean);
}

/** Declared paths: [{ path, source }] from DAG node reads/writes and the contract list. */
export function declaredPaths(dag, contractPaths = []) {
  const list = [];
  for (const n of Array.isArray(dag?.nodes) ? dag.nodes : []) {
    for (const k of ['writes', 'reads']) for (const p of Array.isArray(n[k]) ? n[k] : []) if (typeof p === 'string' && p) list.push({ path: norm(p), source: `node ${n.id ?? '?'} ${k}` });
  }
  for (const p of contractPaths) if (p) list.push({ path: norm(p), source: 'contract' });
  return list;
}

/** Changed files that equal or sit under a declared path: [{ file, path, source }]. */
export function overlaps(changed, declared) {
  const hits = [];
  for (const file of changed.map(norm)) {
    const d = declared.find((x) => file === x.path || file.startsWith(x.path + '/'));
    if (d) hits.push({ file, path: d.path, source: d.source });
  }
  return hits;
}

export function checkBaseDrift({ repo, base, target, dag, contractPaths }) {
  const changed = changedFiles(repo, base, target);
  const hits = overlaps(changed, declaredPaths(dag, contractPaths));
  return { ok: hits.length === 0, changed, overlaps: hits };
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const f = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i].startsWith('--') || rest[i + 1] === undefined) { f.bad = true; break; }
    f[rest[i].slice(2)] = rest[i + 1];
  }
  if (cmd !== 'check' || f.bad || !f.repo || !f.base || !f.target || !f.dag) {
    process.stderr.write('Usage: base-drift.mjs check --repo <path> --base <sha-or-ref> --target <ref> --dag <dag.json> [--contract-paths <file>]\n');
    return 2;
  }
  try {
    const dag = JSON.parse(readFileSync(f.dag, 'utf8'));
    const contractPaths = f['contract-paths']
      ? readFileSync(f['contract-paths'], 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')) : [];
    const r = checkBaseDrift({ repo: f.repo, base: f.base, target: f.target, dag, contractPaths });
    if (r.ok) { process.stdout.write(`base-drift: none (${r.changed.length} changed file(s), no overlap)\n`); return 0; }
    process.stdout.write('base-drift: OVERLAP\n' + r.overlaps.map((h) => `  ${h.file} (declared ${h.path}, ${h.source})`).join('\n') + '\n');
    return 1;
  } catch (e) { process.stderr.write(`base-drift: ${e.message}\n`); return 3; }
}

if (isEntrypoint(import.meta.url)) process.exitCode = main(process.argv.slice(2));
