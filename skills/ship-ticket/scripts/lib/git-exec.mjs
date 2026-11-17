// S-02a0b: the hardened-git execution core. Env composition, typed outcomes, safe serialisation and
// strict decoding. Design: .claude/factory-assessment/consolidation-2026-11/S-02-design.md §2.2 and §3.
// Internal to lib/: S-02a0c builds contexts, handles and the closed OPS table on top of it; only
// `scrubAmbient` is for callers outside lib/. Node 18 compatible, synchronous, no dependency.
//
// `neutralisationPairs` is adapted from DeepSeek Harness 39163dd
// packages/experimental/worktree/src/index.ts:405-428 (`filterOverrides`), and the env recipe from
// worktree/src/process.ts:23-28,156 (`GIT_ENV`, `spawnCommand`) and :352-354 (`gitArgv`).
// Modifications: bytes in (not a string), strict UTF-8 driver names, the pairs merge into the lib's
// one GIT_CONFIG_COUNT instead of returning their own from 0, every GIT_* is scrubbed (not a list),
// and core.hooksPath points at a caller-owned empty dir (not /dev/null). Licence of that material:
//
// MIT License
//
// Copyright (c) 2026 DeepSeek
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { probeGit } from './git-capability.mjs';

const DECODE_CODES = ['git_output_not_utf8', 'path_not_utf8', 'filter_name_not_utf8'];
export const GIT_CODES = Object.freeze(['git_env_too_large', 'git_unavailable', 'git_launch_failed', 'git_timeout', 'git_signal',
  'git_output_truncated', 'git_failed', 'git_stderr', ...DECODE_CODES, 'git_op_invalid']);
// stderr lives in a module-private WeakMap: no property of the error (enumerable, hidden or symbol-keyed)
// carries it, so no inspect option, spread or serialiser can reach it. Stored bytes are capped.
const STDERR = new WeakMap();
export const STDERR_CAP = 64 * 1024;
const OP_ID = /^[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)*$/;

/** A typed git failure. message, stack and toJSON carry {code, op} only; stderr is kept off the object and never printed. */
export class GitError extends Error {
  constructor(code, { op = null, stderr = null } = {}) {
    if (!GIT_CODES.includes(code)) throw new TypeError('GitError: unknown code');
    const id = typeof op === 'string' && op.length <= 64 && OP_ID.test(op) ? op : null;
    super(id ? `${code} (${id})` : code);
    Object.defineProperty(this, 'name', { value: 'GitError', enumerable: false });
    this.code = code;
    this.op = id;
    const bytes = Buffer.isBuffer(stderr) && stderr.length ? stderr : null;
    STDERR.set(this, bytes && Object.freeze({ bytes: Buffer.from(bytes.subarray(0, STDERR_CAP)), total: bytes.length }));
  }
  toJSON() { return { code: this.code, op: this.op }; }
  [Symbol.for('nodejs.util.inspect.custom')]() {
    const n = STDERR.get(this)?.total ?? 0;
    return `GitError [${this.code}]${this.op ? ` op=${this.op}` : ''}${n ? ` {stderr: <redacted ${n} bytes>}` : ''}`;
  }
}
const fail = (code, op, stderr) => new GitError(code, { op, stderr });
const invalid = () => fail('git_op_invalid');
/** Explicit diagnostics only: {bytes (at most STDERR_CAP), total, truncated} of a GitError's stderr, else null. */
export function stderrOf(e) {
  const s = e instanceof GitError ? STDERR.get(e) : null;
  return s ? { bytes: Buffer.from(s.bytes), total: s.total, truncated: s.total > s.bytes.length } : null;
}

// ------------------------------------------------------------------ strict decoding (the lib's only decoder)

const DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
/** Exact UTF-8 or a typed GitError; never a U+FFFD substitute. Bytes only: a string may already be lossy. */
export function decodeStrict(bytes, code = 'git_output_not_utf8') {
  if (!DECODE_CODES.includes(code) || !(bytes instanceof Uint8Array)) throw invalid();
  let s = null;
  try { s = DECODER.decode(bytes); } catch { /* typed below */ }
  if (s === null || !Buffer.from(s).equals(bytes)) throw fail(code);
  return s;
}

/** NUL-separated records as Buffers. Only the trailing terminator is stripped; interior empty records are kept. */
export function zSplit(bytes) {
  if (!(bytes instanceof Uint8Array)) throw invalid();
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  const out = [];
  let at = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0) { out.push(buf.subarray(at, i)); at = i + 1; }
  if (at < buf.length) out.push(buf.subarray(at));
  return out;
}

const HEX = '0123456789abcdef';
/** Display only, never compared: printable ASCII kept, the backslash doubled, every other byte as \xNN. */
export function label(bytes) {
  let s = '';
  for (const b of bytes) s += b === 0x5c ? '\\\\' : b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : `\\x${HEX[b >> 4]}${HEX[b & 15]}`;
  return s;
}

// ------------------------------------------------------------------ environment composition (pure)

export const BASE_ENV = Object.freeze({
  GIT_NO_REPLACE_OBJECTS: '1', GIT_LITERAL_PATHSPECS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never',
  GIT_LFS_SKIP_SMUDGE: '1', GIT_ALLOW_PROTOCOL: 'file', LC_ALL: 'C',
});
/** The only GIT_* keys a policy may set (hermetic config) and the only ones selection may set (§2.3). */
export const POLICY_GIT_KEYS = Object.freeze(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_ATTR_NOSYSTEM']);
export const SELECTION_KEYS = Object.freeze(['GIT_CEILING_DIRECTORIES']);
const HOME_FAMILY = ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'HOMEDRIVE', 'HOMEPATH'];
const COMPOSED = new WeakMap(); // composed env -> the platform it was validated for
const up = (k) => k.toUpperCase();
const isStr = (v) => typeof v === 'string' && !v.includes('\0');
const isKey = (k) => isStr(k) && k.length > 0 && !k.includes('=');
/**
 * Absolute for the TARGET platform. POSIX: `/`-rooted only (`C:\x` and `\x` are relative names there).
 * win32: a drive root (`C:\`, `C:/`) or a UNC/device prefix (`\\srv\share`, `\\?\C:\`); a rooted-relative
 * `\x` or `/x`, and a drive-relative `C:x`, are refused.
 */
const isAbs = (p, platform) => isStr(p) && (platform === 'win32' ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(p) : p.startsWith('/'));
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
/** An own data property's value through its descriptor (never a getter or an inherited value), else undefined. */
const ownValue = (o, k) => { const d = Object.getOwnPropertyDescriptor(o, k); return d && own(d, 'value') ? d.value : undefined; };
const isScrubbed = (k) => up(k).startsWith('GIT_') || up(k) === 'SSH_ASKPASS';

/**
 * A null-prototype copy of the ambient env without any GIT_* or SSH_ASKPASS key (upper-cased match on every
 * OS), and without entries no child can receive (a key with `=` or NUL, a non-string, NUL or accessor
 * value). Values are read through own descriptors, so `__proto__`, `constructor` or a getter cannot inject
 * or hide a value, and Node's `for...in` env copy sees no inherited key. On Windows case-duplicate keys
 * collapse to the lexicographically first, the one Node's child_process passes on (VERIFIED against the
 * Node 22.23.1 child_process source; not re-read for Node 18).
 */
export function scrubAmbient(env, { platform = process.platform } = {}) {
  if (!env || typeof env !== 'object') throw invalid();
  const keys = Object.keys(env).filter((k) => isKey(k) && isStr(ownValue(env, k)) && !isScrubbed(k));
  const keep = new Set(keys);
  if (platform === 'win32') {
    const seen = new Set();
    for (const k of [...keys].sort()) if (seen.has(up(k))) keep.delete(k); else seen.add(up(k));
  }
  const out = Object.create(null);
  for (const k of keys) if (keep.has(k)) out[k] = ownValue(env, k);
  return out;
}

/** The P neutralEnv elements (a890b0d:337-342) as a pure policy; the caller owns and creates the paths. */
export function hermeticPolicy({ home, globalConfig, platform = process.platform } = {}) {
  if (!isAbs(home, platform) || !isAbs(globalConfig, platform)) throw invalid();
  return Object.freeze({
    deletes: Object.freeze([...HOME_FAMILY]),
    set: Object.freeze({ HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1' }),
  });
}

/**
 * Pairs that disable every clean, smudge and process filter for one command without editing config, from
 * the bytes of `git config --null --name-only --get-regexp ^filter\.` (adapted upstream filterOverrides).
 */
export function neutralisationPairs(stdout) {
  const drivers = new Set();
  for (const rec of zSplit(stdout)) {
    const key = decodeStrict(rec, 'filter_name_not_utf8');
    const dot = key.lastIndexOf('.');
    if (key.startsWith('filter.') && dot >= 'filter.'.length && ['clean', 'smudge', 'process', 'required'].includes(key.slice(dot + 1))) {
      drivers.add(key.slice('filter.'.length, dot));
    }
  }
  const pairs = [];
  for (const d of drivers) for (const a of ['clean', 'smudge', 'process', 'required']) pairs.push(Object.freeze([`filter.${d}.${a}`, a === 'required' ? 'false' : '']));
  return Object.freeze(pairs);
}

// A caller pair may not name a BASE pair key (git: the later pair wins; names compare case-insensitively).
const BASE_PAIR_LOWER = ['core.fsmonitor', 'core.hookspath'];
const okPairs = (pairs) => Array.isArray(pairs) && pairs.every((p) => Array.isArray(p) && p.length === 2 && isStr(p[0]) && p[0].length > 0
  && !/[\n\r]/.test(p[0]) && isStr(p[1]) && !BASE_PAIR_LOWER.includes(p[0].toLowerCase()));
// Neutralisation pairs can only DISABLE a filter: `filter.<d>.clean|smudge|process` = '' or `.required` = 'false'.
const okNeutral = (pairs) => okPairs(pairs) && pairs.every(([k, v]) => /^filter\..*\.(?:clean|smudge|process|required)$/.test(k)
  && v === (k.endsWith('.required') ? 'false' : ''));

/**
 * The child env, in the fixed order of design §2.2: (1) scrub, (2) policy deletes, (3) BASE then policy
 * sets, (4) selection, (5) ONE contiguous GIT_CONFIG_* list: BASE pairs, policy pairs, neutralisation pairs.
 * Pure. Nothing the inputs carry can set a GIT_CONFIG index, GIT_CONFIG_PARAMETERS or a BASE key.
 */
export function composeEnv({ ambient, platform = process.platform, gitInfo, hooksDir, policy = {}, selection = {}, neutralisation = [] } = {}) {
  const { deletes = [], set = {}, pairs = [], ...extra } = policy ?? {};
  const baseKeys = new Set(Object.keys(BASE_ENV).map(up));
  // A policy may set a non-git variable, or a GIT_* key from the closed list by its exact spelling.
  const settable = ([k, v]) => isKey(k) && isStr(v) && !baseKeys.has(up(k)) && !isScrubbed(k) || POLICY_GIT_KEYS.includes(k) && isStr(v);
  const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
  if (Object.keys(extra).length || typeof gitInfo?.noLazyFetch !== 'boolean' || !isAbs(hooksDir, platform)
    || !Array.isArray(deletes) || !deletes.every(isKey)
    || !isObj(set) || !Object.entries(set).every(settable)
    || !isObj(selection) || !Object.entries(selection).every(([k, v]) => SELECTION_KEYS.includes(k) && isAbs(v, platform))
    || !okPairs(pairs) || !okNeutral(neutralisation)) throw invalid();
  const env = scrubAmbient(ambient, { platform });
  const drop = (k) => { for (const e of Object.keys(env)) if (up(e) === up(k)) delete env[e]; };
  const put = (k, v) => { drop(k); env[k] = v; };
  for (const k of deletes) drop(k);
  for (const [k, v] of Object.entries(BASE_ENV)) put(k, v);
  if (gitInfo.noLazyFetch) put('GIT_NO_LAZY_FETCH', '1');
  for (const [k, v] of Object.entries(set)) put(k, v);
  for (const [k, v] of Object.entries(selection)) put(k, v);
  const all = [['core.fsmonitor', 'false'], ['core.hooksPath', hooksDir], ...pairs, ...neutralisation];
  all.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${i}`] = k; env[`GIT_CONFIG_VALUE_${i}`] = v; });
  env.GIT_CONFIG_COUNT = `${all.length}`;
  Object.freeze(env);
  COMPOSED.set(env, platform);
  return env;
}

// ------------------------------------------------------------------ process outcome

/** Design §2.2 precedence; the first matching row wins. */
export const OUTCOME_ROWS = Object.freeze(['git_env_too_large', 'git_unavailable', 'git_launch_failed', 'git_timeout', 'git_signal',
  'git_output_truncated', 'git_failed', 'git_stderr', 'decode']);
const ERROR_ROW = { ENOENT: 'git_unavailable', EACCES: 'git_unavailable', ETIMEDOUT: 'git_timeout', ENOBUFS: 'git_output_truncated' };

/**
 * Map the facts of one run to a frozen {outcome, status, stdout} or throw a typed GitError. A spawn error
 * has one code, so rows 2/3/4/6 exclude each other; row 5 is a signal WITHOUT a spawn error, because Node
 * reports SIGKILL alongside its own timeout and maxBuffer kills (measured, Node 18 and 22). Partial stdout
 * is never returned with an error, and a decode failure is never mapped to a status outcome.
 */
export function classify(facts, spec) {
  const { op = null, status: map = { 0: 'ok' }, stderr: mode = 'forbid', decode } = spec;
  const err = (code) => fail(code, op, facts.stderr);
  if (facts.envTooLarge) throw err('git_env_too_large');
  if (facts.error) throw err(Object.prototype.hasOwnProperty.call(ERROR_ROW, facts.error.code) ? ERROR_ROW[facts.error.code] : 'git_launch_failed');
  if (facts.signal) throw err('git_signal');
  if (!Object.prototype.hasOwnProperty.call(map, facts.status)) throw err('git_failed');
  if (mode !== 'allow' && facts.stderr?.length > 0) throw err('git_stderr');
  if (decode) {
    try { return Object.freeze({ outcome: map[facts.status], status: facts.status, stdout: decodeStrict(facts.stdout, decode) }); } catch (e) { throw err(e.code); }
  }
  return Object.freeze({ outcome: map[facts.status], status: facts.status, stdout: facts.stdout });
}

/** Conservative Windows environment-block bound in UTF-16 units (the real limit is UNVERIFIED, design R-A5). */
const WIN_ENV_LIMIT = 32767;
/** UTF-16 units of the block `k=v\0...\0`: own keys and values of a null-prototype env (no inherited reads). */
const envUnits = (env) => Object.keys(env).reduce((n, k) => n + k.length + env[k].length + 2, 1);

/**
 * The ONE spawn site. The binary is the one `probeGit` (S-02a0a) resolved and version-checked in this
 * call: callers of `run` cannot supply an executable (the probe options themselves, PATH/cwd/exclude and
 * a0a's fs seam, still choose what probeGit resolves), and `info` (noLazyFetch, for composeEnv) describes
 * exactly the binary that runs. `platform` is the target platform: it fixes the Windows env bound and must
 * equal the platform the env was composed for. A missing cwd is refused before spawn as git_launch_failed
 * (spawn would report ENOENT, indistinguishable from a missing binary). `run` executes `args` once with an env from composeEnv: `status` maps accepted exit
 * codes to outcome names, `stderr` is 'forbid' (default) or 'allow', `decode` is a decode code or absent
 * (stdout stays a Buffer). Option-free argv building is S-02a0c's (closed OPS).
 */
export function gitRunner({ platform = process.platform, envLimit, ...probeOptions } = {}) {
  if (envLimit !== undefined && !Number.isSafeInteger(envLimit)) throw invalid();
  const gi = probeGit(probeOptions);
  const run = ({ args, cwd, env, op, status = { 0: 'ok' }, stderr = 'forbid', decode, timeoutMs = 60_000, maxBuffer = 64 * 1024 * 1024,
    ...unknown } = {}) => {
    if (Object.keys(unknown).length || !isAbs(cwd, platform) || COMPOSED.get(env) !== platform || !Array.isArray(args) || !args.every(isStr)
      || !status || typeof status !== 'object' || !Object.entries(status).every(([k, v]) => /^\d+$/.test(k) && /^[a-z_]+$/.test(v))
      || !['forbid', 'allow'].includes(stderr) || (decode !== undefined && !DECODE_CODES.includes(decode))
      || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxBuffer) || maxBuffer <= 0) throw invalid();
    const spec = { op, status, stderr, decode };
    if (envUnits(env) > (envLimit ?? (platform === 'win32' ? WIN_ENV_LIMIT : Infinity))) return classify({ envTooLarge: true }, spec);
    let isDir = false;
    try { isDir = statSync(cwd).isDirectory(); } catch { /* refused below */ }
    if (!isDir) return classify({ error: { code: 'ECWD' } }, spec);
    const r = spawnSync(gi.path, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer });
    return classify({ error: r.error ? { code: r.error.code } : null, signal: r.signal, status: r.status, stdout: r.stdout, stderr: r.stderr }, spec);
  };
  return Object.freeze({ info: gi, run });
}
