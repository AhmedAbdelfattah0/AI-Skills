#!/usr/bin/env node
/**
 * plan-sync.mjs (S3b-B1): a READ-ONLY comparison of the approved (native) plan's narrative digest with the repo plan
 * artifact's narrative digest.
 *
 *   node plan-sync.mjs --check --native <native plan file> --artifact <repo plan artifact file>
 *
 * Prints ONE JSON line on stdout: { status: 'in_sync' | 'out_of_sync' | 'refused', native_digest, artifact_digest, reason? }.
 * Exit 0 in_sync, 1 out_of_sync, 2 usage, 3 unreadable or refused (plan_invalid, symlink, not a regular file, oversize, unreadable).
 *
 * The digest is brief.mjs planDigest, the shared canonical implementation (the engine's planNarrativeDigest): sha256 of the raw
 * text with everything strictly between the RUN-STATE markers removed. There is NO line-end or BOM normalisation, so a CRLF
 * file and its LF twin have different digests and report out_of_sync (as in the engine). The RUN-STATE body is excluded, so
 * differing events or attestation lines never change the digest.
 *
 * This tool grants NO authority. It never reads or writes RUN-STATE events, never interprets START or approval, writes no
 * file, opens no network connection and starts no process. A file that is a symlink, not a regular file, or larger than
 * 1 MiB is refused. Files are opened O_RDONLY | O_NOFOLLOW | O_NONBLOCK after an lstat.
 */
import { lstatSync, openSync, fstatSync, readSync, closeSync, constants } from 'node:fs';
import { planDigest } from './brief.mjs';
import { isEntrypoint } from './harness.mjs';

export const MAX_BYTES = 1024 * 1024;
const USAGE = 'usage: plan-sync.mjs --check --native <native plan file> --artifact <repo plan artifact file>';
const refusal = (reason, which) => Object.assign(new Error(reason), { refused: true, reason, which });

/** Read one plan file as utf8 (same decoding as readFileSync 'utf8': no BOM or line-end change). */
export function readPlan(path, which) {
  let l;
  try { l = lstatSync(path); } catch { throw refusal('unreadable', which); }
  if (l.isSymbolicLink()) throw refusal('symlink', which);
  if (!l.isFile()) throw refusal('not_regular', which);
  if (l.size > MAX_BYTES) throw refusal('oversize', which);
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile()) throw refusal('not_regular', which);
    if (st.size > MAX_BYTES) throw refusal('oversize', which);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off).toString('utf8');
  } catch (err) {
    if (err.refused) throw err;
    throw refusal(err.code === 'ELOOP' ? 'symlink' : 'unreadable', which);
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* read-only descriptor */ }
  }
}

function digestOf(text, which) {
  try { return planDigest(text); } catch (err) {
    throw refusal(/^plan_invalid/.test(err.message) ? 'plan_invalid' : 'unreadable', which);
  }
}

/** Pure comparison of two plan texts. Throws a refusal for an invalid plan. */
export function comparePlans(nativeText, artifactText) {
  const native_digest = digestOf(nativeText, 'native');
  const artifact_digest = digestOf(artifactText, 'artifact');
  return { status: native_digest === artifact_digest ? 'in_sync' : 'out_of_sync', native_digest, artifact_digest };
}

function parseArgs(argv) {
  const o = {};
  let check = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--check') { if (check) throw Object.assign(new Error('--check given twice'), { usage: true }); check = true; continue; }
    if (a === '--native' || a === '--artifact') {
      const k = a.slice(2);
      if (o[k] !== undefined) throw Object.assign(new Error(`${a} given twice`), { usage: true });
      if (i + 1 >= argv.length) throw Object.assign(new Error(`${a} needs a value`), { usage: true });
      o[k] = argv[i + 1]; i += 1; // the value is taken verbatim, even when it starts with '-'
      continue;
    }
    throw Object.assign(new Error(`unknown argument ${JSON.stringify(a)}`), { usage: true });
  }
  if (!check) throw Object.assign(new Error('--check is required'), { usage: true });
  if (!o.native || !o.artifact) throw Object.assign(new Error('--native and --artifact are both required'), { usage: true });
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
    const r = comparePlans(readPlan(o.native, 'native'), readPlan(o.artifact, 'artifact'));
    out.write(`${JSON.stringify(r)}\n`);
    return r.status === 'in_sync' ? 0 : 1;
  } catch (e) {
    if (!e.refused) throw e;
    out.write(`${JSON.stringify({ status: 'refused', native_digest: null, artifact_digest: null, reason: e.reason, which: e.which })}\n`);
    return 3;
  }
}

if (isEntrypoint(import.meta.url)) process.exitCode = main(process.argv.slice(2));
