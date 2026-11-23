/**
 * S-01b2 P4r: runner evidence I/O (design rev 6, sections 1, 3, 4, 5.2 row P4r; owner decision OD-2). This module holds the
 * SHARED RULES and builds records; `engine-test-kinds-reuse.mjs` reuses records and gives the verdict; the bottom layer
 * (limits, readers, the report scan) is `engine-test-kinds-base.mjs`.
 *
 * ONE RULE, ONE PLACE (I-A). Every rule a record depends on is implemented ONCE, here, and buildRecord, recordUsable and
 * tkVerdict all call the same function: the current context (`currentContext`: entries, current commands, candidate,
 * runner_config_changed, config digests, test globs) and the record schema with its provenance relations (`validRecord`).
 * buildRecord passes its own output through `validRecord` before returning it (I-B), so a record it emits is a record reuse
 * accepts, and a field reuse would reject is never emitted.
 *
 * CLAIM (L-ran, and nothing stronger; L5/L12): a record built here says the runner EXECUTED a test whose own title carries a
 * marker and recorded it as passed. It does NOT say the test is meaningful (a vacuous or assertion-free test passes; review
 * against the acceptance criteria covers that), and it does not cover Angular/nx tests, `threads` pools or tampering with
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
 *   report  at most 32 MiB of UTF-8 BYTES; ONE JSON document (no duplicate keys after escape decoding, at most 65 nested levels);
 *           `success === true`, `numFailedTestSuites === 0`, `numFailedTests === 0`, every suite `status === 'passed'`
 *           (vitest 4 writes only `passed`/`failed`); at most 100000 results and every title at most 2048 characters, both
 *           checked on the parsed document BEFORE the runner parser builds its result list. Over a cap: REFUSED, never dropped.
 *   result  credits only when `status === 'passed'`; skipped, todo, pending and disabled results NEVER credit. A `failed` result
 *           or suite, or `success:false`, makes the WHOLE record `evidence_run_failed` even with exit 0. Any status outside
 *           vitest's six is `evidence_unavailable`.
 *   marker  `[kind:<id>]` / `[plan:<id>]` read from the test's OWN (leaf) title only, through P3 `markers`.
 *   file    the report name, realpath-resolved (the nearest existing ancestor for a missing file), inside the repo, in P, an
 *           lstat-regular file (a symlink is resolved first, so the TARGET is what counts), matching the test globs and the
 *           entry's `covers`, at most 4 MiB. Otherwise a typed FILE void that never credits. Names resolving to one file merge
 *           into one row, and every per-row cap is re-checked after the merge (I-C). Every report name that carries a marker,
 *           passed or not, is classified, so an unclassifiable name refuses the record instead of being guessed.
 *
 * CREDIT RULE (owner decision 2026-11-19, SIMP design: the "test is NEW" rule R-3 and every historical Git comparison are
 * REMOVED). A kind or item is credited from a PASSED result whose leaf title carries a valid marker, in a counted file (above),
 * in a report bound to the exact candidate, runner and config. The age of the test is NOT checked: an old test that already
 * carried its marker, in a file of P, credits when it passes. Whether a credited test is RELEVANT and ADEQUATE to the ticket's
 * acceptance criteria is the reviewers' to judge (ship-ticket review), never this module's.
 * WHY "in P" STAYS (exact-candidate binding, not novelty): the identity hashes the bytes of exactly the paths of P, so a credited
 * file is always one whose bytes the identity holds. A file outside P is bound only through `base_sha` and git's view of it, which
 * a local clean filter can make differ from the bytes the runner read: such a file is `not_in_P` and never credits.
 * ACCEPTED (owner, SIMP section 6): a marker added to an unrelated test credits when that test passes; the diff review sees it.
 * THE IDENTITY IS THE WORKTREE, BY DESIGN (rev 5 section 1a): P is git's list of changed paths, and their WORKTREE bytes are hashed.
 * That what is committed equals the evidenced worktree candidate is the ship step's and P5r's to enforce, not this module's.
 * WHAT STILL HOLDS AGAINST A LOCAL GIT SETTING (`.git/config`, `.git/info/attributes`, `.git/info/exclude`, all untracked):
 *   - CLOSED: a declared `config_paths` file must equal base AS BYTES (CRLF -> LF only), so an edit a clean filter hides from git's
 *     diff is `runner_config_changed` (review of 40486a5, B1); hidden index flags are refused by `changedPaths`.
 *   - RESIDUAL, owner-accepted class (same uid, `.git` write; R-TC, like editing `node_modules`): an edit a clean filter hides in
 *     IMPORTED SOURCE is outside the identity and can make a credited test pass against bytes that would not be committed; and a
 *     test `git rm --cached` + `info/exclude` keeps in the worktree is in P (deleted) and is credited while the commit deletes it.
 *     The conversion refusals of rounds 4-9 closed the first; rounds 1-3 behaved as now.
 * EMPTY CONFIG BINDING (documented, not refused): `config_paths: []` (which P5r INIT accepts) binds no config file; a changed config
 * file is still a path of P, in the identity and in the reviewed diff, but `runner_config_changed` cannot fire for it.
 *
 * PATH IDENTITY (S2): every comparison of a declared, stored or report-derived path with a git path goes through ONE rule
 * (`pathIndex`/`under` in the base module): a spelling that shares a key (NFC, lower case) with a git path without being it is
 * refused (`path_alias`), on every platform. A config path must also be its own file: no symlinked directory on the way.
 * IDENTITY BRACKET (P5r/FX requirement, not decidable here): `evidence_id_before` is the identity before the run; a runner reading a
 * mutable checkout could modify a covered file and restore it before the identity is taken again. Binding what the runner reads to
 * the recorded identity (R-TC, the launch binding) is P5r's; P4r only checks the bracket it is given.
 * NOT IN P (accepted, design: ignored files are outside release scope): a NEW file that `.gitignore`, `.git/info/exclude` or a
 * global excludes file ignores never enters P, so it is outside the identity even if a test imports it. The same holds for a file inside
 * a `.git`-named directory within a tracked directory (`libs/money/.git/helper.mjs`; git never lists it) and, with `core.ignorecase=true`
 * on a case-sensitive filesystem, for an untracked `OLD.TEST.TS` beside a tracked `old.test.ts`. None of them can be committed.
 * TOCTOU (rests on P5r quiescence): files are read by path (lstat, then read) without `O_NOFOLLOW` or an fstat re-check; a writer
 * racing the identity is excluded by the caller's quiescence (`quiesced`), not here.
 * NOT A CHANGE (accepted; it cannot help a test pass): a `chmod +x` with `core.fileMode=false` on an otherwise unchanged file is
 * not listed by git, so it is not in P (for a path of P the identity hashes the executable bit; Vitest ignores it).
 * SUBMODULES (S3, kept for the BINDING): the identity hashes a nested repository as an empty directory, so its contents would be
 * outside `evidence_id`. V0 evidence is backend/library vitest (OD-2) and the reference repository has none, so ANY gitlink at
 * base or in the index (a name listing, no blob is read), and any changed path that is a directory holding a `.git`, is refused
 * with `evidence_unavailable` / detail `submodule_unsupported_v0`.
 * CONFIG AT BASE (D4 and B1, the config binding): a declared config path must equal base. The same base listing says whether it
 * existed at base; if it did, its RAW base blob (`cat-file blob`, the one historical read left, for config files only) is compared
 * with its working-tree bytes after CRLF -> LF on both sides, so a Windows autocrlf checkout is not refused. Absent at base and present
 * now, or different bytes, is `runner_config_changed`, even when an ignore rule or clean filter keeps the change out of git's diff.
 *
 * PROVENANCE (supplied by the caller, section 1): `runner_id`, `runner_version`, `attempt_id`, `exit_code`, `report_sha256`
 * (checked against the text), `report_eof`, `sealed`, `quiesced`, `binding_verified` (all `true`), `evidence_id_before`.
 * Refusal order in buildRecord: the current context (entry, command, identity, `runner_config_changed`, config digest, globs),
 * then report text, runner, report size, tamper, survivor, quiescence, exit, `candidate_moved`, report content, and last the
 * record schema (`test_kinds_error`). Rev 6 section 1 orders the VERDICT codes; this is the build order.
 *
 * State and output carry ids, codes, counts and repo-relative file names only: NEVER a test title (AC6); a non-creditable
 * marker, or any marker of a non-passed title, is not stored either. Hostile input (L3, L6): caller objects are read through own DATA descriptors
 * only (no getter or proxy trap runs); work is charged to per-call budgets and the named LIMITS. The exported entry points
 * return refusals (`{ code, detail? }`) instead of throwing, except `readEntry`, `commandFor`, `currentContext`, `candidate`,
 * `applicable` and `validRecord`, which THROW a `Refusal` for every input they refuse (a git or filesystem fault, or a
 * caller callback of `currentContext`, may surface as another error; each entry point maps any error to a refusal).
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { devNull } from 'node:os';
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep, basename } from 'node:path';
import { changedPaths } from './risk-floor.mjs';
import { markers, ITEM_ID } from './test-kinds.mjs';
import { parseRunnerOutput } from './gate.mjs';
import { LIMITS as P2_LIMITS } from './engine-test-kinds.mjs';
import { LIMITS, FILE_VOIDS, creditable, refuse, refusalOf, charge, plain, own, ownOr, arr, exactKeys, isStr, safeRel, pathIndex, under, globList, matcher, matches, parseScanned, preflight } from './engine-test-kinds-base.mjs';

export { LIMITS, REFUSALS, FILE_VOIDS, MARKER_ID, creditable, Refusal, refuse, codeOf, refusalOf, pathKey, pathIndex, under, charge, plain, own, ownOr, arr, exactKeys, isStr, safeRel, globList, matcher, matches } from './engine-test-kinds-base.mjs';
export const CLAIM = 'L-ran';
export const BUILTIN_TEST_GLOBS = Object.freeze(['**/*.test.*', '**/*.spec.*']);
export const RUNNER = Object.freeze({ id: 'vitest', format: 'vitest-json', cmd: 'node_modules/.bin/vitest', args: Object.freeze(['run', '--pool=forks', '--reporter=json', '--outputFile={report}']), files: '{files}', report: '/dev/fd/3' });
export const INTEGRITY = Object.freeze(['sealed', 'report_eof', 'quiesced', 'binding_verified', 'identity_stable']);
export const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/, HEX64 = /^[0-9a-f]{64}$/, EVIDENCE_ID = /^e1:[0-9a-f]{64}$/, ENTRY_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
/** A runner version as a package manager spells it (`2.1.0`, `4.0.0-beta.3+sha`): never empty, never free text. */
export const RUNNER_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const sha256 = (...parts) => { const h = createHash('sha256'); for (const p of parts) h.update(p); return h.digest('hex'); };

// ---- git (TEMPORARY fourth copy of the hardened-git helper, as in test-kinds.mjs: TODO(S-02a0b) replace with lib/git-capability.mjs) ----
const gitEnv = () => { const e = { ...process.env }; for (const k of Object.keys(e)) if (k.toUpperCase().startsWith('GIT_')) delete e[k]; return { ...e, GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: devNull, GIT_LITERAL_PATHSPECS: '1', GIT_OPTIONAL_LOCKS: '0' }; };
const git = (cwd, args, max = 1 << 20, input = undefined) => execFileSync('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', ...args], { cwd, env: gitEnv(), maxBuffer: max, input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
const topOf = (repo) => (typeof repo !== 'string' ? refuse('test_kinds_error') : realpathSync.native(git(realpathSync.native(repo), ['rev-parse', '--show-toplevel']).toString('utf8').replace(/\n$/, ''))); // a primitive string, before the filesystem sees it (no URL-like getter runs)
const gitRefusal = (e) => (e?.code === 'ENOBUFS' ? 'evidence_budget_exceeded' : 'evidence_unavailable');

// ---- the evidence identity (design rev 5 section 1a): the candidate-id encoding over P, from the worktree ----
export const SUBMODULE = 'submodule_unsupported_v0';
/** `e1:` + sha256 over base_sha and every changed path (byte order): path, kind, mode, length, bytes. Never throws. */
export function evidenceIdentity(input) {
  try { const c = candidate(own(input, 'repo'), own(input, 'baseSha'), ownOr(input, 'exclusions', [])); return { ok: true, evidence_id: c.evidence_id, paths: c.paths }; } catch (e) { return { ok: false, ...refusalOf(e, 'evidence_unavailable') }; }
}
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }); // a file name may start with U+FEFF: keep it
/** The NUL-terminated records of a `-z` git listing, as bytes (a path is never decoded lossily). */
const records = (buf) => { const out = []; for (let at = 0; at < buf.length;) { const end = buf.indexOf(0, at) < 0 ? buf.length : buf.indexOf(0, at); out.push(buf.subarray(at, end)); at = end + 1; } return out; };
const isGitlink = (rec) => rec.subarray(0, 7).toString('latin1') === '160000 ';
/** lstat of a working-tree path: null when it is missing (ENOENT, or ENOTDIR below a file); any other error refuses. */
function stat(top, p) { try { return lstatSync(join(top, p)); } catch (e) { return e?.code === 'ENOENT' || e?.code === 'ENOTDIR' ? null : refuse('evidence_unavailable'); } }
/**
 * The candidate: identity, P (`paths`, after exclusions), every changed path before ANY exclusion (`all`, for config_paths), the
 * path lookups over both (`inP`, `inAll`) and the NAMES at base (`atBase`, for D4; no base blob is read). Throws a Refusal.
 */
export function candidate(repo, baseSha, exclusions) {
  if (typeof baseSha !== 'string' || !SHA.test(baseSha)) refuse('test_kinds_error');
  const ex = arr(exclusions, LIMITS.maxList, safeRel, { work: 0, max: 1e6 });
  const top = topOf(repo);
  let all, index, tree;
  try { index = git(top, ['ls-files', '-s', '-z'], 64 << 20); tree = git(top, ['ls-tree', '-r', '-z', '--full-tree', baseSha], 64 << 20); } catch (e) { refuse(gitRefusal(e)); }
  const treeRecs = records(tree);
  if (records(index).some(isGitlink) || treeRecs.some(isGitlink)) refuse('evidence_unavailable', SUBMODULE); // S3, before anything else reads it
  const atBase = new Set(treeRecs.map((rec) => { try { return utf8.decode(rec.subarray(rec.indexOf(9) + 1)); } catch { return refuse('evidence_unavailable'); } })); // never decoded lossily
  try { all = changedPaths(top, baseSha, 'WORKTREE'); } catch { refuse('evidence_unavailable'); }
  if (all.length > LIMITS.maxPaths) refuse('evidence_budget_exceeded');
  const inAll = pathIndex(all), paths = all.filter((p) => !p.startsWith('.ship-ticket/') && !ex.some((e) => under(p, e))), inP = pathIndex(paths);
  const h = createHash('sha256'), abs = (p) => join(top, p);
  h.update(`ship-ticket-tk-evidence-v1\0${baseSha}\0`);
  let bytes = 0;
  for (const p of paths) {
    let kind = 'deleted', mode = '0', content = Buffer.from('tombstone');
    let st = null;
    try { st = lstatSync(abs(p)); } catch (e) { if (e?.code !== 'ENOENT' && e?.code !== 'ENOTDIR') refuse('evidence_unavailable'); } // below a file: deleted
    if (st && realOrAncestor(dirname(abs(p)), { work: 0, max: 1e6 }) !== dirname(abs(p))) refuse('evidence_unavailable'); // reached through a symlinked directory: bytes git does not see
    if (st) {
      if (st.isSymbolicLink()) { kind = 'symlink'; mode = '120000'; content = readlinkSync(abs(p), { encoding: 'buffer' }); }
      else if (st.isFile()) {
        bytes += st.size; if (bytes > LIMITS.maxIdentityBytes) refuse('evidence_budget_exceeded');
        kind = 'file'; mode = (st.mode & 0o111) === 0 ? '100644' : '100755'; content = readFileSync(abs(p));
      } else if (st.isDirectory()) { // a file replaced by a directory: git lists its files as paths of P; a REPOSITORY it does not
        try { lstatSync(join(abs(p), '.git')); refuse('evidence_unavailable', SUBMODULE); } catch (e) { if (e?.code !== 'ENOENT') throw e; }
        kind = 'directory'; mode = '40000'; content = Buffer.alloc(0);
      }
      else refuse('evidence_unavailable'); // a fifo or device is never read (it could block)
    }
    h.update(Buffer.from(p, 'utf8')); h.update(`\0${kind}\0${mode}\0${content.length}\0`); h.update(content); h.update('\0');
  }
  return { evidence_id: `e1:${h.digest('hex')}`, paths, all, inP, inAll, atBase, top, base_sha: baseSha };
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
/** The digest of the `config_paths` bytes (a missing file is `absent`; a symlink on the way, non-regular or over-64-MiB file is refused). Never throws. */
export function configDigest(repo, paths) {
  try {
    const list = arr(paths, LIMITS.maxList, safeRel, { work: 0, max: 1e6 }), top = topOf(repo), h = createHash('sha256');
    for (const p of [...new Set(list)].sort()) {
      if (realOrAncestor(join(top, p), { work: 0, max: 1e6 }) !== join(top, p)) refuse('evidence_unavailable'); // its own file: no symlinked directory, no alias
      let st = null;
      try { st = lstatSync(join(top, p)); } catch (e) { if (e?.code !== 'ENOENT') refuse('evidence_unavailable'); }
      if (st && (!st.isFile() || st.size > LIMITS.maxConfigBytes)) refuse('evidence_unavailable');
      const bytes = st ? readFileSync(join(top, p)) : null; // presence and length before the bytes: `absent` is not a file holding "absent"
      h.update(`${p}\0${bytes ? `present\0${bytes.length}\0` : 'absent\0'}`); if (bytes) h.update(bytes); h.update('\0');
    }
    return { ok: true, digest: h.digest('hex') };
  } catch (e) { return { ok: false, ...refusalOf(e, 'evidence_unavailable') }; }
}

/** Line endings only: a CRLF checkout (core.autocrlf) of an LF blob is the same config. Latin1 maps every byte, so nothing else folds. */
const lfText = (buf) => buf.toString('latin1').replace(/\r\n/g, '\n');
/**
 * A declared config path equals base (D4, B1): absent at base and absent now; or present at both with the same bytes up to CRLF -> LF,
 * the working-tree file against the RAW base blob (`cat-file blob`, no filter). Config files only: no test or source file is compared
 * with base (owner decision 2026-11-19). Throws a Refusal.
 */
function configEqualsBase(c, p) {
  const st = stat(c.top, p);
  if (!c.atBase.has(p)) return !st;
  if (!st) return false; // deleted: git lists a deletion, so `inAll` refuses first (documented equivalent)
  let blob;
  try { blob = git(c.top, ['cat-file', 'blob', `${c.base_sha}:${p}`], LIMITS.maxConfigBytes + 1); } catch (e) { refuse(gitRefusal(e)); }
  return lfText(blob) === lfText(readFileSync(join(c.top, p)));
}

// ---- THE current context (I-A, I-F): one derivation, one refusal order, for buildRecord, recordUsable and tkVerdict ----
/**
 * currentContext({ repo, baseSha, exclusions, entries:[entry], commandOf(entry) -> {cmd,args}|undefined, needCommand(entry), globs }, ctx)
 *   -> { c, testGlobs, per: Map(name -> { entry, covers, command, command_digest, config_digest }) }. THROWS a Refusal, in this order:
 *   1. every entry through `readEntry` (names unique);
 *   2. EVERY entry's current command through `commandFor`, before any record is looked at (C6); `undefined` is allowed only
 *      when `needCommand(entry)` is false (the verdict: an entry with no record, whose `{files}` may have nothing to run);
 *   3. the candidate; 4. `runner_config_changed`: any entry's config_paths in `all`, or an alias of one, BEFORE any exclusion (I6, C3, S2);
 *   5. every entry's config digest, then (D4) a config path absent at base but present now is `runner_config_changed`; 6. the test globs.
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
  if (entries.some((en) => en.config_paths.some((p) => c.inAll(p, 'runner_config_changed') !== null))) refuse('runner_config_changed');
  const per = new Map();
  for (const { entry, command } of decl) {
    const cd = configDigest(c.top, entry.config_paths);
    if (!cd.ok) refuse(cd.code, cd.detail);
    // D4 + review of 40486a5 (B1): a config path must EQUAL base (design rev 6) as BYTES, not only in git's view, which a local ignore
    // rule or clean filter can hide (after the digest, so a symlinked or non-regular config path is still `evidence_unavailable`)
    if (entry.config_paths.some((p) => !configEqualsBase(c, p))) refuse('runner_config_changed');
    per.set(entry.name, { entry, covers: matcher(entry.covers), command, command_digest: command && commandDigest(command.cmd, command.args), config_digest: cd.digest });
  }
  const testGlobs = matcher([...BUILTIN_TEST_GLOBS, ...globList(own(input, 'globs'), ctx)]);
  return { c, testGlobs, per };
}

// ---- THE record schema (I1, I-B, S1): one validator, used by buildRecord on its own output and by reuse on a stored record ----
const TOP = ['evidence_id', 'base_sha', 'entry', 'dag_digest', 'command_digest', 'config_digest', 'attempt_id', 'exit_code', 'report_sha256', 'report_len', 'runner', 'claim', 'integrity', 'files', 'counts'];
const ROW = ['file', 'outcome', 'credited', 'unknown'], COUNTS = ['marker_files', 'credited', 'unknown_markers'], RUNNER_KEYS = ['id', 'version', 'format'];
const OUTCOMES = ['counted', ...FILE_VOIDS];
const uint = (v, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= 0 && v <= max;
const str = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
const sortedUnique = (xs) => xs.every((x, i) => i === 0 || xs[i - 1] < x);
/**
 * validRecord(R, ctx) -> a fresh copy built from primitives, or null. Throws only a Refusal on a hostile shape. A record is its
 * ROWS plus provenance (S1): nothing is stored that the rows cannot be checked against. Checks: exact key sets at every level
 * (a row is exactly `{file, outcome, credited, unknown}`; a pre-2026-11-19 row with `withheld`/`skipped` is malformed); typed
 * fields (`runner.version` a RUNNER_VERSION, `report_len` >= 1); per row, the outcome allowlist, `credited` creditable, sorted and
 * unique, `unknown` a count; a VOID row credits and counts nothing; and `counts` EQUAL to the totals recomputed from the rows.
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
    && INTEGRITY.every((k) => typeof copy.integrity[k] === 'boolean');
  if (!typed) return null;
  const seen = new Set(), sum = { marker_files: 0, credited: 0, unknown_markers: 0 };
  for (const f of arr(g('files'), LIMITS.maxMarkerFiles, plain, ctx)) {
    if (!exactKeys(f, ROW)) return null;
    const file = own(f, 'file'), outcome = own(f, 'outcome'), unknown = own(f, 'unknown');
    if (typeof outcome !== 'string' || !OUTCOMES.includes(outcome)) return null;
    if (!(file === null ? outcome === 'result_outside_repo' : safeRel(file) && outcome !== 'result_outside_repo')) return null;
    if (file !== null && seen.has(file)) return null;
    seen.add(file);
    const ids = arr(own(f, 'credited'), LIMITS.maxIds, creditable, ctx);
    if (!sortedUnique(ids) || !uint(unknown, LIMITS.maxIds)) return null;
    if (outcome !== 'counted' && (ids.length || unknown)) return null; // a VOID row never credits (I1)
    sum.marker_files++; sum.credited += ids.length; sum.unknown_markers += unknown;
    copy.files.push({ file, outcome, credited: [...ids], unknown });
  }
  // P2 takes at most this many items: a record that would exceed it is refused (I-B: the builder never emits one), never truncated
  if (new Set(copy.files.flatMap((f) => f.credited.filter((m) => m.startsWith('plan:')))).size > P2_LIMITS.maxItems) refuse('evidence_budget_exceeded');
  return COUNTS.every((k) => copy.counts[k] === sum[k]) ? copy : null; // S1: a stored total is the total of its rows, or the record is malformed
}

// ---- file classification ----
/** A report file name to a POSIX repo-relative path, or null when it escapes `root` (`P` is the platform path module: win32 in tests). */
export function toRepoRel(root, file, P = { relative, isAbsolute, sep }) {
  if (typeof file !== 'string' || !P.isAbsolute(file)) return null;
  const rel = P.relative(root, file);
  if (rel === '' || rel === '..' || rel.startsWith(`..${P.sep}`) || P.isAbsolute(rel)) return null;
  return rel.split(P.sep).join('/');
}
/**
 * The native realpath of `file`; for a missing file, the realpath of its nearest existing ancestor plus the missing tail (I7).
 * Any error other than a missing component (EACCES, ELOOP, ...) is a refusal, never "outside the repo". Throws a Refusal.
 */
function realOrAncestor(file, ctx) {
  const missing = (e) => (e?.code === 'ENOENT' || e?.code === 'ENOTDIR' ? null : refuse('evidence_unavailable'));
  try { return realpathSync.native(file); } catch (e) { missing(e); }
  const tail = [];
  for (let at = file; ; at = dirname(at)) {
    charge(ctx);
    if (dirname(at) === at) return null;
    if (tail.length > 256) refuse('evidence_budget_exceeded');
    tail.unshift(basename(at));
    try { return join(realpathSync.native(dirname(at)), ...tail); } catch (e) { missing(e); }
  }
}
/** Applicability of a repo-relative file to an entry (section 4 rule 3 after the repo/P steps): a FILE void code, or null. */
export function applicable(top, rel, testGlobs, covers, ctx) {
  let st;
  try { st = lstatSync(join(top, rel)); } catch { return 'not_regular'; }
  if (!st.isFile()) return 'not_regular';
  // no symlinked directory on the way: `candidate` refuses any existing path of P reached through one (round 5), and `classify` names
  // a file by its realpath, so every rel that reaches here already is its own file
  if (!matches(testGlobs, rel, ctx)) return 'not_test_file';
  if (!matches(covers, rel, ctx)) return 'runner_uncovered';
  if (st.size > LIMITS.maxFileBytes) return 'file_too_large';
  return null;
}
/** One report file name: `{ outcome, rel }` (rel null when outside the repo). */
function classify(c, file, testGlobs, covers, ctx) {
  if (!isAbsolute(file)) return { outcome: 'result_outside_repo', rel: null }; // a relative name would resolve against the cwd, never the repo
  const real = realOrAncestor(file, ctx), rel = real === null ? null : toRepoRel(c.top, real);
  if (rel === null) return { outcome: 'result_outside_repo', rel: null };
  if (c.inP(rel) === null) return { outcome: 'not_in_P', rel }; // an alias of a path in P is refused (S2)
  return { outcome: applicable(c.top, rel, testGlobs, covers, ctx) ?? 'counted', rel };
}

// ---- building a record from a provided report (section 1 output; sections 3-4 counting) ----
/** I-C: every per-row collection is re-checked after EVERY change to it, a merge of two report names included (C4). */
function capSlot(s) {
  if (s.ids.size > LIMITS.maxIds || s.unknown.size > LIMITS.maxIds) refuse('evidence_budget_exceeded');
  return s;
}
/**
 * buildRecord({ repo, baseSha, entry, commandArgs, tests:{globs}, dagDigest, exclusions?, report:{text, ...provenance} })
 *   -> { ok:true, record, voids } | { ok:false, code }
 * `commandArgs` are the args that RAN (`commandFor`); `report` is `{ text, runner_id, runner_version, attempt_id, exit_code,
 * report_sha256, report_eof, sealed, quiesced, binding_verified, evidence_id_before }`. Never throws.
 */
export function buildRecord(input) {
  try { return { ok: true, ...build(input) }; } catch (e) { return { ok: false, ...refusalOf(e, 'test_kinds_error') }; }
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
  if (!parsed.supported) refuse('evidence_unavailable'); // REACHABLE: preflight does not check every field the parser reads (P4r-35)
  const results = parsed.results; // at most LIMITS.maxResults: preflight counted them

  // per report name: the creditable ids and unknown markers of PASSED results; a non-passed marked result only makes its name a row
  const byFile = new Map();
  for (const r of results) {
    charge(ctx);
    if (typeof r.title !== 'string' || typeof r.file !== 'string') refuse('evidence_unavailable'); // unreachable after preflight
    const m = markers([r.title]);
    if (!m.kinds.length && !m.items.length && !m.unknown.length) continue;
    if (!byFile.has(r.file) && byFile.size >= LIMITS.maxMarkerFiles) refuse('evidence_budget_exceeded');
    const slot = byFile.get(r.file) ?? { ids: new Set(), unknown: new Set() };
    byFile.set(r.file, slot);
    if (r.status === 'pass') { // skipped, todo, pending and disabled never credit
      for (const k of m.kinds) slot.ids.add(`kind:${k}`);
      for (const i of m.items) (ITEM_ID.test(i) ? slot.ids : slot.unknown).add(`plan:${i}`);
      for (const u of m.unknown) slot.unknown.add(u);
    }
    capSlot(slot);
  }
  // classify each report name; names resolving to the same repo file (a symlink and its target) merge into ONE row, re-capped
  const rows = [], byRel = new Map(), voids = {};
  for (const [file, slot] of [...byFile].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const v = classify(c, file, testGlobs, covers, ctx), prev = v.rel === null ? null : byRel.get(v.rel);
    if (prev) {
      for (const k of slot.ids) prev.ids.add(k);
      for (const k of slot.unknown) prev.unknown.add(k);
      capSlot(prev);
      continue;
    }
    const row = { file: v.rel, outcome: v.outcome, ...slot };
    rows.push(row);
    if (v.rel !== null) byRel.set(v.rel, row);
  }
  const files = [];
  for (const row of rows) {
    if (row.outcome !== 'counted') { voids[row.outcome] = (voids[row.outcome] ?? 0) + 1; files.push({ file: row.file, outcome: row.outcome, credited: [], unknown: 0 }); continue; }
    files.push({ file: row.file, outcome: 'counted', credited: [...row.ids].sort(), unknown: row.unknown.size });
  }
  files.sort((a, b) => ((a.file ?? '') < (b.file ?? '') ? -1 : (a.file ?? '') > (b.file ?? '') ? 1 : 0));
  const record = { evidence_id: c.evidence_id, base_sha: c.base_sha, entry: entry.name, dag_digest: own(input, 'dagDigest'), command_digest,
    config_digest, attempt_id: prov.attempt_id, exit_code: 0, report_sha256: digest, report_len: bytes,
    runner: { id: prov.runner_id, version: prov.runner_version, format: entry.format }, claim: CLAIM,
    integrity: Object.fromEntries(INTEGRITY.map((k) => [k, true])), files,
    counts: { marker_files: files.length, credited: files.reduce((n, f) => n + f.credited.length, 0), unknown_markers: files.reduce((n, f) => n + f.unknown, 0) } };
  if (!validRecord(record, ctx)) refuse('test_kinds_error'); // I-B: never emit a record reuse would reject (C7)
  return { record, voids };
}
