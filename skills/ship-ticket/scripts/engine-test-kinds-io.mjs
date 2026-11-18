/**
 * S-01b2 P4r: runner evidence I/O (design rev 6, sections 1, 3, 4, 5.2 row P4r; owner decision OD-2).
 *
 * CLAIM (L-ran, and nothing stronger; L5/L12): a record built here says the runner EXECUTED a test whose own title
 * carries a marker and recorded it as passed. It does NOT say the test is meaningful (a vacuous or assertion-free test passes;
 * mutation testing and independent review cover that), and it does not cover Angular/nx tests, `threads` pools or tampering
 * with installed dependencies. This module never runs a runner: it consumes a report PROVIDED BY THE CALLER (P5r, from the
 * sealed runner result of FX) together with provenance, and decides what that report may be believed for.
 *
 * SUPPORTED GRAMMAR (L11): everything not listed here is a typed refusal or no evidence, never a guess.
 *   runner      format `vitest-json`, runner `vitest`, args holding exactly `--pool=forks` and `--reporter=json` and no other
 *               `--pool*` / `--reporter*`. ANY other runner, format or pool is `runner_unsupported` (OD-2; never bypassed).
 *   report      ONE JSON document (no duplicate keys in any object, depth <= 64) of at most 32 MiB, with at most 100000
 *               results, read through the existing `parseRunnerOutput('vitest-json', text)`. The fields read are
 *               `testResults[].{name, status, assertionResults[].{ancestorTitles, title, status}}`; nothing else is read.
 *   result      counts only when `status === 'pass'` (skip, todo, `.only`-sibling skips, `ctx.skip()` are `skip`; a failure or a
 *               load error makes the WHOLE record `evidence_run_failed`, so a RED run never satisfies a kind).
 *   marker      `[kind:<id>]` / `[plan:<id>]` read from the test's OWN (leaf) title only, through P3 `markers`.
 *   file        realpath inside the repo, in P, a regular non-symlink file matching the test globs and the entry's `covers`,
 *               and holding MORE of that marker than the file at `base_sha` (R-3, no base run).
 *
 * PROVENANCE (supplied by the caller, per design section 1): `runner_id`, `runner_version`, `attempt_id`, `exit_code`,
 * `report_sha256` (the sealed digest; checked against the text), `report_eof`, `sealed`, `quiesced`, `binding_verified` (all
 * `true`), `evidence_id_before` (the identity before the run). The command and config digests are computed here.
 *
 * State and output carry ids, codes, counts and repo-relative file names only: NEVER a test title (AC6).
 * Hostile input (L3, L6): own data descriptors only, no proxy, every visit charged to LIMITS.maxWork or a named cap, nothing throws.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { types } from 'node:util';
import { changedPaths, compileGlob, matchSegments } from './risk-floor.mjs';
import { markers, kindsForClasses, PROTECTED_TAGS, ITEM_ID } from './test-kinds.mjs';
import { testKindsVerdict } from './engine-test-kinds.mjs';
import { testKindWaivers } from './engine-authority.mjs';
import { parseRunnerOutput } from './gate.mjs';

export const LIMITS = Object.freeze({ maxReportBytes: 32 * 1024 * 1024, maxResults: 100_000, maxPaths: 20_000, maxIdentityBytes: 256 * 1024 * 1024,
  maxFileBytes: 4 * 1024 * 1024, maxMarkerFiles: 2_000, maxScanTokens: 8_000_000, maxDepth: 64, maxList: 64, maxPathChars: 512 });
export const REFUSALS = Object.freeze(['runner_unsupported', 'runner_config_changed', 'runner_output_tampered', 'runner_survivor', 'evidence_run_failed', 'evidence_unavailable', 'candidate_moved', 'quiescence_unknown', 'evidence_budget_exceeded', 'test_kinds_error']);
export const FILE_VOIDS = Object.freeze(['runner_uncovered', 'result_outside_repo', 'not_in_P', 'not_regular', 'not_test_file', 'file_too_large']);
export const CLAIM = 'L-ran';
export const BUILTIN_TEST_GLOBS = Object.freeze(['**/*.test.*', '**/*.spec.*']);
const INTEGRITY = ['sealed', 'report_eof', 'quiesced', 'binding_verified', 'identity_stable'];
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/, HEX64 = /^[0-9a-f]{64}$/;

class Refusal extends Error { constructor(code) { super(code); this.code = code; } }
const refuse = (code) => { throw new Refusal(code); };
const charge = (ctx, n = 1) => { ctx.work += n; if (ctx.work > ctx.max) refuse('evidence_budget_exceeded'); };
const sha256 = (...parts) => { const h = createHash('sha256'); for (const p of parts) h.update(p); return h.digest('hex'); };

// ---- hostile-input readers (L6): own DATA descriptors only, never a trap or a getter ----
const plain = (v) => v !== null && typeof v === 'object' && !types.isProxy(v) && [Object.prototype, null].includes(Reflect.getPrototypeOf(v));
function own(o, k) {
  if (!plain(o) && !(Array.isArray(o) && !types.isProxy(o))) refuse('test_kinds_error');
  const d = Reflect.getOwnPropertyDescriptor(o, k);
  if (!d || !('value' in d)) refuse('test_kinds_error');
  return d.value;
}
function arr(v, max, ok, ctx) {
  if (!Array.isArray(v) || types.isProxy(v) || Reflect.getPrototypeOf(v) !== Array.prototype) refuse('test_kinds_error');
  const n = Reflect.getOwnPropertyDescriptor(v, 'length')?.value;
  if (!Number.isSafeInteger(n) || n < 0) refuse('test_kinds_error');
  if (n > max) refuse('evidence_budget_exceeded');
  charge(ctx, n + 1);
  const out = [];
  for (let i = 0; i < n; i++) { const x = own(v, String(i)); if (!ok(x)) refuse('test_kinds_error'); out.push(x); }
  return out;
}
const isStr = (max) => (v) => typeof v === 'string' && v.length <= max;
/** A repo-relative POSIX path: no absolute, backslash, NUL, empty, `.` or `..` segment. */
const safeRel = (p) => typeof p === 'string' && p.length > 0 && p.length <= LIMITS.maxPathChars && !/[\\\0]/.test(p) && !p.startsWith('/') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
const isGlob = (g) => { try { compileGlob(g); return typeof g === 'string' && g.length <= LIMITS.maxPathChars; } catch { return false; } };

// ---- git (TEMPORARY fourth copy of the hardened-git helper, as in test-kinds.mjs: TODO(S-02a0b) replace with lib/git-capability.mjs) ----
const gitEnv = () => { const e = { ...process.env }; for (const k of Object.keys(e)) if (k.toUpperCase().startsWith('GIT_')) delete e[k]; return { ...e, GIT_NO_REPLACE_OBJECTS: '1', GIT_LITERAL_PATHSPECS: '1', GIT_OPTIONAL_LOCKS: '0' }; };
const git = (cwd, args, max = 1 << 20) => execFileSync('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', ...args], { cwd, env: gitEnv(), maxBuffer: max, stdio: ['ignore', 'pipe', 'pipe'] });
const topOf = (repo) => realpathSync.native(git(realpathSync.native(repo), ['rev-parse', '--show-toplevel']).toString('utf8').replace(/\n$/, ''));

// ---- the evidence identity (design rev 5 section 1a): the candidate-id encoding over P, from the worktree ----
/** `e1:` + sha256 over base_sha and every changed path (byte order): path, kind, mode, length, bytes. Never throws. */
export function evidenceIdentity({ repo, baseSha, exclusions = [] } = {}) {
  try { return { ok: true, ...identity(repo, baseSha, exclusions) }; } catch (e) { return { ok: false, code: e instanceof Refusal ? e.code : 'evidence_unavailable' }; }
}
function identity(repo, baseSha, exclusions) {
  if (typeof baseSha !== 'string' || !SHA.test(baseSha)) refuse('test_kinds_error');
  const ex = arr(exclusions, LIMITS.maxList, safeRel, { work: 0, max: 1e6 });
  const top = topOf(repo);
  let all;
  try { all = changedPaths(top, baseSha, 'WORKTREE'); } catch { refuse('evidence_unavailable'); }
  const excluded = (p) => p.startsWith('.ship-ticket/') || ex.some((e) => p === e || p.startsWith(`${e.replace(/\/$/, '')}/`));
  const paths = all.filter((p) => !excluded(p));
  if (paths.length > LIMITS.maxPaths) refuse('evidence_budget_exceeded');
  const h = createHash('sha256'), abs = (p) => join(top, p);
  h.update(`ship-ticket-tk-evidence-v1\0${baseSha}\0`);
  let bytes = 0;
  for (const p of paths) {
    let kind = 'deleted', mode = '0', content = Buffer.from('tombstone');
    let st = null;
    try { st = lstatSync(abs(p)); } catch (e) { if (e?.code !== 'ENOENT') refuse('evidence_unavailable'); }
    if (st) {
      if (st.isSymbolicLink()) { kind = 'symlink'; mode = '120000'; content = Buffer.from(readlinkSync(abs(p))); }
      else if (st.isFile()) {
        bytes += st.size; if (bytes > LIMITS.maxIdentityBytes) refuse('evidence_budget_exceeded');
        kind = 'file'; mode = (st.mode & 0o111) === 0 ? '100644' : '100755'; content = readFileSync(abs(p));
      } else if (st.isDirectory()) { kind = 'submodule'; mode = '160000'; try { content = Buffer.from(git(abs(p), ['rev-parse', 'HEAD']).toString('utf8').trim()); } catch { refuse('evidence_unavailable'); } }
      else refuse('evidence_unavailable'); // a fifo or device is never read (it could block)
    }
    h.update(Buffer.from(p, 'utf8')); h.update(`\0${kind}\0${mode}\0${content.length}\0`); h.update(content); h.update('\0');
  }
  return { evidence_id: `e1:${h.digest('hex')}`, paths, top };
}

// ---- the declared entry (config.testCommands.<name>) and the supported-runner rule (OD-2) ----
/** Validate an entry; `runner_unsupported` for any runner, format or pool outside the supported grammar. Returns a plain copy. */
export function readEntry(entry) {
  const ctx = { work: 0, max: 1e6 };
  const name = own(entry, 'name'), format = own(entry, 'format'), cmd = own(entry, 'cmd');
  if (!isStr(80)(name) || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) || !isStr(512)(cmd)) refuse('test_kinds_error');
  if (format !== 'vitest-json') refuse('runner_unsupported');
  const args = arr(own(entry, 'args'), 256, isStr(1024), ctx);
  const covers = arr(own(entry, 'covers'), LIMITS.maxList, isGlob, ctx), configPaths = arr(own(entry, 'config_paths'), LIMITS.maxList, safeRel, ctx);
  if (!covers.length) refuse('test_kinds_error');
  if (basename(cmd).replace(/\.(?:cmd|exe)$/i, '') !== 'vitest') refuse('runner_unsupported');
  if (args.filter((a) => a === '--pool=forks').length !== 1 || args.some((a) => /^--pool/.test(a) && a !== '--pool=forks')) refuse('runner_unsupported');
  if (args.filter((a) => a === '--reporter=json').length !== 1 || args.some((a) => /^--reporter/.test(a) && a !== '--reporter=json')) refuse('runner_unsupported');
  return { name, format, cmd, args, covers, config_paths: configPaths };
}
/** The digest of the command after substitution. */
export const commandDigest = (cmd, args) => sha256(JSON.stringify([cmd, args]));
/** The digest of the `config_paths` bytes (a missing file is `absent`; a symlink or non-regular file is refused). Never throws. */
export function configDigest(repo, paths) {
  try {
    const list = arr(paths, LIMITS.maxList, safeRel, { work: 0, max: 1e6 }), top = topOf(repo), h = createHash('sha256');
    for (const p of [...new Set(list)].sort()) {
      let st = null;
      try { st = lstatSync(join(top, p)); } catch (e) { if (e?.code !== 'ENOENT') refuse('evidence_unavailable'); }
      if (st && (!st.isFile() || st.size > LIMITS.maxFileBytes)) refuse('evidence_unavailable');
      h.update(`${p}\0`); h.update(st ? readFileSync(join(top, p)) : 'absent'); h.update('\0');
    }
    return { ok: true, digest: h.digest('hex') };
  } catch (e) { return { ok: false, code: e instanceof Refusal ? e.code : 'evidence_unavailable' }; }
}

// ---- the report: a strict JSON shape scan (duplicate keys, depth, work) before the existing parser reads it ----
/** Throws a Refusal: evidence_unavailable for malformed/duplicate-key/too-deep JSON, evidence_budget_exceeded past the token cap. */
function scanJson(text) {
  let i = 0, tokens = 0;
  const n = text.length, bad = () => refuse('evidence_unavailable');
  const ws = () => { while (i < n) { const c = text.charCodeAt(i); if (c === 32 || c === 10 || c === 13 || c === 9) i++; else break; } };
  const str = () => { const s = i++; while (i < n) { const c = text.charCodeAt(i); if (c === 34) { i++; return text.slice(s, i); } if (c === 92) i += 2; else if (c < 32) bad(); else i++; } return bad(); };
  const lit = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;
  const val = (d) => {
    if (d > LIMITS.maxDepth) bad();
    if (++tokens > LIMITS.maxScanTokens) refuse('evidence_budget_exceeded');
    ws();
    const c = text[i];
    if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']', keys = new Set();
      i++; ws();
      if (text[i] === close) { i++; return; }
      for (;;) {
        ws();
        if (c === '{') {
          if (text[i] !== '"') bad();
          const raw = str();
          let key = raw.slice(1, -1);
          if (key.includes('\\')) { try { key = JSON.parse(raw); } catch { bad(); } }
          if (keys.has(key)) bad(); // a duplicate key: which value wins is a parser accident, never evidence
          keys.add(key); ws();
          if (text[i++] !== ':') bad();
        }
        val(d + 1); ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === close) { i++; return; }
        bad();
      }
    } else if (c === '"') str();
    else { lit.lastIndex = i; const m = lit.exec(text); if (!m) bad(); i += m[0].length; }
  };
  val(0); ws();
  if (i !== n) bad();
}

// ---- file classification and marker counting ----
const matcher = (globs) => globs.map((g) => compileGlob(g));
const matches = (compiled, rel, ctx) => {
  charge(ctx);
  try { const segs = rel.split('/'); return compiled.some((g) => matchSegments(g, segs, ctx.glob)); } catch { return refuse('evidence_budget_exceeded'); }
};
const MARKER = /\[(kind|plan):([A-Za-z0-9][A-Za-z0-9_-]{0,63})\]/g;
/** Occurrences of every `[kind:x]` / `[plan:x]` marker in a file's bytes (latin1 view: markers are ASCII, line endings do not matter). */
function countMarkers(buf) {
  const out = new Map();
  for (const m of buf.toString('latin1').matchAll(MARKER)) out.set(`${m[1]}:${m[2]}`, (out.get(`${m[1]}:${m[2]}`) ?? 0) + 1);
  return out;
}
/** The file's blob at the base commit, or null when it does not exist there. */
function baseBlob(top, sha, rel) {
  let entry;
  try { entry = git(top, ['ls-tree', '-z', sha, '--', rel]).toString('utf8').replace(/\0$/, ''); } catch { refuse('evidence_unavailable'); }
  const m = /^\d+ blob ([0-9a-f]+)\t/.exec(entry);
  if (!m) return null;
  try { return git(top, ['cat-file', 'blob', m[1]], LIMITS.maxFileBytes + 1); } catch (e) { return refuse(e?.code === 'ENOBUFS' ? 'evidence_budget_exceeded' : 'evidence_unavailable'); }
}
/** A report file name to a POSIX repo-relative path, or null when it escapes `root` (`P` is the platform path module: win32 in tests). */
export function toRepoRel(root, file, P = { relative, isAbsolute, sep }) {
  if (typeof file !== 'string' || !P.isAbsolute(file)) return null;
  const rel = P.relative(root, file);
  if (rel === '' || rel === '..' || rel.startsWith(`..${P.sep}`) || P.isAbsolute(rel)) return null;
  return rel.split(P.sep).join('/');
}

// ---- building a record from a provided report (section 1 output; sections 3-4 counting) ----
/**
 * buildRecord({ repo, baseSha, entry, tests:{globs}, dagDigest, commandArgs?, report:{text, ...provenance} })
 *   -> { ok:true, record, voids } | { ok:false, code }
 * `report` is `{ text, runner_id, runner_version, attempt_id, exit_code, report_sha256, report_eof, sealed, quiesced, binding_verified, evidence_id_before }`.
 * The record holds ids, codes, counts and repo-relative file names only. Never throws.
 */
export function buildRecord(input) {
  try { return { ok: true, ...build(input) }; } catch (e) { return { ok: false, code: e instanceof Refusal ? e.code : 'test_kinds_error' }; }
}
function build(input) {
  const ctx = { work: 0, max: 5_000_000, glob: { steps: 0 } };
  const entry = readEntry(own(input, 'entry')), repo = own(input, 'repo'), baseSha = own(input, 'baseSha'), dagDigest = own(input, 'dagDigest');
  const R = own(input, 'report'), text = own(R, 'text');
  const tests = own(input, 'tests'), globs = arr(own(tests, 'globs'), LIMITS.maxList, isGlob, ctx);
  const prov = {};
  for (const k of ['runner_id', 'runner_version', 'attempt_id', 'report_sha256', 'evidence_id_before']) prov[k] = own(R, k);
  for (const k of ['report_eof', 'sealed', 'quiesced', 'binding_verified']) prov[k] = own(R, k);
  const exit = own(R, 'exit_code');
  if (typeof text !== 'string' || !isStr(80)(prov.attempt_id) || !isStr(64)(prov.runner_version) || !HEX64.test(dagDigest) || typeof prov.evidence_id_before !== 'string') refuse('test_kinds_error');
  if (prov.runner_id !== 'vitest') refuse('runner_unsupported');
  if (text.length > LIMITS.maxReportBytes) refuse('evidence_budget_exceeded');
  const id = evidenceIdentity({ repo, baseSha, exclusions: ownOr(input, 'exclusions', []) });
  if (!id.ok) refuse(id.code);
  const inP = new Set(id.paths);
  if (entry.config_paths.some((p) => inP.has(p))) refuse('runner_config_changed');
  const digest = sha256(text);
  if (prov.sealed !== true || prov.binding_verified !== true || typeof prov.report_sha256 !== 'string' || prov.report_sha256 !== digest) refuse('runner_output_tampered');
  if (prov.report_eof !== true) refuse('runner_survivor');
  if (prov.quiesced !== true) refuse('quiescence_unknown');
  if (exit !== 0) refuse('evidence_run_failed'); // non-zero, a timeout (null) or anything else: a RED run is never evidence
  if (prov.evidence_id_before !== id.evidence_id) refuse('candidate_moved');
  scanJson(text);
  const parsed = parseRunnerOutput(entry.format, text);
  if (!parsed.supported) refuse('evidence_unavailable');
  const results = parsed.results;
  if (results.length > LIMITS.maxResults) refuse('evidence_budget_exceeded');
  if (results.some((r) => r.status === 'fail')) refuse('evidence_run_failed');

  // group the passing results that carry a marker in their own title, by file
  const byFile = new Map();
  let passed = 0;
  for (const r of results) {
    charge(ctx);
    if (r.status !== 'pass') continue;
    passed++;
    if (typeof r.title !== 'string' || r.title.length > 2048 || typeof r.file !== 'string') continue;
    const m = markers([r.title]);
    if (!m.kinds.length && !m.items.length && !m.unknown.length) continue;
    const slot = byFile.get(r.file) ?? { ids: new Set(), unknown: new Set() };
    for (const k of m.kinds) slot.ids.add(`kind:${k}`);
    for (const i of m.items) (ITEM_ID.test(i) ? slot.ids : slot.unknown).add(`plan:${i}`);
    for (const u of m.unknown) slot.unknown.add(u);
    byFile.set(r.file, slot);
  }
  if (byFile.size > LIMITS.maxMarkerFiles) refuse('evidence_budget_exceeded');
  const testGlobs = matcher([...BUILTIN_TEST_GLOBS, ...globs]), covers = matcher(entry.covers);
  const files = [], voids = {};
  let unknownMarkers = 0, credited = 0;
  for (const [file, slot] of [...byFile].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const v = fileVoid(id, inP, file, testGlobs, covers, ctx);
    if (v.void) { voids[v.void] = (voids[v.void] ?? 0) + 1; files.push({ file: v.rel ?? null, outcome: v.void, credited: [] }); continue; }
    const cand = countMarkers(v.buf), blob = baseBlob(id.top, baseSha, v.rel), base = blob ? countMarkers(blob) : new Map();
    const ids = [...slot.ids].filter((m) => (cand.get(m) ?? 0) > (base.get(m) ?? 0)).sort(); // R-3
    unknownMarkers += slot.unknown.size; credited += ids.length;
    files.push({ file: v.rel, outcome: 'counted', credited: ids });
  }
  files.sort((a, b) => (a.file ?? '') < (b.file ?? '') ? -1 : 1);
  const record = { evidence_id: id.evidence_id, base_sha: baseSha, entry: entry.name, dag_digest: dagDigest, command_digest: commandDigest(entry.cmd, entry.args),
    config_digest: cfg(repo, entry), attempt_id: prov.attempt_id, exit_code: 0, report_sha256: digest, report_len: text.length,
    runner: { id: prov.runner_id, version: prov.runner_version }, claim: CLAIM,
    integrity: Object.fromEntries(INTEGRITY.map((k) => [k, true])), files,
    counts: { results: results.length, passed, marker_files: byFile.size, credited, unknown_markers: unknownMarkers } };
  return { record, voids };
}
const ownOr = (o, k, dflt) => (Reflect.getOwnPropertyDescriptor(o, k) ? own(o, k) : dflt);
function cfg(repo, entry) { const c = configDigest(repo, entry.config_paths); if (!c.ok) refuse(c.code); return c.digest; }
/** One result file: `{void, rel?}` or `{rel, buf}` (the candidate bytes, read once). */
function fileVoid(id, inP, file, testGlobs, covers, ctx) {
  if (!isAbsolute(file)) return { void: 'result_outside_repo' }; // a relative name would resolve against the cwd, never the repo
  let real;
  try { real = realpathSync.native(file); } catch (e) { return { void: e?.code === 'ENOENT' ? 'not_regular' : 'result_outside_repo' }; }
  const rel = toRepoRel(id.top, real);
  if (rel === null) return { void: 'result_outside_repo' };
  if (!inP.has(rel)) return { void: 'not_in_P', rel };
  let st;
  try { st = lstatSync(join(id.top, rel)); } catch { return { void: 'not_regular', rel }; }
  if (!st.isFile()) return { void: 'not_regular', rel };
  if (!matches(testGlobs, rel, ctx)) return { void: 'not_test_file', rel };
  if (!matches(covers, rel, ctx)) return { void: 'runner_uncovered', rel };
  if (st.size > LIMITS.maxFileBytes) return { void: 'file_too_large', rel };
  return { rel, buf: readFileSync(join(id.top, rel)) };
}

// ---- reuse (section 3): four conditions, each of which alone invalidates a stored record ----
/**
 * recordUsable(R, cur) -> { ok:true } | { ok:false, reason: 'identity'|'integrity'|'applicability'|'freshness'|'malformed' }
 * cur = { evidence_id, base_sha, entry (a readEntry copy), dag_digest, command_digest, config_digest }.
 */
export function recordUsable(R, cur) {
  try {
    const ctx = { work: 0, max: 1e6, glob: { steps: 0 } };
    const g = (k) => own(R, k), c = (k) => own(cur, k);
    const entry = c('entry'), integ = g('integrity'), files = arr(g('files'), LIMITS.maxMarkerFiles, plain, ctx);
    const ID = /^(?:kind|plan):[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
    for (const f of files) if (own(f, 'outcome') === 'counted') { if (!safeRel(own(f, 'file'))) return { ok: false, reason: 'malformed' }; arr(own(f, 'credited'), 512, (m) => typeof m === 'string' && ID.test(m), ctx); }
    if (!Number.isSafeInteger(own(own(R, 'counts'), 'unknown_markers')) || own(own(R, 'counts'), 'unknown_markers') < 0) return { ok: false, reason: 'malformed' };
    if (g('evidence_id') !== c('evidence_id') || g('base_sha') !== c('base_sha')) return { ok: false, reason: 'identity' };
    if (!INTEGRITY.every((k) => own(integ, k) === true)) return { ok: false, reason: 'integrity' };
    const covers = matcher(own(entry, 'covers'));
    const covered = files.every((f) => own(f, 'outcome') !== 'counted' || matches(covers, own(f, 'file'), ctx));
    if (g('entry') !== own(entry, 'name') || g('exit_code') !== 0 || own(entry, 'format') !== 'vitest-json' || !covered) return { ok: false, reason: 'applicability' };
    if (g('dag_digest') !== c('dag_digest') || g('command_digest') !== c('command_digest') || g('config_digest') !== c('config_digest')) return { ok: false, reason: 'freshness' };
    return { ok: true };
  } catch { return { ok: false, reason: 'malformed' }; }
}

// ---- the verdict (P2 input + P6 waivers; P4r never runs anything) ----
const refusedVerdict = (code, evidence_id = null) => ({ status: 'refused', code, codes: [code], required_kinds: [], required_items: [], protected_kinds: [], missing_kinds: [], unmapped_items: [], waived: [], counts: {}, evidence_id, claim: CLAIM, records: {}, voids: {} });
/**
 * tkVerdict(E, point) -> the P2 verdict plus { evidence_id, claim:'L-ran', records:{<entry>: 'current'|'absent'|'stale:<reason>'}, voids:{runner_uncovered:n} }.
 * E = { repo, baseSha, exclusions?, dagDigest, entries:[entry], commands:{<name>:{cmd,args}} (the CURRENT substituted commands),
 *       records:{<name>: R}, tests:{globs}, bound, declaration, reassessed:[class], S (the engine state for waivers), retryAuthorised? }.
 * P2 is called through its REAL interface (the real `kindsForClasses`, called by P2 with ONE object); held and open repairs are 0 (inert in V0).
 * Never throws.
 */
export function tkVerdict(E, point) {
  try { return verdict(E, point); } catch (e) { return refusedVerdict(e instanceof Refusal ? e.code : 'test_kinds_error'); }
}
function verdict(E, point) {
  const ctx = { work: 0, max: 5_000_000, glob: { steps: 0 } };
  const repo = own(E, 'repo'), baseSha = own(E, 'baseSha'), dagDigest = own(E, 'dagDigest');
  const entries = arr(own(E, 'entries'), LIMITS.maxList, plain, ctx).map(readEntry); // runner_unsupported is raised, never skipped
  const id = evidenceIdentity({ repo, baseSha, exclusions: ownOr(E, 'exclusions', []) });
  if (!id.ok) refuse(id.code);
  const inP = new Set(id.paths);
  if (entries.some((en) => en.config_paths.some((p) => inP.has(p)))) refuse('runner_config_changed');
  const globs = arr(own(own(E, 'tests'), 'globs'), LIMITS.maxList, isGlob, ctx), testGlobs = matcher([...BUILTIN_TEST_GLOBS, ...globs]);
  const commands = own(E, 'commands'), records = own(E, 'records');
  if (!plain(commands) || !plain(records)) refuse('test_kinds_error');
  const coverSets = entries.map((en) => matcher(en.covers));
  const kinds = new Set(), items = new Set(), states = {};
  let unknown = 0;
  for (const en of entries) {
    const R = Reflect.getOwnPropertyDescriptor(records, en.name);
    if (!R) { states[en.name] = 'absent'; continue; }
    if (!('value' in R)) refuse('test_kinds_error');
    const cmd = own(commands, en.name), cd = configDigest(repo, en.config_paths);
    if (!cd.ok) refuse(cd.code);
    const u = recordUsable(R.value, { evidence_id: id.evidence_id, base_sha: baseSha, entry: en, dag_digest: dagDigest, command_digest: commandDigest(own(cmd, 'cmd'), arr(own(cmd, 'args'), 256, isStr(1024), ctx)), config_digest: cd.digest });
    states[en.name] = u.ok ? 'current' : `stale:${u.reason}`;
    if (!u.ok) continue;
    for (const f of own(R.value, 'files')) for (const m of own(f, 'credited')) (m.startsWith('kind:') ? kinds : items).add(m.slice(m.indexOf(':') + 1));
    unknown += own(own(R.value, 'counts'), 'unknown_markers');
  }
  let uncovered = 0;
  for (const p of id.paths) if (matches(testGlobs, p, ctx) && !coverSets.some((c) => matches(c, p, ctx))) uncovered++;
  const S = own(E, 'S');
  const base = { bound: own(E, 'bound'), declaration: own(E, 'declaration'), reassessed: own(E, 'reassessed'), evidence: { kinds: [...kinds].sort(), items: [...items].sort(), unknown_markers: unknown } };
  const deps = { kindsForClasses, protectedTags: [...PROTECTED_TAGS] };
  const run = (w) => testKindsVerdict({ ...base, waivers: w, state: { point, retry_authorised: ownOr(E, 'retryAuthorised', false) === true, held: 0, open_repairs: 0 } }, deps);
  const v0 = run({ trusted: [], untrusted: [] });
  const done = (v) => ({ ...v, evidence_id: id.evidence_id, claim: CLAIM, records: states, voids: { runner_uncovered: uncovered } });
  if (['test_kinds_error', 'evidence_budget_exceeded'].includes(v0.code)) return done(v0);
  // P6 owns waiver matching and trust: it needs the REQUIRED and PROTECTED sets P2 just recomputed, and the evidence identity as the candidate
  const w = testKindWaivers(S, id.evidence_id, { required: [...v0.required_kinds.map((k) => `kind:${k}`), ...v0.required_items.map((i) => `plan:${i}`)], protected: v0.protected_kinds.map((k) => `kind:${k}`) });
  if (!w.ok) return done({ ...v0, status: 'refused', code: w.code, codes: [w.code] });
  return done(run({ trusted: w.waived, untrusted: w.unauthorized }));
}
