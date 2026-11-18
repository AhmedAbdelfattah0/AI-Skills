/**
 * S-01b2 P4r: runner evidence I/O (design rev 6, sections 1, 3, 4, 5.2 row P4r; owner decision OD-2). This module holds the
 * SHARED RULES and builds records; `engine-test-kinds-reuse.mjs` reuses records and gives the verdict; the bottom layer
 * (limits, readers, the report scan) is `engine-test-kinds-base.mjs`.
 *
 * ONE RULE, ONE PLACE (I-A). Every rule a record depends on is implemented ONCE, here, and buildRecord, recordUsable and
 * tkVerdict all call the same function: the current context (`currentContext`: entries, current commands, candidate,
 * runner_config_changed, config digests, test globs), the record schema with its provenance relations (`validRecord`) and R-3
 * (`r3Inputs` + `r3Rule`). buildRecord passes its own output through `validRecord` before returning it (I-B), so a record it
 * emits is a record reuse accepts, and a field reuse would reject is never emitted.
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
 *           other runner, format, flag, order or `--` terminator is `runner_unsupported` (OD-2; never bypassed). The entry is
 *           the FLAT form `{name, format, cmd, args, covers, config_paths}` (P5r maps the design's `evidence:{...}` onto it).
 *   command the args that RAN: the template with `{report}` -> `/dev/fd/3` and `{files}` -> 1..N repo-relative paths, none
 *           starting with `-`. The record's `command_digest` hashes exactly these args; the verdict hashes the same.
 *   report  at most 32 MiB of UTF-8 BYTES; ONE JSON document (no duplicate keys after escape decoding, depth <= 64);
 *           `success === true`, `numFailedTestSuites === 0`, `numFailedTests === 0`, every suite `status === 'passed'`
 *           (vitest 4 writes only `passed`/`failed`); at most 100000 results and every title at most 2048 characters, both
 *           checked on the parsed document BEFORE the runner parser builds its result list. Over a cap: REFUSED, never dropped.
 *   result  counts only when `status === 'passed'`; a `failed` result or suite, or `success:false`, makes the WHOLE record
 *           `evidence_run_failed` even with exit 0. Any status outside vitest's six is `evidence_unavailable`.
 *   marker  `[kind:<id>]` / `[plan:<id>]` read from the test's OWN (leaf) title only, through P3 `markers`.
 *   file    the report name, realpath-resolved (the nearest existing ancestor for a missing file), inside the repo, in P, an
 *           lstat-regular file (a symlink is resolved first, so the TARGET is what counts), matching the test globs and the
 *           entry's `covers`, at most 4 MiB. Otherwise a typed FILE void that never credits. Names resolving to one file merge
 *           into one row, and every per-row cap is re-checked after the merge (I-C).
 *
 * R-3, WHAT IS ENFORCED (section 4 rule 5, no base run; stricter than the design). With K the files that have a `counted` row
 * and d(f, m) = count_cand(f, m) - count_base(f, m) - skipped(f, m):
 *   (per file)  d(f, m) > 0, for f in K
 *   (over P)    sum over f in P of (f in K ? d(f, m) : min(d(f, m), 0)) > 0 (deleted and renamed-away paths included)
 * Each term is at most the round-1 term (d), so this is pointwise stricter than the rule it replaces.
 * `count` is the number of `[kind:x]`/`[plan:x]` occurrences in the bytes; `skipped(f, m)` the occurrences in NON-passed result
 * titles of f. A marker added OUTSIDE K (a README, a helper, an unrun or uncovered test) can only lower the total, so a pure
 * rename or move credits nothing even with a marker added elsewhere, nor does a skipped or todo test added beside an old passing
 * one (a skipped `.each` over-subtracts, failing closed).
 * NOT ENFORCED (the accepted L-ran limit, "gameable only by a visible added marker", design section 4): a marker added in a
 * comment or in dead code of a file IN K is indistinguishable from an added title and CAN credit a passing test that already
 * carried m, in that file or (for a moved test) anywhere in K. A skip that is never reported is the same case.
 *
 * PROVENANCE (supplied by the caller, section 1): `runner_id`, `runner_version`, `attempt_id`, `exit_code`, `report_sha256`
 * (checked against the text), `report_eof`, `sealed`, `quiesced`, `binding_verified` (all `true`), `evidence_id_before`.
 * Refusal order in buildRecord: the current context (entry, command, identity, `runner_config_changed`, config digest, globs),
 * then report text, runner, report size, tamper, survivor, quiescence, exit, `candidate_moved`, report content, and last the
 * record schema (`test_kinds_error`). Rev 6 section 1 orders the VERDICT codes; this is the build order.
 *
 * State and output carry ids, codes, counts and repo-relative file names only: NEVER a test title (AC6); a non-creditable
 * marker on a skipped title is not stored either. Hostile input (L3, L6): caller objects are read through own DATA descriptors
 * only (no getter or proxy trap runs); work is charged to per-call budgets and the named LIMITS. The exported entry points
 * return refusals instead of throwing, except `readEntry`/`commandFor`/`currentContext`, which THROW a `Refusal`.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep, basename } from 'node:path';
import { changedPaths, hiddenFlagged } from './risk-floor.mjs';
import { markers, ITEM_ID } from './test-kinds.mjs';
import { parseRunnerOutput } from './gate.mjs';
import { LIMITS, FILE_VOIDS, creditable, refuse, codeOf, charge, plain, own, ownOr, arr, exactKeys, isStr, safeRel, globList, matcher, matches, countMarkers, bufMarkers, parseScanned, preflight } from './engine-test-kinds-base.mjs';

export { LIMITS, REFUSALS, FILE_VOIDS, MARKER_ID, creditable, Refusal, refuse, codeOf, charge, plain, own, ownOr, arr, exactKeys, isStr, safeRel, globList, matcher, matches } from './engine-test-kinds-base.mjs';
export const CLAIM = 'L-ran';
export const BUILTIN_TEST_GLOBS = Object.freeze(['**/*.test.*', '**/*.spec.*']);
export const RUNNER = Object.freeze({ id: 'vitest', format: 'vitest-json', cmd: 'node_modules/.bin/vitest', args: Object.freeze(['run', '--pool=forks', '--reporter=json', '--outputFile={report}']), files: '{files}', report: '/dev/fd/3' });
export const INTEGRITY = Object.freeze(['sealed', 'report_eof', 'quiesced', 'binding_verified', 'identity_stable']);
export const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/, HEX64 = /^[0-9a-f]{64}$/, EVIDENCE_ID = /^e1:[0-9a-f]{64}$/, ENTRY_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
/** A runner version as a package manager spells it (`2.1.0`, `4.0.0-beta.3+sha`): never empty, never free text. */
export const RUNNER_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const sha256 = (...parts) => { const h = createHash('sha256'); for (const p of parts) h.update(p); return h.digest('hex'); };

// ---- git (TEMPORARY fourth copy of the hardened-git helper, as in test-kinds.mjs: TODO(S-02a0b) replace with lib/git-capability.mjs) ----
const gitEnv = () => { const e = { ...process.env }; for (const k of Object.keys(e)) if (k.toUpperCase().startsWith('GIT_')) delete e[k]; return { ...e, GIT_NO_REPLACE_OBJECTS: '1', GIT_LITERAL_PATHSPECS: '1', GIT_OPTIONAL_LOCKS: '0' }; };
const git = (cwd, args, max = 1 << 20, input = undefined) => execFileSync('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', ...args], { cwd, env: gitEnv(), maxBuffer: max, input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
const topOf = (repo) => realpathSync.native(git(realpathSync.native(repo), ['rev-parse', '--show-toplevel']).toString('utf8').replace(/\n$/, ''));
const gitRefusal = (e) => (e?.code === 'ENOBUFS' ? 'evidence_budget_exceeded' : 'evidence_unavailable');

// ---- the evidence identity (design rev 5 section 1a): the candidate-id encoding over P, from the worktree ----
/** `e1:` + sha256 over base_sha and every changed path (byte order): path, kind, mode, length, bytes. Never throws. */
export function evidenceIdentity(input) {
  try { const c = candidate(own(input, 'repo'), own(input, 'baseSha'), ownOr(input, 'exclusions', [])); return { ok: true, evidence_id: c.evidence_id, paths: c.paths }; } catch (e) { return { ok: false, code: codeOf(e, 'evidence_unavailable') }; }
}
/** An index entry that is a gitlink (`<tag> 160000 ...` in `ls-files -v -s -z` output). */
const hasGitlink = (buf) => buf.toString('latin1').split('\0').some((l) => /^\S 160000 /.test(l));
/**
 * Is `abs` a submodule checkout (the top of its own work tree)? When it is, nothing in it may differ from its HEAD unseen (I-E):
 * a tracked file with an assume-unchanged or skip-worktree bit (git status would not look at it), or a submodule of its own
 * (one level down the same flags would hide again), is refused. ONE check for a submodule in P and one outside it. Throws a Refusal.
 */
function submoduleCheckout(abs) {
  let top, index;
  try { top = realpathSync.native(git(abs, ['rev-parse', '--show-toplevel']).toString('utf8').replace(/\n$/, '')); } catch { return refuse('evidence_unavailable'); }
  if (top !== realpathSync.native(abs)) return false; // a plain directory, or a submodule that is not checked out
  try { index = git(abs, ['ls-files', '-v', '-s', '-z'], 64 << 20); } catch (e) { return refuse(gitRefusal(e)); }
  if (hiddenFlagged(index) || hasGitlink(index)) refuse('evidence_unavailable');
  return true;
}
/**
 * A directory in P is a submodule only when it is a checkout; its HEAD identifies it only when it is also clean (I4).
 * Returns the HEAD bytes, or null for a plain directory. Throws a Refusal.
 */
function submoduleHead(abs) {
  if (!submoduleCheckout(abs)) return null; // a plain directory (its files are paths of P themselves)
  let status;
  try { status = git(abs, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']); } catch (e) { return refuse(gitRefusal(e)); }
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
  // a submodule OUTSIDE P is outside P only because its status is clean: the same hidden-flag check, or its edits are unseen (C2 twin)
  const inPaths = new Set(paths);
  let index;
  try { index = git(top, ['ls-files', '-s', '-z'], 64 << 20).toString('utf8'); } catch (e) { refuse(gitRefusal(e)); }
  for (const l of index.split('\0')) {
    const m = /^160000 [0-9a-f]+ \d\t(.*)$/s.exec(l);
    if (!m || inPaths.has(m[1])) continue;
    let st = null;
    try { st = lstatSync(join(top, m[1])); } catch (e) { if (e?.code !== 'ENOENT') refuse('evidence_unavailable'); }
    if (st?.isDirectory()) submoduleCheckout(join(top, m[1]));
  }
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
 * The R-3 census over P: candidate and base marker counts per path. Base blobs come from ONE `ls-tree` and ONE `cat-file
 * --batch`; an unreadable or oversized base refuses (never skipped). Memoised on the candidate. Throws a Refusal.
 */
export function census(c) {
  if (c.census) return c.census;
  const want = new Set(c.paths), base = new Map(), oids = [];
  let ls;
  try { ls = git(c.top, ['ls-tree', '-r', '-z', '--full-tree', c.base_sha], 64 << 20).toString('utf8'); } catch (e) { refuse(gitRefusal(e)); }
  for (const line of ls.split('\0')) {
    const m = /^(100644|100755) blob ([0-9a-f]{40,64})\t(.*)$/s.exec(line);
    if (m && want.has(m[3])) oids.push([m[3], m[2]]);
  }
  if (oids.length) {
    let out;
    try { out = git(c.top, ['cat-file', '--batch'], LIMITS.maxIdentityBytes + oids.length * 128, oids.map((o) => o[1]).join('\n') + '\n'); } catch (e) { refuse(gitRefusal(e)); }
    let at = 0;
    for (const [p, oid] of oids) {
      const nl = out.indexOf(10, at), head = /^([0-9a-f]+) blob (\d+)$/.exec(out.subarray(at, nl).toString('latin1'));
      if (nl < 0 || !head || head[1] !== oid) refuse('evidence_unavailable');
      const size = Number(head[2]);
      base.set(p, bufMarkers(out.subarray(nl + 1, nl + 1 + size)));
      at = nl + 1 + size + 1;
    }
  }
  c.census = { cand: c.cand, base };
  return c.census;
}
/** The R-3 inputs from rows `{file, outcome, skipped: Map}` (a built row or a stored one, the SAME function): K and skipped-in-P. */
export function r3Inputs(rows, inP) {
  const counted = new Set(), skipped = new Map();
  for (const f of rows) {
    if (f.file === null || !inP.has(f.file)) continue;
    skipped.set(f.file, f.skipped);
    if (f.outcome === 'counted') counted.add(f.file);
  }
  return { counted, skipped };
}
/** R-3 (header): returns `(rel, m) => may m be credited from rel`. The totals over P are computed once, charged to `ctx`. */
export function r3Rule(cs, { counted, skipped }, ctx) {
  const n = (map, k) => map?.get(k) ?? 0, total = new Map();
  for (const p of new Set([...cs.cand.keys(), ...cs.base.keys(), ...skipped.keys()])) {
    const a = cs.cand.get(p), b = cs.base.get(p), s = skipped.get(p);
    for (const m of new Set([...(a?.keys() ?? []), ...(b?.keys() ?? []), ...(s?.keys() ?? [])])) {
      charge(ctx);
      const d = n(a, m) - n(b, m) - n(s, m);
      total.set(m, (total.get(m) ?? 0) + (counted.has(p) ? d : Math.min(d, 0))); // outside K a file can only subtract
    }
  }
  return (rel, m) => counted.has(rel) && n(cs.cand.get(rel), m) - n(cs.base.get(rel), m) - n(skipped.get(rel), m) > 0 && n(total, m) > 0;
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
/** The digest of the `config_paths` bytes (a missing file is `absent`; a symlink, non-regular or over-64-MiB file is refused). Never throws. */
export function configDigest(repo, paths) {
  try {
    const list = arr(paths, LIMITS.maxList, safeRel, { work: 0, max: 1e6 }), top = topOf(repo), h = createHash('sha256');
    for (const p of [...new Set(list)].sort()) {
      let st = null;
      try { st = lstatSync(join(top, p)); } catch (e) { if (e?.code !== 'ENOENT') refuse('evidence_unavailable'); }
      if (st && (!st.isFile() || st.size > LIMITS.maxConfigBytes)) refuse('evidence_unavailable');
      h.update(`${p}\0`); h.update(st ? readFileSync(join(top, p)) : 'absent'); h.update('\0');
    }
    return { ok: true, digest: h.digest('hex') };
  } catch (e) { return { ok: false, code: codeOf(e, 'evidence_unavailable') }; }
}

// ---- THE current context (I-A, I-F): one derivation, one refusal order, for buildRecord, recordUsable and tkVerdict ----
/**
 * currentContext({ repo, baseSha, exclusions, entries:[entry], commandOf(entry) -> {cmd,args}|undefined, needCommand(entry), globs }, ctx)
 *   -> { c, testGlobs, per: Map(name -> { entry, covers, command, command_digest, config_digest }) }. THROWS a Refusal, in this order:
 *   1. every entry through `readEntry` (names unique);
 *   2. EVERY entry's current command through `commandFor`, before any record is looked at (C6); `undefined` is allowed only
 *      when `needCommand(entry)` is false (the verdict: an entry with no record, whose `{files}` may have nothing to run);
 *   3. the candidate; 4. `runner_config_changed`: any entry's config_paths in `all`, BEFORE any exclusion (I6, C3);
 *   5. every entry's config digest; 6. the test globs.
 */
export function currentContext(input, ctx) {
  const entries = arr(own(input, 'entries'), LIMITS.maxList, plain, ctx).map(readEntry);
  if (new Set(entries.map((e) => e.name)).size !== entries.length) refuse('test_kinds_error');
  const commandOf = own(input, 'commandOf'), needCommand = own(input, 'needCommand');
  const decl = entries.map((entry) => {
    const raw = commandOf(entry);
    if (raw === undefined) { if (needCommand(entry) !== false) refuse('test_kinds_error'); return { entry, command: null }; }
    return { entry, command: commandFor(entry, own(raw, 'cmd'), own(raw, 'args')) };
  });
  const c = candidate(own(input, 'repo'), own(input, 'baseSha'), ownOr(input, 'exclusions', []));
  const all = new Set(c.all);
  if (entries.some((en) => en.config_paths.some((p) => all.has(p)))) refuse('runner_config_changed');
  const per = new Map();
  for (const { entry, command } of decl) {
    const cd = configDigest(c.top, entry.config_paths);
    if (!cd.ok) refuse(cd.code);
    per.set(entry.name, { entry, covers: matcher(entry.covers), command, command_digest: command && commandDigest(command.cmd, command.args), config_digest: cd.digest });
  }
  const testGlobs = matcher([...BUILTIN_TEST_GLOBS, ...globList(own(input, 'globs'), ctx)]);
  return { c, testGlobs, per };
}

// ---- THE record schema (I1, I-B, I-D): one validator, used by buildRecord on its own output and by reuse on a stored record ----
const TOP = ['evidence_id', 'base_sha', 'entry', 'dag_digest', 'command_digest', 'config_digest', 'attempt_id', 'exit_code', 'report_sha256', 'report_len', 'runner', 'claim', 'integrity', 'files', 'counts'];
const ROW = ['file', 'outcome', 'credited', 'skipped'], COUNTS = ['results', 'passed', 'marker_files', 'credited', 'unknown_markers'], RUNNER_KEYS = ['id', 'version', 'format'];
const OUTCOMES = ['counted', ...FILE_VOIDS];
const uint = (v, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= 0 && v <= max;
const str = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
const sortedUnique = (xs) => xs.every((x, i) => i === 0 || xs[i - 1] < x);
/**
 * validRecord(R, ctx) -> a fresh copy built from primitives (rows carry `skipped` as a Map), or null. Throws only a Refusal on a
 * hostile shape. Checks: exact key sets at every level; typed fields (`runner.version` a RUNNER_VERSION, `report_len` >= 1);
 * row outcomes in the allowlist; `credited` only on `counted` rows, creditable, sorted and unique; `skipped` keys creditable
 * with counts >= 1, only on rows inside P; and the RELATIONS a real report imposes on its counts (I-D): rows and credits
 * reconcile, passed <= results, every row came from a result, a credit or an unknown marker needs a passed result, a skipped
 * carrier needs a non-passed result, unknown markers fit the counted rows.
 */
export function validRecord(R, ctx) {
  if (!exactKeys(R, TOP)) return null;
  const g = (k) => own(R, k);
  const runner = g('runner'), integ = g('integrity'), counts = g('counts');
  if (!exactKeys(runner, RUNNER_KEYS) || !exactKeys(integ, INTEGRITY) || !exactKeys(counts, COUNTS)) return null;
  const copy = {
    evidence_id: g('evidence_id'), base_sha: g('base_sha'), entry: g('entry'), dag_digest: g('dag_digest'), command_digest: g('command_digest'), config_digest: g('config_digest'),
    attempt_id: g('attempt_id'), exit_code: g('exit_code'), report_sha256: g('report_sha256'), report_len: g('report_len'), claim: g('claim'),
    runner: Object.fromEntries(RUNNER_KEYS.map((k) => [k, own(runner, k)])), integrity: Object.fromEntries(INTEGRITY.map((k) => [k, own(integ, k)])),
    counts: Object.fromEntries(COUNTS.map((k) => [k, own(counts, k)])), files: [],
  };
  const typed = typeof copy.evidence_id === 'string' && EVIDENCE_ID.test(copy.evidence_id) && typeof copy.base_sha === 'string' && SHA.test(copy.base_sha)
    && typeof copy.entry === 'string' && ENTRY_NAME.test(copy.entry) && ['dag_digest', 'command_digest', 'config_digest', 'report_sha256'].every((k) => typeof copy[k] === 'string' && HEX64.test(copy[k]))
    && str(copy.attempt_id, 80) && Number.isSafeInteger(copy.exit_code) && uint(copy.report_len, LIMITS.maxReportBytes) && copy.report_len >= 1 && str(copy.claim, 16)
    && str(copy.runner.id, 64) && str(copy.runner.format, 64) && typeof copy.runner.version === 'string' && RUNNER_VERSION.test(copy.runner.version)
    && INTEGRITY.every((k) => typeof copy.integrity[k] === 'boolean') && COUNTS.every((k) => uint(copy.counts[k]));
  if (!typed) return null;
  const seen = new Set();
  let credited = 0;
  for (const f of arr(g('files'), LIMITS.maxMarkerFiles, plain, ctx)) {
    if (!exactKeys(f, ROW)) return null;
    const file = own(f, 'file'), outcome = own(f, 'outcome');
    if (typeof outcome !== 'string' || !OUTCOMES.includes(outcome)) return null;
    if (!(file === null ? outcome === 'result_outside_repo' : safeRel(file) && outcome !== 'result_outside_repo')) return null;
    if (file !== null && seen.has(file)) return null;
    seen.add(file);
    const ids = arr(own(f, 'credited'), LIMITS.maxIds, creditable, ctx);
    if ((outcome !== 'counted' && ids.length) || !sortedUnique(ids)) return null; // a VOID row never credits (I1)
    const sk = own(f, 'skipped');
    if (!plain(sk)) return null;
    const keys = Reflect.ownKeys(sk);
    if (keys.length > LIMITS.maxIds || (keys.length && ['not_in_P', 'result_outside_repo'].includes(outcome))) return null;
    const skipped = new Map();
    for (const k of keys) { if (!creditable(k)) return null; const n = own(sk, k); if (!uint(n) || n === 0) return null; skipped.set(k, n); }
    credited += ids.length;
    copy.files.push({ file, outcome, credited: [...ids], skipped });
  }
  const n = copy.counts, countedRows = copy.files.filter((f) => f.outcome === 'counted').length;
  const related = n.marker_files === copy.files.length && n.credited === credited && n.passed <= n.results && n.results <= LIMITS.maxResults
    && n.marker_files <= n.results && (n.passed >= 1 || (n.credited === 0 && n.unknown_markers === 0))
    && (n.results > n.passed || copy.files.every((f) => f.skipped.size === 0)) && n.unknown_markers <= countedRows * LIMITS.maxIds;
  return related ? copy : null;
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
/** I-C: every per-row collection is re-checked after EVERY change to it, a merge of two report names included (C4). */
function capSlot(s) {
  if (s.ids.size > LIMITS.maxIds || s.unknown.size > LIMITS.maxIds || s.skipped.size > LIMITS.maxIds) refuse('evidence_budget_exceeded');
  return s;
}
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
  const { c, testGlobs, per } = currentContext({ repo: own(input, 'repo'), baseSha: own(input, 'baseSha'), exclusions: ownOr(input, 'exclusions', []), entries: [own(input, 'entry')],
    commandOf: (en) => ({ cmd: en.cmd, args: own(input, 'commandArgs') }), needCommand: () => true, globs: own(own(input, 'tests'), 'globs') }, ctx);
  const [{ entry, covers, command_digest, config_digest }] = per.values();
  const R = own(input, 'report'), text = own(R, 'text');
  const prov = {};
  for (const k of ['runner_id', 'runner_version', 'attempt_id', 'report_sha256', 'evidence_id_before', 'report_eof', 'sealed', 'quiesced', 'binding_verified', 'exit_code']) prov[k] = own(R, k);
  if (typeof text !== 'string') refuse('test_kinds_error');
  if (prov.runner_id !== RUNNER.id) refuse('runner_unsupported');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > LIMITS.maxReportBytes) refuse('evidence_budget_exceeded');
  const digest = sha256(text);
  if (prov.sealed !== true || prov.binding_verified !== true || prov.report_sha256 !== digest) refuse('runner_output_tampered');
  if (prov.report_eof !== true) refuse('runner_survivor');
  if (prov.quiesced !== true) refuse('quiescence_unknown');
  if (prov.exit_code !== 0) refuse('evidence_run_failed'); // non-zero, a timeout (null) or anything else: a RED run is never evidence
  if (prov.evidence_id_before !== c.evidence_id) refuse('candidate_moved');
  preflight(parseScanned(text), ctx);
  const parsed = parseRunnerOutput(entry.format, text);
  if (!parsed.supported) refuse('evidence_unavailable'); // unreachable after preflight (documented equivalent mutant)
  const results = parsed.results; // at most LIMITS.maxResults: preflight counted them

  // per report name: the creditable ids of PASSED results, unknown markers, and the creditable non-passed carriers (R-3 subtracts them)
  const byFile = new Map();
  let passed = 0;
  for (const r of results) {
    charge(ctx);
    if (typeof r.title !== 'string' || typeof r.file !== 'string') refuse('evidence_unavailable'); // unreachable after preflight
    if (r.status === 'pass') passed++;
    const m = markers([r.title]);
    if (!m.kinds.length && !m.items.length && !m.unknown.length) continue;
    if (!byFile.has(r.file) && byFile.size >= LIMITS.maxMarkerFiles) refuse('evidence_budget_exceeded');
    const slot = byFile.get(r.file) ?? { ids: new Set(), unknown: new Set(), skipped: new Map() };
    byFile.set(r.file, slot);
    if (r.status !== 'pass') { for (const [k, n] of countMarkers(r.title)) if (creditable(k)) slot.skipped.set(k, (slot.skipped.get(k) ?? 0) + n); }
    else {
      for (const k of m.kinds) slot.ids.add(`kind:${k}`);
      for (const i of m.items) (ITEM_ID.test(i) ? slot.ids : slot.unknown).add(`plan:${i}`);
      for (const u of m.unknown) slot.unknown.add(u);
    }
    capSlot(slot);
  }
  // classify each report name; names resolving to the same repo file (a symlink and its target) merge into ONE row, re-capped
  const rows = [], byRel = new Map(), voids = {}, inP = new Set(c.paths);
  for (const [file, slot] of [...byFile].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const v = classify(c, inP, file, testGlobs, covers, ctx), prev = v.rel === null ? null : byRel.get(v.rel);
    if (prev) {
      for (const k of slot.ids) prev.ids.add(k);
      for (const k of slot.unknown) prev.unknown.add(k);
      for (const [k, n] of slot.skipped) prev.skipped.set(k, (prev.skipped.get(k) ?? 0) + n);
      capSlot(prev);
      continue;
    }
    const row = { file: v.rel, outcome: v.outcome, ...slot };
    rows.push(row);
    if (v.rel !== null) byRel.set(v.rel, row);
  }
  for (const row of rows) if (row.file === null || !inP.has(row.file)) row.skipped = new Map(); // a carrier outside P subtracts nothing
  const credit = rows.some((x) => x.outcome === 'counted') ? r3Rule(census(c), r3Inputs(rows, inP), ctx) : null;
  const files = [];
  let unknownMarkers = 0, credited = 0;
  for (const row of rows) {
    const skip = Object.fromEntries([...row.skipped].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
    if (row.outcome !== 'counted') { voids[row.outcome] = (voids[row.outcome] ?? 0) + 1; files.push({ file: row.file, outcome: row.outcome, credited: [], skipped: skip }); continue; }
    const ids = [...row.ids].filter((m) => credit(row.file, m)).sort();
    unknownMarkers += row.unknown.size; credited += ids.length;
    files.push({ file: row.file, outcome: 'counted', credited: ids, skipped: skip });
  }
  files.sort((a, b) => ((a.file ?? '') < (b.file ?? '') ? -1 : (a.file ?? '') > (b.file ?? '') ? 1 : 0));
  const record = { evidence_id: c.evidence_id, base_sha: c.base_sha, entry: entry.name, dag_digest: own(input, 'dagDigest'), command_digest,
    config_digest, attempt_id: prov.attempt_id, exit_code: 0, report_sha256: digest, report_len: bytes,
    runner: { id: prov.runner_id, version: prov.runner_version, format: entry.format }, claim: CLAIM,
    integrity: Object.fromEntries(INTEGRITY.map((k) => [k, true])), files,
    counts: { results: results.length, passed, marker_files: files.length, credited, unknown_markers: unknownMarkers } };
  if (!validRecord(record, ctx)) refuse('test_kinds_error'); // I-B: never emit a record reuse would reject (C7)
  return { record, voids };
}
