#!/usr/bin/env node
/**
 * plan-sync.mjs (S3b-B1): a READ-ONLY check that the repo plan artifact still says what the approved native plan says.
 *
 *   node plan-sync.mjs check --native <file> --plan <artifact> [--approved <sha256:hex>]
 *
 * A file with a BOM or a CRLF line end (either side) is REFUSED as input (exit 2, plan_bom / plan_crlf), never normalised and never
 * reported as stale; the engine digest of a CRLF twin still differs from the LF one, plan-sync just does not accept such input.
 *
 * Two shapes of native file (PLAN-S3b package, B1):
 *  1. The native file has RUN-STATE markers: planDigest(native) must equal planDigest(artifact) (brief.mjs, the engine's
 *     planNarrativeDigest: RUN-STATE body excluded, markers kept, no line-end or BOM normalisation).
 *  2. The native file has no markers: the artifact text BEFORE the BEGIN marker (minus exactly one trailing LF) plus the text
 *     AFTER the END marker must equal the native bytes exactly. No normalisation (CRLF and BOM files are refused before this point).
 *
 * One JSON line on stdout. In sync: { in_sync: true, native_sha256, narrative_digest [, approved_match] }. Stale: the same with
 * in_sync false, code 'plan_sync_stale' and first_difference { line, native, artifact } (each side escaped, at most 200 chars with the ellipsis, null
 * when that side has no such line). Refused or unsupported: { in_sync: false, code, reason, which }.
 * Exit 0 in sync, 1 stale (plan_sync_stale), 2 refused input (usage, CRLF, BOM, invalid UTF-8 plan_encoding, file_changed during the read, unreadable, symlink, not regular, oversize, plan_invalid,
 * malformed --approved), 3 plan_sync_unsupported (a wave file, D9: single ticket only; see isWaveFile for the exact structural rule).
 *
 * This tool grants NO authority. It reads no RUN-STATE event, writes no file, opens no network connection and starts no process.
 * Files are opened O_RDONLY | O_NOFOLLOW | O_NONBLOCK after an lstat, and capped at 1 MiB.
 */
import { createHash } from 'node:crypto';
import { lstatSync, openSync, fstatSync, readSync, closeSync, constants } from 'node:fs';
import { planDigest } from './brief.mjs';
import { isEntrypoint } from './harness.mjs';

export const MAX_BYTES = 1024 * 1024;
const USAGE = 'usage: plan-sync.mjs check --native <native plan file> --plan <repo plan artifact> [--approved <sha256:hex>]';
const BEGIN = '<!-- RUN-STATE:BEGIN -->', END = '<!-- RUN-STATE:END -->';
const LINE_CAP = 200;
const refusal = (reason, which) => Object.assign(new Error(reason), { refused: true, reason, which });

const REAL_IO = { lstatSync, openSync, fstatSync, readSync, closeSync };
const sameFile = (x, y) => x.dev === y.dev && x.ino === y.ino && x.size === y.size && x.mtimeMs === y.mtimeMs;

/**
 * Read one plan file as its exact bytes. Reads to EOF (never only to the size seen at fstat); a file that is larger than the
 * cap, that yields more or fewer bytes than its first fstat size, or whose (dev, ino, size, mtimeMs) changed during the read
 * is refused as file_changed. `io` is a seam for the change-during-read tests only.
 */
export function readPlanBytes(path, which, io = REAL_IO) {
  let l;
  try { l = io.lstatSync(path); } catch { throw refusal('unreadable', which); }
  if (l.isSymbolicLink()) throw refusal('symlink', which);
  if (!l.isFile()) throw refusal('not_regular', which);
  if (l.size > MAX_BYTES) throw refusal('oversize', which);
  let fd;
  try {
    fd = io.openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = io.fstatSync(fd);
    if (!st.isFile()) throw refusal('not_regular', which);
    if (st.size > MAX_BYTES) throw refusal('oversize', which);
    const buf = Buffer.alloc(st.size + 1); // one spare byte: a full buffer means the file grew
    let off = 0;
    while (off < buf.length) {
      const n = io.readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) break;
      off += n;
    }
    if (off !== st.size) throw refusal(off > MAX_BYTES ? 'oversize' : 'file_changed', which);
    if (!sameFile(st, io.fstatSync(fd))) throw refusal('file_changed', which);
    return buf.subarray(0, off);
  } catch (err) {
    if (err.refused) throw err;
    throw refusal(err.code === 'ELOOP' ? 'symlink' : 'unreadable', which);
  } finally {
    if (fd !== undefined) try { io.closeSync(fd); } catch { /* read-only descriptor */ }
  }
}

const DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }); // ignoreBOM: a BOM stays in the text, so it is seen and refused
/** Strict UTF-8: invalid bytes are refused (plan_encoding), never replaced by U+FFFD. */
export function decodePlan(bytes, which) {
  try { return DECODER.decode(bytes); } catch { throw refusal('plan_encoding', which); }
}
export const readPlan = (path, which, io) => decodePlan(readPlanBytes(path, which, io), which);

/**
 * WAVE FILE (D9), defined structurally from the real shape: a multi-ticket plan carries one section per ticket
 * (references/plan.md "Waves"; .specs/plans/AIS-HARNESS-4-closure.md has `## Ticket 3` and `## Ticket 4`). A file is a wave file when,
 * OUTSIDE fenced code blocks, it has two or more heading lines `#`..`######` (up to 3 leading spaces) that start with
 * `Ticket <number>` with different numbers. A single `Ticket 1` heading, a title or a heading that merely contains the word wave
 * ("Wave 0", "Waves", "Wave-based rollout", "Wavelength") is a single-ticket plan. Other multi-ticket shapes cannot be detected.
 */
export function isWaveFile(text) {
  let fence = null;
  const numbers = new Set();
  for (const line of text.split('\n')) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) { if (fence === null) fence = f[1][0]; else if (fence === f[1][0]) fence = null; continue; }
    if (fence !== null) continue;
    const m = /^ {0,3}#{1,6}[ \t]+Ticket[ \t]+(\d+)\b/i.exec(line);
    if (m) numbers.add(Number(m[1]));
  }
  return numbers.size >= 2;
}
const sha256 = (buf) => `sha256:${createHash('sha256').update(buf).digest('hex')}`;

/** The artifact's single RUN-STATE block: exactly one BEGIN and one END, in order; anything else is plan_invalid. */
function artifactBlock(text) {
  const b = text.indexOf(BEGIN), e = text.indexOf(END);
  const once = (m) => text.indexOf(m) === text.lastIndexOf(m);
  if (b < 0 || e < b || !once(BEGIN) || !once(END)) throw refusal('plan_invalid', 'artifact');
  return { b, e };
}

/** A line shown for diagnosis: control, NEL, U+2028/2029, BOM, U+FFFD and backslash escaped as \uXXXX (nothing is trimmed), at most 200 characters INCLUDING the ellipsis. */
export function showLine(l) {
  if (l === undefined) return null;
  const e = l.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff\ufffd\\]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return e.length > LINE_CAP ? `${e.slice(0, LINE_CAP - 3)}...` : e;
}

/** First line (1-based) at which two texts differ, split on LF only (a CR stays part of its line), each side bounded and escaped. */
export function firstDifference(a, b) {
  const x = a.split('\n'), y = b.split('\n');
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if (x[i] !== y[i]) return { line: i + 1, native: showLine(x[i]), artifact: showLine(y[i]) };
  }
  return { line: 0, native: null, artifact: null };
}

/** Pure comparison. Throws a refusal (plan_invalid) or an unsupported error (wave file). */
export function comparePlans(nativeText, artifactText, approved, nativeBytes = Buffer.from(nativeText, 'utf8')) {
  for (const [which, text] of [['native', nativeText], ['artifact', artifactText]]) {
    if (text.charCodeAt(0) === 0xFEFF) throw refusal('plan_bom', which);
    if (text.includes('\r\n')) throw refusal('plan_crlf', which);
  }
  for (const [which, text] of [['native', nativeText], ['artifact', artifactText]]) {
    if (isWaveFile(text)) throw Object.assign(new Error('wave_plan'), { unsupported: true, reason: 'wave_plan', which });
  }
  if (approved !== undefined && !/^sha256:[0-9a-f]{64}$/.test(approved)) throw refusal('approved_malformed', 'approved');
  const { b, e } = artifactBlock(artifactText);
  const narrative_digest = planDigest(artifactText);
  const nativeMarked = nativeText.includes(BEGIN) || nativeText.includes(END);
  let inSync, diff;
  if (nativeMarked) {
    let d;
    try { d = planDigest(nativeText); } catch { throw refusal('plan_invalid', 'native'); }
    const nb = nativeText.indexOf(BEGIN), ne = nativeText.indexOf(END);
    if (nativeText.lastIndexOf(BEGIN) !== nb || nativeText.lastIndexOf(END) !== ne) throw refusal('plan_invalid', 'native');
    inSync = d === narrative_digest;
    if (!inSync) diff = firstDifference(nativeText.slice(0, nb + BEGIN.length) + nativeText.slice(ne), artifactText.slice(0, b + BEGIN.length) + artifactText.slice(e));
  } else {
    const after = artifactText.slice(e + END.length);
    if (after !== '' && after !== '\n') throw refusal('plan_invalid', 'artifact'); // text after END must be empty or exactly one LF
    const before = artifactText.slice(0, b);
    const expected = (before.endsWith('\n') ? before.slice(0, -1) : before) + artifactText.slice(e + END.length);
    inSync = expected === nativeText;
    if (!inSync) diff = firstDifference(nativeText, expected);
  }
  const out = { in_sync: inSync, native_sha256: sha256(nativeBytes), narrative_digest };
  if (!inSync) { out.code = 'plan_sync_stale'; out.first_difference = diff; }
  if (approved !== undefined) out.approved_match = inSync && narrative_digest === approved; // never true for a stale artifact
  return out;
}

function parseArgs(argv) {
  const o = {};
  const [cmd, ...rest] = argv;
  if (cmd !== 'check') throw Object.assign(new Error('the first argument must be the command: check'), { usage: true });
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--native' || a === '--plan' || a === '--approved') {
      const k = a.slice(2);
      if (o[k] !== undefined) throw Object.assign(new Error(`${a} given twice`), { usage: true });
      if (i + 1 >= rest.length) throw Object.assign(new Error(`${a} needs a value`), { usage: true });
      o[k] = rest[i + 1]; i += 1; // the value is taken verbatim, even when it starts with '-'
      continue;
    }
    throw Object.assign(new Error(`unknown argument ${JSON.stringify(a)}`), { usage: true });
  }
  if (!o.native || !o.plan) throw Object.assign(new Error('--native and --plan are both required'), { usage: true });
  return o;
}

export function main(argv, out = process.stdout, err = process.stderr) {
  let o;
  try { o = parseArgs(argv); } catch (e) {
    if (!e.usage) throw e;
    err.write(`plan-sync: ${e.message}\n${USAGE}\n`);
    return 2;
  }
  try {
    const nb = readPlanBytes(o.native, 'native');
    const r = comparePlans(decodePlan(nb, 'native'), readPlan(o.plan, 'artifact'), o.approved, nb);
    out.write(`${JSON.stringify(r)}\n`);
    return r.in_sync ? 0 : 1;
  } catch (e) {
    if (e.unsupported) { out.write(`${JSON.stringify({ in_sync: false, code: 'plan_sync_unsupported', reason: e.reason, which: e.which })}\n`); return 3; }
    if (!e.refused) throw e;
    out.write(`${JSON.stringify({ in_sync: false, code: e.reason, reason: e.reason, which: e.which })}\n`);
    return 2;
  }
}

if (isEntrypoint(import.meta.url)) process.exitCode = main(process.argv.slice(2));
