/**
 * S-01b2 P4r: runner evidence I/O, the RECORD side (design rev 6, sections 1, 3, 4, 5.2 row P4r; owner decision OD-2).
 * The reuse rule and the verdict live in `engine-test-kinds-reuse.mjs`; both share the readers and the R-3 census below.
 *
 * CLAIM (L-ran, and nothing stronger; L5/L12): a record built here says the runner EXECUTED a test whose own title carries a
 * marker and recorded it as passed. It does NOT say the test is meaningful (a vacuous or assertion-free test passes; mutation
 * testing and independent review cover that), and it does not cover Angular/nx tests, `threads` pools or tampering with
 * installed dependencies. This module never runs a runner: it consumes a report PROVIDED BY THE CALLER (P5r, from the sealed
 * runner result of FX) with provenance, and decides what that report may be believed for. `channel_unsupported` (win32) and
 * `evidence_unquiet` (another attempt is live) are design section 1 refusals OWNED BY P5r/FX: they are decided before a run.
 *
 * SUPPORTED GRAMMAR (L11): an allowlist. Everything not listed is a typed refusal or no evidence, never a guess.
 *   entry   format `vitest-json`; cmd EXACTLY `node_modules/.bin/vitest` (repo-relative; the launcher runs it from the repo top);
 *           args EXACTLY `run --pool=forks --reporter=json --outputFile={report}`, optionally followed by ONE `{files}`. Any
 *           other runner, format, flag, order or `--` terminator is `runner_unsupported` (OD-2; never bypassed).
 *   command the args that RAN: the template with `{report}` -> `/dev/fd/3` and `{files}` -> 1..N repo-relative paths, none
 *           starting with `-`. The record's `command_digest` hashes exactly these args; the verdict hashes the same.
 *   report  at most 32 MiB of UTF-8 BYTES; ONE JSON document (no duplicate keys after escape decoding, depth <= 64);
 *           `success === true`, `numFailedTestSuites === 0`, `numFailedTests === 0`, every suite `status === 'passed'`
 *           (vitest 4 writes only `passed`/`failed`); at most 100000 results, counted BEFORE the parser materialises them.
 *           Fields read: those, plus `testResults[].{name, assertionResults[].{ancestorTitles, title, status}}`.
 *   result  counts only when `status === 'passed'`; a `failed` result or suite, or `success:false`, makes the WHOLE record
 *           `evidence_run_failed` even with exit 0. Any status outside vitest's six is `evidence_unavailable`.
 *   marker  `[kind:<id>]` / `[plan:<id>]` read from the test's OWN (leaf) title only, through P3 `markers`.
 *   file    the report name, realpath-resolved (the nearest existing ancestor for a missing file), inside the repo, in P, an
 *           lstat-regular file (a symlink is resolved first, so the TARGET is what counts), matching the test globs and the
 *           entry's `covers`, at most 4 MiB. Otherwise a typed FILE void that never credits.
 *
 * R-3, WHAT IS ENFORCED (section 4 rule 5, no base run). Marker m is credited from file f only when BOTH hold:
 *   (per file)  count_cand(f, m) - count_base(f, m) - skipped(f, m) > 0
 *   (over P)    sum_P count_cand(m) - sum_P count_base(m) - sum_P skipped(m) > 0  (deleted and renamed-away paths included)
 * where `count` is the number of `[kind:x]`/`[plan:x]` occurrences in the bytes and `skipped(f, m)` is the number of NON-passed
 * results in f whose own title carries m. So a pure rename or move credits nothing, nor does a skipped or todo test added
 * beside an old passing one (a skipped `.each` over-subtracts, failing closed); `preflight` has already refused any failed result.
 * NOT ENFORCED: a marker added in a comment or in dead code that never registers a test is indistinguishable from an added
 * title and CAN credit a passing test that already carried m, in f itself or (for a moved test) anywhere in P: the accepted
 * L-ran limit "gameable only by a visible added marker" (design section 4). A skip that is never reported is the same case.
 *
 * PROVENANCE (supplied by the caller, section 1): `runner_id`, `runner_version`, `attempt_id`, `exit_code`, `report_sha256`
 * (checked against the text), `report_eof`, `sealed`, `quiesced`, `binding_verified` (all `true`), `evidence_id_before`.
 * Refusal order in buildRecord: input shape, runner, report size, identity, `runner_config_changed`, tamper, survivor,
 * quiescence, exit, `candidate_moved`, report content (rev 6 section 1 orders the VERDICT codes; this is the build order).
 *
 * State and output carry ids, codes, counts and repo-relative file names only: NEVER a test title (AC6).
 * Hostile input (L3, L6): caller objects are read through own DATA descriptors only (no getter or proxy trap runs); work is
 * charged to per-call budgets and the named LIMITS. The exported entry points return refusals instead of throwing, except
 * `readEntry`/`commandFor`, which THROW a `Refusal` (they are the validators the entry points call).
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep, basename } from 'node:path';
import { types } from 'node:util';
import { changedPaths, compileGlob, matchSegments } from './risk-floor.mjs';
import { markers, ITEM_ID, KINDS } from './test-kinds.mjs';
import { parseRunnerOutput } from './gate.mjs';

export const LIMITS = Object.freeze({ maxReportBytes: 32 * 1024 * 1024, maxResults: 100_000, maxPaths: 20_000, maxIdentityBytes: 256 * 1024 * 1024,
  maxFileBytes: 4 * 1024 * 1024, maxMarkerFiles: 2_000, maxScanTokens: 8_000_000, maxDepth: 64, maxList: 64, maxPathChars: 512, maxTitleChars: 2048, maxIds: 512 });
export const REFUSALS = Object.freeze(['runner_unsupported', 'runner_config_changed', 'runner_output_tampered', 'runner_survivor', 'evidence_run_failed', 'evidence_unavailable', 'candidate_moved', 'quiescence_unknown', 'evidence_budget_exceeded', 'test_kinds_error']);
export const FILE_VOIDS = Object.freeze(['runner_uncovered', 'result_outside_repo', 'not_in_P', 'not_regular', 'not_test_file', 'file_too_large']);
export const CLAIM = 'L-ran';
export const BUILTIN_TEST_GLOBS = Object.freeze(['**/*.test.*', '**/*.spec.*']);
export const RUNNER = Object.freeze({ id: 'vitest', format: 'vitest-json', cmd: 'node_modules/.bin/vitest', args: Object.freeze(['run', '--pool=forks', '--reporter=json', '--outputFile={report}']), files: '{files}', report: '/dev/fd/3' });
export const INTEGRITY = Object.freeze(['sealed', 'report_eof', 'quiesced', 'binding_verified', 'identity_stable']);
export const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/, HEX64 = /^[0-9a-f]{64}$/, EVIDENCE_ID = /^e1:[0-9a-f]{64}$/, ENTRY_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
/** A marker id as the bytes spell it, and a CREDITABLE id (a known kind or a lifecycle item id). */
export const MARKER_ID = /^(?:kind|plan):[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const creditable = (m) => typeof m === 'string' && (m.startsWith('kind:') ? Object.hasOwn(KINDS, m.slice(5)) : m.startsWith('plan:') && ITEM_ID.test(m.slice(5)));

export class Refusal extends Error { constructor(code) { super(code); this.code = code; } }
export const refuse = (code) => { throw new Refusal(code); };
export const codeOf = (e, dflt) => (e instanceof Refusal ? e.code : dflt);
export const charge = (ctx, n = 1) => { ctx.work += n; if (ctx.work > ctx.max) refuse('evidence_budget_exceeded'); };
const sha256 = (...parts) => { const h = createHash('sha256'); for (const p of parts) h.update(p); return h.digest('hex'); };

// ---- hostile-input readers (L6): own DATA descriptors only, never a trap or a getter ----
export const plain = (v) => v !== null && typeof v === 'object' && !types.isProxy(v) && [Object.prototype, null].includes(Reflect.getPrototypeOf(v));
export function own(o, k) {
  if (!plain(o) && !(Array.isArray(o) && !types.isProxy(o))) refuse('test_kinds_error');
  const d = Reflect.getOwnPropertyDescriptor(o, k);
  if (!d || !('value' in d)) refuse('test_kinds_error');
  return d.value;
}
export const ownOr = (o, k, dflt) => { if (!plain(o)) refuse('test_kinds_error'); return Reflect.getOwnPropertyDescriptor(o, k) ? own(o, k) : dflt; };
export function arr(v, max, ok, ctx) {
  if (!Array.isArray(v) || types.isProxy(v) || Reflect.getPrototypeOf(v) !== Array.prototype) refuse('test_kinds_error');
  const n = Reflect.getOwnPropertyDescriptor(v, 'length')?.value;
  if (!Number.isSafeInteger(n) || n < 0) refuse('test_kinds_error');
  if (n > max) refuse('evidence_budget_exceeded');
  charge(ctx, n + 1);
  const out = [];
  for (let i = 0; i < n; i++) { const x = own(v, String(i)); if (!ok(x)) refuse('test_kinds_error'); out.push(x); }
  return out;
}
/** The object's own keys when they are exactly `keys` (a plain object, string keys only), else null. */
export function exactKeys(o, keys) {
  if (!plain(o)) return null;
  const ks = Reflect.ownKeys(o);
  return ks.length === keys.length && ks.every((k) => typeof k === 'string' && keys.includes(k)) ? ks : null;
}
export const isStr = (max) => (v) => typeof v === 'string' && v.length <= max;
/** A repo-relative POSIX path: no absolute, backslash, NUL, empty, `.` or `..` segment. */
export const safeRel = (p) => typeof p === 'string' && p.length > 0 && p.length <= LIMITS.maxPathChars && !/[\\\0]/.test(p) && !p.startsWith('/') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
const isGlob = (g) => { try { compileGlob(g); return typeof g === 'string' && g.length <= LIMITS.maxPathChars; } catch { return false; } };
export const globList = (v, ctx) => arr(v, LIMITS.maxList, isGlob, ctx);
export const matcher = (globs) => globs.map((g) => compileGlob(g));
export const matches = (compiled, rel, ctx) => {
  charge(ctx);
  try { const segs = rel.split('/'); return compiled.some((g) => matchSegments(g, segs, ctx.glob)); } catch { return refuse('evidence_budget_exceeded'); }
};

// ---- git (TEMPORARY fourth copy of the hardened-git helper, as in test-kinds.mjs: TODO(S-02a0b) replace with lib/git-capability.mjs) ----
const gitEnv = () => { const e = { ...process.env }; for (const k of Object.keys(e)) if (k.toUpperCase().startsWith('GIT_')) delete e[k]; return { ...e, GIT_NO_REPLACE_OBJECTS: '1', GIT_LITERAL_PATHSPECS: '1', GIT_OPTIONAL_LOCKS: '0' }; };
const git = (cwd, args, max = 1 << 20, input = undefined) => execFileSync('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', ...args], { cwd, env: gitEnv(), maxBuffer: max, input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
const topOf = (repo) => realpathSync.native(git(realpathSync.native(repo), ['rev-parse', '--show-toplevel']).toString('utf8').replace(/\n$/, ''));

// ---- marker counting (R-3) ----
const MARKER = /\[(kind|plan):([A-Za-z0-9][A-Za-z0-9_-]{0,63})\]/g;
/** Occurrences of every `[kind:x]` / `[plan:x]` marker (latin1 view: markers are ASCII, line endings do not matter). */
function countMarkers(text, out = new Map()) {
  for (const m of text.matchAll(MARKER)) out.set(`${m[1]}:${m[2]}`, (out.get(`${m[1]}:${m[2]}`) ?? 0) + 1);
  return out;
}
const bufMarkers = (buf) => countMarkers(buf.toString('latin1'));
const sumInto = (total, m) => { for (const [k, n] of m) total.set(k, (total.get(k) ?? 0) + n); return total; };

// ---- the evidence identity (design rev 5 section 1a): the candidate-id encoding over P, from the worktree ----
/** `e1:` + sha256 over base_sha and every changed path (byte order): path, kind, mode, length, bytes. Never throws. */
export function evidenceIdentity({ repo, baseSha, exclusions = [] } = {}) {
  try { const c = candidate(repo, baseSha, exclusions); return { ok: true, evidence_id: c.evidence_id, paths: c.paths }; } catch (e) { return { ok: false, code: codeOf(e, 'evidence_unavailable') }; }
}
/** A directory in P is a submodule only when it is the top of its own clean work tree; a dirty one is refused (I4). */
function submoduleHead(abs) {
  let top;
  try { top = realpathSync.native(git(abs, ['rev-parse', '--show-toplevel']).toString('utf8').replace(/\n$/, '')); } catch { return refuse('evidence_unavailable'); }
  if (top !== realpathSync.native(abs)) return null; // a plain directory (its files are paths of P themselves)
  let status;
  try { status = git(abs, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']); } catch { return refuse('evidence_unavailable'); }
  if (status.length) refuse('evidence_unavailable'); // a dirty submodule cannot be identified by its HEAD
  try { return Buffer.from(git(abs, ['rev-parse', '--verify', 'HEAD^{commit}']).toString('utf8').trim()); } catch { return refuse('evidence_unavailable'); }
}
/**
 * The candidate: identity, P (`paths`, after exclusions), every changed path before ANY exclusion (`all`, for config_paths),
 * and the candidate marker counts of every regular file in P (`cand`). Throws a Refusal.
 */
export function candidate(repo, baseSha, exclusions) {
  if (typeof baseSha !== 'string' || !SHA.test(baseSha)) refuse('test_kinds_error');
  const ex = arr(exclusions, LIMITS.maxList, safeRel, { work: 0, max: 1e6 });
  const top = topOf(repo);
  let all;
  try { all = changedPaths(top, baseSha, 'WORKTREE'); } catch { refuse('evidence_unavailable'); }
  if (all.length > LIMITS.maxPaths) refuse('evidence_budget_exceeded');
  const excluded = (p) => p.startsWith('.ship-ticket/') || ex.some((e) => p === e || p.startsWith(`${e.replace(/\/$/, '')}/`));
  const paths = all.filter((p) => !excluded(p));
  const h = createHash('sha256'), abs = (p) => join(top, p), cand = new Map();
  h.update(`ship-ticket-tk-evidence-v1\0${baseSha}\0`);
  let bytes = 0;
  for (const p of paths) {
    let kind = 'deleted', mode = '0', content = Buffer.from('tombstone');
    let st = null;
    try { st = lstatSync(abs(p)); } catch (e) { if (e?.code !== 'ENOENT') refuse('evidence_unavailable'); }
    if (st) {
      if (st.isSymbolicLink()) { kind = 'symlink'; mode = '120000'; content = readlinkSync(abs(p), { encoding: 'buffer' }); }
      else if (st.isFile()) {
        bytes += st.size; if (bytes > LIMITS.maxIdentityBytes) refuse('evidence_budget_exceeded');
        kind = 'file'; mode = (st.mode & 0o111) === 0 ? '100644' : '100755'; content = readFileSync(abs(p));
        cand.set(p, bufMarkers(content));
      } else if (st.isDirectory()) {
        const head = submoduleHead(abs(p));
        if (head) { kind = 'submodule'; mode = '160000'; content = head; } else { kind = 'directory'; mode = '40000'; content = Buffer.alloc(0); }
      } else refuse('evidence_unavailable'); // a fifo or device is never read (it could block)
    }
    h.update(Buffer.from(p, 'utf8')); h.update(`\0${kind}\0${mode}\0${content.length}\0`); h.update(content); h.update('\0');
  }
  return { evidence_id: `e1:${h.digest('hex')}`, paths, all, top, cand, base_sha: baseSha, census: null };
}
/**
 * The R-3 census over P: candidate and base marker counts per path and summed over P. Base blobs come from ONE `ls-tree` and
 * ONE `cat-file --batch`; an unreadable or oversized base refuses (never skipped). Memoised on the candidate. Throws a Refusal.
 */
export function census(c) {
  if (c.census) return c.census;
  const want = new Set(c.paths), base = new Map(), oids = [];
  let ls;
  try { ls = git(c.top, ['ls-tree', '-r', '-z', '--full-tree', c.base_sha], 64 << 20).toString('utf8'); } catch (e) { refuse(e?.code === 'ENOBUFS' ? 'evidence_budget_exceeded' : 'evidence_unavailable'); }
  for (const line of ls.split('\0')) {
    const m = /^(100644|100755) blob ([0-9a-f]{40,64})\t(.*)$/s.exec(line);
    if (m && want.has(m[3])) oids.push([m[3], m[2]]);
  }
  if (oids.length) {
    let out;
    try { out = git(c.top, ['cat-file', '--batch'], LIMITS.maxIdentityBytes + oids.length * 128, oids.map((o) => o[1]).join('\n') + '\n'); } catch (e) { refuse(e?.code === 'ENOBUFS' ? 'evidence_budget_exceeded' : 'evidence_unavailable'); }
    let at = 0;
    for (const [p, oid] of oids) {
      const nl = out.indexOf(10, at), head = /^([0-9a-f]+) blob (\d+)$/.exec(out.subarray(at, nl).toString('latin1'));
      if (nl < 0 || !head || head[1] !== oid) refuse('evidence_unavailable');
      const size = Number(head[2]);
      base.set(p, bufMarkers(out.subarray(nl + 1, nl + 1 + size)));
      at = nl + 1 + size + 1;
    }
  }
  const total = { cand: new Map(), base: new Map() };
  for (const m of c.cand.values()) sumInto(total.cand, m);
  for (const m of base.values()) sumInto(total.base, m);
  c.census = { cand: c.cand, base, total };
  return c.census;
}
/** R-3 (header): may id `m` be credited from `rel`, given the non-passed carriers per file (`skipped`: path -> Map)? */
export function r3(cs, rel, m, skipped) {
  const n = (map, k) => map?.get(k) ?? 0;
  let skipTotal = 0;
  for (const s of skipped.values()) skipTotal += n(s, m);
  return n(cs.cand.get(rel), m) - n(cs.base.get(rel), m) - n(skipped.get(rel), m) > 0 && n(cs.total.cand, m) - n(cs.total.base, m) - skipTotal > 0;
}

// ---- the declared entry (config.testCommands.<name>) and the exact-argv rule (OD-2, I2) ----
const hasFiles = (args) => args.length === RUNNER.args.length + 1;
/** Validate an entry against the allowlisted grammar. Returns a plain copy. THROWS a Refusal (`runner_unsupported` for any other runner). */
export function readEntry(entry) {
  const ctx = { work: 0, max: 1e6 };
  const name = own(entry, 'name'), format = own(entry, 'format'), cmd = own(entry, 'cmd');
  if (typeof name !== 'string' || !ENTRY_NAME.test(name) || !isStr(512)(cmd)) refuse('test_kinds_error');
  if (format !== RUNNER.format || cmd !== RUNNER.cmd) refuse('runner_unsupported');
  const args = arr(own(entry, 'args'), 256, isStr(1024), ctx);
  if (!RUNNER.args.every((a, i) => args[i] === a) || !(args.length === RUNNER.args.length || (hasFiles(args) && args[RUNNER.args.length] === RUNNER.files))) refuse('runner_unsupported');
  const covers = globList(own(entry, 'covers'), ctx), configPaths = arr(own(entry, 'config_paths'), LIMITS.maxList, safeRel, ctx);
  if (!covers.length) refuse('test_kinds_error');
  return { name, format, cmd, args, covers, config_paths: configPaths };
}
/** The command that RAN for a validated entry: `{report}` and `{files}` substituted, nothing else. Returns `{cmd, args}`. THROWS a Refusal. */
export function commandFor(entry, cmd, args) {
  if (cmd !== entry.cmd) refuse('runner_unsupported');
  const list = arr(args, RUNNER.args.length + LIMITS.maxMarkerFiles, isStr(LIMITS.maxPathChars + 32), { work: 0, max: 1e6 });
  const fixed = RUNNER.args.map((a) => a.replace('{report}', RUNNER.report));
  if (!fixed.every((a, i) => list[i] === a)) refuse('runner_unsupported');
  const files = list.slice(fixed.length);
  if (hasFiles(entry.args) ? !files.length : files.length) refuse('runner_unsupported');
  if (!files.every((f) => safeRel(f) && !f.startsWith('-'))) refuse('runner_unsupported'); // a name that parses as a flag is a flag
  return { cmd, args: list };
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
  } catch (e) { return { ok: false, code: codeOf(e, 'evidence_unavailable') }; }
}

// ---- the report: a strict JSON shape scan (duplicate keys, depth, work), then the whole-run pre-pass ----
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
const STATUSES = new Set(['passed', 'failed', 'skipped', 'pending', 'todo', 'disabled']); // vitest's StatusMap image plus jest's `disabled`
const field = (o, k) => (Object.hasOwn(o, k) ? o[k] : undefined);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** The whole-run checks (I8), on the parsed document, BEFORE the parser materialises any result. Throws a Refusal. */
function preflight(doc, ctx) {
  const unavailable = () => refuse('evidence_unavailable'), failed = () => refuse('evidence_run_failed');
  if (!isObj(doc)) unavailable();
  const success = field(doc, 'success'), suites = field(doc, 'testResults');
  for (const k of ['numFailedTestSuites', 'numFailedTests']) { const v = field(doc, k); if (!Number.isSafeInteger(v) || v < 0) unavailable(); if (v > 0) failed(); }
  if (typeof success !== 'boolean') unavailable();
  if (!success) failed();
  if (!Array.isArray(suites)) unavailable();
  let results = 0;
  for (const s of suites) {
    charge(ctx);
    if (!isObj(s) || typeof field(s, 'name') !== 'string' || !Array.isArray(field(s, 'assertionResults'))) unavailable();
    if (field(s, 'status') === 'failed') failed();
    if (field(s, 'status') !== 'passed') unavailable();
    const cases = field(s, 'assertionResults');
    results += cases.length;
    if (results > LIMITS.maxResults) refuse('evidence_budget_exceeded');
    for (const c of cases) {
      charge(ctx);
      if (!isObj(c) || !STATUSES.has(field(c, 'status')) || typeof field(c, 'title') !== 'string') unavailable();
      if (field(c, 'status') === 'failed') failed();
    }
  }
}

// ---- file classification ----
/** A report file name to a POSIX repo-relative path, or null when it escapes `root` (`P` is the platform path module: win32 in tests). */
export function toRepoRel(root, file, P = { relative, isAbsolute, sep }) {
  if (typeof file !== 'string' || !P.isAbsolute(file)) return null;
  const rel = P.relative(root, file);
  if (rel === '' || rel === '..' || rel.startsWith(`..${P.sep}`) || P.isAbsolute(rel)) return null;
  return rel.split(P.sep).join('/');
}
/** The native realpath of `file`; for a missing file, the realpath of its nearest existing ancestor plus the missing tail (I7). */
function realOrAncestor(file, ctx) {
  try { return realpathSync.native(file); } catch (e) { if (e?.code !== 'ENOENT' && e?.code !== 'ENOTDIR') return null; }
  const tail = [];
  for (let at = file; ; at = dirname(at)) {
    charge(ctx);
    if (dirname(at) === at || tail.length > 256) return null;
    tail.unshift(basename(at));
    try { return join(realpathSync.native(dirname(at)), ...tail); } catch (e) { if (e?.code !== 'ENOENT' && e?.code !== 'ENOTDIR') return null; }
  }
}
/** Applicability of a repo-relative file to an entry (section 4 rule 3 after the repo/P steps): a FILE void code, or null. */
export function applicable(top, rel, testGlobs, covers, ctx) {
  let st;
  try { st = lstatSync(join(top, rel)); } catch { return 'not_regular'; }
  if (!st.isFile()) return 'not_regular';
  try { if (realpathSync.native(join(top, rel)) !== join(top, rel)) return 'not_regular'; } catch { return 'not_regular'; } // no symlinked directory on the way
  if (!matches(testGlobs, rel, ctx)) return 'not_test_file';
  if (!matches(covers, rel, ctx)) return 'runner_uncovered';
  if (st.size > LIMITS.maxFileBytes) return 'file_too_large';
  return null;
}
/** One report file name: `{ outcome, rel }` (rel null when outside the repo). */
function classify(c, inP, file, testGlobs, covers, ctx) {
  if (!isAbsolute(file)) return { outcome: 'result_outside_repo', rel: null }; // a relative name would resolve against the cwd, never the repo
  const real = realOrAncestor(file, ctx), rel = real === null ? null : toRepoRel(c.top, real);
  if (rel === null) return { outcome: 'result_outside_repo', rel: null };
  if (!inP.has(rel)) return { outcome: 'not_in_P', rel };
  return { outcome: applicable(c.top, rel, testGlobs, covers, ctx) ?? 'counted', rel };
}

// ---- building a record from a provided report (section 1 output; sections 3-4 counting) ----
/**
 * buildRecord({ repo, baseSha, entry, commandArgs, tests:{globs}, dagDigest, exclusions?, report:{text, ...provenance} })
 *   -> { ok:true, record, voids } | { ok:false, code }
 * `commandArgs` are the args that RAN (`commandFor`); `report` is `{ text, runner_id, runner_version, attempt_id, exit_code,
 * report_sha256, report_eof, sealed, quiesced, binding_verified, evidence_id_before }`. Never throws.
 */
export function buildRecord(input) {
  try { return { ok: true, ...build(input) }; } catch (e) { return { ok: false, code: codeOf(e, 'test_kinds_error') }; }
}
function build(input) {
  const ctx = { work: 0, max: 5_000_000, glob: { steps: 0 } };
  const entry = readEntry(own(input, 'entry')), command = commandFor(entry, entry.cmd, own(input, 'commandArgs'));
  const repo = own(input, 'repo'), baseSha = own(input, 'baseSha'), dagDigest = own(input, 'dagDigest');
  const R = own(input, 'report'), text = own(R, 'text');
  const globs = globList(own(own(input, 'tests'), 'globs'), ctx);
  const prov = {};
  for (const k of ['runner_id', 'runner_version', 'attempt_id', 'report_sha256', 'evidence_id_before', 'report_eof', 'sealed', 'quiesced', 'binding_verified', 'exit_code']) prov[k] = own(R, k);
  if (typeof text !== 'string' || !isStr(80)(prov.attempt_id) || !prov.attempt_id || !isStr(64)(prov.runner_version) || typeof dagDigest !== 'string' || !HEX64.test(dagDigest) || typeof prov.evidence_id_before !== 'string') refuse('test_kinds_error');
  if (prov.runner_id !== RUNNER.id) refuse('runner_unsupported');
  if (text.length > LIMITS.maxReportBytes) refuse('evidence_budget_exceeded'); // cheap first: a UTF-16 unit is at least one byte
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > LIMITS.maxReportBytes) refuse('evidence_budget_exceeded');
  const c = candidate(repo, baseSha, ownOr(input, 'exclusions', []));
  const all = new Set(c.all), inP = new Set(c.paths);
  if (entry.config_paths.some((p) => all.has(p))) refuse('runner_config_changed'); // before ANY exclusion (I6)
  const digest = sha256(text);
  if (prov.sealed !== true || prov.binding_verified !== true || typeof prov.report_sha256 !== 'string' || prov.report_sha256 !== digest) refuse('runner_output_tampered');
  if (prov.report_eof !== true) refuse('runner_survivor');
  if (prov.quiesced !== true) refuse('quiescence_unknown');
  if (prov.exit_code !== 0) refuse('evidence_run_failed'); // non-zero, a timeout (null) or anything else: a RED run is never evidence
  if (prov.evidence_id_before !== c.evidence_id) refuse('candidate_moved');
  scanJson(text);
  preflight(JSON.parse(text), ctx);
  const parsed = parseRunnerOutput(entry.format, text);
  if (!parsed.supported) refuse('evidence_unavailable');
  const results = parsed.results;
  if (results.length > LIMITS.maxResults) refuse('evidence_budget_exceeded');

  // per file: the creditable ids of PASSED results, unknown markers, and the non-passed carriers (R-3 subtracts them)
  const byFile = new Map();
  let passed = 0;
  for (const r of results) {
    charge(ctx);
    if (r.status === 'pass') passed++;
    if (typeof r.title !== 'string' || r.title.length > LIMITS.maxTitleChars || typeof r.file !== 'string') continue;
    const m = markers([r.title]);
    if (!m.kinds.length && !m.items.length && !m.unknown.length) continue;
    if (!byFile.has(r.file) && byFile.size >= LIMITS.maxMarkerFiles) refuse('evidence_budget_exceeded');
    const slot = byFile.get(r.file) ?? { ids: new Set(), unknown: new Set(), skipped: new Map() };
    byFile.set(r.file, slot);
    if (r.status !== 'pass') { countMarkers(r.title, slot.skipped); if (slot.skipped.size > LIMITS.maxIds) refuse('evidence_budget_exceeded'); continue; }
    for (const k of m.kinds) slot.ids.add(`kind:${k}`);
    for (const i of m.items) (ITEM_ID.test(i) ? slot.ids : slot.unknown).add(`plan:${i}`);
    for (const u of m.unknown) slot.unknown.add(u);
    if (slot.ids.size > LIMITS.maxIds || slot.unknown.size > LIMITS.maxIds) refuse('evidence_budget_exceeded');
  }
  const testGlobs = matcher([...BUILTIN_TEST_GLOBS, ...globs]), covers = matcher(entry.covers);
  // classify each report name; names resolving to the same repo file (a symlink and its target) merge into ONE row
  const rows = [], byRel = new Map(), skipped = new Map(), voids = {};
  for (const [file, slot] of [...byFile].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const v = classify(c, inP, file, testGlobs, covers, ctx), prev = v.rel === null ? null : byRel.get(v.rel);
    if (prev) { for (const k of slot.ids) prev.slot.ids.add(k); for (const k of slot.unknown) prev.slot.unknown.add(k); sumInto(prev.slot.skipped, slot.skipped); continue; }
    const row = { v, slot };
    rows.push(row);
    if (v.rel !== null) byRel.set(v.rel, row);
  }
  for (const { v, slot } of rows) if (v.rel !== null && inP.has(v.rel)) skipped.set(v.rel, slot.skipped);
  const cs = rows.some((x) => x.v.outcome === 'counted') ? census(c) : null;
  const files = [];
  let unknownMarkers = 0, credited = 0;
  for (const { v, slot } of rows) {
    const skip = skipped.has(v.rel) ? Object.fromEntries([...slot.skipped].sort((a, b) => (a[0] < b[0] ? -1 : 1))) : {};
    if (v.outcome !== 'counted') { voids[v.outcome] = (voids[v.outcome] ?? 0) + 1; files.push({ file: v.rel, outcome: v.outcome, credited: [], skipped: skip }); continue; }
    const ids = [...slot.ids].filter((m) => r3(cs, v.rel, m, skipped)).sort();
    unknownMarkers += slot.unknown.size; credited += ids.length;
    files.push({ file: v.rel, outcome: 'counted', credited: ids, skipped: skip });
  }
  files.sort((a, b) => ((a.file ?? '') < (b.file ?? '') ? -1 : (a.file ?? '') > (b.file ?? '') ? 1 : 0));
  const cfg = configDigest(repo, entry.config_paths);
  if (!cfg.ok) refuse(cfg.code);
  const record = { evidence_id: c.evidence_id, base_sha: baseSha, entry: entry.name, dag_digest: dagDigest, command_digest: commandDigest(command.cmd, command.args),
    config_digest: cfg.digest, attempt_id: prov.attempt_id, exit_code: 0, report_sha256: digest, report_len: bytes,
    runner: { id: prov.runner_id, version: prov.runner_version, format: entry.format }, claim: CLAIM,
    integrity: Object.fromEntries(INTEGRITY.map((k) => [k, true])), files,
    counts: { results: results.length, passed, marker_files: files.length, credited, unknown_markers: unknownMarkers } };
  return { record, voids };
}
