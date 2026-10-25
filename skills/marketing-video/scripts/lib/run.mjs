// Run-directory layout and file safety. A run lives at
// <root>/.specs/marketing-video/<project>/<run-id>/ and keeps immutable
// originals under restricted/, which is never packaged, bundled or reviewed.
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const SCHEMA_VERSION = 1;

export function readJson(file, fallback) {
  if (!existsSync(file)) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing ${file}`);
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function sha256Json(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function projectDir(root, project) {
  return join(resolve(root), '.specs', 'marketing-video', project);
}

export function runPaths(runDir) {
  const dir = resolve(runDir);
  return {
    dir,
    project: join(dir, '..', 'project.json'),
    brief: join(dir, 'brief.json'),
    manifest: join(dir, 'asset-manifest.json'),
    claims: join(dir, 'claims.json'),
    timeline: join(dir, 'timeline.json'),
    decisions: join(dir, 'decisions.jsonl'),
    approvals: join(dir, 'approvals.json'),
    assets: join(dir, 'assets'),
    restricted: join(dir, 'restricted'),
    originals: join(dir, 'restricted', 'originals'),
    previews: join(dir, 'previews'),
    exports: join(dir, 'exports'),
    reports: join(dir, 'reports'),
    snapshots: join(dir, 'project'),
  };
}

// restricted/ protects itself: its own .gitignore exists before the first
// original is copied, so a later `git add -A` cannot pick originals up.
export function ensureRestricted(runDir) {
  const p = runPaths(runDir);
  mkdirSync(p.dir, { recursive: true });
  assertResolvesInside(p.dir, p.originals);
  mkdirSync(p.originals, { recursive: true });
  assertResolvesInside(p.dir, p.originals);
  const ignore = join(p.restricted, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n!.gitignore\n');
  try { chmodSync(p.restricted, 0o700); } catch { /* not supported on this filesystem */ }
  return p.restricted;
}

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const LANG_PATTERN = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

export function assertId(value, what) {
  if (!ID_PATTERN.test(String(value))) throw new Error(`${what} must be lowercase letters, digits and dashes (got ${JSON.stringify(value)})`);
  return value;
}

// realpathSync.native returns the on-disk case, so `Restricted/` on a
// case-insensitive volume still resolves to `restricted/`. Comparison is
// case-folded as well, for volumes where the native call keeps input case.
const real = (p) => realpathSync.native(p);
const fold = (p) => (process.platform === 'linux' ? p : p.toLowerCase());

function relInside(base, target) {
  const rel = relative(fold(base), fold(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)) ? rel : null;
}

// A path is deliverable only when its real location is inside the run and
// outside restricted/. Symlinks are resolved before the check.
export function deliverablePath(runDir, candidate) {
  const p = runPaths(runDir);
  const abs = isAbsolute(candidate) ? candidate : join(p.dir, candidate);
  if (!existsSync(abs)) return { ok: false, reason: `missing: ${candidate}` };
  const target = real(abs);
  const rel = relInside(real(p.dir), target);
  if (rel === null) return { ok: false, reason: `escapes the run directory: ${candidate}` };
  if (existsSync(p.restricted) && relInside(real(p.restricted), target) !== null) return { ok: false, reason: `restricted original: ${candidate}` };
  return { ok: true, real: target, rel: relative(real(p.dir), target) };
}

// Every write lands inside its intended directory: the nearest existing
// ancestor of the destination must resolve inside `base`.
export function containedPath(base, ...parts) {
  const dest = resolve(base, ...parts);
  let probe = dest;
  while (!existsSync(probe)) probe = dirname(probe);
  if (relInside(real(base), real(probe)) === null || relInside(resolve(base), dest) === null) {
    throw new Error(`refusing to write outside ${base}: ${dest}`);
  }
  return dest;
}

// A write inside a run: the target directory must itself resolve inside the
// run (so a symlinked assets/ or exports/ cannot redirect it), and the
// destination must stay inside that directory.
export function runWritePath(runDir, base, ...parts) {
  assertResolvesInside(runDir, base);
  mkdirSync(base, { recursive: true });
  assertResolvesInside(runDir, base);
  return containedPath(base, ...parts);
}

// Checked before anything is created: the nearest existing ancestor of
// `target` must resolve inside the run, so no directory is ever created
// through a symlink that points elsewhere.
function assertResolvesInside(runDir, target) {
  let probe = resolve(target);
  while (!existsSync(probe)) probe = dirname(probe);
  if (relInside(real(runDir), real(probe)) === null || (probe === resolve(target) && lstatSync(probe).isSymbolicLink())) {
    throw new Error(`refusing to write: ${target} does not resolve inside the run ${runDir}`);
  }
}

// Copy a file or directory into a package, checking every entry: symlinks are
// refused outright and every source must be deliverable.
export function copyDeliverable(runDir, source, destRoot, name) {
  const files = [];
  const walk = (src, rel) => {
    const st = lstatSync(src);
    if (st.isSymbolicLink()) throw new Error(`refusing to package a symlink: ${src}`);
    const d = deliverablePath(runDir, src);
    if (!d.ok) throw new Error(`refusing to package ${src}: ${d.reason}`);
    const dest = containedPath(destRoot, rel);
    if (st.isDirectory()) {
      mkdirSync(dest, { recursive: true });
      for (const entry of readdirSync(src)) walk(join(src, entry), join(rel, entry));
    } else {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
      files.push(rel);
    }
  };
  walk(isAbsolute(source) ? source : join(resolve(runDir), source), name);
  return files;
}

export function appendDecision(runDir, entry) {
  const file = runPaths(runDir).decisions;
  mkdirSync(dirname(file), { recursive: true });
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  writeFileSync(file, `${line}\n`, { flag: 'a' });
}

export function readDecisions(runDir) {
  const file = runPaths(runDir).decisions;
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
