#!/usr/bin/env node
/**
 * Structural PATH risk floor (ASTF-11, S-10). The repository declares its sensitive paths in `.ship-ticket/risk-paths.json`,
 * read from the BASE commit (never the working tree: the change being checked must not control its own check). Deterministic
 * code turns those globs plus a list of paths into a floor; an AI assessment owns semantic risk, business impact and indirect
 * dependencies. final = max(floor, claimed, ai): it is never lower than any of the three. A structural floor only RAISES, and
 * a path that matches nothing is NOT evidence of low risk. A repository that declares no paths gets no structural protection
 * (floor STANDARD, reason `no_risk_paths_declared`); the AI assessment is then the only protection and is still required.
 * Text/keyword classification was evaluated and dropped from this slice (deferred to an optional, measured corpus experiment).
 *
 *   risk-floor.mjs check    --base <commit> --planned-paths <json array|file> --claimed <profile> --ai <profile> [--repo <dir>]
 *   risk-floor.mjs reassess --base <commit> --head <commit|WORKTREE> --claimed <profile> --ai <profile> [--repo <dir>]
 * `reassess` recomputes the floor from the ACTUAL changed paths (git diff base..head; renames count both paths, deletions and
 * mode-only changes count; WORKTREE = the working tree against base plus untracked files). Profiles are STANDARD or ELEVATED in
 * any case; anything else is an error. Flags take `--flag value` or `--flag=value`; a missing value, unknown or repeated flag, or
 * a positional argument is an error. Files are read as strict UTF-8 (BOMs of UTF-16/32, NUL, invalid bytes rejected), at most
 * MAX_INPUT bytes.
 * Exit codes: 0 = `claimed` already meets the final; 2 = final is HIGHER than `claimed` (raise the classification before release);
 * 1 = unusable or untrustworthy input (missing/malformed paths, undecodable path, oversized, tampered or invalid declaration,
 * unknown profile, usage error). An exit-1 output still carries final=ELEVATED.
 * Glob syntax: `*` and `?` stay inside one path segment, a whole segment `**` spans zero or more segments, a pattern without `/`
 * matches at any depth, a trailing `/` means `dir/**`, everything else (including `[ ] { }`) is literal. Matching is
 * case-INSENSITIVE and NFC-normalised (over-classifying is safe), `\` counts as `/`, a leading `./` and `.` segments are dropped,
 * and a `..` segment or an absolute path is malformed.
 * ADVISORY, NOT ENFORCED: no gate or engine step runs this yet (wiring is the driver slice, S-23/S-24).
 */
import { openSync, readSync, closeSync, realpathSync, readFileSync, lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const MAX_INPUT = 2_000_000;
export const MAX_PATHS = 200_000;
export const DECLARATION_PATH = '.ship-ticket/risk-paths.json';
const RANK = { STANDARD: 0, ELEVATED: 1 };
export const normProfile = (c) => (typeof c === 'string' && Object.hasOwn(RANK, c.trim().toUpperCase()) ? c.trim().toUpperCase() : null);
const bad = (code, reason) => Object.assign(new Error(reason), { code });

// ---- paths and globs ----
const wellFormed = (x) => typeof x === 'string' && x !== '' && !/[\u0000�]|[\uD800-\uDFFF]/u.test(x);
function segmentsOf(p, what) {
  if (!wellFormed(p)) throw bad('malformed_input', `${what} is not a well-formed string`);
  let s = p.normalize('NFC').toLowerCase().replace(/\\/g, '/');
  if (s.startsWith('/') || /^[a-z]:\//.test(s)) throw bad('malformed_input', `${what} is absolute`);
  const segs = [];
  for (const seg of s.split('/')) { if (seg === '' || seg === '.') continue; if (seg === '..') throw bad('malformed_input', `${what} has a ".." segment`); segs.push(seg); }
  if (!segs.length) throw bad('malformed_input', `${what} is empty`);
  return segs;
}
function segMatch(pat, str) { // `*` any run, `?` one character, no backtracking blow-up (greedy two-pointer)
  let p = 0, s = 0, star = -1, mark = 0;
  while (s < str.length) {
    if (p < pat.length && (pat[p] === '?' || pat[p] === str[s])) { p++; s++; }
    else if (p < pat.length && pat[p] === '*') { star = p++; mark = s; }
    else if (star >= 0) { p = star + 1; s = ++mark; }
    else return false;
  }
  while (p < pat.length && pat[p] === '*') p++;
  return p === pat.length;
}
export function compileGlob(glob) {
  const slash = typeof glob === 'string' && /[/\\]/.test(glob.replace(/[/\\]+$/, ''));
  const trailing = typeof glob === 'string' && /[/\\]$/.test(glob);
  const segs = segmentsOf(glob, 'a glob').map((g) => (g === '**' ? g : g.replace(/\*+/g, '*')));
  if (trailing) segs.push('**');
  return slash || trailing ? segs : ['**', ...segs];
}
export function matchSegments(g, p) {
  let row = new Array(p.length + 1).fill(false); row[p.length] = true; // row[j]: g[i..] matches p[j..]
  for (let i = g.length - 1; i >= 0; i--) {
    const next = row; row = new Array(p.length + 1).fill(false);
    if (g[i] === '**') { row[p.length] = next[p.length]; for (let j = p.length - 1; j >= 0; j--) row[j] = next[j] || row[j + 1]; }
    else for (let j = p.length - 1; j >= 0; j--) row[j] = next[j + 1] && segMatch(g[i], p[j]);
  }
  return row[0];
}
export const globMatches = (glob, path) => matchSegments(compileGlob(glob), segmentsOf(path, 'a path'));

// ---- declaration ----
export function validateDeclaration(d) {
  const inv = (m) => bad('declaration_invalid', m);
  if (!d || typeof d !== 'object' || Array.isArray(d) || Object.keys(d).some((k) => !['version', 'classes'].includes(k)) || d.version !== 1) throw inv('version must be 1, only version and classes allowed');
  if (!Array.isArray(d.classes) || !d.classes.length || d.classes.length > 200) throw inv('classes must be a non-empty array of at most 200');
  const names = new Set(), out = [];
  for (const c of d.classes) {
    if (!c || typeof c !== 'object' || Object.keys(c).some((k) => !['name', 'floor', 'globs'].includes(k))) throw inv('a class has unknown keys');
    if (typeof c.name !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(c.name) || names.has(c.name)) throw inv('class names are unique [a-z0-9_-] identifiers');
    if (c.floor !== 'ELEVATED') throw inv('a class floor must be "ELEVATED"');
    if (!Array.isArray(c.globs) || !c.globs.length || c.globs.length > 500) throw inv('globs must be a non-empty array of at most 500');
    names.add(c.name);
    try { out.push({ name: c.name, globs: c.globs.map(compileGlob) }); } catch (e) { throw inv(`bad glob in ${c.name}: ${e.message}`); }
  }
  return out;
}

// ---- assessment (pure) ----
/** paths: array of strings. declaration: validated classes or null. Never throws: unusable input becomes final ELEVATED. */
export function assess({ paths, declaration = null, declSha = 'none', claimed, ai }) {
  const errors = [], reasons = [];
  const c = normProfile(claimed), a = normProfile(ai);
  if (c === null) errors.push('bad_claimed');
  if (a === null) errors.push('bad_ai');
  let segs = [];
  try {
    if (!Array.isArray(paths) || !paths.length || paths.length > MAX_PATHS) throw bad('malformed_input', 'paths must be a non-empty array within the limit');
    if (paths.reduce((n, p) => n + (typeof p === 'string' ? p.length : 0), 0) > MAX_INPUT) throw bad('malformed_input', 'paths are oversized');
    segs = paths.map((p) => segmentsOf(p, 'a path'));
  } catch (e) { errors.push(e.code ?? 'malformed_input'); }
  const classes = new Set(); let matched = 0;
  if (!errors.length) {
    if (!declaration) reasons.push('no_risk_paths_declared');
    else for (const p of segs) {
      let hit = false;
      for (const cl of declaration) if (cl.globs.some((g) => matchSegments(g, p))) { classes.add(cl.name); hit = true; }
      if (hit) matched++;
    }
  }
  const floor = errors.length || classes.size ? 'ELEVATED' : 'STANDARD';
  const base = errors.length ? 'ELEVATED' : floor;
  const final = [base, c ?? 'ELEVATED', a ?? 'ELEVATED'].reduce((x, y) => (RANK[y] > RANK[x] ? y : x));
  const names = [...classes].sort();
  return { ok: !errors.length, errors, floor, floor_classes: names, reasons, claimed: c ?? 'invalid', ai: a ?? 'invalid', final, raised: errors.length > 0 || final !== c,
    counts: { paths: Array.isArray(paths) ? paths.length : 0, matched },
    // Class names and counts only, never raw paths.
    record_line: `risk-floor: floor=${floor}; classes=${names.join(',') || 'none'}; claimed=${c ?? 'invalid'}; ai=${a ?? 'invalid'}; final=${final}; paths=${Array.isArray(paths) ? paths.length : 0}; matched=${matched}; declaration=${declSha}${errors.length ? `; errors=${errors.join(',')}` : ''}` };
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
      let got; try { got = readSync(fd, buf, n, buf.length - n, null); } catch (e) { if (e.code === 'EOF') break; if (e.code === 'EAGAIN') continue; throw e; }
      if (got === 0) break; n += got;
    }
  } finally { if (fd !== 0) closeSync(fd); }
  if (n > MAX_INPUT) throw bad('malformed_input', 'too_large');
  return buf.subarray(0, n);
}
export function parsePathsArg(v) {
  const text = v.trim().startsWith('[') ? v : decodeStrict(readBounded(v));
  if (text.length > MAX_INPUT) throw bad('malformed_input', 'too_large');
  return JSON.parse(text);
}

// ---- hardened git (mirrors fast-checks.mjs: no GIT_* inherited, replace objects off, literal pathspecs, raw -z paths) ----
const gitEnv = () => { const e = { ...process.env }; for (const k of Object.keys(e)) if (k.toUpperCase().startsWith('GIT_')) delete e[k]; e.GIT_NO_REPLACE_OBJECTS = '1'; e.GIT_LITERAL_PATHSPECS = '1'; return e; };
const gitRaw = (cwd, args) => execFileSync('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', ...args], { cwd, env: gitEnv(), maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const git = (cwd, args) => gitRaw(cwd, args).toString('utf8').replace(/\n$/, '');
const zSplit = (buf) => { const out = []; let at = 0; for (let i = 0; i < buf.length; i++) if (buf[i] === 0) { if (i > at) out.push(buf.subarray(at, i)); at = i + 1; } if (at < buf.length) out.push(buf.subarray(at)); return out; };
const utf8Path = (raw) => { const p = raw.toString('utf8'); return Buffer.from(p, 'utf8').equals(raw) ? p : null; };

function resolveRepo(repo, base) {
  if (typeof base !== 'string' || !base || base.startsWith('-')) throw bad('base_invalid', '--base must be a commit-ish not starting with "-"');
  let top, sha;
  try { top = realpathSync.native(git(realpathSync.native(repo), ['rev-parse', '--show-toplevel'])); } catch { throw bad('repo_unavailable', 'git could not resolve the repository'); }
  try { sha = git(top, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${base}^{commit}`]); } catch { throw bad('base_invalid', 'git could not resolve --base to a commit'); }
  return { top, sha };
}
/** The declaration as of BASE. `other` is the bytes it must equal (working tree or head), or null to skip that comparison. */
function readDeclaration(top, sha, otherReader) {
  let entry;
  try { entry = git(top, ['ls-tree', '-z', sha, '--', DECLARATION_PATH]); } catch { throw bad('repo_unavailable', 'git could not read the declaration at base'); }
  if (!entry) return { declaration: null, declSha: 'none' };
  const m = /^(\d+) (\w+) ([0-9a-f]+)\t/.exec(entry);
  if (!m || m[2] !== 'blob' || !/^100(644|755)$/.test(m[1])) throw bad('declaration_invalid', 'the base declaration is not a regular file');
  const bytes = gitRaw(top, ['cat-file', 'blob', m[3]]);
  const other = otherReader();
  if (other && !other.equals(bytes)) throw bad('declaration_tampered', `${DECLARATION_PATH} differs from its content at base`);
  if (!other) throw bad('declaration_tampered', `${DECLARATION_PATH} is missing from the compared state`);
  try { return { declaration: validateDeclaration(JSON.parse(decodeStrict(bytes))), declSha: createHash('sha256').update(bytes).digest('hex').slice(0, 16) }; }
  catch (e) { throw e.code ? e : bad('declaration_invalid', 'the base declaration is not valid JSON'); }
}
const failed = (e, claimed, ai) => { const r = assess({ paths: null, claimed, ai }); return { ...r, errors: [e.code ?? 'internal', ...r.errors.filter((x) => x !== 'malformed_input')], final: 'ELEVATED', raised: true, error_detail: String(e.message).slice(0, 200) }; };

export function check({ repo = '.', base, plannedPaths, claimed, ai }) {
  try {
    const { top, sha } = resolveRepo(repo, base);
    const { declaration, declSha } = readDeclaration(top, sha, () => { try { return lstatSync(join(top, DECLARATION_PATH)).isFile() ? readFileSync(join(top, DECLARATION_PATH)) : null; } catch { return null; } });
    return assess({ paths: plannedPaths, declaration, declSha, claimed, ai });
  } catch (e) { return failed(e, claimed, ai); }
}

export function changedPaths(top, sha, head) {
  let raws;
  if (head === 'WORKTREE') {
    for (const rec of zSplit(gitRaw(top, ['ls-files', '-v', '-z']))) if (/^[a-zS] /.test(rec.subarray(0, 2).toString('latin1'))) throw bad('index_flags_hidden', 'a tracked file carries an assume-unchanged or skip-worktree bit');
    raws = [...zSplit(gitRaw(top, ['diff', '-z', '--name-only', '--no-renames', '--ignore-submodules=none', sha, '--'])), ...zSplit(gitRaw(top, ['ls-files', '-z', '--others', '--exclude-standard']))];
  } else {
    if (typeof head !== 'string' || !head || head.startsWith('-')) throw bad('head_invalid', '--head must be a commit-ish or WORKTREE');
    let hsha; try { hsha = git(top, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${head}^{commit}`]); } catch { throw bad('head_invalid', 'git could not resolve --head'); }
    raws = zSplit(gitRaw(top, ['diff', '-z', '--name-only', '--no-renames', '--ignore-submodules=none', sha, hsha, '--']));
  }
  const seen = new Set(), out = [];
  for (const raw of raws.sort(Buffer.compare)) {
    const k = raw.toString('hex'); if (seen.has(k)) continue; seen.add(k);
    const p = utf8Path(raw); if (p === null) throw bad('malformed_input', 'a changed path is not valid UTF-8');
    out.push(p);
  }
  return out;
}

export function reassess({ repo = '.', base, head, claimed, ai }) {
  try {
    const { top, sha } = resolveRepo(repo, base);
    const otherReader = () => {
      if (head === 'WORKTREE') { try { return lstatSync(join(top, DECLARATION_PATH)).isFile() ? readFileSync(join(top, DECLARATION_PATH)) : null; } catch { return null; } }
      try { return gitRaw(top, ['cat-file', 'blob', `${git(top, ['rev-parse', '--verify', '--end-of-options', `${head}^{commit}`])}:${DECLARATION_PATH}`]); } catch { return null; }
    };
    const { declaration, declSha } = readDeclaration(top, sha, otherReader);
    return assess({ paths: changedPaths(top, sha, head), declaration, declSha, claimed, ai });
  } catch (e) { return failed(e, claimed, ai); }
}

// ---- CLI ----
const FLAGS = { check: ['base', 'planned-paths', 'claimed', 'ai', 'repo'], reassess: ['base', 'head', 'claimed', 'ai', 'repo'] };
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
  const usage = { ok: false, final: 'ELEVATED', errors: ['bad_usage'], usage: 'risk-floor.mjs check --base <c> --planned-paths <json|file> --claimed <p> --ai <p> [--repo <d>] | reassess --base <c> --head <c|WORKTREE> --claimed <p> --ai <p> [--repo <d>]' };
  const cmd = argv[0], allowed = FLAGS[cmd];
  const f = allowed ? parseFlags(argv.slice(1), allowed) : null;
  const need = cmd === 'check' ? ['base', 'planned-paths', 'claimed', 'ai'] : ['base', 'head', 'claimed', 'ai'];
  if (!f || need.some((k) => f[k] === undefined)) return { code: 1, out: usage };
  let r;
  if (cmd === 'check') {
    let paths = null; try { paths = parsePathsArg(f['planned-paths']); } catch { /* stays null: malformed */ }
    r = check({ repo: f.repo, base: f.base, plannedPaths: paths, claimed: f.claimed, ai: f.ai });
  } else r = reassess({ repo: f.repo, base: f.base, head: f.head, claimed: f.claimed, ai: f.ai });
  return { code: exitCodeFor(r), out: r };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { code, out } = main(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exitCode = code;
}
