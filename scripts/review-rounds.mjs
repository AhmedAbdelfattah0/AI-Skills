#!/usr/bin/env node
// review-rounds.mjs - FR-4d: the two-cycle review budget for Factory-development PRs.
//
//   node scripts/review-rounds.mjs check  [--root DIR] (--base REV | --no-base)
//   node scripts/review-rounds.mjs report [--root DIR] (--base REV | --no-base)
//   node scripts/review-rounds.mjs next   --unit UNIT [--root DIR] (--base REV | --no-base)
//
// WHAT THIS IS: a PROCESS control, not a security boundary. Anyone who can write to the repository
// can forge rows, reviewer identities and verdicts; authorized_by is self-reported and not
// authenticated. The check makes a third automatic review cycle, an unauthorized new attempt and a
// rewritten ledger visible and refused in CI; it does not prove that a review happened.
//
// Ledgers: <root>/.specs/reviews/<UNIT>/review-rounds.jsonl (tracked, append-only, one canonical
// JSON object per line; see "Row shapes"). Every ledger under .specs/reviews is read; zero is valid.
// Symlinks are refused at .specs, .specs/reviews, each unit directory and each ledger.
//
// APPEND-ONLY (--base REV): the merge-base of REV and HEAD is the base. Every commit of
// `git rev-list <base>..HEAD` is compared with EVERY one of its parents (merge commits included: CI
// checks out the PR merge ref, whose first parent is the base branch, so a first-parent walk would
// skip the PR's own commits), and the working tree with HEAD and with the base. At each comparison
// a ledger the older side holds must still exist and its bytes must be a prefix of the newer bytes
// (rows may only be appended); a ledger may first appear at any commit. More than 1000 commits or 2000 ledger versions fails closed
// (E_HISTORY_CAP). It sees only the pushed history: a force-push or other history rewrite made
// before CI runs replaces the chain it walks and is NOT detected (residual; process control). Without a usable base (not a git repository, root is not the top level, a
// shallow clone, REV or the merge-base unresolvable) the run fails closed with E_BASE_UNRESOLVED,
// also when no ledger exists: a deleted ledger set looks exactly like an empty one. --no-base skips
// the comparison and says so on the OK line ("append-only NOT verified"). The comparison only sees
// history relative to the base CI gives it: a rewrite that already reached the base is not detected.
// CI passes the PR's base sha (pull_request) or the pre-push sha (push) with a full-history checkout.
//
// next (the orchestrator's pre-dispatch query): run it before dispatching any review round for a
// unit, e.g. `node scripts/review-rounds.mjs next --unit FR4d --base origin/main`. Exit 0 prints
// "allowed: cycle N of attempt M"; exit 4 prints "refused: <state>" (cycle 2 failed = BLOCKED, the
// budget is spent, or the second opinion was refused); any other exit code is a ledger problem and
// also means "do not dispatch". `check` itself exits 0 in the BLOCKED state: a correctly recorded
// failed cycle 2 is a valid ledger, and the stop is enforced by `next` and by E_CYCLE_LIMIT.
//
// EXIT CODES
//   0  every ledger is valid (check, report) / next cycle allowed (next)
//   1  at least one ledger violates a rule (typed code on stderr: "review-rounds: <file>:<line>: <CODE>: <detail>")
//   2  usage error (bad command, unknown or repeated flag, missing value, neither or both base flags)
//   3  environment: E_IO (unreadable), E_UNSAFE_PATH (symlink or non-regular entry), E_BASE_UNRESOLVED,
//      E_HISTORY_CAP (too much history to verify; fails closed)
//   4  next: the next review cycle is not allowed for this unit
//
// VIOLATION CODES
//   E_FORMAT                 BOM, invalid UTF-8, blank line, empty file, no final LF, > 2000 rows, > 1 MiB
//   E_CRLF                   a carriage return anywhere in the file
//   E_JSON                   a line is not a JSON object
//   E_CANONICAL              line differs from the canonical form (sorted keys, no whitespace)
//   E_SCHEMA                 closed-schema violation (missing/extra key, wrong type or value, unit grammar)
//   E_UNIT_MISMATCH          row.unit differs from the ledger's directory name
//   E_DUPLICATE              an identical row, or a second row for one (kind, attempt, cycle)
//   E_CYCLE_LIMIT            cycle >= 3 on an attempt (budget is cycle 1 and cycle 2 only)
//   E_CYCLE_ORDER            cycles not 1 then 2 within an attempt
//   E_HEAD_REUSE             one head sha reviewed in two cycles of one attempt (per attempt only: an
//                            authorized new attempt may review a head again)
//   E_REPAIR_LINK            cycle 2 head differs from the cycle 1 repair_commit
//   E_ATTEMPT_ORDER          attempt numbers not consecutive, or rows for a closed attempt
//   E_ATTEMPT_UNRECORDED     rows for an attempt that has no attempt row
//   E_ATTEMPT_NO_AUTH        attempt row without authorized_by
//   E_ATTEMPT_NO_ASSESSMENT  attempt row without an assessment digest, or no matching assessment row
//   E_ASSESSMENT_DIGEST      digest does not equal sha256 of the assessment file
//   E_ASSESSMENT_FILE        assessment missing, unsafe path, symlink, resolves outside its unit dir, too big
//   E_ASSESSMENT_SCOPE       assessment path is not a file under .specs/reviews/<UNIT>/ of its own ledger
//   E_ASSESSMENT_EMPTY       assessment file is empty
//   E_ASSESSMENT_TEMPLATE    assessment lacks the five FR-4a template headings in order (markdown heading
//                            lines containing: Evidence; Classification; Why the consolidated repair did
//                            not hold; corrective approach; next attempt) or names none of the five classes
//                            (architecture defect, implementation defect, unclear acceptance contract,
//                            trust-boundary failure, incomplete test strategy). Presence only: the
//                            engineering choice is never checked.
//   E_CROSS_UNIT             one pr number, or one head sha, recorded under two units (a PR's budget
//                            cannot be split across ledgers; pr:null rows are bound by head only)
//   E_APPEND_ONLY            a ledger's bytes at some step do not extend the previous step (row changed or removed)
//   E_LEDGER_DELETED         a ledger present at one step is absent at the next (or its unit directory is gone)
//
// Row shapes (closed: any other key is E_SCHEMA). Every row has kind, unit, at (UTC, YYYY-MM-DDTHH:MM:SSZ).
//   cycle:      attempt, cycle (1|2), pr (int|null), head (40 hex), reviewers [primary, second_opinion],
//               summary (string), repair_commit (40 hex|null; only on cycle 1),
//               finding_classes (OPTIONAL, additive: strictly ascending unique slugs [a-z0-9-], 1..20;
//               the classes of the qualifying findings, used by report for repeated classes)
//     primary         {role:"primary", reviewer:"opus", verdict:"pass"|"fail", blockers, majors}
//     second_opinion  {role:"second_opinion", reviewer:"codex"|"fable", verdict:"pass"|"fail"|"provider_refused",
//                      blockers, majors[, message (required iff provider_refused)]}
//     verdict fail <=> blockers+majors > 0; provider_refused needs blockers=majors=0.
//   assessment: attempt, path (.specs/reviews/<UNIT>/<file>), sha256 (hex of the file bytes)
//   attempt:    attempt (>= 2, previous attempt + 1), authorized_by, assessment_sha256, reason
//
// Node built-ins only, no network, no shell. The only child process is `git` (argv array, no shell,
// GIT_* environment removed), used read-only for the --base comparison.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXIT = Object.freeze({ OK: 0, VIOLATION: 1, USAGE: 2, IO: 3, NEXT_REFUSED: 4 });
export const LEDGER_NAME = 'review-rounds.jsonl';
const MAX_LEDGER_BYTES = 1 << 20;
const MAX_ASSESSMENT_BYTES = 4 << 20;
const MAX_ROWS = 2000;
const MAX_COMMITS = 1000; // commits walked since the base
const MAX_VERSIONS = 2000; // distinct ledger blobs read along that chain
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const UNIT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const LEDGER_AT_BASE = /^\.specs\/reviews\/([^/]+)\/review-rounds\.jsonl$/;
// FR-4a assessment template (skills/ship-ticket/references/review.md, "Assessment template").
const TEMPLATE_HEADINGS = ['evidence', 'classification', 'why the consolidated repair did not hold', 'corrective approach', 'next attempt'];
const CLASSES = ['architecture defect', 'implementation defect', 'unclear acceptance contract', 'trust-boundary failure', 'incomplete test strategy'];

class Violation extends Error {
  constructor(code, detail, line = 0) {
    super(detail);
    this.code = code;
    this.line = line;
  }
}
class EnvError extends Error {
  constructor(code, detail) {
    super(detail);
    this.code = code;
  }
}

export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v, min = 0) => Number.isSafeInteger(v) && v >= min;
const has = (o, k) => Object.hasOwn(o, k);
const isText = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);

function exactKeys(o, required, optional, what, line) {
  for (const k of Object.keys(o)) {
    if (!required.includes(k) && !optional.includes(k)) throw new Violation('E_SCHEMA', `${what}: unexpected key ${JSON.stringify(k)}`, line);
  }
  for (const k of required) {
    if (!has(o, k)) throw new Violation('E_SCHEMA', `${what}: missing key ${JSON.stringify(k)}`, line);
  }
}

function checkAt(o, line) {
  if (typeof o.at !== 'string' || !AT.test(o.at) || Number.isNaN(Date.parse(o.at)) || new Date(o.at).toISOString().slice(0, 19) + 'Z' !== o.at) {
    throw new Violation('E_SCHEMA', 'at must be a real UTC timestamp YYYY-MM-DDTHH:MM:SSZ', line);
  }
}

function checkReviewer(r, role, line) {
  if (!isObj(r)) throw new Violation('E_SCHEMA', `reviewers: ${role} entry is not an object`, line);
  const refused = r.verdict === 'provider_refused';
  exactKeys(r, ['role', 'reviewer', 'verdict', 'blockers', 'majors'], refused ? ['message'] : [], `reviewer ${role}`, line);
  if (r.role !== role) throw new Violation('E_SCHEMA', `reviewers: expected role ${role}`, line);
  const names = role === 'primary' ? ['opus'] : ['codex', 'fable'];
  if (!names.includes(r.reviewer)) throw new Violation('E_SCHEMA', `reviewer ${role}: reviewer must be one of ${names.join('|')}`, line);
  const verdicts = role === 'primary' ? ['pass', 'fail'] : ['pass', 'fail', 'provider_refused'];
  if (!verdicts.includes(r.verdict)) throw new Violation('E_SCHEMA', `reviewer ${role}: verdict must be one of ${verdicts.join('|')}`, line);
  if (!isInt(r.blockers) || !isInt(r.majors)) throw new Violation('E_SCHEMA', `reviewer ${role}: blockers and majors must be non-negative integers`, line);
  const q = r.blockers + r.majors;
  if (r.verdict === 'pass' && q !== 0) throw new Violation('E_SCHEMA', `reviewer ${role}: verdict pass with blockers+majors > 0`, line);
  if (r.verdict === 'fail' && q === 0) throw new Violation('E_SCHEMA', `reviewer ${role}: verdict fail with blockers+majors = 0`, line);
  if (refused) {
    if (q !== 0) throw new Violation('E_SCHEMA', 'provider_refused needs blockers=0 and majors=0', line);
    if (!isText(r.message, 500)) throw new Violation('E_SCHEMA', 'provider_refused needs a non-empty message (the provider text)', line);
  }
}

function checkFindingClasses(v, line) {
  const ok = Array.isArray(v) && v.length >= 1 && v.length <= 20
    && v.every((s, i) => typeof s === 'string' && SLUG.test(s) && (i === 0 || v[i - 1] < s));
  if (!ok) throw new Violation('E_SCHEMA', 'finding_classes must be 1..20 strictly ascending unique slugs [a-z0-9-]', line);
}

function validateRow(o, line) {
  if (!isObj(o)) throw new Violation('E_JSON', 'line is not a JSON object', line);
  // Typed refusals first, so the code names the actual gap (still inside the closed schema).
  if (o.kind === 'attempt') {
    if (!isText(o.authorized_by, 200)) throw new Violation('E_ATTEMPT_NO_AUTH', 'attempt row needs a non-empty authorized_by', line);
    if (typeof o.assessment_sha256 !== 'string' || !HEX64.test(o.assessment_sha256)) {
      throw new Violation('E_ATTEMPT_NO_ASSESSMENT', 'attempt row needs assessment_sha256 (64 lowercase hex)', line);
    }
  }
  if (o.kind === 'cycle' && isInt(o.cycle) && o.cycle >= 3) {
    throw new Violation('E_CYCLE_LIMIT', `cycle ${o.cycle} refused: budget is cycle 1 and cycle 2 per attempt; write an assessment and obtain an authorized new attempt`, line);
  }
  if (!UNIT.test(o.unit ?? '')) throw new Violation('E_SCHEMA', 'unit must match ' + UNIT, line);
  if (o.kind === 'cycle') {
    exactKeys(o, ['kind', 'unit', 'attempt', 'cycle', 'pr', 'head', 'reviewers', 'summary', 'repair_commit', 'at'], ['finding_classes'], 'cycle row', line);
    if (!isInt(o.attempt, 1)) throw new Violation('E_SCHEMA', 'attempt must be an integer >= 1', line);
    if (!isInt(o.cycle, 1)) throw new Violation('E_SCHEMA', 'cycle must be an integer >= 1', line);
    if (!(o.pr === null || isInt(o.pr, 1))) throw new Violation('E_SCHEMA', 'pr must be a positive integer or null', line);
    if (typeof o.head !== 'string' || !HEX40.test(o.head)) throw new Violation('E_SCHEMA', 'head must be 40 lowercase hex', line);
    if (!(o.repair_commit === null || (typeof o.repair_commit === 'string' && HEX40.test(o.repair_commit)))) {
      throw new Violation('E_SCHEMA', 'repair_commit must be 40 lowercase hex or null', line);
    }
    if (o.cycle === 2 && o.repair_commit !== null) throw new Violation('E_SCHEMA', 'repair_commit must be null on cycle 2 (no automatic repair after cycle 2)', line);
    if (!isText(o.summary, 1000)) throw new Violation('E_SCHEMA', 'summary must be a non-empty single-line string (<= 1000)', line);
    if (!Array.isArray(o.reviewers) || o.reviewers.length !== 2) {
      throw new Violation('E_SCHEMA', 'reviewers must be [primary, second_opinion] (an independent second opinion or a provider_refused entry is required)', line);
    }
    checkReviewer(o.reviewers[0], 'primary', line);
    checkReviewer(o.reviewers[1], 'second_opinion', line);
    if (has(o, 'finding_classes')) checkFindingClasses(o.finding_classes, line);
    checkAt(o, line);
    return;
  }
  if (o.kind === 'assessment') {
    exactKeys(o, ['kind', 'unit', 'attempt', 'path', 'sha256', 'at'], [], 'assessment row', line);
    if (!isInt(o.attempt, 1)) throw new Violation('E_SCHEMA', 'attempt must be an integer >= 1', line);
    if (!isText(o.path, 300)) throw new Violation('E_SCHEMA', 'path must be a non-empty string', line);
    if (typeof o.sha256 !== 'string' || !HEX64.test(o.sha256)) throw new Violation('E_ASSESSMENT_DIGEST', 'sha256 must be 64 lowercase hex', line);
    checkAt(o, line);
    return;
  }
  if (o.kind === 'attempt') {
    exactKeys(o, ['kind', 'unit', 'attempt', 'authorized_by', 'assessment_sha256', 'reason', 'at'], [], 'attempt row', line);
    if (!isInt(o.attempt, 2)) throw new Violation('E_SCHEMA', 'attempt rows start at attempt 2', line);
    if (!isText(o.reason, 1000)) throw new Violation('E_SCHEMA', 'reason must be a non-empty single-line string', line);
    checkAt(o, line);
    return;
  }
  throw new Violation('E_SCHEMA', 'kind must be cycle|assessment|attempt', line);
}

function sha256Of(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function readRegular(abs, max, tooBig) {
  const st = lstatSync(abs);
  if (!st.isFile()) throw new Error('not a regular file (symlinks are refused)');
  if (st.size > max) throw tooBig();
  const fd = openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(fstatSync(fd).size);
    let n = 0;
    while (n < buf.length) {
      const r = readSync(fd, buf, n, buf.length - n, n);
      if (r === 0) break;
      n += r;
    }
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

// Checks scope, safety, size, non-emptiness and the template; returns {sha256, classes}.
function readAssessment(root, unit, rel, line) {
  if (rel.includes('\\') || rel.startsWith('/') || rel.split('/').some((p) => p === '' || p === '.' || p === '..')) {
    throw new Violation('E_ASSESSMENT_FILE', `unsafe assessment path ${JSON.stringify(rel)}`, line);
  }
  const prefix = `.specs/reviews/${unit}/`;
  if (!rel.startsWith(prefix) || rel.length === prefix.length) {
    throw new Violation('E_ASSESSMENT_SCOPE', `assessment ${JSON.stringify(rel)} must be a file under ${prefix}`, line);
  }
  let buf;
  try {
    const abs = resolve(root, rel);
    buf = readRegular(abs, MAX_ASSESSMENT_BYTES, () => new Error('too large'));
    // lstat above refuses a final-component symlink; this refuses a symlinked directory on the way.
    if (!realpathSync(abs).startsWith(realpathSync(join(root, '.specs', 'reviews', unit)) + sep)) throw new Error(`resolves outside ${prefix}`);
  } catch (e) {
    throw new Violation('E_ASSESSMENT_FILE', `assessment ${JSON.stringify(rel)}: ${e.message}`, line);
  }
  if (buf.length === 0) throw new Violation('E_ASSESSMENT_EMPTY', `assessment ${JSON.stringify(rel)} is empty`, line);
  const text = buf.toString('utf8').toLowerCase();
  const headings = text.split('\n').filter((l) => /^#{1,6}\s/.test(l));
  let at = 0;
  for (const h of TEMPLATE_HEADINGS) {
    const i = headings.findIndex((l, k) => k >= at && l.includes(h));
    if (i === -1) throw new Violation('E_ASSESSMENT_TEMPLATE', `assessment ${JSON.stringify(rel)}: no heading "${h}" after the previous template heading (FR-4a template: ${TEMPLATE_HEADINGS.join(' / ')})`, line);
    at = i + 1;
  }
  const classes = CLASSES.filter((c) => text.includes(c));
  if (classes.length === 0) throw new Violation('E_ASSESSMENT_TEMPLATE', `assessment ${JSON.stringify(rel)}: the classification names none of: ${CLASSES.join(', ')}`, line);
  return { sha256: sha256Of(buf), classes };
}

// Parses and validates one ledger. Returns {unit, rows, attempts, assessed}; throws Violation on the first problem.
export function checkLedgerBytes(buf, unit, root) {
  if (buf.length === 0) throw new Violation('E_FORMAT', 'empty ledger (delete it or add rows)');
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) throw new Violation('E_FORMAT', 'BOM is not allowed');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw new Violation('E_FORMAT', 'invalid UTF-8');
  }
  const cr = text.indexOf('\r');
  if (cr !== -1) throw new Violation('E_CRLF', 'carriage return found: LF line endings only', text.slice(0, cr).split('\n').length);
  if (!text.endsWith('\n')) throw new Violation('E_FORMAT', 'missing final newline');
  const lines = text.slice(0, -1).split('\n');
  if (lines.length > MAX_ROWS) throw new Violation('E_FORMAT', `more than ${MAX_ROWS} rows`);

  const seenKeys = new Set();
  const rows = [];
  let cur = 1; // attempt 1 needs no attempt row
  let cycles = []; // cycle rows of the current attempt
  const assessments = new Map(); // attempt -> sha256
  const assessed = new Map(); // attempt -> classes named in the assessment
  const opened = new Set([1]);

  lines.forEach((text1, i) => {
    const line = i + 1;
    if (text1 === '') throw new Violation('E_FORMAT', 'blank line', line);
    let o;
    try {
      o = JSON.parse(text1);
    } catch (e) {
      throw new Violation('E_JSON', `malformed JSON: ${e.message}`, line);
    }
    validateRow(o, line);
    if (canonical(o) !== text1) throw new Violation('E_CANONICAL', `not canonical; expected ${canonical(o)}`, line);
    if (o.unit !== unit) throw new Violation('E_UNIT_MISMATCH', `unit ${JSON.stringify(o.unit)} is not ${JSON.stringify(unit)}`, line);
    const key = `${o.kind}|${o.attempt}|${o.kind === 'cycle' ? o.cycle : ''}`;
    if (seenKeys.has(key)) throw new Violation('E_DUPLICATE', `second ${o.kind} row for attempt ${o.attempt}${o.kind === 'cycle' ? ` cycle ${o.cycle}` : ''}`, line);
    seenKeys.add(key);

    if (o.kind === 'assessment') {
      if (o.attempt !== cur) throw new Violation('E_ATTEMPT_ORDER', `assessment for attempt ${o.attempt} but attempt ${cur} is open`, line);
      const actual = readAssessment(root, unit, o.path, line);
      if (actual.sha256 !== o.sha256) throw new Violation('E_ASSESSMENT_DIGEST', `sha256 ${o.sha256} != file digest ${actual.sha256}`, line);
      assessments.set(o.attempt, o.sha256);
      assessed.set(o.attempt, actual.classes);
    } else if (o.kind === 'attempt') {
      if (o.attempt !== cur + 1) throw new Violation('E_ATTEMPT_ORDER', `attempt ${o.attempt} must follow attempt ${cur}`, line);
      if (!assessments.has(cur)) throw new Violation('E_ATTEMPT_NO_ASSESSMENT', `no assessment row for attempt ${cur} before attempt ${o.attempt}`, line);
      if (assessments.get(cur) !== o.assessment_sha256) throw new Violation('E_ASSESSMENT_DIGEST', 'assessment_sha256 does not equal the assessment row digest of the previous attempt', line);
      cur = o.attempt;
      opened.add(cur);
      cycles = [];
    } else {
      if (o.attempt > cur) throw new Violation('E_ATTEMPT_UNRECORDED', `attempt ${o.attempt} has no attempt row`, line);
      if (o.attempt < cur) throw new Violation('E_ATTEMPT_ORDER', `attempt ${o.attempt} is closed (attempt ${cur} is open)`, line);
      const last = cycles.length ? cycles[cycles.length - 1].cycle : 0;
      if (o.cycle === last) throw new Violation('E_DUPLICATE', `cycle ${o.cycle} repeated`, line);
      if (o.cycle !== last + 1) throw new Violation('E_CYCLE_ORDER', `cycle ${o.cycle} after cycle ${last}: cycles must be 1 then 2`, line);
      if (cycles.some((c) => c.head === o.head)) throw new Violation('E_HEAD_REUSE', `head ${o.head} already reviewed in this attempt`, line);
      if (o.cycle === 2 && cycles[0].repair_commit !== null && cycles[0].repair_commit !== o.head) {
        throw new Violation('E_REPAIR_LINK', 'cycle 2 head must equal the cycle 1 repair_commit', line);
      }
      cycles.push({ cycle: o.cycle, head: o.head, repair_commit: o.repair_commit });
    }
    rows.push(o);
  });
  return { unit, rows, attempts: [...opened], assessed };
}

// --- discovery and reading (symlinks refused) ------------------------------------------------
function noSymlink(p) {
  let st;
  try {
    st = lstatSync(p);
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw new EnvError('E_IO', `cannot stat ${p}: ${e.message}`);
  }
  if (!st.isDirectory()) throw new EnvError('E_UNSAFE_PATH', `${p}: not a directory (symlinks are refused)`);
  return true;
}

function discover(root) {
  if (!noSymlink(join(root, '.specs'))) return [];
  const base = join(root, '.specs', 'reviews');
  if (!noSymlink(base)) return [];
  let entries;
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch (e) {
    throw new EnvError('E_IO', `cannot read ${base}: ${e.message}`);
  }
  const out = [];
  for (const d of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (d.isSymbolicLink()) throw new EnvError('E_UNSAFE_PATH', `${join(base, d.name)}: symlinks are refused under .specs/reviews`);
    if (!d.isDirectory()) continue;
    const p = join(base, d.name, LEDGER_NAME);
    try {
      lstatSync(p);
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw new EnvError('E_IO', `cannot stat ${p}: ${e.message}`);
    }
    out.push({ unit: d.name, path: p });
  }
  return out;
}

function readLedger(path) {
  try {
    return readRegular(path, MAX_LEDGER_BYTES, () => new Violation('E_FORMAT', `ledger larger than ${MAX_LEDGER_BYTES} bytes`));
  } catch (e) {
    if (e instanceof Violation) throw e;
    if (e.message.startsWith('not a regular file')) throw new EnvError('E_UNSAFE_PATH', `${path}: ${e.message}`);
    throw new EnvError('E_IO', `cannot read ${path}: ${e.message}`);
  }
}

// --- base (append-only) -----------------------------------------------------------------------
function gitIn(root, args, encoding = 'utf8') {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  return execFileSync('git', ['-C', root, ...args], {
    encoding, env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * MAX_LEDGER_BYTES + (1 << 20),
  });
}

// Returns {sha, ledgers: Map(unit -> Buffer)} for the merge-base of rev and HEAD; throws EnvError.
function loadBase(root, rev) {
  const fail = (what, e) => new EnvError('E_BASE_UNRESOLVED', `${what}${e ? `: ${String(e.stderr || e.message).trim().split('\n')[0]}` : ''} (append-only cannot be verified; fails closed)`);
  let top;
  try {
    top = gitIn(root, ['rev-parse', '--show-toplevel']).trim();
  } catch (e) {
    throw fail(`${root} is not a git repository`, e);
  }
  if (realpathSync(top) !== realpathSync(root)) throw fail(`${root} is not the repository top level (${top})`);
  let shallow;
  try {
    shallow = gitIn(root, ['rev-parse', '--is-shallow-repository']).trim();
  } catch (e) {
    throw fail('cannot tell whether the clone is shallow', e);
  }
  if (shallow !== 'false') throw fail('shallow clone: fetch the full history (actions/checkout fetch-depth: 0)');
  let sha;
  try {
    sha = gitIn(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]).trim();
  } catch (e) {
    throw fail(`base ${JSON.stringify(rev)} does not resolve to a commit`, e);
  }
  let mb;
  try {
    mb = gitIn(root, ['merge-base', sha, 'HEAD']).trim();
  } catch (e) {
    throw fail(`no merge-base between ${sha} and HEAD`, e);
  }
  if (!HEX40.test(mb)) throw fail(`unexpected merge-base ${JSON.stringify(mb)}`);
  // Every commit in <base>..HEAD is compared with EVERY parent (merge commits included): CI checks
  // out the PR merge ref, whose first parent is the base branch, so a first-parent walk would skip
  // the PR's own commits. A ledger only has to persist and extend where the parent had it.
  let edges;
  let head;
  try {
    head = gitIn(root, ['rev-parse', '--verify', 'HEAD^{commit}']).trim();
    edges = gitIn(root, ['rev-list', '--reverse', '--parents', `${mb}..HEAD`]).split('\n').filter(Boolean).map((l) => l.split(' '));
  } catch (e) {
    throw fail(`cannot list the commits ${mb}..HEAD`, e);
  }
  if (edges.length > MAX_COMMITS) {
    throw new EnvError('E_HISTORY_CAP', `${edges.length} commits since the base (cap ${MAX_COMMITS}); append-only cannot be verified; fails closed`);
  }
  const blobs = new Map(); // oid -> Buffer (each version read once)
  const trees = new Map(); // commit -> Map(unit -> Buffer)
  const treeOf = (commit) => {
    if (trees.has(commit)) return trees.get(commit);
    const ledgers = new Map();
    try {
      const listing = gitIn(root, ['ls-tree', '-r', '-z', commit, '--', '.specs/reviews']);
      for (const ent of listing.split('\0').filter(Boolean)) {
        const tab = ent.indexOf('\t');
        const [, type, oid] = ent.slice(0, tab).split(' ');
        const m = LEDGER_AT_BASE.exec(ent.slice(tab + 1));
        if (!m || type !== 'blob') continue;
        if (!blobs.has(oid)) {
          if (blobs.size >= MAX_VERSIONS) throw new EnvError('E_HISTORY_CAP', `more than ${MAX_VERSIONS} distinct ledger versions since the base; append-only cannot be verified; fails closed`);
          blobs.set(oid, gitIn(root, ['cat-file', 'blob', oid], 'buffer'));
        }
        ledgers.set(m[1], blobs.get(oid));
      }
    } catch (e) {
      if (e instanceof EnvError) throw e;
      throw fail(`cannot read the ledgers of commit ${commit}`, e);
    }
    trees.set(commit, ledgers);
    return ledgers;
  };
  const pairs = [];
  for (const [commit, ...parents] of edges) {
    for (const parent of parents) pairs.push([parent, treeOf(parent), commit, treeOf(commit)]);
  }
  return { sha: mb, head, pairs, baseLedgers: treeOf(mb), headLedgers: treeOf(head) };
}

// --- report and next --------------------------------------------------------------------------
const outcome = (c) => (c.reviewers.some((r) => r.verdict === 'fail') ? 'fail'
  : c.reviewers.every((r) => r.verdict === 'pass') ? 'pass' : 'refused');

// State of the open (last) attempt: {allowed, text}.
function stateOf(l) {
  const cur = Math.max(...l.attempts);
  const cyc = l.rows.filter((r) => r.kind === 'cycle' && r.attempt === cur);
  const last = cyc[cyc.length - 1];
  if (!last) return { allowed: true, text: `cycle 1 of attempt ${cur}` };
  const out = outcome(last);
  if (out === 'refused') return { allowed: false, text: `waiting owner - second opinion provider_refused on cycle ${last.cycle}` };
  if (out === 'pass') return { allowed: false, text: `complete - cycle ${last.cycle} passed` };
  if (last.cycle === 1) return { allowed: true, text: `cycle 2 of attempt ${cur} (${last.repair_commit ? `head ${last.repair_commit}` : 'any new head'})` };
  const as = l.rows.some((r) => r.kind === 'assessment' && r.attempt === cur);
  return {
    allowed: false,
    text: as ? 'cycle 2 failed; assessment recorded; owner authorization needed for a new attempt'
      : 'BLOCKED - cycle 2 failed; write an assessment and obtain an authorized new attempt',
  };
}

function repeated(lists) {
  const count = new Map();
  for (const list of lists) for (const c of new Set(list)) count.set(c, (count.get(c) ?? 0) + 1);
  return [...count].filter(([, n]) => n > 1).map(([c]) => c).sort();
}

function formatReport(l) {
  const out = [`unit ${l.unit}`];
  const attempts = [...l.attempts].sort((x, y) => x - y);
  const perAttempt = [];
  for (const a of attempts) {
    const cyc = l.rows.filter((r) => r.kind === 'cycle' && r.attempt === a);
    const as = l.rows.find((r) => r.kind === 'assessment' && r.attempt === a);
    const at = l.rows.find((r) => r.kind === 'attempt' && r.attempt === a);
    const nextAt = l.rows.find((r) => r.kind === 'attempt' && r.attempt === a + 1);
    out.push(`  attempt ${a}: ${cyc.length} cycle(s)${at ? ` (authorized_by ${at.authorized_by})` : ''}`);
    for (const c of cyc) {
      const v = c.reviewers.map((r) => `${r.reviewer}:${r.verdict}`).join(' ');
      out.push(`    cycle ${c.cycle} head ${c.head.slice(0, 12)} pr ${c.pr ?? 'none'} ${v}${c.finding_classes ? ` classes ${c.finding_classes.join(',')}` : ''}`);
    }
    const recorded = cyc.filter((c) => c.finding_classes);
    perAttempt.push(recorded.length ? recorded.flatMap((c) => c.finding_classes) : null);
    const rep = repeated(recorded.map((c) => c.finding_classes));
    out.push(`    repeated finding classes: ${recorded.length ? (rep.join(', ') || 'none') : 'unknown (not recorded)'}`);
    if (as) {
      out.push(`    assessment ${as.path} sha256 ${as.sha256} classification: ${l.assessed.get(a).join(', ')}; ${nextAt ? `next attempt authorized by ${nextAt.authorized_by}` : 'next attempt not authorized'}`);
    }
    if (a === attempts[attempts.length - 1]) {
      const s = stateOf(l);
      out.push(`    state: ${s.allowed ? `ready - ${s.text}` : s.text}`);
    }
  }
  if (attempts.length > 1) {
    const known = perAttempt.filter(Boolean);
    out.push(`  repeated finding classes across attempts: ${known.length < 2 ? 'unknown (not recorded)' : (repeated(known).join(', ') || 'none')}`);
  }
  return out.join('\n');
}

// --- CLI --------------------------------------------------------------------------------------
function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (!['check', 'report', 'next'].includes(cmd)) throw new Error('usage: review-rounds.mjs check|report|next [--unit UNIT] [--root DIR] (--base REV | --no-base)');
  const opts = { cmd, root: null, base: null, noBase: false, unit: null };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === '--no-base') {
      if (opts.noBase) throw new Error('--no-base given twice');
      opts.noBase = true;
      continue;
    }
    const k = { '--root': 'root', '--base': 'base', '--unit': 'unit' }[flag];
    const val = rest[i + 1];
    if (!k || val === undefined) throw new Error(`bad argument ${JSON.stringify(flag)}`);
    if (opts[k] !== null) throw new Error(`${flag} given twice`);
    opts[k] = val;
    i += 1;
  }
  if ((opts.base === null) === !opts.noBase) throw new Error('give exactly one of --base REV or --no-base');
  if (opts.base !== null && (opts.base === '' || opts.base.startsWith('-'))) throw new Error('--base must be a revision, not an option');
  if (cmd === 'next' ? !UNIT.test(opts.unit ?? '') : opts.unit !== null) throw new Error('next needs --unit UNIT (and only next takes it)');
  return opts;
}

export function run(argv, io = { out: (s) => process.stdout.write(`${s}\n`), err: (s) => process.stderr.write(`${s}\n`) }, defaultRoot) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    io.err(`review-rounds: usage: ${e.message}`);
    return EXIT.USAGE;
  }
  const root = resolve(opts.root ?? defaultRoot);
  let found;
  let base = null;
  try {
    found = discover(root);
    if (!opts.noBase) base = loadBase(root, opts.base);
  } catch (e) {
    if (!(e instanceof EnvError)) throw e;
    io.err(`review-rounds: ${e.code}: ${e.message}`);
    return EXIT.IO;
  }
  let code = EXIT.OK;
  const report = (path, e) => {
    if (e instanceof Violation) {
      io.err(`review-rounds: ${path}:${e.line}: ${e.code}: ${e.message}`);
      if (code === EXIT.OK) code = EXIT.VIOLATION;
    } else if (e instanceof EnvError) {
      io.err(`review-rounds: ${e.code}: ${e.message}`);
      code = EXIT.IO;
    } else throw e;
  };
  const ledgers = [];
  const bytes = new Map();
  for (const { unit, path } of found) {
    try {
      const buf = readLedger(path);
      bytes.set(unit, buf);
      ledgers.push({ ...checkLedgerBytes(buf, unit, root), path });
    } catch (e) {
      report(path, e);
    }
  }
  if (base) {
    // Each commit must extend each parent; the working tree must extend HEAD and the base.
    const wt = 'the working tree';
    const pairs = [...base.pairs, [base.head, base.headLedgers, wt, bytes], [base.sha, base.baseLedgers, wt, bytes]];
    const flagged = new Set(); // first violation per ledger only
    for (const [from, prev, to, next] of pairs) {
      for (const [unit, old] of prev) {
        if (flagged.has(unit)) continue;
        const path = join(root, '.specs', 'reviews', unit, LEDGER_NAME);
        const now = next.get(unit);
        if (now === undefined && !(to === wt && found.some((f) => f.unit === unit))) {
          flagged.add(unit);
          report(path, new Violation('E_LEDGER_DELETED', `.specs/reviews/${unit}/${LEDGER_NAME} exists at ${from} but not at ${to}`));
        } else if (now !== undefined && (now.length < old.length || !now.subarray(0, old.length).equals(old))) {
          flagged.add(unit);
          report(path, new Violation('E_APPEND_ONLY', `${to} is not an append to the ${from} version (${old.length} bytes): rows may only be added at the end`));
        }
      }
    }
  }
  const prUnit = new Map();
  const headUnit = new Map();
  for (const l of ledgers) {
    l.rows.forEach((r) => {
      if (r.kind !== 'cycle') return;
      const line = l.rows.indexOf(r) + 1;
      for (const [map, key, what] of [[prUnit, r.pr, `pr ${r.pr}`], [headUnit, r.head, `head ${r.head}`]]) {
        if (key === null) continue;
        const owner = map.get(key);
        if (owner === undefined) map.set(key, l.unit);
        else if (owner !== l.unit) report(l.path, new Violation('E_CROSS_UNIT', `${what} is already recorded under unit ${owner}: one PR's review budget lives in one ledger`, line));
      }
    });
  }
  if (code !== EXIT.OK) return code;
  const verified = base ? `append-only verified against base ${base.sha}` : 'append-only NOT verified (--no-base)';
  if (opts.cmd === 'next') {
    const l = ledgers.find((x) => x.unit === opts.unit);
    const s = l ? stateOf(l) : { allowed: true, text: 'cycle 1 of attempt 1' };
    io.out(`review-rounds: next ${opts.unit}: ${s.allowed ? 'allowed' : 'refused'}: ${s.text}`);
    return s.allowed ? EXIT.OK : EXIT.NEXT_REFUSED;
  }
  if (opts.cmd === 'report') ledgers.forEach((l) => io.out(formatReport(l)));
  io.out(`review-rounds: ${ledgers.length} ledger(s) ok; ${verified}`);
  return code;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url));
  process.exitCode = run(process.argv.slice(2), undefined, resolve(here, '..'));
}
