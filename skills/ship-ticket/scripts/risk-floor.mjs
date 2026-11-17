#!/usr/bin/env node
/**
 * Structural PATH risk floor (ASTF-11, S-10). The repository declares its sensitive paths in `.ship-ticket/risk-paths.json`, read
 * from the BASE commit (never from the thing being checked). Deterministic code turns those globs plus a list of paths into a floor;
 * an AI assessment owns semantic risk, business impact and indirect dependencies. final = max(floor, claimed, ai): never lower than
 * any of the three. A structural floor only RAISES, and a path that matches nothing is NOT evidence of low risk. A repository that
 * declares no paths gets no structural protection (floor STANDARD, reason `no_risk_paths_declared`); the AI assessment is then the only
 * protection and is still required. Text/keyword classification was evaluated and dropped (deferred to an optional measured experiment).
 *
 *   risk-floor.mjs check    --base <commit> --planned-paths <json array|file> --claimed <profile> --ai <profile> [--repo <dir>]
 *   risk-floor.mjs reassess --base <commit> --head <commit|WORKTREE> --recorded-line <file|-> --claimed <profile> --ai <profile> [--repo <dir>]
 * The orchestrator MUST pin --base from the plan/run state (the merge-base recorded at START): the record line carries `base=<sha12>`, and
 * `reassess` fails (`base_mismatch`) when --base differs from the base in the recorded line or the recorded base is not an ancestor of the
 * head. `reassess` recomputes the floor from the ACTUAL changed paths: `--head <commit>` is `git diff base head`; WORKTREE is the UNION of
 * base->working tree, base->index (staged), untracked files, and git-IGNORED untracked files that match a declared glob (git does not list
 * ignored files, so a second pass lists them and keeps only declared matches). Renames count both paths; deletions, mode-only changes and
 * submodule bumps (the gitlink path only: a glob under a submodule does not match its bump) count.
 * Exit codes: 0 = `claimed` already meets the final; 2 = final is HIGHER than `claimed` (raise the classification before release);
 * 1 = unusable or untrustworthy input (malformed or oversized paths/declaration, tampered declaration, unknown profile, base_mismatch,
 * usage error). An exit-1 output still carries final=ELEVATED. Flags take `--flag value` or `--flag=value`; a missing value, unknown or
 * repeated flag, positional argument or unknown command is an error. Files are read as strict UTF-8 (UTF-16/32 BOMs, NUL, invalid bytes rejected).
 * REUSE: real tree paths are enumerated and filtered by git itself (diff/ls-files and its `:(glob,icase)` pathspec magic for the ignored pass). The
 * custom matcher below exists ONLY for PLANNED paths and declared patterns, which are in no tree. Evaluated and rejected: node:path.matchesGlob and
 * fs.glob (Node >= 22 only; CI runs Node 18), picomatch/minimatch (would need vendoring: skills install without npm install).
 * Glob grammar (deliberately small): literal characters, `*` (any run inside ONE path segment), a WHOLE-segment `**`, a trailing `/`.
 * EVERY other metacharacter (`? [ ] { } ! \ ( )`), a `**` that is not a whole segment, and leading/trailing whitespace in a segment make the
 * declaration invalid (fail closed), never a silent non-match. Directory semantics (git-style): a pattern matches a path if it matches the
 * path OR ANY ANCESTOR of it, so `db/migrations`, `db/migrations/` and `db/migrations/**` all cover `db/migrations/1.sql`; a pattern without
 * an inner `/` matches at any depth. Only the PATTERN's `*` is a wildcard: a filename containing `*`, `?` or `[` is plain text. Matching is
 * case-INSENSITIVE, NFC-normalised, ignores default-ignorable (Cf) characters; in a PATH `\` counts as `/`, `./` and `.` segments are dropped,
 * and a `..` segment or an absolute path is malformed (over-classifying is accepted, under-classifying is not).
 * Planned entries that may denote a directory or a set (end with `/`, contain `*`, or have no `.` in the last segment) are conservative: they
 * floor ELEVATED if a declared glob matches them or may match anything below them.
 * Budgets (exceeding one is malformed_input, final ELEVATED): pattern <= 256 chars and 32 segments, <= 256 patterns, declaration <= 256 KB
 * (bytes checked before parsing: cat-file -s for blobs, fstat for the working-tree file), path <= 4096 chars and 64 segments, <= 200000 paths,
 * planned-paths input <= 2 MB. Worst-case work: a linear two-pointer segment matcher with one star restart per segment, so one pattern/path
 * pair costs at most sum(|pattern segment| x |path segment|) <= 256 x 4096 character steps plus 34 x 64 cells (STEP_BOUND_PER_PAIR); a global
 * budget of MAX_STEPS per assessment fails closed.
 * The declaration path (and anything under `.ship-ticket/`) is a built-in class: any change to it (content, deletion, addition, rename, planned
 * or actual) floors ELEVATED with `risk_declaration_changed`, while the floor itself keeps using the BASE declaration. A mode change, a
 * symlink, a gitlink or a directory in its place is `declaration_tampered` (exit 1). Duplicate JSON keys in the declaration are last-wins (a
 * known, deferred limit).
 * ADVISORY, NOT ENFORCED: no gate or engine step runs this yet (wiring is the driver slice, S-23/S-24).
 */
import { openSync, readSync, closeSync, realpathSync, lstatSync, fstatSync, constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const MAX_INPUT = 2_000_000;
export const MAX_PATHS = 200_000;
export const MAX_DECLARATION = 256 * 1024;
const MAX_GLOB_CHARS = 256, MAX_GLOB_SEGS = 32, MAX_PATH_CHARS = 4096, MAX_PATH_SEGS = 64, MAX_GLOBS = 256;
export const STEP_BOUND_PER_PAIR = MAX_GLOB_CHARS * MAX_PATH_CHARS + (MAX_GLOB_SEGS + 2) * (MAX_PATH_SEGS + 1) + 1;
export const MAX_STEPS = 50_000_000;
export const CHANGED = 'risk_declaration_changed';
export const DECLARATION_PATH = '.ship-ticket/risk-paths.json';
const RANK = { STANDARD: 0, ELEVATED: 1 };
export const normProfile = (c) => (typeof c === 'string' && Object.hasOwn(RANK, c.trim().toUpperCase()) ? c.trim().toUpperCase() : null);
const bad = (code, reason) => Object.assign(new Error(reason), { code });

// ---- paths and globs ----
const wellFormed = (x) => typeof x === 'string' && x !== '' && !/[\u0000�]|[\uD800-\uDFFF]/u.test(x);
function segmentsOf(p, what, maxChars = MAX_PATH_CHARS, maxSegs = MAX_PATH_SEGS) {
  if (!wellFormed(p) || p.length > maxChars) throw bad('malformed_input', `${what} is not a well-formed string within the budget`);
  const s = p.replace(/\p{Cf}/gu, '').normalize('NFC').toLowerCase().normalize('NFC').replace(/\\/g, '/');
  if (s.startsWith('/') || /^[a-z]:\//.test(s)) throw bad('malformed_input', `${what} is absolute`);
  const segs = [];
  for (const seg of s.split('/')) { if (seg === '' || seg === '.') continue; if (seg === '..') throw bad('malformed_input', `${what} has a ".." segment`); segs.push(seg); }
  if (!segs.length || segs.length > maxSegs) throw bad('malformed_input', `${what} is empty or has too many segments`);
  return segs;
}
function segMatch(pat, str, ctx) { // `*` is the only wildcard and is handled BEFORE literal equality; one star restart: O(|pat| x |str|)
  let p = 0, s = 0, star = -1, mark = 0;
  while (s < str.length) {
    if (ctx) ctx.steps++;
    if (p < pat.length && pat[p] === '*') { star = p++; mark = s; }
    else if (p < pat.length && pat[p] === str[s]) { p++; s++; }
    else if (star >= 0) { p = star + 1; s = ++mark; }
    else return false;
  }
  while (p < pat.length && pat[p] === '*') p++;
  return p === pat.length;
}
export function compileGlob(glob) {
  if (typeof glob !== 'string' || /[?[\]{}!()\\]/.test(glob)) throw bad('malformed_input', 'a glob uses an unsupported metacharacter');
  const slash = /\//.test(glob.replace(/\/+$/, ''));
  const segs = segmentsOf(glob, 'a glob', MAX_GLOB_CHARS, MAX_GLOB_SEGS);
  for (const g of segs) if ((g.includes('**') && g !== '**') || g !== g.trim()) throw bad('malformed_input', 'a glob uses ** outside a whole segment or edge whitespace');
  if (segs[segs.length - 1] !== '**') segs.push('**'); // directory semantics: the pattern also covers everything below a match
  return slash ? segs : ['**', ...segs];
}
export function matchSegments(g, p, ctx = null) {
  if (ctx && (ctx.steps += 1 + g.length * (p.length + 1)) > MAX_STEPS) throw bad('malformed_input', 'work budget exceeded'); // every DP row and cell is charged BEFORE allocation
  let row = new Array(p.length + 1).fill(false); row[p.length] = true; // row[j]: g[i..] matches p[j..]
  for (let i = g.length - 1; i >= 0; i--) {
    const next = row; row = new Array(p.length + 1).fill(false);
    if (g[i] === '**') { row[p.length] = next[p.length]; for (let j = p.length - 1; j >= 0; j--) row[j] = next[j] || row[j + 1]; }
    else for (let j = p.length - 1; j >= 0; j--) row[j] = next[j + 1] && segMatch(g[i], p[j], ctx);
    if (ctx && ctx.steps > MAX_STEPS) throw bad('malformed_input', 'work budget exceeded');
  }
  return row[0];
}
export const globMatches = (glob, path) => matchSegments(compileGlob(glob), segmentsOf(path, 'a path'));
// A planned entry that may denote a set: may any path below it match this glob? Conservative: a glob whose literal prefix is empty (any depth) may.
function mayCover(g, dir, ctx) {
  if (ctx) ctx.steps += g.length;
  let lit = 0; while (lit < g.length && !g[lit].includes('*')) lit++;
  if (lit === 0) return true;
  const n = Math.min(lit, dir.length);
  return g.slice(0, n).every((x, i) => x === dir[i]);
}

// ---- declaration ----
export function validateDeclaration(d) {
  const inv = (m) => bad('declaration_invalid', m);
  if (!d || typeof d !== 'object' || Array.isArray(d) || Object.keys(d).some((k) => !['version', 'classes'].includes(k)) || d.version !== 1) throw inv('version must be 1, only version and classes allowed');
  if (!Array.isArray(d.classes) || !d.classes.length || d.classes.length > 200) throw inv('classes must be a non-empty array of at most 200');
  const names = new Set(), out = []; let total = 0;
  for (const c of d.classes) {
    if (!c || typeof c !== 'object' || Object.keys(c).some((k) => !['name', 'floor', 'globs'].includes(k))) throw inv('a class has unknown keys');
    if (typeof c.name !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(c.name) || names.has(c.name) || c.name === CHANGED) throw inv('class names are unique [a-z0-9_-] identifiers (one is reserved)');
    if (c.floor !== 'ELEVATED') throw inv('a class floor must be "ELEVATED"');
    if (!Array.isArray(c.globs) || !c.globs.length || (total += c.globs.length) > MAX_GLOBS) throw inv('globs must be non-empty arrays, at most 256 in total');
    names.add(c.name);
    try { out.push({ name: c.name, globs: c.globs.map(compileGlob) }); } catch (e) { throw inv(`bad glob in ${c.name}: ${e.message}`); }
  }
  return out;
}

// ---- assessment (pure) ----
const DECL_SEGS = DECLARATION_PATH.split('/');
/** paths: array of strings. declaration: validated classes or null. forced: error codes decided by the caller. Never throws. */
export function assess({ paths, declaration = null, declSha = 'none', declChanged = false, claimed, ai, forced = [], also = [], planned = false, baseSha = 'none', headLabel = 'none' }) {
  const errors = [...forced], reasons = [];
  const c = normProfile(claimed), a = normProfile(ai);
  if (c === null) errors.push('bad_claimed');
  if (a === null) errors.push('bad_ai');
  let segs = [];
  if (!forced.length) {
    try {
      if (!Array.isArray(paths) || !paths.length || paths.length > MAX_PATHS) throw bad('malformed_input', 'paths must be a non-empty array within the limit');
      if (paths.reduce((n, p) => n + (typeof p === 'string' ? p.length : 0), 0) > MAX_INPUT) throw bad('malformed_input', 'paths are oversized');
      segs = paths.map((p) => segmentsOf(p, 'a path'));
    } catch (e) { errors.push(e.code ?? 'malformed_input'); }
  }
  const classes = new Set(); let matched = 0;
  if (!errors.length) {
    const ctx = { steps: 0 };
    try {
      if (!declaration) reasons.push('no_risk_paths_declared');
      if (declChanged) classes.add(CHANGED);
      segs.forEach((p, i) => {
        let hit = false;
        if (p[0] === DECL_SEGS[0]) { classes.add(CHANGED); hit = true; }
        const wi = p.findIndex((x) => x.includes('*')), dir = wi < 0 ? p : p.slice(0, wi);
        const dirLike = planned && (/[\\/]$/.test(paths[i]) || wi >= 0 || !p[p.length - 1].includes('.'));
        for (const cl of declaration ?? []) if (cl.globs.some((g) => matchSegments(g, p, ctx) || (dirLike && mayCover(g, dir, ctx)))) { classes.add(cl.name); hit = true; }
        if (hit) matched++;
      });
    } catch (e) { errors.push(e.code ?? 'malformed_input'); }
  }
  const floor = errors.length || classes.size ? 'ELEVATED' : 'STANDARD';
  const final = [floor, c ?? 'ELEVATED', a ?? 'ELEVATED', ...also].reduce((x, y) => (RANK[y] > RANK[x] ? y : x));
  const names = [...classes].sort(), n = Array.isArray(paths) ? paths.length : 0;
  return { ok: !errors.length, errors, floor, floor_classes: names, reasons, claimed: c ?? 'invalid', ai: a ?? 'invalid', final, raised: errors.length > 0 || final !== c,
    counts: { paths: n, matched },
    // Class names, counts and short hashes only, never raw paths. Built AFTER the final error list.
    record_line: `risk-floor: floor=${floor}; classes=${names.join(',') || 'none'}; claimed=${c ?? 'invalid'}; ai=${a ?? 'invalid'}; final=${final}; paths=${n}; matched=${matched}; base=${baseSha}; head=${headLabel}; declaration=${declSha}${errors.length ? `; errors=${[...new Set(errors)].join(',')}` : ''}` };
}
export const exitCodeFor = (r) => (r.errors.length ? 1 : r.final !== r.claimed ? 2 : 0);

// ---- strict reading ----
export function decodeStrict(buf) {
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) throw bad('malformed_input', 'utf16_or_utf32');
  if (buf.includes(0)) throw bad('malformed_input', 'nul');
  return new TextDecoder('utf-8', { fatal: true }).decode(buf);
}
function readBounded(f) { // at most MAX_INPUT + 1 bytes are read
  const fd = f === '-' ? 0 : openSync(f, 'r'), buf = Buffer.alloc(MAX_INPUT + 1);
  let n = 0;
  try {
    while (n < buf.length) {
      let got; try { got = readSync(fd, buf, n, buf.length - n, null); } catch (e) { if (e.code === 'EOF') break; if (e.code === 'EAGAIN') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); continue; } throw e; }
      if (got === 0) break; n += got;
    }
  } finally { if (fd !== 0) closeSync(fd); }
  if (n > MAX_INPUT) throw bad('malformed_input', 'too_large');
  return buf.subarray(0, n);
}
export const readText = (f) => decodeStrict(readBounded(f));
export const parsePathsArg = (v) => JSON.parse(v.trim().startsWith('[') ? (v.length > MAX_INPUT ? (() => { throw bad('malformed_input', 'too_large'); })() : v) : readText(v));

// ---- hardened git (mirrors fast-checks.mjs: no GIT_* inherited, replace objects off, literal pathspecs, raw -z paths, no optional locks) ----
const gitEnv = () => { const e = { ...process.env }; for (const k of Object.keys(e)) if (k.toUpperCase().startsWith('GIT_')) delete e[k]; e.GIT_NO_REPLACE_OBJECTS = '1'; e.GIT_LITERAL_PATHSPECS = '1'; e.GIT_OPTIONAL_LOCKS = '0'; return e; };
const LIST_CAP = 64 * 1024 * 1024; // bytes git may print for ONE enumeration; excess aborts the child (ENOBUFS) before anything is sorted or hashed
const gitRaw = (cwd, args, { env = gitEnv(), maxBuffer = 256 * 1024 * 1024 } = {}) => execFileSync('git', ['--no-replace-objects', '--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], { cwd, env, maxBuffer, stdio: ['ignore', 'pipe', 'pipe'] });
const git = (cwd, args) => gitRaw(cwd, args).toString('utf8').replace(/\n$/, '');
const zSplit = (buf) => { const out = []; let at = 0; for (let i = 0; i < buf.length; i++) if (buf[i] === 0) { if (i > at) out.push(buf.subarray(at, i)); at = i + 1; } if (at < buf.length) out.push(buf.subarray(at)); return out; };
const utf8Path = (raw) => { const p = raw.toString('utf8'); return Buffer.from(p, 'utf8').equals(raw) ? p : null; };
/** One bounded enumeration (byte cap in git, count cap here). Excess or failure is malformed_input, never a truncated list. */
function listZ(top, args, env) {
  let buf; try { buf = gitRaw(top, args, { env, maxBuffer: LIST_CAP }); } catch { throw bad('malformed_input', 'git listing failed or exceeded the byte cap'); }
  const parts = zSplit(buf); if (parts.length > MAX_PATHS) throw bad('malformed_input', 'too many changed paths'); return parts;
}
const commitOf = (top, ref, code) => { if (typeof ref !== 'string' || !ref || ref.startsWith('-')) throw bad(code, 'a commit-ish must not be empty or start with "-"'); try { return git(top, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]); } catch { throw bad(code, 'git could not resolve the commit-ish'); } };

function resolveRepo(repo, base) {
  let top; try { top = realpathSync.native(git(realpathSync.native(repo), ['rev-parse', '--show-toplevel'])); } catch { throw bad('repo_unavailable', 'git could not resolve the repository'); }
  return { top, sha: commitOf(top, base, 'base_invalid') };
}
const treeEntry = (top, tree) => { const e = git(top, ['ls-tree', '-z', tree, '--', DECLARATION_PATH]).replace(/\0$/, ''); if (!e) return null; const m = /^(\d+) (\w+) ([0-9a-f]+)\t/.exec(e); return m ? { mode: m[1], type: m[2], oid: m[3] } : null; };
const REGULAR = /^100(644|755)$/;
function readFd(fd, limit) { const buf = Buffer.alloc(limit + 1); let n = 0; while (n < buf.length) { const got = readSync(fd, buf, n, buf.length - n, null); if (got === 0) break; n += got; } return buf.subarray(0, n); }
/** The declaration as of BASE, and whether HEAD (commit) and/or the working tree + index differ from it. A non-regular entry or a mode change is tampering. */
function readDeclaration(top, sha, { headSha = null, worktree = false } = {}) {
  let base, baseBytes = null;
  try { base = treeEntry(top, sha); } catch { throw bad('repo_unavailable', 'git could not read the declaration at base'); }
  if (base && (base.type !== 'blob' || !REGULAR.test(base.mode))) throw bad('declaration_tampered', 'the base declaration is not a regular file');
  if (base) { if (Number(git(top, ['cat-file', '-s', base.oid])) > MAX_DECLARATION) throw bad('malformed_input', 'declaration too large'); baseBytes = gitRaw(top, ['cat-file', 'blob', base.oid]); }
  let changed = false;
  if (headSha) {
    const h = treeEntry(top, headSha);
    if (h && (h.type !== 'blob' || !REGULAR.test(h.mode) || (base && h.mode !== base.mode))) throw bad('declaration_tampered', 'the declaration is not a regular file with its base mode at head');
    changed = !h !== !base || (h && base && h.oid !== base.oid);
  }
  if (worktree) {
    let wt = null; const full = join(top, DECLARATION_PATH);
    try {
      const st = lstatSync(full, { throwIfNoEntry: false });
      if (st) {
        if (!st.isFile()) throw bad('declaration_tampered', 'the working-tree declaration is not a regular file');
        const fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        try { const fs2 = fstatSync(fd); if (!fs2.isFile()) throw bad('declaration_tampered', 'the working-tree declaration is not a regular file'); if (fs2.size > MAX_DECLARATION) throw bad('malformed_input', 'declaration too large'); wt = readFd(fd, MAX_DECLARATION); if (wt.length > MAX_DECLARATION) throw bad('malformed_input', 'declaration too large'); if (process.platform !== 'win32' && base && ((fs2.mode & 0o111) !== 0) !== (base.mode === '100755')) throw bad('declaration_tampered', 'mode differs from base'); } finally { closeSync(fd); }
      }
    } catch (e) { if (e.code && /^[a-z_]+$/.test(e.code)) throw e; throw bad('declaration_tampered', 'the working-tree declaration is unreadable'); }
    const idx = gitRaw(top, ['ls-files', '-s', '-z', '--', DECLARATION_PATH]).toString('utf8').replace(/\0$/, '');
    const im = idx ? /^(\d+) ([0-9a-f]+) (\d)\t/.exec(idx) : null;
    if (idx && (!im || !REGULAR.test(im[1]) || im[3] !== '0' || (base && im[1] !== base.mode))) throw bad('declaration_tampered', 'the index declaration is not a regular file with its base mode');
    changed = changed || !wt !== !base || !im !== !base || (wt && baseBytes && !wt.equals(baseBytes)) || (im && base && im[2] !== base.oid);
  }
  if (!base) return { declaration: null, declSha: 'none', changed: !!changed };
  try { return { declaration: validateDeclaration(JSON.parse(decodeStrict(baseBytes))), declSha: createHash('sha256').update(baseBytes).digest('hex').slice(0, 16), changed: !!changed }; }
  catch (e) { throw e.code ? e : bad('declaration_invalid', 'the base declaration is not valid JSON'); }
}
const failed = (e, claimed, ai) => assess({ paths: null, claimed, ai, forced: [e.code ?? 'internal'] });
const headOrNull = (top) => { try { return git(top, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']); } catch { return null; } };

export function check({ repo = '.', base, plannedPaths, claimed, ai }) {
  try {
    const { top, sha } = resolveRepo(repo, base);
    const d = readDeclaration(top, sha, { headSha: headOrNull(top), worktree: true });
    return assess({ paths: plannedPaths, declaration: d.declaration, declSha: d.declSha, declChanged: d.changed, claimed, ai, planned: true, baseSha: sha.slice(0, 12), headLabel: 'planned' });
  } catch (e) { return failed(e, claimed, ai); }
}

export function changedPaths(top, sha, head, declaration = null) {
  const D = ['-z', '--name-only', '--no-renames', '--ignore-submodules=none'];
  let raws;
  if (head === 'WORKTREE') {
    for (const rec of zSplit(gitRaw(top, ['ls-files', '-v', '-z']))) if (/^[a-zS] /.test(rec.subarray(0, 2).toString('latin1'))) throw bad('index_flags_hidden', 'a tracked file carries an assume-unchanged or skip-worktree bit');
    // union: base->HEAD (committed), base->index (staged), base->working tree, untracked, and git-ignored files that match a declared glob
    raws = [...listZ(top, ['diff', ...D, sha, 'HEAD', '--']), ...listZ(top, ['diff', '--cached', ...D, sha, '--']), ...listZ(top, ['diff', ...D, sha, '--']), ...listZ(top, ['ls-files', '-z', '--others', '--exclude-standard'])];
    // The ignored pass REUSES git's own pathspec engine (:(glob,icase)); ignored files are never matched in JS. .ship-ticket/** always counts.
    const specs = new Set(['.ship-ticket/**']); for (const cl of declaration ?? []) for (const g of cl.globs) specs.add(g.join('/'));
    raws.push(...listZ(top, ['ls-files', '-z', '-o', '-i', '--exclude-standard', '--', ...[...specs].map((x) => `:(glob,icase)${x}`)], { ...gitEnv(), GIT_LITERAL_PATHSPECS: '0' }));
  } else raws = listZ(top, ['diff', ...D, sha, commitOf(top, head, 'head_invalid'), '--']);
  if (raws.length > MAX_PATHS) throw bad('malformed_input', 'too many changed paths');
  const seen = new Set(), out = [];
  for (const raw of raws.sort(Buffer.compare)) {
    const k = raw.toString('hex'); if (seen.has(k)) continue; seen.add(k);
    const p = utf8Path(raw); if (p === null) throw bad('unclassifiable_path', 'a changed path is not valid UTF-8');
    try { segmentsOf(p, 'a path'); } catch { throw bad('unclassifiable_path', 'a changed path exceeds the path budget'); }
    out.push(p);
  }
  return out;
}

// The recorded plan line, strict: exactly one `[risk_floor: ]risk-floor: ...` line with exactly these keys. `risk_reassess:` lines are ignored.
const RECORD = /^(?:risk_floor:[ \t]*)?risk-floor: floor=(STANDARD|ELEVATED); classes=[a-z0-9_,-]*; claimed=(STANDARD|ELEVATED); ai=(STANDARD|ELEVATED); final=(STANDARD|ELEVATED); paths=\d+; matched=\d+; base=([0-9a-f]{12}); head=[a-z0-9]+; declaration=(?:[0-9a-f]{16}|none)$/;
export function parseRecordedLine(text) {
  const lines = typeof text === 'string' ? text.split(/\r?\n/).filter((l) => /^(?:risk_floor:[ \t]*)?risk-floor:/.test(l)) : [];
  const m = lines.length === 1 ? RECORD.exec(lines[0]) : null;
  if (!m) throw bad('recorded_line_invalid', 'the recorded line must be exactly one strict risk-floor record');
  return { floor: m[1], claimed: m[2], ai: m[3], final: m[4], base: m[5] };
}

export function reassess({ repo = '.', base, head, recordedLine, claimed, ai }) {
  try {
    const { top, sha } = resolveRepo(repo, base);
    const headSha = head === 'WORKTREE' ? git(top, ['rev-parse', '--verify', 'HEAD^{commit}']) : commitOf(top, head, 'head_invalid');
    const rec = parseRecordedLine(recordedLine);
    if (rec.base !== sha.slice(0, 12)) throw bad('base_mismatch', 'the recorded base does not match --base');
    // base must be an ancestor of the head, so base..head (two-dot) equals merge-base..head and nothing outside the branch is counted
    try { gitRaw(top, ['merge-base', '--is-ancestor', sha, headSha]); } catch { throw bad('base_mismatch', 'the recorded base is not an ancestor of the head'); }
    const d = readDeclaration(top, sha, { headSha, worktree: head === 'WORKTREE' });
    return assess({ paths: changedPaths(top, sha, head, d.declaration), declaration: d.declaration, declSha: d.declSha, declChanged: d.changed, claimed, ai, also: [rec.claimed, rec.ai, rec.final], baseSha: sha.slice(0, 12), headLabel: head === 'WORKTREE' ? 'worktree' : headSha.slice(0, 12) });
  } catch (e) { return failed(e, claimed, ai); }
}

// ---- CLI ----
const FLAGS = { check: ['base', 'planned-paths', 'claimed', 'ai', 'repo'], reassess: ['base', 'head', 'recorded-line', 'claimed', 'ai', 'repo'] };
export function parseFlags(args, allowed) {
  const o = {};
  for (let i = 0; i < args.length; i++) {
    const m = /^--([^=]+)(?:=([\s\S]*))?$/.exec(args[i]);
    if (!m || !allowed.includes(m[1]) || Object.hasOwn(o, m[1])) return null;
    let v = m[2];
    if (v === undefined) { v = args[++i]; if (v === undefined || v.startsWith('--')) return null; }
    o[m[1]] = v;
  }
  return o;
}
export function main(argv) {
  const usage = { ok: false, final: 'ELEVATED', errors: ['bad_usage'], usage: 'risk-floor.mjs check --base <c> --planned-paths <json|file> --claimed <p> --ai <p> [--repo <d>] | reassess --base <c> --head <c|WORKTREE> --recorded-line <file|-> --claimed <p> --ai <p> [--repo <d>]' };
  const cmd = argv[0], allowed = typeof cmd === 'string' && Object.hasOwn(FLAGS, cmd) ? FLAGS[cmd] : null;
  const f = allowed ? parseFlags(argv.slice(1), allowed) : null;
  const need = cmd === 'check' ? ['base', 'planned-paths', 'claimed', 'ai'] : ['base', 'head', 'recorded-line', 'claimed', 'ai'];
  if (!f || need.some((k) => f[k] === undefined)) return { code: 1, out: usage };
  let r;
  if (cmd === 'check') {
    let paths = null; try { paths = parsePathsArg(f['planned-paths']); } catch { /* stays null: malformed */ }
    r = check({ repo: f.repo, base: f.base, plannedPaths: paths, claimed: f.claimed, ai: f.ai });
  } else {
    let recordedLine = null; try { recordedLine = readText(f['recorded-line']); } catch { /* stays null: base_mismatch */ }
    r = reassess({ repo: f.repo, base: f.base, head: f.head, recordedLine, claimed: f.claimed, ai: f.ai });
  }
  return { code: exitCodeFor(r), out: r };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { code, out } = main(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exitCode = code;
}
