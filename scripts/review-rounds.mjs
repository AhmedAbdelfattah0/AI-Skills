#!/usr/bin/env node
// review-rounds.mjs - FR-4d: enforce the two-cycle review budget for Factory-development PRs.
//
//   node scripts/review-rounds.mjs check  [--root DIR] [--file PATH]
//   node scripts/review-rounds.mjs report [--root DIR] [--file PATH]
//
// Ledgers: <root>/.specs/reviews/<UNIT>/review-rounds.jsonl (tracked, append-only, one canonical
// JSON object per line; see "Row shapes"). With no --file every ledger under .specs/reviews is
// read. Zero ledgers is valid.
//
// EXIT CODES
//   0  every ledger is valid (check) / report printed
//   1  at least one ledger violates a rule (typed code on stderr: "review-rounds: <file>:<line>: <CODE>: <detail>")
//   2  usage error (bad command, unknown or repeated flag, missing value)
//   3  I/O error (unreadable ledger directory, unsafe ledger path)
//
// VIOLATION CODES
//   E_FORMAT                 BOM, invalid UTF-8, blank line, empty file or no final LF
//   E_CRLF                   a carriage return anywhere in the file
//   E_JSON                   a line is not a JSON object
//   E_CANONICAL              line differs from the canonical form (sorted keys, no whitespace)
//   E_SCHEMA                 closed-schema violation (missing/extra key, wrong type or value)
//   E_UNIT_MISMATCH          row.unit differs from the ledger's directory name
//   E_DUPLICATE              an identical row, or a second row for one (kind, attempt, cycle)
//   E_CYCLE_LIMIT            cycle >= 3 on an attempt (budget is cycle 1 and cycle 2 only)
//   E_CYCLE_ORDER            cycles not 1 then 2 within an attempt
//   E_HEAD_REUSE             one head sha reviewed in two cycles of an attempt
//   E_REPAIR_LINK            cycle 2 head differs from the cycle 1 repair_commit
//   E_ATTEMPT_ORDER          attempt numbers not consecutive, or rows for a closed attempt
//   E_ATTEMPT_UNRECORDED     rows for an attempt that has no attempt row
//   E_ATTEMPT_NO_AUTH        attempt row without authorized_by
//   E_ATTEMPT_NO_ASSESSMENT  attempt row without an assessment digest, or no matching assessment row
//   E_ASSESSMENT_DIGEST      digest does not equal sha256 of the assessment file
//   E_ASSESSMENT_FILE        assessment file missing, unsafe path, symlink, not a regular file or too big
//
// Row shapes (closed: any other key is E_SCHEMA). Every row has kind, unit, at (UTC, YYYY-MM-DDTHH:MM:SSZ).
//   cycle:      attempt, cycle (1|2), pr (int|null), head (40 hex), reviewers [primary, second_opinion],
//               summary (string), repair_commit (40 hex|null; only on cycle 1)
//     primary         {role:"primary", reviewer:"opus", verdict:"pass"|"fail", blockers, majors}
//     second_opinion  {role:"second_opinion", reviewer:"codex"|"fable", verdict:"pass"|"fail"|"provider_refused",
//                      blockers, majors[, message (required iff provider_refused)]}
//     verdict fail <=> blockers+majors > 0; provider_refused needs blockers=majors=0.
//   assessment: attempt, path (repo-relative file), sha256 (hex of the file bytes)
//   attempt:    attempt (>= 2, previous attempt + 1), authorized_by, assessment_sha256, reason
//
// RESIDUAL: rows are self-reported. The check stops a third automatic cycle and an unauthorized new
// attempt; it does not authenticate verdicts or the identity in authorized_by.
//
// No network, no shell, no child process: Node built-ins (fs, path, crypto, url) only.

import { createHash } from 'node:crypto';
import {
  closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXIT = Object.freeze({ OK: 0, VIOLATION: 1, USAGE: 2, IO: 3 });
export const LEDGER_NAME = 'review-rounds.jsonl';
const MAX_LEDGER_BYTES = 1 << 20;
const MAX_ASSESSMENT_BYTES = 4 << 20;
const MAX_ROWS = 2000;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const UNIT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

class Violation extends Error {
  constructor(code, detail, line = 0) {
    super(detail);
    this.code = code;
    this.line = line;
  }
}
class IoError extends Error {}

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
  return q;
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
    exactKeys(o, ['kind', 'unit', 'attempt', 'cycle', 'pr', 'head', 'reviewers', 'summary', 'repair_commit', 'at'], [], 'cycle row', line);
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
    const q = checkReviewer(o.reviewers[0], 'primary', line) + checkReviewer(o.reviewers[1], 'second_opinion', line);
    checkAt(o, line);
    return { q };
  }
  if (o.kind === 'assessment') {
    exactKeys(o, ['kind', 'unit', 'attempt', 'path', 'sha256', 'at'], [], 'assessment row', line);
    if (!isInt(o.attempt, 1)) throw new Violation('E_SCHEMA', 'attempt must be an integer >= 1', line);
    if (!isText(o.path, 300)) throw new Violation('E_SCHEMA', 'path must be a non-empty string', line);
    if (typeof o.sha256 !== 'string' || !HEX64.test(o.sha256)) throw new Violation('E_ASSESSMENT_DIGEST', 'sha256 must be 64 lowercase hex', line);
    checkAt(o, line);
    return {};
  }
  if (o.kind === 'attempt') {
    exactKeys(o, ['kind', 'unit', 'attempt', 'authorized_by', 'assessment_sha256', 'reason', 'at'], [], 'attempt row', line);
    if (!isInt(o.attempt, 2)) throw new Violation('E_SCHEMA', 'attempt rows start at attempt 2', line);
    if (!isText(o.reason, 1000)) throw new Violation('E_SCHEMA', 'reason must be a non-empty single-line string', line);
    checkAt(o, line);
    return {};
  }
  throw new Violation('E_SCHEMA', 'kind must be cycle|assessment|attempt', line);
}

function sha256Of(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function readAssessment(root, rel, line) {
  if (rel.includes('\\') || rel.startsWith('/') || rel.split('/').some((p) => p === '' || p === '.' || p === '..')) {
    throw new Violation('E_ASSESSMENT_FILE', `unsafe assessment path ${JSON.stringify(rel)}`, line);
  }
  const abs = resolve(root, rel);
  let fd;
  try {
    const rootReal = realpathSync(root);
    const st = lstatSync(abs);
    if (!st.isFile()) throw new Error('not a regular file (symlinks are refused)');
    if (st.size > MAX_ASSESSMENT_BYTES) throw new Error('too large');
    if (!realpathSync(abs).startsWith(rootReal + sep)) throw new Error('resolves outside root');
    fd = openSync(abs, 'r');
    const buf = Buffer.alloc(fstatSync(fd).size);
    let n = 0;
    while (n < buf.length) {
      const r = readSync(fd, buf, n, buf.length - n, n);
      if (r === 0) break;
      n += r;
    }
    return sha256Of(buf.subarray(0, n));
  } catch (e) {
    throw new Violation('E_ASSESSMENT_FILE', `assessment ${JSON.stringify(rel)}: ${e.message}`, line);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Parses and validates one ledger. Returns {unit, rows, attempts}; throws Violation on the first problem.
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
    const { q } = validateRowThenCanon(o, text1, line);
    if (o.unit !== unit) throw new Violation('E_UNIT_MISMATCH', `unit ${JSON.stringify(o.unit)} is not ${JSON.stringify(unit)}`, line);
    const key = `${o.kind}|${o.attempt}|${o.kind === 'cycle' ? o.cycle : ''}`;
    if (seenKeys.has(key)) throw new Violation('E_DUPLICATE', `second ${o.kind} row for attempt ${o.attempt}${o.kind === 'cycle' ? ` cycle ${o.cycle}` : ''}`, line);
    seenKeys.add(key);

    if (o.kind === 'assessment') {
      if (o.attempt !== cur) throw new Violation('E_ATTEMPT_ORDER', `assessment for attempt ${o.attempt} but attempt ${cur} is open`, line);
      const actual = readAssessment(root, o.path, line);
      if (actual !== o.sha256) throw new Violation('E_ASSESSMENT_DIGEST', `sha256 ${o.sha256} != file digest ${actual}`, line);
      assessments.set(o.attempt, o.sha256);
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
      cycles.push({ cycle: o.cycle, head: o.head, repair_commit: o.repair_commit, q });
    }
    rows.push(o);
  });
  return { unit, rows, attempts: [...opened] };
}

function validateRowThenCanon(o, text1, line) {
  const res = validateRow(o, line);
  if (canonical(o) !== text1) throw new Violation('E_CANONICAL', `not canonical; expected ${canonical(o)}`, line);
  return res;
}

function discover(root) {
  const base = join(root, '.specs', 'reviews');
  let entries;
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw new IoError(`cannot read ${base}: ${e.message}`);
  }
  const out = [];
  for (const d of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!d.isDirectory()) continue;
    const p = join(base, d.name, LEDGER_NAME);
    try {
      lstatSync(p);
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw new IoError(`cannot stat ${p}: ${e.message}`);
    }
    out.push(p);
  }
  return out;
}

function readLedger(path) {
  let fd;
  try {
    const st = lstatSync(path);
    if (!st.isFile()) throw new IoError(`${path}: not a regular file (symlinks are refused)`);
    if (st.size > MAX_LEDGER_BYTES) throw new Violation('E_FORMAT', `ledger larger than ${MAX_LEDGER_BYTES} bytes`);
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(fstatSync(fd).size);
    let n = 0;
    while (n < buf.length) {
      const r = readSync(fd, buf, n, buf.length - n, n);
      if (r === 0) break;
      n += r;
    }
    return buf.subarray(0, n);
  } catch (e) {
    if (e instanceof Violation || e instanceof IoError) throw e;
    throw new IoError(`cannot read ${path}: ${e.message}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (cmd !== 'check' && cmd !== 'report') throw new Error('usage: review-rounds.mjs check|report [--root DIR] [--file PATH]');
  const opts = { cmd, root: null, file: null };
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const val = rest[i + 1];
    if ((flag !== '--root' && flag !== '--file') || val === undefined) throw new Error(`bad argument ${JSON.stringify(flag)}`);
    const k = flag.slice(2);
    if (opts[k] !== null) throw new Error(`${flag} given twice`);
    opts[k] = val;
  }
  return opts;
}

function formatReport(l) {
  const out = [`unit ${l.unit}`];
  for (const a of l.attempts.sort((x, y) => x - y)) {
    const cyc = l.rows.filter((r) => r.kind === 'cycle' && r.attempt === a);
    const as = l.rows.find((r) => r.kind === 'assessment' && r.attempt === a);
    const at = l.rows.find((r) => r.kind === 'attempt' && r.attempt === a);
    out.push(`  attempt ${a}: ${cyc.length} cycle(s)${at ? ` (authorized_by ${at.authorized_by})` : ''}`);
    for (const c of cyc) {
      const v = c.reviewers.map((r) => `${r.reviewer}:${r.verdict}`).join(' ');
      out.push(`    cycle ${c.cycle} head ${c.head.slice(0, 12)} ${v}`);
    }
    if (as) out.push(`    assessment ${as.path} sha256 ${as.sha256}`);
    const last = cyc[cyc.length - 1];
    if (last && last.cycle === 2 && last.reviewers.some((r) => r.verdict === 'fail')) {
      out.push(as ? '    state: cycle 2 failed; assessment recorded; owner authorization needed for a new attempt' : '    state: BLOCKED - cycle 2 failed; write an assessment and obtain an authorized new attempt');
    }
  }
  return out.join('\n');
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
  let files;
  try {
    files = opts.file ? [resolve(opts.file)] : discover(root);
  } catch (e) {
    io.err(`review-rounds: E_IO: ${e.message}`);
    return EXIT.IO;
  }
  let code = EXIT.OK;
  const ledgers = [];
  for (const f of files) {
    try {
      const unit = basename(dirname(f));
      if (basename(f) !== LEDGER_NAME) throw new IoError(`${f}: ledger file must be named ${LEDGER_NAME}`);
      ledgers.push(checkLedgerBytes(readLedger(f), unit, root));
    } catch (e) {
      if (e instanceof Violation) {
        io.err(`review-rounds: ${f}:${e.line}: ${e.code}: ${e.message}`);
        if (code === EXIT.OK) code = EXIT.VIOLATION;
      } else if (e instanceof IoError) {
        io.err(`review-rounds: E_IO: ${e.message}`);
        code = EXIT.IO;
      } else throw e;
    }
  }
  if (code === EXIT.OK) {
    if (opts.cmd === 'report') ledgers.forEach((l) => io.out(formatReport(l)));
    io.out(`review-rounds: ${ledgers.length} ledger(s) ok`);
  }
  return code;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url));
  process.exitCode = run(process.argv.slice(2), undefined, resolve(here, '..'));
}
