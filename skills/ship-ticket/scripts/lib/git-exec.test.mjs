// S-02a0b tests: node --test skills/ship-ticket/scripts/lib/git-exec.test.mjs
//
// Ported in part from DeepSeek Harness 39163dd: the GIT_ENV selector list
// (packages/experimental/worktree/src/process.ts:23-28) is the hostile-env fixture below, and the
// driver names of worktree/tests/checkout-safety.spec.ts:25 (`some.nested.driver`, `x=y`, `lfs`)
// seed the neutralisation-pair cases. Licence of that material:
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
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inspect } from 'node:util';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as X from './git-exec.mjs';

const {
  BASE_ENV, GIT_CODES, GitError, OUTCOME_ROWS, STDERR_CAP, classify, composeEnv, decodeStrict, hermeticPolicy, label,
  gitRunner, neutralisationPairs, scrubAmbient, stderrOf, zSplit,
} = X;
const here = dirname(fileURLToPath(import.meta.url));
const win = process.platform === 'win32';
const code = (c) => (e) => { assert.ok(e instanceof GitError, `GitError, got ${e}`); assert.equal(e.code, c); return true; };
const B = (...a) => Buffer.from(a.flat());
const S = (s) => Buffer.from(s);
function tmp(t) {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), 'git-exec-')));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
/** An absolute path for the TARGET platform (composeEnv validates against the platform it is given). */
const absFor = (platform, ...parts) => (platform === 'win32' ? `C:\\${parts.join('\\')}` : `/${parts.join('/')}`);
const HOOKS = absFor(process.platform, 'ctx', 'hooks');
const GI = { noLazyFetch: true };
const env0 = (o = {}) => composeEnv({ ambient: {}, gitInfo: GI, hooksDir: HOOKS, ...o });
const NOFAKE = win && 'a fake git is a POSIX shell script; Windows runs the real-git rows';
/** A runner whose probed "git" answers --version and otherwise execs node with the argv (POSIX). */
function fakeRunner(t, binName = 'bin', runnerOpts = {}) {
  const root = tmp(t);
  const bin = join(root, binName); mkdirSync(bin);
  const f = join(bin, 'git');
  writeFileSync(f, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'git version 2.50.0'; exit 0; fi\nexec '${process.execPath}' "$@"\n`);
  chmodSync(f, 0o755);
  const cwd = join(root, 'cwd'); mkdirSync(cwd);
  return { cwd, f, runner: gitRunner({ env: { PATH: bin }, cwd, ...runnerOpts }) };
}

// ------------------------------------------------------------------ module surface

test('the export list is pinned: no lossy or try-decoder can be added unseen', () => {
  assert.deepEqual(Object.keys(X).sort(), [
    'BASE_ENV', 'GIT_CODES', 'GitError', 'OUTCOME_ROWS', 'POLICY_GIT_KEYS', 'SELECTION_KEYS', 'STDERR_CAP',
    'classify', 'composeEnv', 'decodeStrict', 'gitRunner', 'hermeticPolicy', 'label', 'neutralisationPairs',
    'scrubAmbient', 'stderrOf', 'zSplit',
  ]);
});

// ------------------------------------------------------------------ strict decoding (AC4: T4b on the helpers)

test('decodeStrict returns exact UTF-8 and keeps a leading BOM as U+FEFF', () => {
  assert.equal(decodeStrict(S('plain/path.txt')), 'plain/path.txt');
  assert.equal(decodeStrict(S('caf\u00e9/\u{1F600}')), 'caf\u00e9/\u{1F600}');
  assert.equal(decodeStrict(B(0xef, 0xbb, 0xbf, 0x61)), '\uFEFFa', 'BOM is data, not stripped');
  assert.equal(decodeStrict(B(0xef, 0xbf, 0xbd)), '\uFFFD', 'a literal U+FFFD in the input is not a substitution');
  assert.equal(decodeStrict(new Uint8Array([0x61])), 'a');
  assert.equal(decodeStrict(Buffer.alloc(0)), '');
});

test('decodeStrict refuses every invalid sequence with the requested typed code, never U+FFFD', () => {
  const bad = [[0xff], [0xc3], [0x61, 0xc3], [0xc0, 0xaf], [0xe0, 0x80, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0x80], [0x61, 0xfe, 0x62]];
  for (const b of bad) {
    assert.throws(() => decodeStrict(B(b)), code('git_output_not_utf8'), String(b));
    assert.throws(() => decodeStrict(B(b), 'path_not_utf8'), code('path_not_utf8'));
    assert.throws(() => decodeStrict(B(b), 'filter_name_not_utf8'), code('filter_name_not_utf8'));
  }
});

test('decodeStrict takes bytes only and a decode code only', () => {
  for (const v of ['already a string', null, undefined, 42, [0x61]]) assert.throws(() => decodeStrict(v), code('git_op_invalid'));
  assert.throws(() => decodeStrict(S('a'), 'git_failed'), code('git_op_invalid'));
});

test('property: random bytes either round-trip exactly or throw the typed code (no substitution)', () => {
  let seed = 0x5eed;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  let ok = 0, refused = 0;
  for (let i = 0; i < 4000; i++) {
    const n = Math.floor(rnd() * 12);
    const pool = [0x00, 0x2f, 0x41, 0x7f, 0x80, 0xbf, 0xc2, 0xc3, 0xe0, 0xed, 0xef, 0xbb, 0xbd, 0xf0, 0xf4, 0xff];
    const b = Buffer.from(Array.from({ length: n }, () => (rnd() < 0.5 ? pool[Math.floor(rnd() * pool.length)] : Math.floor(rnd() * 256))));
    let s;
    try { s = decodeStrict(b, 'path_not_utf8'); } catch (e) { assert.equal(e.code, 'path_not_utf8'); refused++; continue; }
    ok++;
    assert.ok(Buffer.from(s).equals(b), 'round-trip');
    const fffdIn = b.length < 3 ? 0 : [...b.keys()].filter((k) => b[k] === 0xef && b[k + 1] === 0xbf && b[k + 2] === 0xbd).length;
    assert.equal([...s].filter((c) => c === '\uFFFD').length, fffdIn, 'U+FFFD only where the input held EF BF BD');
  }
  assert.ok(ok > 100 && refused > 100, `both branches exercised (${ok} ok, ${refused} refused)`);
});

test('zSplit returns Buffers, strips only the trailing terminator, and keeps interior empty records', () => {
  const eq = (input, want) => {
    const got = zSplit(input);
    assert.ok(got.every((b) => Buffer.isBuffer(b)));
    assert.deepEqual(got.map((b) => [...b]), want.map((w) => [...Buffer.from(w)]), JSON.stringify(want));
  };
  eq(Buffer.alloc(0), []);
  eq(S('a\0b\0'), ['a', 'b']);
  eq(S('a\0\0b\0'), ['a', '', 'b']);
  eq(S('a\0b'), ['a', 'b']);
  eq(S('\0'), ['']);
  eq(S('\0\0'), ['', '']);
  const raw = zSplit(B(0x66, 0xff, 0x00, 0x67, 0x00));
  assert.deepEqual([...raw[0]], [0x66, 0xff], 'invalid bytes kept as bytes');
  assert.throws(() => zSplit('a\0b'), code('git_op_invalid'));
});

test('label escapes every non-printable or non-ASCII byte and the backslash (display only)', () => {
  assert.equal(label(B(0x61, 0xff, 0x5c, 0x0a, 0xc3, 0xa9)), 'a\\xff\\\\\\x0a\\xc3\\xa9');
  assert.equal(label(S('x\\xff')), 'x\\\\xff', 'a literal "\\xff" stays distinct from the byte 0xff');
});

// ------------------------------------------------------------------ typed errors and safe serialisation (AC3)

test('GitError serialises {code, op} only; stderr is held off the object and redacted everywhere', () => {
  const marker = 'SECRET-https://user:tok3n@example.invalid/';
  const e = new GitError('git_failed', { op: 'blob.read', stderr: S(`fatal: ${marker}\n`) });
  assert.equal(e.message, 'git_failed (blob.read)');
  assert.deepEqual(JSON.parse(JSON.stringify(e)), { code: 'git_failed', op: 'blob.read' });
  assert.deepEqual(Object.keys(e).sort(), ['code', 'op']);
  const seen = [JSON.stringify(e), JSON.stringify({ wrapped: e }), inspect(e), inspect({ deep: { e } }, { depth: 5 }),
    inspect(e, { showHidden: true }), String(e), e.stack, `${e}`, Object.getOwnPropertyNames(e).join(',')];
  seen.push(inspect({ ...e }, { showHidden: true }), JSON.stringify({ ...e }), inspect(Object.assign({}, e)),
    inspect(e, { customInspect: false, showHidden: true, depth: 9 }), inspect({ e }, { customInspect: false, showHidden: true, depth: 9 }));
  // Neither the text nor its bytes: a default inspect of a Buffer prints hex ("74 6f 6b 33 6e" is "tok3n").
  for (const s of seen) assert.ok(!s.includes('tok3n') && !s.includes('74 6f 6b 33 6e') && !s.includes('<Buffer'), `leaked: ${s}`);
  assert.match(inspect(e, { showHidden: true }), /^GitError \[git_failed\] op=blob\.read \{stderr: <redacted \d+ bytes>\}$/);
  assert.deepEqual(Object.getOwnPropertySymbols(e), [], 'no symbol-keyed copy for spread or showHidden to reach');
  assert.ok(stderrOf(e).bytes.includes(marker), 'positive control: the stderr was stored and is reachable explicitly');
  assert.deepEqual([stderrOf(e).total, stderrOf(e).truncated], [Buffer.byteLength(`fatal: ${marker}\n`), false]);
  assert.equal(stderrOf(new Error('x')), null);
  assert.equal(stderrOf(new GitError('git_failed')), null);
});

test('stored stderr is capped at STDERR_CAP bytes, with the total and a truncation flag', () => {
  const big = Buffer.alloc(STDERR_CAP * 3, 0x61);
  const s = stderrOf(new GitError('git_stderr', { stderr: big }));
  assert.deepEqual([s.bytes.length, s.total, s.truncated], [STDERR_CAP, STDERR_CAP * 3, true]);
  assert.equal(STDERR_CAP, 64 * 1024);
  const t = stderrOf(new GitError('git_stderr', { stderr: big.subarray(0, STDERR_CAP) }));
  assert.deepEqual([t.bytes.length, t.truncated], [STDERR_CAP, false], 'exactly at the cap is not truncated');
});

test('GitError refuses unknown codes and records only a closed-shape op id', () => {
  assert.throws(() => new GitError('made_up'), TypeError);
  assert.equal(new GitError('git_failed', { op: 'bad\nop tok3n' }).op, null);
  assert.ok(!inspect(new GitError('git_failed', { op: 'bad\nop tok3n' })).includes('tok3n'));
  assert.equal(new GitError('git_failed').message, 'git_failed');
  assert.ok(GIT_CODES.includes('git_op_invalid') && Object.isFrozen(GIT_CODES));
});

test('a real failing child: stderr, argv and bin path never reach the serialised error', { skip: NOFAKE }, (t) => {
  const marker = 'tok3n-' + 'z'.repeat(8);
  const { cwd, f, runner } = fakeRunner(t, `bin-${marker}`);
  const env = env0();
  let e1;
  try { runner.run({ args: ['-e', `process.stderr.write('${marker}'); process.exit(2)`, marker], cwd, env, op: 'test.fail' }); } catch (e) { e1 = e; }
  assert.ok(e1 instanceof GitError && e1.code === 'git_failed');
  rmSync(f);
  let e2;
  try { runner.run({ args: [marker], cwd, env, op: 'test.fail' }); } catch (e) { e2 = e; }
  assert.ok(e2 instanceof GitError && e2.code === 'git_unavailable', String(e2));
  for (const e of [e1, e2]) {
    for (const s of [JSON.stringify(e), inspect(e, { showHidden: true, depth: 9 }), String(e), e.stack]) assert.ok(!s.includes(marker), s);
    assert.equal(e.cause, undefined, 'the Node spawn error (spawnargs, path) is never attached');
  }
  assert.ok(stderrOf(e1).bytes.includes(marker), 'positive control');
});

// ------------------------------------------------------------------ environment (AC1: T2a; AC5: neutralEnv elements)

// Upstream GIT_ENV (process.ts:23-28) plus the S-02-design §6 T2 additions and mixed-case spellings.
const UPSTREAM_GIT_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  'GIT_CEILING_DIRECTORIES', 'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE', 'GIT_REPLACE_REF_BASE', 'GIT_ATTR_SOURCE'];
const HOSTILE = (() => {
  const h = {};
  for (const k of UPSTREAM_GIT_ENV) h[k] = `HOSTILE-${k}`;
  Object.assign(h, {
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: 'HOSTILE-hooks', GIT_CONFIG_KEY_1: 'HOSTILE.k', GIT_CONFIG_VALUE_1: 'HOSTILE',
    GIT_CONFIG_PARAMETERS: "'core.fsmonitor'='HOSTILE'", GIT_EXEC_PATH: 'HOSTILE-exec', GIT_SSH_COMMAND: 'HOSTILE-ssh', GIT_SSH: 'HOSTILE-ssh', GIT_ASKPASS: 'HOSTILE-ask',
    SSH_ASKPASS: 'HOSTILE-sshask', GIT_EXTERNAL_DIFF: 'HOSTILE-diff', GIT_TRACE: '/HOSTILE-trace', GIT_TRACE2_EVENT: '/HOSTILE-t2', GIT_TRACE_PACKET: '1',
    GIT_NAMESPACE: 'HOSTILE', GIT_PAGER: 'HOSTILE', GIT_EDITOR: 'HOSTILE', GIT_TERMINAL_PROMPT: '1', GIT_OPTIONAL_LOCKS: '1', GIT_NO_REPLACE_OBJECTS: '0',
    GIT_ALLOW_PROTOCOL: 'ext:HOSTILE', GIT_PROTOCOL_FROM_USER: '1', GIT_LFS_SKIP_SMUDGE: '0', GIT_NO_LAZY_FETCH: '0', GIT_CONFIG_GLOBAL: '/HOSTILE.gitconfig',
    GIT_CONFIG_SYSTEM: '/HOSTILE.sys', GIT_CONFIG_NOSYSTEM: '0', GIT_ATTR_NOSYSTEM: '0', GIT_INDEX_VERSION: '4',
    git_dir: 'HOSTILE-lower', Git_Config_Count: '9', gIT_wORK_tREE: 'HOSTILE-mixed', ssh_askpass: 'HOSTILE-lower-ssh',
    HOME: '/HOSTILE-home', XDG_CONFIG_HOME: '/HOSTILE-xdg', USERPROFILE: 'C:\\HOSTILE', HOMEDRIVE: 'H:', HOMEPATH: '\\HOSTILE',
    LC_ALL: 'HOSTILE', PATH: '/usr/bin', KEEP_ME: 'kept',
  });
  return Object.freeze(h);
})();
const isHostile = (v) => /HOSTILE/.test(v);

test('scrubAmbient removes every GIT_* and SSH_ASKPASS case-insensitively and keeps the rest', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const e = scrubAmbient(HOSTILE, { platform });
    assert.deepEqual(Object.keys(e).filter((k) => /^GIT_|^SSH_ASKPASS$/i.test(k)), [], platform);
    assert.equal(e.KEEP_ME, 'kept');
    assert.equal(e.HOME, '/HOSTILE-home', 'non-git variables are not this function’s business');
  }
  const odd = scrubAmbient({ '=C:': 'C:\\x', 'A\0B': 'v', OK: 'a\0b', N: 1, U: undefined, FINE: 'y' }, { platform: 'linux' });
  assert.deepEqual({ ...odd }, { FINE: 'y' }, 'keys with = or NUL, and non-string or NUL values, are dropped');
  const acc = Object.defineProperty({ A: 'a' }, 'GETTER', { get: () => 'x', enumerable: true });
  assert.deepEqual({ ...scrubAmbient(acc, { platform: 'linux' }) }, { A: 'a' }, 'an accessor value is never invoked or kept');
});

test('scrubAmbient on Windows collapses case-duplicates to the lexicographically first key (Node child_process rule)', () => {
  const e = scrubAmbient({ path: 'c', Path: 'b', PATH: 'a', Temp: 't' }, { platform: 'win32' });
  assert.deepEqual({ ...e }, { PATH: 'a', Temp: 't' });
  assert.deepEqual({ ...scrubAmbient({ path: 'c', PATH: 'a' }, { platform: 'linux' }) }, { path: 'c', PATH: 'a' }, 'POSIX names are case-sensitive');
});

test('hostile prototype keys (__proto__, constructor, toString) are own data, never inherited reads or pollution', () => {
  const amb = JSON.parse('{"__proto__":"P","constructor":"C","toString":"T","hasOwnProperty":"H","A":"a"}');
  for (const platform of ['linux', 'win32']) {
    const e = scrubAmbient(amb, { platform });
    assert.equal(Object.getPrototypeOf(e), null, 'null prototype: Node copies the child env with for...in');
    assert.deepEqual(Object.keys(e).sort(), ['A', '__proto__', 'constructor', 'hasOwnProperty', 'toString']);
    assert.equal(e['__proto__'], 'P');
    const env = composeEnv({ ambient: amb, platform, gitInfo: GI, hooksDir: absFor(platform, 'h') });
    assert.equal(Object.getPrototypeOf(env), null);
    assert.equal(env['__proto__'], 'P');
    assert.equal(env.constructor, 'C');
  }
  Object.prototype.GIT_DIR_POLLUTED = 'x';
  try {
    const env = env0();
    assert.equal(env.GIT_DIR_POLLUTED, undefined, 'a polluted Object.prototype key is not visible through the composed env');
  } finally { delete Object.prototype.GIT_DIR_POLLUTED; }
});

const POLICIES = (platform) => ({
  plain: {},
  hermetic: { policy: hermeticPolicy({ platform, home: absFor(platform, 'r', 'home'), globalConfig: absFor(platform, 'r', 'empty.gitconfig') }) },
  hermeticNoRepo: { policy: hermeticPolicy({ platform, home: absFor(platform, 'r', 'home'), globalConfig: absFor(platform, 'r', 'empty.gitconfig') }), selection: { GIT_CEILING_DIRECTORIES: absFor(platform, 'r') } },
  neutralised: { neutralisation: neutralisationPairs(S('filter.lfs.clean\0filter.x=y.smudge\0')) },
});

test('T2a: over the hostile corpus, the env holds only lib-set GIT_* keys, a contiguous COUNT and no hostile value', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const hooks = absFor(platform, 'ctx', 'hooks');
    for (const [name, o] of Object.entries(POLICIES(platform))) {
      for (const noLazyFetch of [true, false]) {
        const env = composeEnv({ ambient: HOSTILE, platform, gitInfo: { noLazyFetch }, hooksDir: hooks, ...o });
        const tag = `${platform}/${name}/${noLazyFetch}`;
        assert.ok(Object.isFrozen(env), tag);
        // Without the hermetic policy the user's HOME family is kept by design (repo-query reads the user view).
        const kept = o.policy ? [] : ['HOME', 'XDG_CONFIG_HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH'];
        for (const [k, v] of Object.entries(env)) if (!kept.includes(k.toUpperCase())) assert.ok(!isHostile(v), `${tag}: ${k}=${v}`);
        if (o.policy) for (const k of ['HOMEDRIVE', 'HOMEPATH']) assert.equal(env[k], undefined, tag);
        const n = Number(env.GIT_CONFIG_COUNT);
        const allowed = new Set([...Object.keys(BASE_ENV), 'GIT_CONFIG_COUNT', ...(noLazyFetch ? ['GIT_NO_LAZY_FETCH'] : []),
          ...Object.keys(o.policy?.set ?? {}), ...Object.keys(o.selection ?? {})]);
        for (let i = 0; i < n; i++) allowed.add(`GIT_CONFIG_KEY_${i}`).add(`GIT_CONFIG_VALUE_${i}`);
        const gitKeys = Object.keys(env).filter((k) => /^GIT_/i.test(k));
        assert.deepEqual(gitKeys.filter((k) => !allowed.has(k)), [], tag);
        assert.deepEqual([...allowed].filter((k) => !(k in env)), [], `${tag}: every expected key present`);
        assert.equal(String(n), env.GIT_CONFIG_COUNT);
        assert.equal(env.GIT_CONFIG_KEY_0, 'core.fsmonitor');
        assert.equal(env.GIT_CONFIG_VALUE_0, 'false');
        assert.equal(env.GIT_CONFIG_KEY_1, 'core.hooksPath');
        assert.equal(env.GIT_CONFIG_VALUE_1, hooks);
        assert.equal(n, 2 + (name === 'neutralised' ? 8 : 0), tag);
        assert.ok(!Object.keys(env).some((k) => /^SSH_ASKPASS$/i.test(k)), tag);
        for (const [k, v] of Object.entries(BASE_ENV)) assert.equal(env[k], v, `${tag}: ${k}`);
        assert.equal(env.GIT_NO_LAZY_FETCH, noLazyFetch ? '1' : undefined, tag);
        assert.equal(env.KEEP_ME, 'kept');
        if (platform === 'win32') assert.deepEqual(Object.keys(env).filter((k) => k.toUpperCase() === 'LC_ALL'), ['LC_ALL']);
      }
    }
  }
});

test('BASE is the design §2.2 list exactly', () => {
  assert.deepEqual({ ...BASE_ENV }, {
    GIT_NO_REPLACE_OBJECTS: '1', GIT_LITERAL_PATHSPECS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never',
    GIT_LFS_SKIP_SMUDGE: '1', GIT_ALLOW_PROTOCOL: 'file', LC_ALL: 'C',
  });
  assert.ok(Object.isFrozen(BASE_ENV));
});

test('pair order is BASE, policy, neutralisation, serialised once with contiguous indices', () => {
  const env = env0({ policy: { pairs: [['diff.external', '']] }, neutralisation: neutralisationPairs(S('filter.a.clean\0')) });
  const n = Number(env.GIT_CONFIG_COUNT);
  const pairs = Array.from({ length: n }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]);
  assert.deepEqual(pairs, [['core.fsmonitor', 'false'], ['core.hooksPath', HOOKS], ['diff.external', ''],
    ['filter.a.clean', ''], ['filter.a.smudge', ''], ['filter.a.process', ''], ['filter.a.required', 'false']]);
  assert.equal(env[`GIT_CONFIG_KEY_${n}`], undefined);
});

test('AC5: hermeticPolicy carries every element of P neutralEnv (a890b0d:337-342)', () => {
  const home = 'C:\\c\\home';
  const cfg = 'C:\\c\\empty.gitconfig';
  const env = env0({ ambient: HOSTILE, platform: 'win32', hooksDir: 'C:\\h', policy: hermeticPolicy({ platform: 'win32', home, globalConfig: cfg }), selection: { GIT_CEILING_DIRECTORIES: 'C:\\c' } });
  // neutralEnv: HOME/USERPROFILE/XDG_CONFIG_HOME=tmp, GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_GLOBAL=empty file,
  // GIT_CEILING_DIRECTORIES (no-repo ops, set through the selection step), GIT_ATTR_NOSYSTEM=1, LC_ALL=C.
  for (const [k, v] of Object.entries({ HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: cfg,
    GIT_CEILING_DIRECTORIES: 'C:\\c', GIT_ATTR_NOSYSTEM: '1', LC_ALL: 'C' })) assert.equal(env[k], v, k);
  for (const k of ['HOMEDRIVE', 'HOMEPATH']) assert.equal(env[k], undefined, `${k} deleted (Windows HOME fallback)`);
  assert.throws(() => hermeticPolicy({ platform: 'win32', home: 'rel', globalConfig: cfg }), code('git_op_invalid'));
  assert.throws(() => hermeticPolicy({ platform: 'win32', home, globalConfig: undefined }), code('git_op_invalid'));
  assert.throws(() => hermeticPolicy({ platform: 'linux', home, globalConfig: cfg }), code('git_op_invalid'), 'C:\\ is a relative name on POSIX');
});

test('on Windows a set replaces every case-variant spelling (HOME vs Home)', () => {
  const env = env0({ ambient: { Home: '/HOSTILE', Lc_All: 'x', Path: 'p' }, platform: 'win32', hooksDir: 'C:\\k', policy: hermeticPolicy({ platform: 'win32', home: 'C:\\h', globalConfig: 'C:\\g' }) });
  assert.deepEqual(Object.keys(env).filter((k) => k.toUpperCase() === 'HOME'), ['HOME']);
  assert.deepEqual(Object.keys(env).filter((k) => k.toUpperCase() === 'LC_ALL'), ['LC_ALL']);
  assert.equal(env.Path, 'p');
});

test('composeEnv refuses inputs that could reach a GIT_CONFIG index, a BASE key or an untyped spawn throw', () => {
  const bad = [
    { policy: { set: { GIT_CONFIG_COUNT: '0' } } }, { policy: { set: { git_config_key_0: 'x' } } }, { policy: { set: { GIT_DIR: '/x' } } },
    { policy: { set: { GIT_TERMINAL_PROMPT: '1' } } }, { policy: { set: { lc_all: 'fr' } } }, { policy: { set: { GIT_CONFIG_PARAMETERS: 'x' } } },
    { policy: { set: { 'A=B': 'x' } } }, { policy: { set: { A: 'x\0y' } } }, { policy: { set: { A: 1 } } }, { policy: { deletes: ['A\0'] } },
    { policy: { pairs: [['a.b', 'x\0']] } }, { policy: { pairs: [['', 'x']] } }, { policy: { pairs: [['a.b\nc', 'x']] } }, { policy: { pairs: [['a.b']] } }, { policy: { pairs: [['Core.HooksPath', '/x']] } }, { neutralisation: [['core.fsmonitor', 'true']] },
    { policy: { extra: 1 } }, { selection: { GIT_DIR: '/x' } }, { selection: { GIT_CEILING_DIRECTORIES: 'a\0' } }, { selection: { HOME: '/x' } },
    { neutralisation: [['filter.a.clean', '\0']] }, { hooksDir: 'relative/hooks' }, { hooksDir: undefined }, { gitInfo: undefined },
    { gitInfo: { noLazyFetch: 'yes' } }, { ambient: null }, { selection: { GIT_CEILING_DIRECTORIES: 'rel' } },
    // Neutralisation pairs may only disable a filter.
    { neutralisation: [['filter.x.smudge', 'sh -c evil']] }, { neutralisation: [['alias.x', '!evil']] }, { neutralisation: [['filter.x.required', 'true']] },
    { neutralisation: [['filter.x.clean', 'false']] }, { neutralisation: [['filter.x.textconv', '']] },
  ];
  for (const o of bad) assert.throws(() => env0(o), code('git_op_invalid'), JSON.stringify(o));
});

test('absolute paths are judged for the TARGET platform (hooksDir, ceiling, hermetic paths)', () => {
  const ok = (platform, p) => composeEnv({ ambient: {}, platform, gitInfo: GI, hooksDir: p });
  const no = (platform, p) => assert.throws(() => ok(platform, p), code('git_op_invalid'), `${platform}: ${JSON.stringify(p)}`);
  for (const platform of ['linux', 'darwin']) {
    ok(platform, '/ctx/hooks');
    for (const p of ['C:\\ctx\\hooks', 'C:/ctx/hooks', '\\ctx\\hooks', '\\\\srv\\share\\h', 'ctx/hooks', '', 'C:h']) no(platform, p);
  }
  for (const p of ['C:\\ctx\\hooks', 'c:/ctx/hooks', '\\\\srv\\share\\h', '//srv/share/h', '\\\\?\\C:\\h']) ok('win32', p);
  for (const p of ['\\ctx\\hooks', '/ctx/hooks', 'C:ctx', 'ctx\\hooks', '\\\\srv', '']) no('win32', p);
  assert.throws(() => composeEnv({ ambient: {}, platform: 'linux', gitInfo: GI, hooksDir: '/h', selection: { GIT_CEILING_DIRECTORIES: 'C:\\c' } }), code('git_op_invalid'));
});

test('real git: hostile ambient COUNT/KEY_0/PARAMETERS lose to the lib pairs; HOME/XDG plants are ignored when hermetic', (t) => {
  const g = gitRunner();
  const gi = g.info;
  const d = tmp(t);
  const cwd = join(d, 'cwd'); mkdirSync(cwd);
  const plantHome = join(d, 'planted'); mkdirSync(join(plantHome, 'xdg', 'git'), { recursive: true });
  writeFileSync(join(plantHome, '.gitconfig'), '[user]\n\tname = PLANTED-HOME\n');
  writeFileSync(join(plantHome, 'xdg', 'git', 'config'), '[user]\n\temail = PLANTED-XDG\n');
  const home = join(d, 'home'); mkdirSync(home);
  const cfg = join(d, 'empty.gitconfig'); writeFileSync(cfg, '');
  const ambient = { ...process.env, ...HOSTILE, PATH: process.env.PATH, HOME: plantHome, USERPROFILE: plantHome, XDG_CONFIG_HOME: join(plantHome, 'xdg'),
    GIT_CONFIG_PARAMETERS: "'user.name'='HOSTILE-PARAM'" };
  for (const k of ['HOMEDRIVE', 'HOMEPATH']) delete ambient[k];
  const get = (env, key) => g.run({ args: ['config', '--get', key], cwd, env, op: 'test.config', status: { 0: 'ok', 1: 'absent' }, decode: 'git_output_not_utf8' });
  const sel = { GIT_CEILING_DIRECTORIES: d };
  const plain = composeEnv({ ambient, gitInfo: gi, hooksDir: join(d, 'hooks'), selection: sel });
  assert.deepEqual(get(plain, 'core.hooksPath'), { outcome: 'ok', status: 0, stdout: `${join(d, 'hooks')}\n` });
  assert.equal(get(plain, 'core.fsmonitor').stdout, 'false\n');
  assert.equal(get(plain, 'hostile.k').outcome, 'absent', 'ambient KEY_1 beyond our COUNT is gone');
  assert.equal(get(plain, 'user.name').stdout, 'PLANTED-HOME\n', 'positive control: the HOME plant is live without the hermetic policy');
  assert.equal(get(plain, 'user.email').stdout, 'PLANTED-XDG\n', 'positive control: the XDG plant is live');
  const herm = composeEnv({ ambient, gitInfo: gi, hooksDir: join(d, 'hooks'), selection: sel, policy: hermeticPolicy({ home, globalConfig: cfg }) });
  assert.equal(get(herm, 'user.name').outcome, 'absent');
  assert.equal(get(herm, 'user.email').outcome, 'absent');
  assert.equal(get(herm, 'core.hooksPath').stdout, `${join(d, 'hooks')}\n`);
});

// ------------------------------------------------------------------ neutralisation pairs (adapted upstream filterOverrides)

test('neutralisationPairs: upstream driver names, four pairs each, discovery order, deduplicated', () => {
  const out = S('filter.some.nested.driver.clean\0filter.x=y.smudge\0filter.lfs.required\0filter.lfs.process\0filter.a.foo\0filter.clean\0');
  const pairs = neutralisationPairs(out);
  const drivers = ['some.nested.driver', 'x=y', 'lfs'];
  assert.deepEqual(pairs, drivers.flatMap((d) => [[`filter.${d}.clean`, ''], [`filter.${d}.smudge`, ''], [`filter.${d}.process`, ''], [`filter.${d}.required`, 'false']]));
  assert.ok(Object.isFrozen(pairs));
  assert.deepEqual(neutralisationPairs(Buffer.alloc(0)), []);
  assert.deepEqual(neutralisationPairs(S('filter..clean\0')).map(([k]) => k)[0], 'filter..clean', 'an empty driver name is neutralised too (fail closed)');
});

test('neutralisationPairs: EACH attribute alone discovers its driver (process-only, required-only, clean-only, smudge-only)', () => {
  const four = (d) => [[`filter.${d}.clean`, ''], [`filter.${d}.smudge`, ''], [`filter.${d}.process`, ''], [`filter.${d}.required`, 'false']];
  for (const a of ['clean', 'smudge', 'process', 'required']) assert.deepEqual(neutralisationPairs(S(`filter.only.${a}\0`)), four('only'), a);
  for (const combo of [['process', 'required'], ['clean', 'process'], ['smudge', 'required'], ['clean', 'smudge', 'process', 'required']]) {
    assert.deepEqual(neutralisationPairs(S(combo.map((a) => `filter.c.${a}\0`).join(''))), four('c'), combo.join('+'));
  }
  for (const a of ['textconv', 'foo', 'cleaner', 'Process']) assert.deepEqual(neutralisationPairs(S(`filter.n.${a}\0`)), [], `${a}: not a filter attribute`);
});

test('neutralisationPairs refuses a non-UTF-8 driver name and takes bytes only', () => {
  assert.throws(() => neutralisationPairs(B([...S('filter.'), 0xff, ...S('.clean'), 0])), code('filter_name_not_utf8'));
  assert.throws(() => neutralisationPairs('filter.a.clean\0'), code('git_op_invalid'));
});

test('real git: neutralisation pairs override a required smudge driver in repo config without editing it', (t) => {
  const g = gitRunner();
  const gi = g.info;
  const d = tmp(t);
  const repo = join(d, 'repo');
  const env = composeEnv({ ambient: process.env, gitInfo: gi, hooksDir: join(d, 'hooks'), neutralisation: neutralisationPairs(S('filter.evil.smudge\0filter.evil.required\0')) });
  const run = (args, o = {}) => g.run({ args, cwd: d, env, op: 'test.config', status: { 0: 'ok', 1: 'absent' }, decode: 'git_output_not_utf8', ...o });
  run(['init', '-q', repo], { stderr: 'allow' });
  const cfg = join(repo, '.git', 'config');
  writeFileSync(cfg, readFileSync(cfg, 'latin1') + '[filter "evil"]\n\tsmudge = HOSTILE-smudge\n\trequired = true\n', 'latin1');
  const get = (key, file) => run(['--git-dir', join(repo, '.git'), 'config', ...(file ? ['--file', cfg] : []), '--get', key]);
  assert.equal(get('filter.evil.required', true).stdout, 'true\n', 'control: the repo config itself is untouched and live');
  assert.equal(get('filter.evil.required').stdout, 'false\n', 'the GIT_CONFIG_* pairs win over repo-level config');
  assert.equal(get('filter.evil.smudge').stdout, '\n');
});

test('real git: a process-only driver is discovered and neutralised (the discovery output comes from git itself)', (t) => {
  const g = gitRunner();
  const d = tmp(t);
  const repo = join(d, 'repo');
  const plain = composeEnv({ ambient: process.env, gitInfo: g.info, hooksDir: join(d, 'hooks') });
  const run = (env, args, o = {}) => g.run({ args, cwd: d, env, op: 'test.config', status: { 0: 'ok', 1: 'absent' }, ...o });
  run(plain, ['init', '-q', repo], { stderr: 'allow' });
  const gd = ['--git-dir', join(repo, '.git')];
  run(plain, [...gd, 'config', 'filter.ponly.process', 'HOSTILE-process']);
  // Discover through the same channel a0c will use; drop drivers inherited from the user's config (lfs, ...).
  const found = run(plain, [...gd, 'config', '--local', '--null', '--name-only', '--get-regexp', '^filter\\.']).stdout;
  const pairs = neutralisationPairs(found);
  assert.deepEqual(pairs.map(([k]) => k), ['filter.ponly.clean', 'filter.ponly.smudge', 'filter.ponly.process', 'filter.ponly.required']);
  const env = composeEnv({ ambient: process.env, gitInfo: g.info, hooksDir: join(d, 'hooks'), neutralisation: pairs });
  assert.equal(decodeStrict(run(plain, [...gd, 'config', '--get', 'filter.ponly.process']).stdout), 'HOSTILE-process\n', 'control: live without pairs');
  assert.equal(decodeStrict(run(env, [...gd, 'config', '--get', 'filter.ponly.process']).stdout), '\n', 'neutralised with pairs');
});

// ------------------------------------------------------------------ outcomes (AC2)

// The design §2.2 table, written independently of the module as the oracle. Row 5 is "a signal with no
// spawn error": Node reports SIGKILL alongside its own timeout and maxBuffer kills (measured on Node 18
// and 22), so a literal "any signal" row would make rows 4 and 6 unreachable.
const SPEC = [
  ['git_env_too_large', (f) => f.envTooLarge],
  ['git_unavailable', (f) => ['ENOENT', 'EACCES'].includes(f.error?.code)],
  ['git_launch_failed', (f) => !!f.error && !['ENOENT', 'EACCES', 'ETIMEDOUT', 'ENOBUFS'].includes(f.error.code)],
  ['git_timeout', (f) => f.error?.code === 'ETIMEDOUT'],
  ['git_signal', (f) => !f.error && !!f.signal],
  ['git_output_truncated', (f) => f.error?.code === 'ENOBUFS'],
  ['git_failed', (f, s) => !(f.status in s.status)],
  ['git_stderr', (f, s) => s.stderr !== 'allow' && f.stderr.length > 0],
  ['DECODE', (f, s) => !!s.decode && !f.validUtf8],
];

test('the module precedence rows equal the design table order', () => {
  assert.deepEqual([...OUTCOME_ROWS], ['git_env_too_large', 'git_unavailable', 'git_launch_failed', 'git_timeout', 'git_signal',
    'git_output_truncated', 'git_failed', 'git_stderr', 'decode']);
});

test('every outcome code is reachable and exactly one fires, in precedence order, over the full fact cross-product', () => {
  const errors = [null, 'ENOENT', 'EACCES', 'E2BIG', 'ENAMETOOLONG', 'ETIMEDOUT', 'ENOBUFS'];
  const fired = new Set();
  let n = 0;
  for (const envTooLarge of [false, true]) for (const err of errors) for (const signal of [null, 'SIGKILL'])
    for (const status of [null, 0, 1, 2]) for (const stderr of ['', 'warn']) for (const validUtf8 of [true, false])
      for (const decode of [undefined, 'git_output_not_utf8', 'path_not_utf8']) for (const stderrMode of ['forbid', 'allow']) {
        const facts = { envTooLarge, error: err && { code: err, path: '/secret', spawnargs: ['x'] }, signal, status, stderr: S(stderr), stdout: validUtf8 ? S('ok\n') : B(0xff) };
        const spec = { status: { 0: 'ok', 1: 'absent' }, stderr: stderrMode, decode, op: 'x.y' };
        const row = SPEC.find(([, p]) => p({ ...facts, validUtf8 }, spec));
        const want = row ? (row[0] === 'DECODE' ? decode : row[0]) : null;
        let got;
        try { const r = classify(facts, spec); got = null; assert.equal(r.outcome, spec.status[status]); assert.equal(typeof r.stdout, decode ? 'string' : 'object'); } catch (e) {
          assert.ok(e instanceof GitError, String(e)); got = e.code; assert.equal(e.op, 'x.y');
        }
        assert.equal(got, want, JSON.stringify({ envTooLarge, err, signal, status, stderr, validUtf8, decode, stderrMode }));
        if (got) fired.add(got);
        n++;
      }
  assert.deepEqual([...fired].sort(), ['git_env_too_large', 'git_failed', 'git_launch_failed', 'git_output_not_utf8', 'git_output_truncated',
    'git_signal', 'git_stderr', 'git_timeout', 'git_unavailable', 'path_not_utf8']);
  assert.equal(n, 2 * 7 * 2 * 4 * 2 * 2 * 3 * 2, "every combination visited");
});

test('a decode failure is never reinterpreted as a mapped outcome (absent, ok)', () => {
  for (const status of [0, 1]) {
    assert.throws(() => classify({ status, signal: null, stderr: Buffer.alloc(0), stdout: B(0x61, 0xff) },
      { status: { 0: 'ok', 1: 'absent' }, decode: 'path_not_utf8' }), code('path_not_utf8'));
  }
});

// Real children through a probed fake git that execs node (POSIX). Outcomes are deterministic: the
// timeout child never exits, the overflow child always overflows. Windows covers the spawn path through
// the real-git rows above and the refusal rows below.
const node = (script, o = {}) => (t) => {
  const { cwd, runner } = fakeRunner(t);
  return runner.run({ args: ['-e', script], cwd, env: env0(), op: 'test.child', ...o });
};
const childRed = (c, script, o) => (t) => assert.throws(() => node(script, o)(t), code(c));

test('real child: ok returns the stdout Buffer and the mapped outcome', { skip: NOFAKE }, (t) => {
  const r = node('process.stdout.write(Buffer.from([0x61,0xff]))')(t);
  assert.deepEqual([r.outcome, r.status, [...r.stdout]], ['ok', 0, [0x61, 0xff]]);
  assert.equal(node('process.exit(1)', { status: { 0: 'ok', 1: 'absent' } })(t).outcome, 'absent');
  assert.equal(node('process.stderr.write("w")', { stderr: 'allow' })(t).outcome, 'ok');
  assert.equal(node('process.stdout.write("caf\u00e9")', { decode: 'git_output_not_utf8' })(t).stdout, 'caf\u00e9');
});
test('real child: git_failed', { skip: NOFAKE }, childRed('git_failed', 'process.exit(3)'));
test('real child: git_stderr', { skip: NOFAKE }, childRed('git_stderr', 'process.stderr.write("warning: x")'));
test('real child: git_output_not_utf8', { skip: NOFAKE }, childRed('git_output_not_utf8', 'process.stdout.write(Buffer.from([0xff]))', { decode: 'git_output_not_utf8' }));
test('real child: path_not_utf8', { skip: NOFAKE }, childRed('path_not_utf8', 'process.stdout.write(Buffer.from([0x61,0xc3]))', { decode: 'path_not_utf8' }));
test('real child: git_output_truncated (partial stdout never returned)', { skip: NOFAKE }, childRed('git_output_truncated', 'process.stdout.write("x".repeat(1<<20))', { maxBuffer: 1024 }));
test('real child: git_timeout', { skip: NOFAKE }, childRed('git_timeout', 'setInterval(()=>{},1e6)', { timeoutMs: 300 }));
test('real child: a SIGTERM-ignoring child cannot hold the runner past its timeout (external watchdog)', { skip: NOFAKE }, (t) => {
  const { cwd, f } = fakeRunner(t);
  const ready = join(cwd, 'ready');
  // Trap FIRST, then publish readiness (its PID). Only SIGKILL ends it: a SIGTERM regression hangs the
  // inner runner and the outer watchdog fails the test; a child slower than the timeout fails red, never green.
  const child = `process.on('SIGTERM',()=>{});require('fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1e6)`;
  t.after(() => { try { process.kill(Number(readFileSync(ready, 'latin1')), 'SIGKILL'); } catch { /* already gone */ } });
  const script = `import { gitRunner, composeEnv } from ${JSON.stringify(new URL('./git-exec.mjs', import.meta.url).href)};
const r = gitRunner({ env: { PATH: ${JSON.stringify(dirname(f))} }, cwd: ${JSON.stringify(cwd)} });
const env = composeEnv({ ambient: {}, gitInfo: r.info, hooksDir: '/h' });
try { r.run({ args: ['-e', ${JSON.stringify(child)}], cwd: ${JSON.stringify(cwd)}, env, timeoutMs: 5000 }); console.log('no-error'); } catch (e) { console.log(e.code); }`;
  // The inner 5 s timeout is a failure bound for a slow start (red, never green); the outer 30 s watchdog
  // only catches a SIGTERM regression.
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'latin1', timeout: 30_000, killSignal: 'SIGKILL' });
  assert.ok(existsSync(ready), 'readiness: the TERM trap was installed before the runner killed the child');
  assert.equal(out.signal, null, 'the outer watchdog did not have to kill the runner');
  assert.equal(out.stdout.trim(), 'git_timeout');
});
test('real child: git_signal', { skip: NOFAKE }, childRed('git_signal', 'process.kill(process.pid,"SIGKILL")'));
test('real child: git_unavailable (the probed binary vanished)', { skip: NOFAKE }, (t) => {
  const { cwd, f, runner } = fakeRunner(t);
  rmSync(f);
  assert.throws(() => runner.run({ args: [], cwd, env: env0(), op: 'test.child' }), code('git_unavailable'));
});
test('real child: git_launch_failed (E2BIG)', { skip: NOFAKE }, (t) => {
  const { cwd, runner } = fakeRunner(t);
  assert.throws(() => runner.run({ args: ['-e', '0', 'x'.repeat(4 << 20)], cwd, env: env0(), op: 'test.child' }), code('git_launch_failed'));
});
test('git_env_too_large is decided before any fs check or spawn; a __proto__ key cannot shrink the size', (t) => {
  const w = gitRunner({ platform: 'win32' });
  const wenv = (ambient) => composeEnv({ ambient, platform: 'win32', gitInfo: w.info, hooksDir: 'C:\\h' });
  const cwd = 'C:\\git-exec-no-such-dir-0d1e';
  const big = 'x'.repeat(40000);
  assert.throws(() => w.run({ args: ['--version'], cwd, env: wenv({ BIG: big }), op: 'test.child' }), code('git_env_too_large'));
  for (const k of ['__proto__', 'constructor', 'toString']) {
    assert.throws(() => w.run({ args: ['--version'], cwd, env: wenv(JSON.parse(`{${JSON.stringify(k)}:${JSON.stringify(big)}}`)), op: 'test.child' }), code('git_env_too_large'), k);
  }
  // Control: a small env passes the bound and then meets the missing cwd (refused, nothing spawned).
  assert.throws(() => w.run({ args: ['--version'], cwd, env: wenv({}), op: 'test.child' }), code('git_launch_failed'));
});
test('real child: the POSIX default applies no Windows bound', { skip: NOFAKE }, (t) => {
  const { cwd, runner } = fakeRunner(t);
  const mark = join(cwd, 'ran');
  runner.run({ args: ['-e', `require('fs').writeFileSync(${JSON.stringify(mark)},'')`], cwd, env: env0({ ambient: { BIG: 'x'.repeat(40000) } }), op: 'test.child' });
  assert.equal(existsSync(mark), true);
});
test('the env bound counts the exact block size: k=v NUL per entry plus the final NUL', (t) => {
  const g = gitRunner();
  const cwd = tmp(t);
  const env = env0({ ambient: process.env, gitInfo: g.info });
  const units = 1 + Object.keys(env).reduce((n, k) => n + k.length + 1 + env[k].length + 1, 0);
  const run = (envLimit) => gitRunner({ envLimit }).run({ args: ['--version'], cwd, env, op: 'test.child' });
  let r;
  assert.doesNotThrow(() => { r = run(units); }, 'at the limit: allowed');
  assert.equal(r.outcome, 'ok');
  assert.throws(() => run(units - 1), code('git_env_too_large'), 'one unit over: refused');
});
test('a missing cwd is refused before spawn as git_launch_failed, not reported as a missing git', (t) => {
  const g = gitRunner();
  const cwd = join(tmp(t), 'gone');
  assert.throws(() => g.run({ args: ['--version'], cwd, env: env0({ ambient: process.env, gitInfo: g.info }), op: 'test.child' }), code('git_launch_failed'));
});

test('the runner spawns only the probed binary, and refuses an env composeEnv did not build or a malformed spec', (t) => {
  const g = gitRunner();
  assert.ok(Object.isFrozen(g) && Object.isFrozen(g.info));
  const cwd = tmp(t);
  const ok = { args: ['--version'], cwd, env: env0({ ambient: process.env, gitInfo: g.info }), op: 'test.child' };
  assert.match(decodeStrict(g.run(ok).stdout), /^git version /);
  const other = process.platform === 'win32' ? 'linux' : 'win32';
  const bad = [{ env: { ...ok.env } }, { env: process.env }, { env: composeEnv({ ambient: {}, platform: other, gitInfo: g.info, hooksDir: absFor(other, 'h') }) }, { cwd: 'rel' }, { args: ['a\0b'] }, { args: 'x' }, { args: { encoding: 'utf8' } }, { bin: '/bin/sh' }, { spawn: () => ({}) }, { shell: true },
    { status: { 0: 'OK!' } }, { stderr: 'sometimes' }, { decode: 'git_failed' }, { timeoutMs: 0 }, { maxBuffer: -1 }, { envLimit: 10 }, { platform: 'win32' }];
  for (const o of bad) assert.throws(() => g.run({ ...ok, ...o }), code('git_op_invalid'), JSON.stringify(Object.keys(o)));
  assert.throws(() => gitRunner({ envLimit: 'x' }), code('git_op_invalid'));
  assert.throws(() => gitRunner({ envLimit: 10 }).run(ok), code('git_env_too_large'), 'the bound is fixed at construction, not per call');
});

test('classify reads only own data: an inherited error code is not a row, and a status getter is never invoked', () => {
  const facts = { signal: null, stderr: Buffer.alloc(0), stdout: Buffer.from('x') };
  for (const c of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) assert.throws(() => classify({ ...facts, error: { code: c } }, {}), code('git_launch_failed'), c);
  let called = 0;
  const status = Object.defineProperty({}, '0', { get() { called++; return 'ok'; }, enumerable: true });
  assert.equal(classify({ ...facts, error: null, status: 0 }, { status }).outcome, undefined);
  assert.equal(called, 0, 'the getter is not run');
});

test('classify reads the spawn error code as own data, once: an inherited or accessor code is not a row', () => {
  const facts = { signal: null, stderr: Buffer.alloc(0), stdout: Buffer.from('x') };
  assert.throws(() => classify({ ...facts, error: Object.create({ code: 'ENOENT' }) }, {}), code('git_launch_failed'), 'inherited .code');
  let reads = 0;
  const error = Object.defineProperty({}, 'code', { get() { reads++; return 'ENOENT'; }, enumerable: true });
  assert.throws(() => classify({ ...facts, error }, {}), code('git_launch_failed'), 'accessor .code');
  assert.equal(reads, 0, 'the accessor is never run');
  for (const [c, row] of [['ENOENT', 'git_unavailable'], ['EACCES', 'git_unavailable'], ['ETIMEDOUT', 'git_timeout'], ['ENOBUFS', 'git_output_truncated'], ['E2BIG', 'git_launch_failed']]) {
    assert.throws(() => classify({ ...facts, error: { code: c } }, {}), code(row), c);
  }
});

test('run() normalises the status map before spawn: an accessor entry is refused unrun; inherited and non-enumerable entries are never outcomes', (t) => {
  const g = gitRunner();
  const cwd = tmp(t);
  const ok = { args: ['--version'], cwd, env: env0({ ambient: process.env, gitInfo: g.info }), op: 'test.child' };
  let calls = 0;
  const accessor = Object.defineProperty({}, '0', { get() { calls++; return 'ok'; }, enumerable: true });
  assert.throws(() => g.run({ ...ok, status: accessor }), code('git_op_invalid'), 'an accessor entry is refused');
  assert.equal(calls, 0, 'and its getter is never run');
  assert.throws(() => g.run({ ...ok, status: Object.defineProperty({ 1: 'other' }, '0', { value: 'ok', enumerable: false }) }), code('git_failed'), 'non-enumerable own entry');
  assert.throws(() => g.run({ ...ok, status: Object.create({ 0: 'ok' }) }), code('git_failed'), 'inherited entry');
  for (const bad of [{ 0: 1 }, { 0: undefined }, { x: 'ok' }, null, 'ok']) assert.throws(() => g.run({ ...ok, status: bad }), code('git_op_invalid'), JSON.stringify(bad));
  const r = g.run({ ...ok, status: { 0: 'ok', 1: 'other' } });
  assert.deepEqual([r.outcome, r.status, Object.isFrozen(r)], ['ok', 0, true]);
});

// ------------------------------------------------------------------ T4a: decode-site check on the AST (AC4)

// DECISION (round 6; reviews r1-r5 each found a gap in a checker that DENIED listed forms). The strict-decode choke
// point already exists: decodeStrict, with the one fatal, BOM-keeping TextDecoder, is the lib's only decoder. What T4a
// adds is a static check of the two guarded files in two layers; the verdict needs both:
//  - LAYER 1, the GRAMMAR (grammarSites, the soundness gate): an ALLOWLIST. The supported subset of JavaScript is
//    written down as tables (node types, operators, free globals with the exact forms each may take, per-file exact
//    import specifiers and names with their uses, readable member names, class method keys) plus a handful of pinned
//    productions (the own-data reader, `Object.defineProperty(this, ...)` in a constructor, spawnSync's shape, the one
//    `new TextDecoder(...)` as the top-level `const DECODER`, which is unaliasable and appears only in the one call
//    `s = DECODER.decode(bytes);` in decodeStrict (round 7), the `[Symbol.for('<literal>')]` method key). Anything else,
//    anywhere, is refused, including `.decode` on any other value. The tables
//    equal what the files use (a tightness test fails on an unused entry), so the surface only grows by review.
//    Scope is resolved by NAME, which is sound here because no declaration may take a name that is a property of
//    globalThis on the running Node (prototype chain included) or an allowlisted global, and an import's local name is
//    declared once: so a free name is the global and a declared name is never one. Assignment is `=` to a declared
//    non-import name or `this.<member> =` in a class constructor; update is `++` on such a name; a computed member is
//    a READ through a provably numeric key only (no computed write, delete, call, new or destructuring).
//  - LAYER 2, the legacy RULES (decodeSites, below): named tripwires for every decode-capable form, each hit pinned in
//    ALLOWED_SITES by file, function, ordinal, complete invocation and context. Layer 1 admits a decode-capable form
//    (`.toString`, `.realpath`, `realpathSync.native`, `String(x)`, `process.cwd()`, the one TextDecoder) only because
//    layer 2 flags every use of it (the layer-link test), so only a reviewed ALLOWED_SITES entry admits it.
// The alternative (a minimal choke point plus a deny list of decode-capable identifiers) is what rounds 1-5 were, and a
// deny list cannot be complete; replacing layer 2 would re-derive ~250 exact-rule fixtures for no added soundness.
//
// WHAT THE VERDICT ESTABLISHES, for the two guarded files as written (not for their callers): no explicit decoder of
// bytes runs outside a pinned site, and no path to Function, eval, a prototype or a reflective API exists, because
// every capability the files can reach is in the tables and none of those leads there. It does NOT establish
// "git output is never decoded lossily": see NOT CHECKED (implicit ToString in particular).
//
// HOW. The SCANNED modules (the git-output path of the lib: git-exec.mjs and git-capability.mjs; every other non-test
// JS module under lib/ must be named in OUT_OF_SCOPE with a reason, or the partition test fails) are PARSED by the
// vendored acorn 8.19.0 (skills/ship-ticket/vendor/acorn, MIT, byte-identical to the registry tarball; its mandatory
// pins are checked before it is imported; test-only, see the vendor test) as ES modules (ecmaVersion latest). A
// source acorn cannot parse is one `unclassifiable` hit in each layer. Layer 1 refuses a node type outside
// GRAMMAR_TYPES wherever it appears and, after the descent, any node it did not visit (outside a refused subtree), so a
// production that forgot a child cannot hide code; a test derives acorn's 73 node types from the vendored source and
// requires GRAMMAR_TYPES and the refused list to partition them. Layer 2's walker classifies every type in NODE_RULES
// (rule, walk or fail). Layer 2 resolves imports of fs, fs/promises and child_process (bare or node:) through the
// module's own BINDINGS: named, aliased (`{ readdirSync as rd }`, `{ default as cp }`), default and namespace imports,
// and `ns.member`, `ns.promises.member` and `ns.default.member` chains, by name; a watched API name with no import
// binding (a parameter, a seam object, a local) is treated as the API it names (`seam.realpath(d)`).
//
// LAYER 2 RULES (one rule each; ALLOWED_SITES pins rule names):
//  - decoder-api: a member, a constant computed member (`b['to' + 'String']`, `b['to\x53tring']`), a
//    destructured key, an import specifier or any constant string (a literal, a `+` chain or a template whose
//    pieces are all constant) that names toString, toLocaleString, setEncoding, a Buffer *Slice decoder,
//    TextDecoder(Stream) or StringDecoder; any reference to TextDecoder(Stream), StringDecoder, Response, Blob,
//    File or atob;
//  - decoder-lossy: a TextDecoder that is not `new TextDecoder(x, {...})` (no spread) with exactly one
//    `fatal: true` and exactly one `ignoreBOM: true` (a static literal);
//  - string-coercion: any reference to the global String other than String.fromCharCode or .fromCodePoint
//    (String.raw included: it converts its raw elements to strings);
//  - encoding-literal: a constant string or template chunk equal to a text encoding (utf8, utf-8, latin1, binary,
//    ascii, ucs2, utf16le; any case); encoding-option: an `encoding` key, member or variable that is not an object
//    literal entry `encoding: 'buffer'`;
//  - name-api-no-buffer: a call of realpath, readdir, readlink, mkdtemp or opendir (Sync, .native,
//    fs.promises) whose options, at index 1 (the only position Node reads; a later 'buffer' is ignored,
//    MEASURED), are not 'buffer' or a static literal whose one `encoding` entry is 'buffer' (a callback at
//    index 1 means no options);
//  - read-encoding: readFile(Sync) whose index-1 options name an encoding other than 'buffer';
//  - cp-encoding: spawnSync, execFileSync or execSync with an encoding other than 'buffer', or exec or
//    execFile (utf8 by default, MEASURED) without encoding 'buffer'. Options are read where Node reads them:
//    index 1 for exec(Sync); for spawnSync and execFile(Sync), index 2 after an array literal, null or
//    nothing, else index 1 when that is an object literal or a callback;
//  - cwd: a process.cwd() call (no exact-bytes form exists).
// An allowlist entry pins the COMPLETE invocation (the source of the call or `new` the flagged node is the callee
// of, else of the nearest call or `new` that contains it, so an argument change is a different site) and its
// CONTEXT (the enclosing statement, its head for a compound one, or the parameter default it sits in).
// LAYER 2 FAIL CLOSED ('unclassifiable'; never allowlisted; partly redundant with layer 1, kept as diagnostics):
//  - a parse error; a node type not in NODE_RULES, and WithStatement;
//  - an import or re-export specifier that is not exactly fs, fs/promises, child_process or path (bare or node:,
//    looked up in a Map, so an inherited name such as `constructor` is not one)
//    and does not RESOLVE, as Node resolves it (WHATWG URL against the importer: percent-encoded dot segments,
//    query and fragment, no extension search; MEASURED Node 18 and 22), to a file of the scanned set;
//  - an export of a watched binding or name;
//  - an fs or child_process name not classified as checked or known not to return text;
//  - a watched API or namespace used other than as a direct call or `ns.member` (aliased to a variable,
//    destructured, `.call/.apply/.bind`, `(0, f)()`, `new`, passed or exported as a value);
//  - a spread argument to a checked call, or options that are not static: an identifier, a call, a spread,
//    a computed key, `__proto__` or an accessor;
//  - spawnSync or execFile(Sync) args that are neither an array literal nor an object literal (Node then may
//    take the args as the options and ignore the literal after them, MEASURED Node 18 and 22), and
//    child_process options given as a string (exec ignores 'buffer' and returns a string, MEASURED);
//  - spawn and fork (asynchronous output is not analysed); dynamic import;
//  - require, module, exports, eval, Function, globalThis, global, self, window, Reflect, Proxy, WebAssembly,
//    createRequire and getBuiltinModule as names;
//  - `process` other than process.env, process.platform or a process.cwd() call (so process.binding,
//    .getBuiltinModule, .mainModule, .argv), Buffer other than from, isBuffer, alloc, allocUnsafe, concat,
//    byteLength and compare, and the global Object other than its members keys, entries, values, freeze,
//    isFrozen, create, hasOwn, assign, fromEntries and is (so Object itself as a value fails);
//  - REFLECTION, by any key form: a member, a destructured key or any constant string naming constructor,
//    prototype, __proto__, getPrototypeOf, setPrototypeOf, getOwnPropertyDescriptor(s), defineProperty,
//    defineProperties or __define/lookup{G,S}etter__, and an object-literal `__proto__` other than
//    `__proto__: null`. Two exact productions are the only reflective forms admitted: the lib's own-data reader
//    (OWN_VALUE_SRC, matched on the whole function's source) and `Object.defineProperty(this, '<plain name>',
//    { value|enumerable|writable|configurable: <literal> })`, which defines and never reads;
//  - a computed key that is not a constant: built from string pieces (unless only assigned to), a CALL through
//    it (`b[k]()`), a destructured one (`{ [k]: v } = o`), and a READ through it unless the key is provably
//    numeric (a number literal, unary - + ~, arithmetic or bitwise operators other than +, ++/--) or the
//    counter of the enclosing `for (let i = <number>; ...; i++)` that nothing else in the loop assigns or
//    rebinds (round 6: the frozen-table exemption is removed). A delete through it or an assignment to it is
//    not a read here; layer 1 refuses both;
//  - a compound or logical assignment (`+=`, `||=`, `??=`) to a watched name: it reads the name (round 6).
// NOT CHECKED by either layer (review items; T4b is the behavioural backstop; each example is asserted to give no
// layer-2 hit below, and layer 1 admits the forms the files use):
//  - ANY implicit ToString of a Buffer: `${buf}`, `buf + ''`, Array#join or #sort, JSON.parse(buf), RegExp#exec or
//    #test(buf), String#startsWith(buf), loose equality, use as a property key. This IS a lossy decode if the value is
//    a Buffer; which value is a Buffer is data flow, which neither layer models;
//  - String.fromCharCode and .fromCodePoint in any call form (exempt by design: a latin1 map);
//  - process.env values (decoded by the OS and Node; the lib copies them, never compares them with git bytes);
//  - the implicit cwd of path.resolve; data flow (which value is a Buffer, what a caller passes in: a getter, a Proxy
//    or an iterator in caller data runs caller code); anything outside the scanned set;
//  - a global added or replaced at run time by OTHER code (the name rule is checked against this Node's globalThis).
// Evidence: layer 1's tightness, refusal-corpus (every round-5 finding), node-type partition, layer-link and seeded
// injection tests; layer 2's planted, escape, unchecked and fine fixtures, node-type table test and seeded property
// test; the checker mutants (round-6 log under .specs/reviews/S-02a0b/round-6/).
const VENDOR = join(here, '..', '..', 'vendor', 'acorn');
const UPSTREAM = JSON.parse(readFileSync(join(VENDOR, 'UPSTREAM.json'), 'utf8'));
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
/** The mandatory pin set: both vendored files, exactly. */
const VENDOR_PINS = ['LICENSE', 'acorn.mjs'];
/**
 * Integrity BEFORE load: true only when UPSTREAM.files pins exactly VENDOR_PINS, each with an own 64-hex sha256, and
 * every pinned file hashes to its pin (round 5: an empty or LICENSE-only map was vacuously true, so acorn.mjs could be
 * imported unchecked). On any mismatch acorn is not imported and every T4a test fails on an assertion (not at module
 * load), so the suite keeps its test count. A MISSING UPSTREAM.json or pinned file throws at module load instead.
 */
function vendorIntact(upstream, hashOf) {
  const files = upstream && typeof upstream === 'object' ? upstream.files : null;
  if (!files || typeof files !== 'object' || Object.keys(files).sort().join('\0') !== VENDOR_PINS.join('\0')) return false;
  return VENDOR_PINS.every((f) => {
    const h = Object.getOwnPropertyDescriptor(files, f)?.value?.sha256;
    return typeof h === 'string' && /^[0-9a-f]{64}$/.test(h) && hashOf(f) === h;
  });
}
const VENDOR_OK = vendorIntact(UPSTREAM, (f) => sha256(join(VENDOR, f)));
const acorn = VENDOR_OK ? await import(pathToFileURL(join(VENDOR, 'acorn.mjs')).href) : null;

test('T4a: the vendored acorn is exactly the pinned upstream bytes, and nothing else is in its directory', () => {
  assert.equal(UPSTREAM.name, 'acorn');
  assert.equal(UPSTREAM.version, '8.19.0');
  assert.deepEqual(readdirSync(VENDOR).sort(), [...Object.keys(UPSTREAM.files), 'UPSTREAM.json'].sort());
  for (const [f, { sha256: h }] of Object.entries(UPSTREAM.files)) assert.equal(sha256(join(VENDOR, f)), h, f);
  assert.equal(acorn?.version, UPSTREAM.version, 'the loaded parser is the pinned one');
});

test('T4a: the pre-import integrity predicate needs the complete pin set and every hash', () => {
  const real = (f) => sha256(join(VENDOR, f));
  assert.equal(VENDOR_OK, true);
  assert.equal(vendorIntact(UPSTREAM, real), true);
  const pin = (f) => ({ sha256: real(f) });
  let calls = 0;
  const counted = (f) => { calls++; return real(f); };
  for (const [what, files] of [['empty', {}], ['LICENSE only', { LICENSE: pin('LICENSE') }], ['acorn.mjs only', { 'acorn.mjs': pin('acorn.mjs') }],
    ['an extra pin', { LICENSE: pin('LICENSE'), 'acorn.mjs': pin('acorn.mjs'), 'x.mjs': pin('LICENSE') }]]) {
    assert.equal(vendorIntact({ files }, counted), false, what);
  }
  assert.equal(calls, 0, 'an incomplete pin set is refused before any file is hashed');
  assert.equal(vendorIntact({ files: { LICENSE: pin('LICENSE'), 'acorn.mjs': { sha256: real('LICENSE') } } }, real), false, 'a wrong hash');
  assert.equal(vendorIntact({ files: { LICENSE: pin('LICENSE'), 'acorn.mjs': { sha256: 'x' } } }, () => 'x'), false, 'a malformed hash');
  assert.equal(vendorIntact({ files: { LICENSE: pin('LICENSE'), 'acorn.mjs': {} } }, () => undefined), false, 'a missing hash');
  assert.equal(vendorIntact(null, real), false);
  assert.equal(vendorIntact({ files: Object.create({ LICENSE: pin('LICENSE'), 'acorn.mjs': pin('acorn.mjs') }) }, real), false, 'inherited pins');
});

const ENC_NAME = /^(?:utf-?8|latin1|binary|ascii|ucs-?2|utf-?16le)$/i;
const DECODER_NAME = /^(?:toString|toLocaleString|setEncoding|(?:utf8|latin1|ascii|ucs2|utf16le|binary|hex|base64|base64url)Slice|TextDecoder(?:Stream)?|StringDecoder)$/;
const DECODER_GLOBAL = new Set(['TextDecoder', 'TextDecoderStream', 'StringDecoder', 'Response', 'Blob', 'File', 'atob']);
const OPAQUE_GLOBAL = new Set(['require', 'module', 'exports', 'eval', 'Function', 'globalThis', 'global', 'self', 'window', 'Reflect', 'Proxy', 'WebAssembly', 'createRequire', 'getBuiltinModule']);
// Reflective property names: a member, destructured key or constant string naming one fails closed (any key form).
const REFLECT_NAME = /^(?:constructor|prototype|__proto__|getPrototypeOf|setPrototypeOf|getOwnPropertyDescriptors?|defineProperty|defineProperties|__(?:define|lookup)[GS]etter__)$/;
// The global Object: only these members (none reads a prototype or a descriptor); Object itself as a value fails.
const OBJECT_OK = new Set(['keys', 'entries', 'values', 'freeze', 'isFrozen', 'create', 'hasOwn', 'assign', 'fromEntries', 'is']);
// The one own-data reader production (git-exec.mjs `ownValue`), matched on the whole function's whitespace-normalised source.
const OWN_VALUE_SRC = "(o, k) => { const d = Object.getOwnPropertyDescriptor(o, k); return d && own(d, 'value') ? d.value : undefined; }";
const NAME_API = /^(?:realpath|readdir|readlink|mkdtemp|opendir)(?:Sync)?$/;
const READ_API = /^readFile(?:Sync)?$/;
const CP_API = /^(?:spawnSync|execFileSync|execSync|spawn|execFile|exec|fork)$/;
// A Map, so an inherited name (`import 'constructor'`) is never a watched builtin.
const MODULES = new Map(Object.entries({ fs: 'fs', 'node:fs': 'fs', 'fs/promises': 'fsp', 'node:fs/promises': 'fsp', child_process: 'cp', 'node:child_process': 'cp', path: 'path', 'node:path': 'path' }));
// fs names that return no text: anything not here, not checked and not `promises` is unclassifiable. mkdir(Sync)
// is NOT here: with `recursive` it returns the first directory created as a string (MEASURED, Node 18 and 22).
const FS_SAFE = new Set(['statSync', 'lstatSync', 'fstatSync', 'stat', 'lstat', 'accessSync', 'access', 'existsSync', 'constants',
  'rmSync', 'rm', 'rmdirSync', 'unlinkSync', 'unlink', 'writeFileSync', 'writeFile', 'appendFileSync', 'renameSync', 'rename', 'chmodSync', 'chmod',
  'copyFileSync', 'openSync', 'closeSync', 'writeSync', 'readSync', 'fsyncSync', 'symlinkSync', 'linkSync', 'truncateSync', 'utimesSync']);
// The git-output path of the lib: the modules T4a scans. Every other non-test module under lib/ is named here with
// the reason it is outside the git-output path (the partition test fails on an unnamed one).
const SCANNED = ['git-capability.mjs', 'git-exec.mjs'];
/** lib modules neither scanned nor named out of scope (must be empty). */
const unpartitioned = (files) => files.filter((f) => !SCANNED.includes(f) && !Object.hasOwn(OUT_OF_SCOPE, f));
const OUT_OF_SCOPE = {
  'durable-io.mjs': 'S-30a durable state/lock I/O. FINDING (reported, not adopted): gitPath() spawns `git rev-parse --git-path` with encoding utf8, a lossy git-output decode; no S-30c row adopts it yet (asserted below, so a fix updates this entry)',
  'mutation.test-helper.mjs': 'shared mutation harness (test tooling, imported only by tests); spawns node --test, never git, and decodes TAP output only',
  'shape.mjs': 'S-30b closed-schema validator; no fs, child_process or git output (uses Reflect for own-key reads, which T4a would refuse)',
};
/**
 * Where an import or re-export specifier lands, resolved as Node's ESM resolver does: a watched builtin name is itself;
 * a `/`, `./` or `../` specifier is a WHATWG URL relative to the importer's file URL, and an absolute URL is itself
 * (percent-encoded dot segments are dot segments; query and fragment are dropped for the file; no extension search);
 * it must be a file: URL whose path is exactly one of `scanned` (relative to lib/, `/`-separated). Anything else (a
 * bare package, a `#` package import, another builtin) is null. Returns {mod} for a watched builtin, {lib} for a
 * scanned file, or null.
 */
function resolveSpecifier(spec, file, scanned) {
  if (MODULES.has(spec)) return { mod: MODULES.get(spec) };
  const relativeSpec = /^\.{0,2}\//.test(spec);
  if (!relativeSpec && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(spec)) return null;
  let target;
  try {
    // Only `/`, `./` and `../` use the importer as base; a scheme specifier is parsed alone (`file:x.mjs` is /x.mjs, MEASURED).
    const u = relativeSpec ? new URL(spec, pathToFileURL(join(here, file))) : new URL(spec);
    if (u.protocol !== 'file:') return null;
    u.search = ''; u.hash = '';
    target = relative(here, fileURLToPath(u)).split(sep).join('/');
  } catch { return null; }
  return scanned.includes(target) ? { lib: target } : null;
}
/** 'name' | 'read' | 'cp' | 'safe' | {ns} | null (unclassified) for a member of a watched module. */
function apiKind(mod, name) {
  if (mod === 'path') return 'safe';
  if (mod === 'cp') return CP_API.test(name) ? 'cp' : null;
  if (mod === 'fs' && name === 'promises') return { ns: 'fsp' };
  if (NAME_API.test(name) && (mod === 'fs' || !name.endsWith('Sync'))) return 'name';
  if (READ_API.test(name) && (mod === 'fs' || !name.endsWith('Sync'))) return 'read';
  return FS_SAFE.has(name) && (mod === 'fs' || !name.endsWith('Sync')) ? 'safe' : null;
}
/** The API a watched name with no import binding is taken to be. */
const byName = (name) => (NAME_API.test(name) || READ_API.test(name) ? 'fs' : CP_API.test(name) ? 'cp' : null);

const NOT_CHILD = new Set(['type', 'start', 'end', 'loc', 'range']);
/** Depth-first over every child that is a node; `anc` holds {node, key} from the root to the parent. */
function walk(root, visit) {
  const anc = [];
  const go = (node) => {
    visit(node, anc);
    for (const key of Object.keys(node)) {
      if (NOT_CHILD.has(key)) continue;
      const v = node[key];
      for (const c of Array.isArray(v) ? v : [v]) if (c && typeof c.type === 'string') { anc.push({ node, key }); go(c); anc.pop(); }
    }
  };
  go(root);
}
/** The string an expression always evaluates to (string literal, template whose substitutions are constant, `+` of those). */
const staticTpl = (n) => n.expressions.reduce((acc, e, i) => ((x) => (acc === null || x === null || n.quasis[i + 1].value.cooked == null ? null : acc + x + n.quasis[i + 1].value.cooked))(staticStr(e)), n.quasis[0].value.cooked ?? null);
const staticStr = (n) => (n?.type === 'Literal' && typeof n.value === 'string' ? n.value
  : n?.type === 'TemplateLiteral' ? staticTpl(n)
    : n?.type === 'BinaryExpression' && n.operator === '+' ? ((a, b) => (a !== null && b !== null ? a + b : null))(staticStr(n.left), staticStr(n.right)) : null);
/** A member's property name when it is a constant, else null. */
const staticKey = (m) => (!m.computed ? (m.property.type === 'PrivateIdentifier' ? `#${m.property.name}` : m.property.name)
  : m.property.type === 'Literal' && typeof m.property.value === 'number' ? String(m.property.value) : staticStr(m.property));
const propName = (q) => (q.computed ? staticStr(q.key) : q.key.type === 'Identifier' ? q.key.name : String(q.key.value));
const hasStringPiece = (n) => { let s = false; walk(n, (x) => { if ((x.type === 'Literal' && typeof x.value === 'string') || x.type === 'TemplateLiteral') s = true; }); return s; };
const isFn = (n) => n?.type === 'FunctionExpression' || n?.type === 'ArrowFunctionExpression';
/** An options argument: absent | buffer | other (a string, or a literal naming another encoding) | none (a literal without encoding) | nonstatic | dynamic. */
function optionsOf(n) {
  if (!n || isFn(n)) return 'absent';
  const s = staticStr(n);
  if (s !== null) return s === 'buffer' ? 'buffer' : 'other';
  if (n.type !== 'ObjectExpression') return 'dynamic';
  if (!n.properties.every((q) => q.type === 'Property' && q.kind === 'init' && !q.computed && propName(q) !== '__proto__')) return 'nonstatic';
  const enc = n.properties.filter((q) => propName(q) === 'encoding');
  if (!enc.length) return 'none';
  return enc.length === 1 && !enc[0].shorthand && !enc[0].method && staticStr(enc[0].value) === 'buffer' ? 'buffer' : 'other';
}
const FN_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
/** The enclosing named functions, objects and classes, e.g. `realFs.realpath`; `<module>` at top level. */
function fnName(anc) {
  const names = [];
  anc.forEach(({ node }, i) => {
    const up = anc[i - 1]?.node;
    if (FN_TYPES.has(node.type) || node.type === 'ObjectExpression' || node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      const own = node.id?.name ?? (up?.type === 'VariableDeclarator' && up.id.type === 'Identifier' ? up.id.name
        : (up?.type === 'Property' || up?.type === 'MethodDefinition') && FN_TYPES.has(node.type) ? propName(up) : null);
      if (own) names.push(own);
    }
  });
  return names.join('.') || '<module>';
}
/** A declared or assigned name (a binding position), not a read. */
function isBinding(anc) {
  for (let i = anc.length - 1; i >= 0; i--) {
    const { node: p, key: k } = anc[i];
    if ((p.type === 'VariableDeclarator' && k === 'id') || (FN_TYPES.has(p.type) && (k === 'params' || k === 'id')) || (/^Class/.test(p.type) && k === 'id')
      || (p.type === 'CatchClause' && k === 'param') || (p.type === 'AssignmentExpression' && k === 'left' && p.operator === '=') || (/^For(?:In|Of)Statement$/.test(p.type) && k === 'left')) return true;
    if (p.type === 'AssignmentPattern' ? k !== 'left' : !(['ArrayPattern', 'ObjectPattern', 'RestElement'].includes(p.type)
      || (p.type === 'Property' && k === 'value' && anc[i - 1]?.node.type === 'ObjectPattern'))) return false;
  }
  return false;
}
const NOT_REF_KEY = { MemberExpression: 'property', Property: 'key', MethodDefinition: 'key', PropertyDefinition: 'key' };
// Operators whose result is a number (or BigInt), so a key built with them can never name a property such as constructor.
const NUM_OPS = new Set(['-', '*', '/', '%', '**', '|', '&', '^', '<<', '>>', '>>>']);
const numericKey = (n) => (n.type === 'Literal' && (typeof n.value === 'number' || typeof n.value === 'bigint')) || n.type === 'UpdateExpression'
  || (n.type === 'UnaryExpression' && ['-', '+', '~'].includes(n.operator)) || (n.type === 'BinaryExpression' && NUM_OPS.has(n.operator));
/** `name` is the counter of the enclosing `for (let name = <number>; ...; name++)` read in its test or body, and nothing else there assigns or rebinds it. */
function loopCounter(name, a) {
  for (let i = a.length - 1; i >= 0; i--) {
    const { node: f, key } = a[i];
    const d = f.type === 'ForStatement' ? f.init : null;
    if (!(d?.type === 'VariableDeclaration' && d.declarations.some((x) => x.id.type === 'Identifier' && x.id.name === name))) continue;
    const u = f.update;
    const step = (u?.type === 'UpdateExpression' && u.argument.type === 'Identifier' && u.argument.name === name)
      || (u?.type === 'AssignmentExpression' && ['+=', '-='].includes(u.operator) && u.left.type === 'Identifier' && u.left.name === name && u.right.type === 'Literal' && typeof u.right.value === 'number');
    const init = d.declarations.length === 1 ? d.declarations[0].init : null;
    if (d.kind !== 'let' || !(key === 'body' || key === 'test') || init?.type !== 'Literal' || typeof init.value !== 'number' || !step) return false;
    let clean = true;
    for (const part of [f.test, f.body]) if (part) walk(part, (x, xa) => { if (x.type === 'Identifier' && x.name === name && (isBinding(xa) || xa[xa.length - 1]?.node.type === 'UpdateExpression')) clean = false; });
    return clean;
  }
  return false;
}
// Every node type the vendored acorn can produce (derived from its source by the exhaustiveness test): 'rule' has a case
// in the walker, 'walk' only has its children visited, 'fail' is refused. Any other type is unclassifiable.
const NODE_RULES = {
  ImportExpression: 'rule', ImportDeclaration: 'rule', ExportAllDeclaration: 'rule', ExportNamedDeclaration: 'rule', Literal: 'rule', TemplateLiteral: 'rule',
  BinaryExpression: 'rule', CallExpression: 'rule', MemberExpression: 'rule', Property: 'rule', Identifier: 'rule',
  WithStatement: 'fail',
  ...Object.fromEntries(['ArrayExpression', 'ArrayPattern', 'ArrowFunctionExpression', 'AssignmentExpression', 'AssignmentPattern', 'AwaitExpression', 'BlockStatement',
    'BreakStatement', 'CatchClause', 'ChainExpression', 'ClassBody', 'ClassDeclaration', 'ClassExpression', 'ConditionalExpression', 'ContinueStatement', 'DebuggerStatement',
    'DoWhileStatement', 'EmptyStatement', 'ExportDefaultDeclaration', 'ExportSpecifier', 'ExpressionStatement', 'ForInStatement', 'ForOfStatement', 'ForStatement',
    'FunctionDeclaration', 'FunctionExpression', 'IfStatement', 'ImportAttribute', 'ImportDefaultSpecifier', 'ImportNamespaceSpecifier', 'ImportSpecifier', 'LabeledStatement',
    'LogicalExpression', 'MetaProperty', 'MethodDefinition', 'NewExpression', 'ObjectExpression', 'ObjectPattern', 'ParenthesizedExpression', 'PrivateIdentifier', 'Program',
    'PropertyDefinition', 'RestElement', 'ReturnStatement', 'SequenceExpression', 'SpreadElement', 'StaticBlock', 'Super', 'SwitchCase', 'SwitchStatement',
    'TaggedTemplateExpression', 'TemplateElement', 'ThisExpression', 'ThrowStatement', 'TryStatement', 'UnaryExpression', 'UpdateExpression', 'VariableDeclaration',
    'VariableDeclarator', 'WhileStatement', 'YieldExpression'].map((t) => [t, 'walk'])),
};
// Fixture modules are checked as lib/m.mjs inside this synthetic scanned set.
const FIXTURE_SET = ['m.mjs', 'git-exec.mjs', 'sub/x.mjs'];

/**
 * Every decode site in one module's source (lib/<file>, checked against the `scanned` set): [{file, fn, rule, why, line,
 * pos, text (the flagged node's own source), site (the complete invocation it belongs to)}] in source order.
 */
function decodeSites(file, src, scanned = FIXTURE_SET, rules = NODE_RULES) {
  assert.ok(acorn, 'the vendored acorn failed its integrity check (UPSTREAM.json)');
  let ast;
  try { ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true }); } catch (e) {
    return [{ file, fn: '<module>', rule: 'unclassifiable', why: `parse error: ${e.message}`, line: e.loc?.line ?? 1, pos: e.pos ?? 0, text: '' }];
  }
  const hits = [];
  let anc = [];
  // Parents and the module's binding count per name.
  const parent = new Map();
  const bindCount = new Map();
  walk(ast, (n, a) => {
    const up = a[a.length - 1];
    parent.set(n, up);
    if (n.type === 'Identifier' && (isBinding(a) || (/Specifier$/.test(up?.node.type ?? '') && up.key === 'local'))) bindCount.set(n.name, (bindCount.get(n.name) ?? 0) + 1);
  });
  const text = (n) => src.slice(n.start, n.end).replace(/\s+/g, ' ');
  const isCall = (x) => x?.type === 'CallExpression' || x?.type === 'NewExpression';
  /** The complete invocation a node belongs to: the call it is the callee (chain) of, else the nearest enclosing call. */
  const siteOf = (n) => {
    let s = n;
    let up = parent.get(s);
    while (up?.node.type === 'MemberExpression' && up.key === 'object') { s = up.node; up = parent.get(s); }
    if (isCall(up?.node) && up.key === 'callee') return up.node;
    for (let q = parent.get(n); q; q = parent.get(q.node)) if (isCall(q.node)) return q.node;
    return n;
  };
  /** Where the site sits: the enclosing statement (only its head, up to its body, for a compound one), declaration, or parameter default. */
  const contextOf = (n) => {
    for (let q = parent.get(n); q; q = parent.get(q.node)) {
      const c = q.node;
      if (!/Statement$|^VariableDeclaration$|^AssignmentPattern$/.test(c.type)) continue;
      const body = c.body ?? c.consequent ?? c.block;
      return body?.type && body !== n ? src.slice(c.start, body.start).replace(/\s+/g, ' ').trim() : text(c);
    }
    return text(n);
  };
  const hit = (n, rule, why = rule) => hits.push({ file, fn: fnName(anc), rule, why, line: n.loc.start.line, pos: n.start, text: text(n), site: text(siteOf(n)), ctx: contextOf(n) });
  const objectFree = !bindCount.has('Object');
  /** The two admitted reflective productions: the own-data reader (whole function source) and a defining defineProperty. */
  function admittedReflect(m, a) {
    const c = a[a.length - 1];
    if (!(objectFree && m.object.type === 'Identifier' && m.object.name === 'Object' && !m.computed && c?.node.type === 'CallExpression' && c.key === 'callee')) return false;
    if (m.property.name === 'getOwnPropertyDescriptor') {
      const f = [...a].reverse().find(({ node }) => FN_TYPES.has(node.type))?.node;
      return !!f && text(f) === OWN_VALUE_SRC;
    }
    const [o, k, d, ...rest] = c.node.arguments;
    return m.property.name === 'defineProperty' && !rest.length && o?.type === 'ThisExpression' && k?.type === 'Literal' && typeof k.value === 'string'
      && !REFLECT_NAME.test(k.value) && !DECODER_NAME.test(k.value) && d?.type === 'ObjectExpression' && d.properties.every((q) => q.type === 'Property' && q.kind === 'init'
        && !q.computed && !q.shorthand && !q.method && ['value', 'enumerable', 'writable', 'configurable'].includes(propName(q)) && q.value.type === 'Literal');
  }
  /** A read through a non-constant computed key that provably cannot name a reflective or decoder property. */
  function safeRead(m, a) {
    const { node: p, key: k } = a[a.length - 1];
    if ((p.type === 'AssignmentExpression' && k === 'left' && p.operator === '=') || (p.type === 'UnaryExpression' && p.operator === 'delete')) return true;
    return numericKey(m.property) || (m.property.type === 'Identifier' && loopCounter(m.property.name, a));
  }
  /** The checks on a constant string (a literal, a folded `+` chain or a folded template). */
  const strRules = (n, t, asKey) => {
    if (ENC_NAME.test(t)) hit(n, 'encoding-literal');
    if (!asKey && DECODER_NAME.test(t)) hit(n, 'decoder-api');
    if (!asKey && REFLECT_NAME.test(t)) hit(n, 'unclassifiable', `the string '${t}' names a reflective property`);
  };
  // Import bindings of the watched modules: local name -> {mod, name (null for a namespace or default)}.
  const binds = new Map();
  for (const d of ast.body) {
    if (d.type !== 'ImportDeclaration') continue;
    const to = resolveSpecifier(d.source.value, file, scanned);
    if (!to) hit(d, 'unclassifiable', `import of ${d.source.value}: not a watched builtin or a file of the scanned set`);
    const mod = to?.mod;
    for (const s of d.specifiers) {
      const imported = s.type === 'ImportSpecifier' ? (s.imported.name ?? s.imported.value) : 'default';
      if ([imported, s.local.name].some((x) => DECODER_NAME.test(x))) hit(s, 'decoder-api');
      if (!mod) continue;
      if (imported === 'default' || s.type === 'ImportNamespaceSpecifier') { binds.set(s.local.name, { mod, name: null }); continue; }
      const kind = apiKind(mod, imported);
      if (!kind) hit(s, 'unclassifiable', `${d.source.value} export ${imported} is not classified`);
      else binds.set(s.local.name, kind.ns ? { mod: kind.ns, name: null } : { mod, name: imported });
    }
  }
  // Only a NAMESPACE of a checked module resolves every member itself; any other root (a safe import such as
  // statSync or path, which a local may shadow) leaves the by-name rule on its members in force.
  const rootBound = (n) => { while (n.type === 'MemberExpression') n = n.object; return n.type === 'Identifier' && binds.get(n.name)?.name === null && binds.get(n.name).mod !== 'path'; };
  const isCallee = (i) => anc[i]?.node.type === 'CallExpression' && anc[i].key === 'callee';
  /** One checked call: the options at the position Node reads them. */
  function callRule(kind, name, call, at) {
    const A = call.arguments;
    if (A.some((a) => a.type === 'SpreadElement')) return hit(at, 'unclassifiable', `spread argument to ${name}`);
    const bad = (o) => o === 'dynamic' || o === 'nonstatic';
    if (kind === 'name') {
      const o = optionsOf(A[1]);
      return o === 'buffer' ? undefined : bad(o) ? hit(at, 'unclassifiable', `${name} options are not static`) : hit(at, 'name-api-no-buffer');
    }
    if (kind === 'read') {
      const o = optionsOf(A[1]);
      return o === 'other' ? hit(at, 'read-encoding') : bad(o) ? hit(at, 'unclassifiable', `${name} options are not static`) : undefined;
    }
    if (name === 'spawn' || name === 'fork') return hit(at, 'unclassifiable', `${name}: asynchronous child output is not analysed`);
    let on;
    if (name === 'execSync' || name === 'exec') on = A[1];
    else if (!A[1] || A[1].type === 'ArrayExpression' || (A[1].type === 'Literal' && A[1].value === null)) on = A[2];
    else if (A[1].type === 'ObjectExpression' || isFn(A[1])) on = A[1];
    else return hit(at, 'unclassifiable', `${name} args are not an array literal, so Node may take them as the options`);
    if (staticStr(on) !== null) return hit(at, 'unclassifiable', `${name} options given as a string`);
    const o = optionsOf(on);
    if (bad(o)) return hit(at, 'unclassifiable', `${name} options are not static`);
    if (o === 'buffer' || ((o === 'absent' || o === 'none') && name.endsWith('Sync'))) return undefined;
    return hit(at, 'cp-encoding');
  }
  /** A use of a watched module member `name` (null: the namespace itself) by node n, whose parent is anc[i]. */
  function useOf(mod, name, n, i) {
    const { node: p, key: k } = anc[i] ?? {};
    const member = p?.type === 'MemberExpression' && k === 'object' ? staticKey(p) : null;
    if (name === null) {
      if (member === null) return hit(n, 'unclassifiable', `${mod} namespace used other than as ns.member`);
      if (member === 'default') return useOf(mod, null, p, i - 1);
      const kind = apiKind(mod, member);
      if (!kind) return hit(p, 'unclassifiable', `${mod}.${member} is not classified`);
      return kind.ns ? useOf(kind.ns, null, p, i - 1) : useOf(mod, member, p, i - 1);
    }
    const kind = apiKind(mod, name);
    if (!kind) return hit(n, 'unclassifiable', `${mod}.${name} is not classified`);
    if (kind === 'safe') return undefined;
    if (isCallee(i)) return callRule(kind, name, p, n);
    if (/^realpath/.test(name) && member === 'native' && isCallee(i - 1)) return callRule(kind, name, anc[i - 1].node, n);
    return hit(n, 'unclassifiable', `${name} used other than as a direct call`);
  }
  walk(ast, (n, a) => {
    anc = a;
    const { node: p, key: k } = a[a.length - 1] ?? {};
    const computedKey = (k === 'property' || k === 'key') && p.computed;
    switch (n.type) {
      case 'ImportExpression': return hit(n, 'unclassifiable', 'dynamic import');
      case 'ImportDeclaration': return undefined; // resolved and bound above
      case 'ExportAllDeclaration': case 'ExportNamedDeclaration':
        if (n.source && !resolveSpecifier(n.source.value, file, scanned)?.lib) hit(n, 'unclassifiable', `re-export from ${n.source.value}`);
        if (!n.source) for (const s of n.specifiers ?? []) if (binds.has(s.local.name) || byName(s.local.name)) hit(s, 'unclassifiable', `export of ${s.local.name}`);
        return undefined;
      case 'Literal': case 'TemplateLiteral': {
        if (k === 'source') return undefined;
        const texts = n.type === 'Literal' ? (typeof n.value === 'string' ? [n.value] : []) : n.quasis.map((q) => q.value.cooked ?? '');
        // A literal computed key is checked as the member or property name it is; only the encoding tripwire runs here.
        for (const t of texts) strRules(n, t, computedKey);
        // A template whose substitutions are all constant is also checked as the one string it folds to.
        if (n.type === 'TemplateLiteral' && n.expressions.length && staticStr(n) !== null) strRules(n, staticStr(n), computedKey);
        return undefined;
      }
      case 'BinaryExpression':
        // A maximal constant `+` chain is checked as the one string it folds to.
        if (n.operator === '+' && !(p?.type === 'BinaryExpression' && p.operator === '+') && staticStr(n) !== null) strRules(n, staticStr(n), computedKey);
        return undefined;
      case 'CallExpression':
        if (n.callee.type === 'MemberExpression' && n.callee.computed && staticKey(n.callee) === null) hit(n.callee, 'unclassifiable', 'call through a computed member');
        return undefined;
      case 'MemberExpression': {
        const key = staticKey(n);
        if (key === null) {
          if (hasStringPiece(n.property) && !(p.type === 'AssignmentExpression' && k === 'left' && p.operator === '=')) hit(n, 'unclassifiable', 'computed key built from string pieces');
          else if (!(p.type === 'CallExpression' && k === 'callee') && !safeRead(n, a)) hit(n, 'unclassifiable', 'read through a computed key that is not provably safe');
          return undefined;
        }
        if (DECODER_NAME.test(key)) hit(n, 'decoder-api');
        if (REFLECT_NAME.test(key) && !admittedReflect(n, a)) hit(n, 'unclassifiable', `.${key} is reflective (reaches Function or a prototype)`);
        if (key === 'encoding') hit(n, 'encoding-option');
        const mod = byName(key);
        if (mod && key !== 'exec' && !rootBound(n.object)) useOf(mod, key, n, a.length - 1);
        return undefined;
      }
      case 'Property': {
        const name = propName(n);
        if (name === null) {
          if (hasStringPiece(n.key)) hit(n, 'unclassifiable', 'computed key built from string pieces');
          else if (p.type === 'ObjectPattern') hit(n, 'unclassifiable', 'destructuring through a computed key that is not a constant');
          return undefined;
        }
        if (p.type === 'ObjectPattern') {
          if (DECODER_NAME.test(name)) hit(n, 'decoder-api');
          if (byName(name)) hit(n, 'unclassifiable', `${name} destructured`);
          if (REFLECT_NAME.test(name)) hit(n, 'unclassifiable', `${name} destructured (reflective)`);
        }
        if (p.type === 'ObjectExpression' && name === '__proto__' && !n.computed && !n.shorthand && !(n.value.type === 'Literal' && n.value.value === null)) hit(n, 'unclassifiable', '__proto__ in an object literal sets a prototype');
        if (name === 'encoding' && !(p.type === 'ObjectExpression' && n.kind === 'init' && !n.shorthand && staticStr(n.value) === 'buffer')) hit(n, 'encoding-option');
        return undefined;
      }
      case 'Identifier': {
        if ((NOT_REF_KEY[p?.type] === k && !p.computed) || /Specifier$|^MetaProperty$|^LabeledStatement$|^BreakStatement$|^ContinueStatement$/.test(p?.type ?? '') || isBinding(a)) return undefined;
        const v = n.name;
        const member = p?.type === 'MemberExpression' && k === 'object' ? staticKey(p) : null;
        if (binds.has(v)) return useOf(binds.get(v).mod, binds.get(v).name, n, a.length - 1);
        if (OPAQUE_GLOBAL.has(v)) return hit(n, 'unclassifiable', `${v} is not analysable`);
        if (DECODER_GLOBAL.has(v)) {
          hit(n, 'decoder-api');
          // Exact only with BOTH flags: fatal refuses invalid bytes, ignoreBOM keeps a leading EF BB BF (stripping it is lossy).
          const o = p?.type === 'NewExpression' && k === 'callee' && !p.arguments.some((x) => x.type === 'SpreadElement')
            && p.arguments[1]?.type === 'ObjectExpression' && optionsOf(p.arguments[1]) !== 'nonstatic' ? p.arguments[1] : null;
          const isTrue = (key) => ((f) => f.length === 1 && !f[0].shorthand && f[0].value.type === 'Literal' && f[0].value.value === true)(o.properties.filter((q) => propName(q) === key));
          if (v === 'TextDecoder' && !(o && isTrue('fatal') && isTrue('ignoreBOM'))) hit(n, 'decoder-lossy');
          return undefined;
        }
        if (v === 'String') return ['fromCharCode', 'fromCodePoint'].includes(member) ? undefined : hit(n, 'string-coercion');
        if (v === 'process') {
          if (member === 'env' || member === 'platform') return undefined;
          if (member === 'cwd') return isCallee(a.length - 2) ? hit(p, 'cwd') : hit(p, 'unclassifiable', 'process.cwd used as a value');
          return REFLECT_NAME.test(member ?? '') ? undefined : hit(n, 'unclassifiable', member === null ? 'process used as a value' : `process.${member} is not classified`);
        }
        // A reflective member of Buffer, process or Object is reported (or admitted) once, by the member rule.
        if (v === 'Buffer') return ['from', 'isBuffer', 'alloc', 'allocUnsafe', 'concat', 'byteLength', 'compare'].includes(member) || REFLECT_NAME.test(member ?? '') ? undefined : hit(n, 'unclassifiable', `Buffer.${member} is not classified`);
        if (v === 'Object' && objectFree) {
          if (REFLECT_NAME.test(member ?? '') || OBJECT_OK.has(member)) return undefined;
          return hit(n, 'unclassifiable', member === null ? 'Object used as a value' : `Object.${member} is not classified`);
        }
        if (v === 'encoding' && !(p?.type === 'Property' && p.shorthand)) hit(n, 'encoding-option');
        const mod = byName(v);
        return mod ? useOf(mod, v, n, a.length - 1) : undefined;
      }
      default:
        return rules[n.type] === 'walk' ? undefined : hit(n, 'unclassifiable', rules[n.type] === 'fail' ? `${n.type} is refused` : `node type ${n.type} is not classified`);
    }
  });
  return hits.sort((x, y) => x.pos - y.pos);
}

// ------------------------------------------------------------------ T4a grammar layer: the allowlist the guarded files are written in
//
// The SOUNDNESS GATE of T4a (decision and claim: the HOW block above). A recursive descent over the acorn AST that
// admits only the constructs listed in the GRAMMAR_* tables below and refuses ('unclassifiable', never allowlisted)
// everything else, at the position where it appears. The tables are exactly what the two guarded files use: the
// tightness test fails on an entry the files do not use, so adding a construct means editing a table under review.
// After the descent, any AST node that was neither visited nor inside a refused node is refused too ('not visited'),
// so a production that forgets a child cannot hide code there.

/** Acorn node types admitted somewhere in the grammar (each only at the positions its production below allows). */
const GRAMMAR_TYPES = new Set(['ArrayExpression', 'ArrayPattern', 'ArrowFunctionExpression', 'AssignmentExpression', 'AssignmentPattern',
  'BinaryExpression', 'BlockStatement', 'CallExpression', 'CatchClause', 'ChainExpression', 'ClassBody', 'ClassDeclaration', 'ConditionalExpression',
  'ContinueStatement', 'ExportNamedDeclaration', 'ExpressionStatement', 'ForOfStatement', 'ForStatement', 'FunctionDeclaration', 'FunctionExpression',
  'Identifier', 'IfStatement', 'ImportDeclaration', 'ImportDefaultSpecifier', 'ImportSpecifier', 'Literal', 'LogicalExpression', 'MemberExpression',
  'MethodDefinition', 'NewExpression', 'ObjectExpression', 'ObjectPattern', 'Program', 'Property', 'RestElement', 'ReturnStatement', 'SpreadElement',
  'Super', 'TemplateElement', 'TemplateLiteral', 'ThisExpression', 'ThrowStatement', 'TryStatement', 'UnaryExpression', 'UpdateExpression',
  'VariableDeclaration', 'VariableDeclarator']);
/** Operators admitted, per expression type. Assignment is `=` only and update is `++` only. */
const GRAMMAR_OPS = new Map([
  ['UnaryExpression', new Set(['!', 'typeof', '+'])],
  ['BinaryExpression', new Set(['*', '+', '>>', '&', '<', '<=', '>', '>=', '===', '!==', 'instanceof'])],
  ['LogicalExpression', new Set(['&&', '||', '??'])],
  ['AssignmentExpression', new Set(['='])],
  ['UpdateExpression', new Set(['++'])],
]);
/**
 * Free identifiers: a name declared NOWHERE in the module resolves through globalThis, so it must be one of these,
 * in one of its listed forms: `members` maps a member to 'any' (read anywhere), 'call' (only as a callee), or a
 * pinned production ('ownValue', 'defineThis', 'methodKey', checked where it is used); `call`, `new`, `value`,
 * `instanceof`, `extends` admit the bare name in that position; `newSrc` admits exactly one `new` expression.
 */
const GRAMMAR_GLOBALS = new Map([
  ['Object', { members: new Map([['keys', 'call'], ['entries', 'call'], ['fromEntries', 'call'], ['hasOwn', 'call'], ['freeze', 'any'],
    ['getOwnPropertyDescriptor', 'ownValue'], ['defineProperty', 'defineThis']]) }],
  ['Buffer', { members: new Map([['from', 'call'], ['isBuffer', 'call']]) }],
  ['Array', { members: new Map([['isArray', 'call']]) }],
  ['Number', { members: new Map([['isSafeInteger', 'call']]) }],
  ['Symbol', { members: new Map([['for', 'methodKey']]) }],
  ['String', { call: true, members: new Map([['fromCharCode', 'call']]) }],
  ['process', { members: new Map([['env', 'any'], ['platform', 'any'], ['cwd', 'call']]) }],
  ['TextDecoder', { newSrc: "new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })" }],
  ['Map', { new: true }], ['Set', { new: true }], ['WeakMap', { new: true }], ['TypeError', { new: true }],
  ['Error', { extends: true }], ['Uint8Array', { instanceof: true }], ['Boolean', { value: true }], ['Infinity', { value: true }], ['undefined', { value: true }],
]);
/**
 * Imports, per guarded file: exact specifier -> imported name -> use. A Map, so no inherited name is a key. The
 * local name must equal the imported name (default: any local), and is declared once. Uses: 'call' (callee only),
 * 'spawnSync' (callee only, in the pinned shape below), 'value' (any position; its members are member names),
 * 'member:<m>' (only `local.<m>` as a value), 'callMember:<m>' (only `local.<m>(...)`).
 */
const GRAMMAR_IMPORTS = new Map([
  ['git-exec.mjs', new Map([
    ['node:child_process', new Map([['spawnSync', 'spawnSync']])],
    ['node:fs', new Map([['statSync', 'call']])],
    ['./git-capability.mjs', new Map([['probeGit', 'call']])],
  ])],
  ['git-capability.mjs', new Map([
    ['node:child_process', new Map([['spawnSync', 'spawnSync']])],
    ['node:fs', new Map([['accessSync', 'call'], ['constants', 'member:X_OK'], ['realpathSync', 'callMember:native'], ['statSync', 'call']])],
    ['node:path', new Map([['default', 'value']])],
  ])],
]);
/**
 * Non-computed member names readable on any value that is not a global or a restricted import (also the keys a
 * destructuring pattern may read, and the `this.<name>` a constructor may assign). None names a reflective
 * property or an explicit decoder of any built-in (round 7: `decode` is not here; it is a destructuring-only data key
 * and, as a member, only the pinned GRAMMAR_DECODER call; each name a byte holder defines is in
 * GRAMMAR_BYTE_MEMBER_AUDIT). Implicit ToString through these (`test`, `startsWith`, Array#join or #sort on an array
 * of Buffers) is the documented NOT CHECKED class.
 */
const GRAMMAR_MEMBERS = new Set([
  'PATH', 'add', 'ambient', 'args', 'buffer', 'byteOffset', 'bytes', 'code', 'cwd', 'delete', 'deletes',
  'dirname', 'endsWith', 'env', 'envLimit', 'envTooLarge', 'equals', 'error', 'every', 'exclude', 'exec', 'filter',
  'find', 'flatMap', 'forEach', 'fs', 'get', 'gitInfo', 'globalConfig', 'has', 'home', 'hooksDir', 'includes',
  'isAbsolute', 'isDirectory', 'isExecutableFile', 'isFile', 'join', 'keys', 'lastIndexOf', 'length', 'map',
  'maxBuffer', 'name', 'neutralisation', 'noLazyFetch', 'op', 'pairs', 'partialClone', 'path', 'platform', 'policy',
  'posix', 'prerelease', 'push', 'reduce', 'relative', 'replace', 'resolve', 'selection', 'sep', 'set', 'signal',
  'slice', 'some', 'sort', 'split', 'startsWith', 'status', 'stderr', 'stdout', 'subarray', 'test', 'timeoutMs',
  'toLowerCase', 'toUpperCase', 'total', 'trimEnd', 'value', 'version', 'win32'
]);
/** Destructuring keys that are data fields here but name a decoder method elsewhere (`decode`): readable ONLY as a
 * destructuring key, never as a member expression (round 7). */
const GRAMMAR_DATA_KEYS = new Set(['decode']);
/**
 * The one decoder (round 7, opus r6): the identifier DECODER may appear only as `DECODER.decode(bytes)` in the one
 * statement `s = DECODER.decode(bytes);` of the top-level function decodeStrict, and any other `.decode` member is
 * refused on every value. What DECODER and decodeStrict ARE is fixed by GRAMMAR_PINNED_NAMES (round 8): each resolves to
 * its one pinned top-level declaration in git-exec.mjs, and is refused anywhere else, so the name cannot be rebound.
 */
const GRAMMAR_DECODER = Object.freeze({ binding: 'DECODER', call: 'DECODER.decode(bytes)', stmt: 's = DECODER.decode(bytes);', fn: 'decodeStrict' });
/**
 * Pinned-name resolution (round 8, opus r7: a pin keyed to a NAME must be keyed to a BINDING). Every name a pinned
 * construct relies on, with the one file that may declare it and its one declaration: 'const' (a top-level `const`
 * whose initialiser satisfies `init`) or 'function' (a top-level function declaration). In that file the name must be
 * declared exactly once, as that declaration, and is never assigned or updated; in every other file any declaration
 * of it is refused (a reference there is a free name, which no global allowlists). So each use resolves to the pin.
 * Covered: the decoder pin (DECODER, decodeStrict), the own-data reader production (ownValue and the `own` its text
 * calls), and the enclosing functions ALLOWED_SITES keys its sites by (realFs, resolveGitBinary, parseGitVersion).
 */
const GRAMMAR_PINNED_NAMES = new Map([
  ['DECODER', { file: 'git-exec.mjs', kind: 'const', init: (i, text) => i?.type === 'NewExpression' && text(i) === GRAMMAR_GLOBALS.get('TextDecoder').newSrc }],
  ['decodeStrict', { file: 'git-exec.mjs', kind: 'function' }],
  ['ownValue', { file: 'git-exec.mjs', kind: 'const', init: (i, text) => !!i && text(i) === OWN_VALUE_SRC }],
  ['own', { file: 'git-exec.mjs', kind: 'const', init: (i) => i?.type === 'ArrowFunctionExpression' }],
  ['realFs', { file: 'git-capability.mjs', kind: 'const', init: (i) => i?.type === 'ObjectExpression' }],
  ['resolveGitBinary', { file: 'git-capability.mjs', kind: 'function' }],
  ['parseGitVersion', { file: 'git-capability.mjs', kind: 'function' }],
]);
/**
 * Every GRAMMAR_MEMBERS name that a byte holder (Buffer, Uint8Array, ArrayBuffer, TextDecoder prototype chains) defines,
 * with why it does not decode bytes to text. The audit test derives that set at run time and requires it to equal these
 * keys, so a new member that a byte holder defines forces a decision here (round 7).
 */
const GRAMMAR_BYTE_MEMBER_AUDIT = new Map([
  ['buffer', 'the underlying ArrayBuffer (bytes)'], ['byteOffset', 'a number'], ['length', 'a number'],
  ['equals', 'byte comparison, a boolean'], ['every', 'predicate over numbers, a boolean'], ['some', 'predicate over numbers, a boolean'],
  ['filter', 'a typed array of numbers'], ['map', 'a typed array of numbers'], ['find', 'a number'], ['forEach', 'undefined'],
  ['reduce', 'folds numbers through the callback (analysed code)'], ['keys', 'an iterator of indices'], ['set', 'copies numbers, undefined'],
  ['slice', 'a Buffer view (ArrayBuffer#slice: an ArrayBuffer)'], ['subarray', 'a Buffer view'], ['sort', 'TypedArray#sort is numeric'],
  ['join', 'TypedArray#join joins the NUMBERS (`97,98`), never decodes text'],
  ['includes', 'encodes a string needle (string to bytes); returns a boolean'], ['lastIndexOf', 'encodes a string needle; returns a number'],
]);
/** Member names that ARE decode-capable: admitted by the grammar only as a CALLEE, and only because every use is a
 * legacy-rule hit that must match an ALLOWED_SITES entry (positive control: the layer-link test). */
const GRAMMAR_SITE_PINNED = new Map([['toString', 'decoder-api'], ['realpath', 'name-api-no-buffer']]);
/** Class method keys (besides `constructor` and the one pinned `[Symbol.for('<literal>')]` key). */
const GRAMMAR_METHOD_KEYS = new Set(['toJSON']);
/** Names no declaration may take: every name reachable as a property of globalThis on THIS Node (its prototype
 * chain included: `constructor`, `toString`), the allowlisted globals, and the CommonJS wrapper names. */
const RESERVED_NAME = (name) => name in globalThis || GRAMMAR_GLOBALS.has(name) || ['arguments', 'eval', 'require', 'module', 'exports', '__filename', '__dirname'].includes(name);

/**
 * The grammar layer's refusals for one guarded module: [{file, rule: 'unclassifiable', why, line, pos, text}] in
 * source order, plus `used`, the table entries the module exercised (for the tightness test).
 */
function grammarSites(file, src) {
  assert.ok(acorn, 'the vendored acorn failed its integrity check (UPSTREAM.json)');
  let ast;
  try { ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true }); } catch (e) {
    return { hits: [{ file, fn: '<module>', rule: 'unclassifiable', why: `parse error: ${e.message}`, line: e.loc?.line ?? 1, pos: e.pos ?? 0, text: '' }], used: new Set() };
  }
  const hits = [];
  const used = new Set();
  const seen = new Set();
  const refused = new Set();
  const parent = new Map();
  walk(ast, (n, a) => parent.set(n, a[a.length - 1]));
  const ancestors = (n) => { const a = []; for (let p = parent.get(n); p; p = parent.get(p.node)) a.unshift(p); return a; };
  const text = (n) => src.slice(n.start, n.end).replace(/\s+/g, ' ');
  const refuse = (n, why) => { refused.add(n); hits.push({ file, fn: '<grammar>', rule: 'unclassifiable', why, line: n.loc.start.line, pos: n.start, text: text(n) }); };
  const see = (n) => { seen.add(n); if (!GRAMMAR_TYPES.has(n.type)) { refuse(n, `${n.type} is not in the supported grammar`); return false; } used.add(`type:${n.type}`); return true; };
  const op = (n) => (GRAMMAR_OPS.get(n.type).has(n.operator) ? used.add(`op:${n.type}:${n.operator}`) : refuse(n, `operator ${n.operator} (${n.type}) is not in the supported grammar`));

  // Declarations, by name, anywhere in the module (binding positions only).
  const decl = new Map();
  const declare = (id) => { if (!decl.has(id.name)) decl.set(id.name, []); decl.get(id.name).push(id); };
  const pat = (p) => {
    if (p?.type === 'Identifier') declare(p);
    else if (p?.type === 'ObjectPattern') p.properties.forEach((q) => pat(q.type === 'RestElement' ? q.argument : q.value));
    else if (p?.type === 'ArrayPattern') p.elements.forEach(pat);
    else if (p?.type === 'AssignmentPattern') pat(p.left);
    else if (p?.type === 'RestElement') pat(p.argument);
  };
  walk(ast, (n) => {
    if (n.type === 'VariableDeclarator') pat(n.id);
    if (FN_TYPES.has(n.type)) { if (n.id) declare(n.id); n.params.forEach(pat); }
    if (/^Class(?:Declaration|Expression)$/.test(n.type) && n.id) declare(n.id);
    if (n.type === 'CatchClause') pat(n.param);
    if (/^Import(?:Default|Namespace)?Specifier$/.test(n.type)) declare(n.local);
  });
  for (const [name, ids] of decl) if (RESERVED_NAME(name)) refuse(ids[0], `declaration of ${name}, a global name (no shadowing)`);
  // Pinned-name resolution: a pinned name is declared only as its one pinned top-level declaration, in its own file.
  const topLevel = (n) => /^(?:Program|ExportNamedDeclaration)$/.test(parent.get(n)?.node.type ?? '');
  const pinnedDecl = (id, pin) => {
    const up = parent.get(id);
    if (pin.kind === 'function') return up.node.type === 'FunctionDeclaration' && up.key === 'id' && topLevel(up.node);
    const v = up.node.type === 'VariableDeclarator' && up.key === 'id' ? parent.get(up.node).node : null;
    return !!v && v.kind === 'const' && topLevel(v) && pin.init(up.node.init, text);
  };
  for (const [name, pin] of GRAMMAR_PINNED_NAMES) {
    const ids = decl.get(name) ?? [];
    if (pin.file !== file) { for (const id of ids) refuse(id, `pinned name ${name} declared outside ${pin.file}`); continue; }
    if (ids.length > 1) { for (const id of ids) refuse(id, `pinned name ${name} declared ${ids.length} times`); continue; }
    if (ids.length === 1 && !pinnedDecl(ids[0], pin)) { refuse(ids[0], `pinned name ${name} declared other than as its pinned top-level ${pin.kind}`); continue; }
    if (ids.length === 1) used.add(`pinned-name:${name}`);
  }
  const isLocal = (name) => decl.has(name);

  // Imports: local name -> use.
  const imports = new Map();
  const table = GRAMMAR_IMPORTS.get(file) ?? new Map();
  const importDecl = (d) => {
    see(d); see(d.source);
    const names = table.get(d.source.value);
    if (!names) return refuse(d, `import of ${d.source.value}: not an allowlisted specifier for ${file}`);
    if (d.attributes?.length) return refuse(d, 'import attributes');
    if (!d.specifiers.length) return refuse(d, 'side-effect import');
    for (const s of d.specifiers) {
      if (!see(s)) continue;
      see(s.local);
      if (s.imported) see(s.imported);
      const imported = s.type === 'ImportDefaultSpecifier' ? 'default' : (s.imported.name ?? s.imported.value);
      const u = names.get(imported);
      if (!u) { refuse(s, `${d.source.value} export ${imported} is not allowlisted`); continue; }
      if (imported !== 'default' && s.local.name !== imported) { refuse(s, `import ${imported} renamed`); continue; }
      if (decl.get(s.local.name).length !== 1) { refuse(s, `import ${s.local.name} redeclared`); continue; }
      used.add(`import:${file}:${d.source.value}:${imported}`);
      imports.set(s.local.name, u);
    }
    return undefined;
  };

  /** `id` is the decoder binding inside the one pinned call (text, statement and function all exact). */
  const decoderCall = (id) => {
    const m = parent.get(id);
    const c = m && parent.get(m.node);
    const a = c && parent.get(c.node);
    const st = a && parent.get(a.node);
    const f = c && innermostFn(c.node);
    const fp = f && parent.get(f);
    return m.key === 'object' && m.node.type === 'MemberExpression' && !m.node.computed && m.node.property.name === 'decode'
      && c.key === 'callee' && c.node.type === 'CallExpression' // its text is fixed by the exact statement below
      && a.key === 'right' && a.node.type === 'AssignmentExpression' && st.node.type === 'ExpressionStatement' && text(st.node) === GRAMMAR_DECODER.stmt
      && f.type === 'FunctionDeclaration' && f.id?.name === GRAMMAR_DECODER.fn && /^(?:Program|ExportNamedDeclaration)$/.test(fp?.node.type ?? '');
  };
  /** A bare identifier in position pos: 'value' | 'callee' | 'new' | 'object' | 'instanceof' | 'extends'. */
  const ref = (id, pos) => {
    see(id);
    const name = id.name;
    if (isLocal(name) && name === GRAMMAR_DECODER.binding) {
      if (decoderCall(id)) {
        if (used.has('pin:decoder-call')) return refuse(id, `a second pinned decoder call (exactly one ${GRAMMAR_DECODER.stmt} is admitted)`);
        used.add('pin:decoder-call');
        return true;
      }
      return refuse(id, `the decoder ${name} used other than as the pinned call ${GRAMMAR_DECODER.call} in ${GRAMMAR_DECODER.fn}`);
    }
    if (isLocal(name)) {
      const u = imports.get(name);
      if (u === undefined || u === 'value') return true;
      if (pos === 'callee' && (u === 'call' || u === 'spawnSync')) return true;
      if (pos === 'object' && /^(?:member|callMember):/.test(u)) return true;
      return refuse(id, `import ${name} used as ${pos}`);
    }
    const g = GRAMMAR_GLOBALS.get(name);
    if (!g) return refuse(id, `free identifier ${name} is not an allowlisted global`);
    used.add(`global:${name}`);
    if ((pos === 'object' && g.members) || (pos === 'value' && g.value) || (pos === 'callee' && g.call) || (pos === 'new' && (g.new || g.newSrc))
      || (pos === 'instanceof' && g.instanceof) || (pos === 'extends' && g.extends)) { if (pos !== 'object') used.add(`global:${name}:${pos}`); return true; }
    return refuse(id, `global ${name} used as ${pos}`);
  };

  /** A member expression in position pos ('value' | 'callee'); returns the pinned mode of a global member, if any. */
  const member = (n, pos) => {
    see(n);
    if (n.object.type === 'Super') { see(n.object); return refuse(n, 'a super member'); }
    if (n.computed) {
      if (pos !== 'value') return refuse(n, `a computed member used as ${pos}`);
      if (!(numericKey(n.property) || (n.property.type === 'Identifier' && loopCounter(n.property.name, ancestors(n))))) return refuse(n, 'a computed member key that is not provably numeric');
      used.add('computed:numeric');
      expr(n.object, 'value');
      expr(n.property, 'value');
      return undefined;
    }
    see(n.property);
    if (n.property.type !== 'Identifier') return refuse(n, 'a private member');
    const name = n.property.name;
    const o = n.object;
    if (name === 'decode') {
      if (!(o.type === 'Identifier' && o.name === GRAMMAR_DECODER.binding && isLocal(o.name))) return refuse(n, 'member .decode other than the pinned decoder call');
      ref(o, 'object');
      return undefined;
    }
    if (o.type === 'Identifier' && !isLocal(o.name)) {
      if (!ref(o, 'object')) return undefined;
      const mode = GRAMMAR_GLOBALS.get(o.name).members.get(name);
      if (!mode) return refuse(n, `${o.name}.${name} is not allowlisted`);
      used.add(`global:${o.name}.${name}`);
      if (mode === 'any' || (pos === 'callee' && ['call', 'ownValue', 'defineThis'].includes(mode))) return mode;
      return refuse(n, `${o.name}.${name} used as ${pos}`);
    }
    if (o.type === 'Identifier' && imports.has(o.name)) {
      if (!ref(o, 'object')) return undefined;
      const u = imports.get(o.name);
      if (u === `member:${name}` || (u === `callMember:${name}` && pos === 'callee')) { used.add(`import-member:${o.name}.${name}`); return undefined; }
      if (u !== 'value') return refuse(n, `${o.name}.${name} is not allowlisted`);
    } else expr(o, 'value');
    if (GRAMMAR_MEMBERS.has(name)) { used.add(`member:${name}`); return undefined; }
    if (GRAMMAR_SITE_PINNED.has(name)) {
      if (pos !== 'callee') return refuse(n, `member .${name} (decode-capable) other than as a callee`);
      used.add(`pinned:${name}`);
      return undefined;
    }
    return refuse(n, `member .${name} is not allowlisted`);
  };

  const args = (list) => { for (const x of list) if (x.type === 'SpreadElement') { see(x); expr(x.argument, 'value'); } else expr(x, 'value'); };
  const innermostFn = (n) => { for (let p = parent.get(n); p; p = parent.get(p.node)) if (FN_TYPES.has(p.node.type)) return p.node; return null; };
  /** The one own-data reader: `const ownValue = <OWN_VALUE_SRC>` at module top level, and the call inside it. */
  const ownValueProduction = (call) => {
    const f = innermostFn(call);
    const d = f && parent.get(f);
    const v = d && parent.get(d.node);
    return !!f && text(f) === OWN_VALUE_SRC && d.node.type === 'VariableDeclarator' && d.key === 'init' && d.node.id.type === 'Identifier'
      && d.node.id.name === 'ownValue' && v.node.kind === 'const' && parent.get(v.node)?.node.type === 'Program';
  };
  /** `Object.defineProperty(this, '<plain name>', { value|enumerable|writable|configurable: <literal>, ... })` in a constructor. */
  const defineThis = (call, ctx) => {
    const [o, k, d, ...rest] = call.arguments;
    return ctx.ctor && !rest.length && o?.type === 'ThisExpression' && k?.type === 'Literal' && typeof k.value === 'string' && GRAMMAR_MEMBERS.has(k.value)
      && d?.type === 'ObjectExpression' && d.properties.every((q) => q.type === 'Property' && q.kind === 'init' && !q.computed && !q.shorthand && !q.method
        && ['value', 'enumerable', 'writable', 'configurable'].includes(propName(q)) && q.value.type === 'Literal');
  };
  /** spawnSync(file, [args], { static options with no `encoding` }): Buffer output, nothing reinterpreted as options. */
  const spawnShape = (call) => call.arguments.length === 3 && call.arguments[1].type === 'ArrayExpression' && call.arguments[2].type === 'ObjectExpression'
    && call.arguments[2].properties.every((q) => q.type === 'Property' && q.kind === 'init' && !q.computed && !['encoding', '__proto__'].includes(propName(q)));

  function fn(n, ctx = {}) {
    if (!see(n)) return;
    if (n.async || n.generator) return refuse(n, 'an async or generator function');
    if (n.id) see(n.id);
    n.params.forEach(pattern);
    if (n.body.type === 'BlockStatement') stmt(n.body, { ctor: !!ctx.ctor }); else expr(n.body, 'value', {});
  }
  function pattern(p) {
    if (!see(p)) return;
    switch (p.type) {
      case 'Identifier': return;
      case 'ObjectPattern':
        for (const q of p.properties) {
          if (!see(q)) continue;
          if (q.type === 'RestElement') { pattern(q.argument); continue; }
          see(q.key);
          if (q.computed || q.key.type !== 'Identifier') { refuse(q, 'a destructuring key that is not a plain name'); continue; }
          if (GRAMMAR_DATA_KEYS.has(q.key.name)) used.add(`key:${q.key.name}`);
          else if (!GRAMMAR_MEMBERS.has(q.key.name)) { refuse(q, `destructuring key ${q.key.name} is not allowlisted`); continue; }
          else used.add(`member:${q.key.name}`);
          pattern(q.value);
        }
        return;
      case 'ArrayPattern': p.elements.forEach((e) => e && pattern(e)); return;
      case 'AssignmentPattern': pattern(p.left); expr(p.right, 'value', {}); return;
      case 'RestElement': pattern(p.argument); return;
      default: refuse(p, `${p.type} as a binding pattern`);
    }
  }
  function cls(n) {
    if (!see(n)) return;
    see(n.id);
    if (n.superClass) { if (n.superClass.type === 'Identifier') ref(n.superClass, 'extends'); else refuse(n.superClass, 'a class extending a non-identifier'); }
    see(n.body);
    for (const m of n.body.body) {
      if (!see(m)) continue;
      if (m.type !== 'MethodDefinition' || m.static || !['constructor', 'method'].includes(m.kind)) { refuse(m, `a class member of kind ${m.kind ?? m.type}`); continue; }
      see(m.key);
      if (m.computed) {
        const k = m.key;
        const ok = k.type === 'CallExpression' && k.arguments.length === 1 && k.arguments[0].type === 'Literal' && typeof k.arguments[0].value === 'string'
          && k.callee.type === 'MemberExpression' && !k.callee.computed && k.callee.object.type === 'Identifier' && k.callee.object.name === 'Symbol'
          && !isLocal('Symbol') && k.callee.property.name === 'for';
        if (!ok) { refuse(m, 'a computed class member key other than [Symbol.for(<string>)]'); continue; }
        [k.callee, k.callee.object, k.callee.property, k.arguments[0]].forEach((x) => seen.add(x));
        used.add('global:Symbol').add('global:Symbol.for');
      } else if (m.kind === 'method' && !(m.key.type === 'Identifier' && GRAMMAR_METHOD_KEYS.has(m.key.name))) { refuse(m, `class method ${m.key.name ?? m.key.value} is not allowlisted`); continue; }
      else if (m.kind === 'method') used.add(`method:${m.key.name}`);
      fn(m.value, { ctor: m.kind === 'constructor' });
    }
  }
  function stmt(n, ctx = {}) {
    if (!see(n)) return;
    switch (n.type) {
      case 'VariableDeclaration':
        if (!['const', 'let'].includes(n.kind)) return refuse(n, `a ${n.kind} declaration`);
        for (const d of n.declarations) { see(d); pattern(d.id); if (d.init) expr(d.init, 'value', ctx); }
        return;
      case 'FunctionDeclaration': return fn(n);
      case 'ClassDeclaration': return cls(n);
      case 'ExpressionStatement': return expr(n.expression, 'value', ctx);
      case 'IfStatement': expr(n.test, 'value', ctx); stmt(n.consequent, ctx); if (n.alternate) stmt(n.alternate, ctx); return;
      case 'ForStatement':
        if (n.init) { if (n.init.type === 'VariableDeclaration') stmt(n.init, ctx); else expr(n.init, 'value', ctx); }
        if (n.test) expr(n.test, 'value', ctx);
        if (n.update) expr(n.update, 'value', ctx);
        return stmt(n.body, ctx);
      case 'ForOfStatement':
        if (n.await) return refuse(n, 'for await');
        if (!(see(n.left) && n.left.type === 'VariableDeclaration' && ['const', 'let'].includes(n.left.kind) && n.left.declarations.length === 1 && !n.left.declarations[0].init)) return refuse(n, 'a for-of head that is not one const/let binding');
        see(n.left.declarations[0]);
        pattern(n.left.declarations[0].id);
        expr(n.right, 'value', ctx);
        return stmt(n.body, ctx);
      case 'BlockStatement': n.body.forEach((s) => stmt(s, ctx)); return;
      case 'ReturnStatement': if (n.argument) expr(n.argument, 'value', ctx); return;
      case 'ThrowStatement': return expr(n.argument, 'value', ctx);
      case 'TryStatement':
        stmt(n.block, ctx);
        if (n.handler) { see(n.handler); if (n.handler.param) pattern(n.handler.param); stmt(n.handler.body, ctx); }
        if (n.finalizer) stmt(n.finalizer, ctx);
        return;
      case 'ContinueStatement': if (n.label) refuse(n, 'a labelled continue'); return;
      default: refuse(n, `${n.type} is not admitted as a statement`);
    }
  }
  function expr(n, pos = 'value', ctx = {}) {
    if (n.type === 'Identifier') return ref(n, pos);
    if (n.type === 'MemberExpression') return member(n, pos);
    if (!see(n)) return undefined;
    if (pos !== 'value' && n.type !== 'ChainExpression') return refuse(n, `a ${n.type} in ${pos} position`);
    switch (n.type) {
      case 'Literal': return undefined;
      case 'TemplateLiteral': n.quasis.forEach(see); n.expressions.forEach((e) => expr(e, 'value', ctx)); return undefined;
      case 'ArrayExpression': for (const e of n.elements) if (e) { if (e.type === 'SpreadElement') { see(e); expr(e.argument, 'value', ctx); } else expr(e, 'value', ctx); } return undefined;
      case 'ObjectExpression':
        for (const q of n.properties) {
          if (!see(q)) continue;
          if (q.type === 'SpreadElement') { expr(q.argument, 'value', ctx); continue; }
          see(q.key);
          if (q.computed || q.kind !== 'init') { refuse(q, q.computed ? 'a computed object key' : `an object ${q.kind}ter`); continue; }
          if (propName(q) === '__proto__' && !q.shorthand && !q.method) {
            if (q.value.type === 'Literal' && q.value.value === null) { see(q.value); used.add('proto:null'); } else refuse(q, '__proto__ other than null in an object literal');
            continue;
          }
          if (q.method) fn(q.value); else expr(q.value, 'value', ctx);
        }
        return undefined;
      case 'FunctionExpression': case 'ArrowFunctionExpression': return fn(n);
      case 'ChainExpression': return expr(n.expression, pos, ctx);
      case 'CallExpression': {
        const c = n.callee;
        let mode;
        if (c.type === 'Super') { see(c); if (!ctx.ctor) refuse(c, 'super() outside a constructor'); else used.add('super()'); }
        else if (c.type === 'Identifier') ref(c, 'callee');
        else if (c.type === 'MemberExpression') mode = member(c, 'callee');
        else if (see(c)) refuse(c, `a call of a ${c.type}`);
        if (mode === 'ownValue' && !ownValueProduction(n)) refuse(n, 'Object.getOwnPropertyDescriptor outside the own-data reader production');
        if (mode === 'defineThis' && !defineThis(n, ctx)) refuse(n, 'Object.defineProperty other than the pinned constructor form');
        if (c.type === 'Identifier' && imports.get(c.name) === 'spawnSync' && !spawnShape(n)) refuse(n, 'spawnSync other than (file, [args], { static options without encoding })');
        args(n.arguments);
        return undefined;
      }
      case 'NewExpression': {
        const c = n.callee;
        if (c.type !== 'Identifier') { if (see(c)) refuse(c, `new through a ${c.type}`); }
        else if (ref(c, 'new') && !isLocal(c.name) && GRAMMAR_GLOBALS.get(c.name).newSrc) {
          const d = parent.get(n);
          const v = d && parent.get(d.node);
          if (text(n) !== GRAMMAR_GLOBALS.get(c.name).newSrc) refuse(n, `new ${c.name} other than exactly ${GRAMMAR_GLOBALS.get(c.name).newSrc}`);
          else if (!(d.key === 'init' && d.node.id.type === 'Identifier' && d.node.id.name === GRAMMAR_DECODER.binding && v.node.kind === 'const'
            && parent.get(v.node)?.node.type === 'Program' && decl.get(GRAMMAR_DECODER.binding).length === 1)) refuse(n, `new ${c.name} other than as the one top-level const ${GRAMMAR_DECODER.binding}`);
          else used.add('pin:decoder-binding');
        }
        args(n.arguments);
        return undefined;
      }
      case 'AssignmentExpression': {
        op(n);
        const l = n.left;
        if (l.type === 'Identifier') {
          see(l);
          if (!isLocal(l.name) || imports.has(l.name)) refuse(l, `assignment to ${l.name}, which is not a local binding`);
          else if (GRAMMAR_PINNED_NAMES.has(l.name)) refuse(l, `assignment to the pinned name ${l.name}`);
        }
        else if (l.type === 'MemberExpression' && !l.computed && l.object.type === 'ThisExpression' && l.property.type === 'Identifier' && ctx.ctor && GRAMMAR_MEMBERS.has(l.property.name)) {
          [l, l.object, l.property].forEach((x) => seen.add(x));
          used.add(`member:${l.property.name}`).add('assign:this');
        } else { seen.add(l); refuse(l, 'an assignment target other than a local name or this.<member> in a constructor'); }
        return expr(n.right, 'value', ctx);
      }
      case 'UpdateExpression':
        op(n);
        if (n.argument.type === 'Identifier' && isLocal(n.argument.name) && !imports.has(n.argument.name) && !GRAMMAR_PINNED_NAMES.has(n.argument.name)) see(n.argument);
        else refuse(n, 'an update of something other than a local name');
        return undefined;
      case 'UnaryExpression': op(n); return expr(n.argument, 'value', ctx);
      case 'BinaryExpression': op(n); expr(n.left, 'value', ctx); return expr(n.right, n.operator === 'instanceof' ? 'instanceof' : 'value', ctx);
      case 'LogicalExpression': op(n); expr(n.left, 'value', ctx); return expr(n.right, 'value', ctx);
      case 'ConditionalExpression': expr(n.test, 'value', ctx); expr(n.consequent, 'value', ctx); return expr(n.alternate, 'value', ctx);
      case 'ThisExpression': return undefined;
      default: return refuse(n, `${n.type} is not admitted as an expression`);
    }
  }

  see(ast);
  for (const item of ast.body) {
    if (item.type === 'ImportDeclaration') importDecl(item);
    else if (item.type === 'ExportNamedDeclaration') {
      see(item);
      if (item.source || item.specifiers.length || !item.declaration) refuse(item, 'an export other than `export <declaration>`');
      else stmt(item.declaration);
    } else stmt(item);
  }
  // Fail closed on any node the descent did not reach (outside a refused subtree).
  walk(ast, (n, a) => { if (!seen.has(n) && !a.some(({ node }) => refused.has(node))) refuse(n, `${n.type} not visited by the grammar`); });
  return { hits: hits.sort((x, y) => x.pos - y.pos), used };
}

/** lib/ JS modules (.mjs, .cjs, .js; recursive), excluding *.test.*, as paths relative to lib/ with `/` separators. */
function libModules(dir = here, rel = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? libModules(join(dir, d.name), `${rel}${d.name}/`)
    : /\.(?:mjs|cjs|js)$/.test(d.name) && !/\.test\.(?:mjs|cjs|js)$/.test(d.name) ? [`${rel}${d.name}`] : [])).sort();
}
// Sanctioned sites: [file, enclosing function, rule, ordinal of that rule in that function (source order), the
// COMPLETE invocation's source (whitespace-normalised: callee and every argument), its CONTEXT (the enclosing
// statement, only its head for a compound statement, or the parameter default it sits in), reason]. A hit no entry
// names exactly fails, and so does an entry no hit matches (stale): a second same-rule site in the function is a new
// ordinal, any change to the call (`toString('latin1')` -> `toString('utf8')`, or `toString() || 'latin1'`) changes
// its invocation text, and moving the call to another statement, or changing what consumes it there, changes its
// context. The LINE is not pinned, so CRLF and reformatting elsewhere do not matter.
// `unclassifiable` is never allowlisted.
const ALLOWED_SITES = [
  ['git-exec.mjs', '<module>', 'decoder-api', 0, "new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })", "const DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });", 'the one strict decoder (fatal and ignoreBOM true; decoder-lossy fires otherwise)'],
  ['git-exec.mjs', '<module>', 'encoding-literal', 0, "new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })", "const DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });", 'its label'],
  ['git-capability.mjs', 'realFs.realpath', 'name-api-no-buffer', 0, 'realpathSync.native(p)', 'return realpathSync.native(p);', 'resolves PATH entries (already strings) to the spawn executable; never compared with git output (S-02a0a, owned there)'],
  ['git-capability.mjs', 'resolveGitBinary', 'cwd', 0, 'process.cwd()', 'cwd = process.cwd()', 'default cwd used only to ban PATH dirs inside it; never compared with git output (S-02a0a, owned there)'],
  ['git-capability.mjs', 'resolveGitBinary', 'name-api-no-buffer', 0, 'fs.realpath(d)', 'const banned = [cwd, ...exclude].flatMap((d) => [P.resolve(d), fs.realpath(d)]).filter(Boolean);', 'the resolver seam: realpath of caller-supplied string dirs, compared only with other PATH strings (S-02a0a)'],
  ['git-capability.mjs', 'resolveGitBinary', 'string-coercion', 0, "String(pathVar ?? '')", "for (const raw of String(pathVar ?? '').split(win ? ';' : ':'))", 'coerces the PATH env value (already a string), not bytes'],
  ['git-capability.mjs', 'resolveGitBinary', 'name-api-no-buffer', 1, 'fs.realpath(file)', 'const real = fs.realpath(file);', 'the resolver seam: the spawn executable, never compared with git output (S-02a0a)'],
  ['git-capability.mjs', 'parseGitVersion', 'string-coercion', 0, 'String(out)', "const bytes = Buffer.isBuffer(out) ? out : Buffer.from(String(out), 'utf8');", 'encodes (string to bytes); not a decode'],
  ['git-capability.mjs', 'parseGitVersion', 'encoding-literal', 0, "Buffer.from(String(out), 'utf8')", "const bytes = Buffer.isBuffer(out) ? out : Buffer.from(String(out), 'utf8');", 'Buffer.from(string, utf8): string to bytes'],
  ['git-capability.mjs', 'parseGitVersion', 'decoder-api', 0, "bytes.toString('latin1')", "const m = VERSION.exec(bytes.toString('latin1'));", 'lossless byte-to-code-point map feeding an ASCII-only anchored regex; any non-ASCII byte fails it (S-02a0a, owned there)'],
  ['git-capability.mjs', 'parseGitVersion', 'encoding-literal', 1, "bytes.toString('latin1')", "const m = VERSION.exec(bytes.toString('latin1'));", 'the encoding of that map'],
];
/** Each hit's site key: file, function, rule, its ordinal among same-(file, function, rule) hits in order, its complete invocation and its context. */
const siteKeys = (hits) => { const seen = new Map(); return hits.map((h) => { const b = `${h.file}\0${h.fn}\0${h.rule}`; const n = seen.get(b) ?? 0; seen.set(b, n + 1); return `${b}\0${n}\0${h.site}\0${h.ctx}`; }); };
/** unexplained: hits no entry names; stale: entries no hit matches. */
function allowVerdict(hits, allowed = ALLOWED_SITES) {
  const keys = siteKeys(hits);
  const want = allowed.map(([f, fn, r, n, text, ctx]) => `${f}\0${fn}\0${r}\0${n}\0${text}\0${ctx}`);
  return { unexplained: keys.filter((x) => !want.includes(x)), stale: want.filter((x) => !keys.includes(x)) };
}

test('T4a: no listed lossy decode form appears in the scanned lib outside the strict decoder or an allowlisted, reasoned site', () => {
  const files = SCANNED;
  const hits = files.flatMap((f) => decodeSites(f, readFileSync(join(here, f), 'utf8'), SCANNED));
  assert.deepEqual(hits.filter((h) => h.rule === 'unclassifiable'), [], 'no site the checker cannot classify (fail closed; never allowlisted)');
  assert.deepEqual(files.flatMap((f) => grammarSites(f, readFileSync(join(here, f), 'utf8')).hits), [], 'the grammar layer (the soundness gate) refuses nothing');
  const { unexplained, stale } = allowVerdict(hits);
  assert.deepEqual(unexplained, []);
  assert.deepEqual(stale, [], 'every allowlist entry matches a real site');
  assert.ok(!ALLOWED_SITES.some(([, , r]) => r === 'unclassifiable'));
  // One more site of an allowlisted rule in the same function is a new ordinal, so it is unexplained.
  const extra = allowVerdict([...hits, { ...hits.find((h) => h.fn === 'parseGitVersion' && h.rule === 'decoder-api'), pos: Infinity }]);
  const CTX = "\0const m = VERSION.exec(bytes.toString('latin1'));";
  assert.deepEqual(extra.unexplained, [`git-capability.mjs\0parseGitVersion\0decoder-api\x001\0bytes.toString('latin1')${CTX}`]);
  // Swapping an allowlisted site for another of the same rule in the same function changes its invocation, so it fails.
  const swapped = allowVerdict(hits.map((h) => (h.text === "'latin1'" ? { ...h, site: "bytes.toString('utf8')" } : h)));
  assert.deepEqual([swapped.unexplained, swapped.stale], [[`git-capability.mjs\0parseGitVersion\0encoding-literal\x001\0bytes.toString('utf8')${CTX}`], [`git-capability.mjs\0parseGitVersion\0encoding-literal\x001\0bytes.toString('latin1')${CTX}`]]);
  // The context is pinned too: the same invocation moved to another statement (here: its result returned
  // instead of matched) leaves function, rule, ordinal and invocation unchanged, but no allowlisted context.
  const moved = decodeSites('git-capability.mjs', readFileSync(join(here, 'git-capability.mjs'), 'utf8').replace("const m = VERSION.exec(bytes.toString('latin1'));", "const m = VERSION.exec(''); if (!m) return bytes.toString('latin1');"), SCANNED);
  assert.deepEqual(allowVerdict([...hits.filter((h) => h.file !== 'git-capability.mjs'), ...moved]).unexplained, [
    "git-capability.mjs\0parseGitVersion\0decoder-api\x000\0bytes.toString('latin1')\0return bytes.toString('latin1');",
    "git-capability.mjs\0parseGitVersion\0encoding-literal\x001\0bytes.toString('latin1')\0return bytes.toString('latin1');",
  ]);
  // The complete invocation is pinned, not just the member: dropping the decode's argument (the review's
  // `bytes.toString() || 'latin1'`) leaves both literal and member in parseGitVersion, but no allowlisted invocation.
  const capSrc = readFileSync(join(here, 'git-capability.mjs'), 'utf8');
  assert.equal(capSrc.split("bytes.toString('latin1')").length, 2, 'the allowlisted decode site is in git-capability.mjs once');
  const argless = decodeSites('git-capability.mjs', capSrc.replace("bytes.toString('latin1')", "bytes.toString() || 'latin1'"), SCANNED);
  assert.deepEqual(allowVerdict([...hits.filter((h) => h.file !== 'git-capability.mjs'), ...argless]).unexplained, [
    "git-capability.mjs\0parseGitVersion\0decoder-api\x000\0bytes.toString()\0const m = VERSION.exec(bytes.toString() || 'latin1');",
    "git-capability.mjs\0parseGitVersion\0encoding-literal\x001\0VERSION.exec(bytes.toString() || 'latin1')\0const m = VERSION.exec(bytes.toString() || 'latin1');",
  ]);
  assert.ok(hits.some((h) => h.file === 'git-exec.mjs' && h.rule === 'decoder-api' && h.fn === '<module>'), 'positive control: the decoder site itself was seen');
  // L10: a CRLF checkout (Windows) gives the same verdict.
  const crlf = files.flatMap((f) => decodeSites(f, readFileSync(join(here, f), 'utf8').replace(/\r?\n/g, '\r\n'), SCANNED));
  assert.deepEqual(crlf.map((h) => [h.file, h.line, h.fn, h.rule, h.text, h.site]), hits.map((h) => [h.file, h.line, h.fn, h.rule, h.text, h.site]));
});

const rulesOf = (src) => decodeSites('m.mjs', src).map((h) => h.rule).sort();
const D = ['decoder-api'];
const N = ['name-api-no-buffer'];
const U = ['unclassifiable'];
// Every input of the replaced token scanner's planted table (head 4ffb444), verbatim, with the AST checker's
// exact rules. Changes from that table: a parse error is `unclassifiable`; `/`-ambiguity cases now parse and
// report only their real site; an escaped `toString` is resolved to toString; a child_process namespace
// or default import is resolved through its binding, so the import alone (no use) has nothing to report.
const PLANTED = [
  ['const s = r.stdout.toString();', D], ["const s = buf.toString('utf8');", ['decoder-api', 'encoding-literal']],
  ["spawnSync(b, a, { encoding: 'utf8' })", ['encoding-literal', 'encoding-option', 'unclassifiable']],
  ['spawnSync(b, a, { encoding: "latin1" })', ['encoding-literal', 'encoding-option', 'unclassifiable']],
  ['const d = new TextDecoder();', ['decoder-api', 'decoder-lossy']], ["readFileSync(p, 'utf-8')", ['encoding-literal', 'read-encoding']],
  ['x.utf8Slice(0)', D], ["child.stdout.setEncoding('x')", D], ['const z = buf.toString("latin1")', ['decoder-api', 'encoding-literal']],
  ['const t = String(r.stdout);', ['string-coercion']], ['const u = Buffer.prototype.toString.call(b);', ['decoder-api', 'unclassifiable']],
  ['const l = buf.toLocaleString();', D], ["const m = buf['toString']();", D], ['const n = buf[ "toLocaleString" ]();', D],
  ['const d = new globalThis.TextDecoder();', ['decoder-api', 'unclassifiable']], ['const D = TextDecoder; const d = new D();', ['decoder-api', 'decoder-lossy']],
  ['const r = realpathSync.native(dir);', N], ['const r = realpathSync(dir, {});', N], ['const l = readdirSync(dir);', N],
  ['const t = readlinkSync(p);', N], ['const m = mkdtempSync(prefix);', N], ['const c = process.cwd();', ['cwd']], ['const r = fs.realpath (p, cb);', U],
  ["const cwd = process.cwd(); const names = readdirSync(dir, { encoding: 'buffer' });", ['cwd']],
  ["const names = readdirSync(dir); const o = { encoding: 'buffer' };", N], ["const names = readdirSync(dir, f({ encoding: 'buffer' }));", U],
  ["const a = readdirSync(d, { encoding: 'buffer' }), b = readlinkSync(p);", N],
  ["const u = 'a//b', s = buf.toString();", D], ['const u = "a//b", s = buf.toString();', D], ['const u = `a//b`, s = buf.toString();', D],
  ['const u = "/*", s = buf.toString(); // */', D], ['/* x */ buf.toString()', D], ['const re = /\\/\\//; const s = buf.toString();', D],
  ['const re = /[/]/; buf.toString()', D], ['* buf.toString()', U], ['const t = `${buf.toString()}`;', D], ['const t = `${ { a: 1 }.a }${String(b)}`;', ['string-coercion']],
  ['const t = `a${`b${b.toString()}`}`;', D],
  ['readdirSync(\n  dir,\n  {}\n)', N], ['const s = buf\n  .toString();', D], ["readdirSync(\r\n  dir,\r\n  { encoding:\r\n 'buffer' }\r\n)", []],
  ["buf['to\\x53tring']()", D], ["const e = 'utf\\x38';", ['encoding-literal']], ["buf[k + 'String']()", ['unclassifiable', 'unclassifiable']], ['buf.\\u0074oString()', D],
  ["import { readdirSync as rd } from 'node:fs';\nrd(dir);", N], ['const { readdirSync: rd } = fs;', U],
  ['const f = readdirSync; f(dir);', U], ['[a].map(realpathSync)', U], ["import * as cp from 'node:child_process';", []],
  ["import cp from 'child_process';", []], ["const fs = require('node:fs');", U], ["const fs = await import('node:fs');", U],
  ["export { realpathSync as rp } from 'node:fs';", U], ["import { TextDecoder } from 'node:util';", ['decoder-api', 'unclassifiable']],
  ['spawnSync(b, a, opts)', U], ['spawnSync(b, a, { ...opts })', U],
  ['spawnSync(b, a, { encoding })', ['encoding-option', 'unclassifiable']],
  ['readFileSync(p, enc)', U], ["readFileSync(p, { encoding: 'utf8' })", ['encoding-literal', 'encoding-option', 'read-encoding']], ["const o = { encoding: 'buffer' + x };", ['encoding-option']],
  ["x.encoding = 'buffer';", ['encoding-option']], ["const o = { ['encoding']: 'utf8' };", ['encoding-literal', 'encoding-option']], ['arr.map(String)', ['string-coercion']],
  ["process['cwd']()", ['cwd']], ['const { cwd } = process;', U], ['const g = process.cwd;', U], ['eval(s)', U],
  ['const x = (a) / 2; buf.toString();', D], ["const s = 'it\\'s', t = buf.toString();", D],
  ["function f() { return /'/.test(x) && buf.toString(); }", D],
  ['const l = fs.readdirSync(dir)\n{ x() }', N], ['realpath(p) { return p; }', U], ['const of = 2, q = of / 2, s = buf.toString(), r = 4 / 2;', D],
  ["export default /'/.test(buf.toString()) || /'/.test(x);", D], ["mkdtempSync('buffer')", N], ["readdirSync('buffer')", N], ['String.call(null, buf)', ['string-coercion']],
  ['String.apply(null, [buf])', ['string-coercion']], ['readFileSync(...a)', U], ["readdirSync(...a, { encoding: 'buffer' })", U], ["const s = 'open", U], ['/* open', U],
  ['const t = `open', U], ['const t = `${open', U], ['const r = /open', U], ['i++ / 2', []],
  // two of the replaced scanner's FINE inputs that the AST checker rightly rejects
  ["spawnSync(b, a, { encoding: 'buffer' })", U], ["import { readdirSync, spawnSync } from 'node:fs';", U],
];
// Every escape the three review rounds reported against the token scanner, plus the forms they named.
const ESCAPES = [
  ['const q = 𝑥 / 2, s = buf.toString(), r = 4 / 2;', D], ['𝑥["to" + "String"]()', D], ['const of = buf; of["to" + "String"]();', D],
  ["while (false) { break\n/'/; } buf.toString(); /'/;", D], ["while (false) { break\r\n/'/; } buf.toString(); /'/;", D],
  ["readdirSync(dir, {}, 'buffer');", N], ['readdirSync(dir, opts, "buffer");', U], ["globalThis.eval('buf.toString()');", U],
  ["import { default as cp } from 'node:child_process';\ncp.exec(c);", ['cp-encoding']],
  ["process.getBuiltinModule('node:child_process').execSync(c, { encoding: 'utf8' });", ['cp-encoding', 'encoding-literal', 'encoding-option', 'unclassifiable']],
  ["import { createRequire } from 'node:module';\ncreateRequire(import.meta.url)('node:child_process');", U.concat(U)],
  ["spawnSync(b, [], { __proto__: o });", U.concat(U)], ["spawnSync(b, [], { get encoding() { return 'utf8'; } });", ['encoding-literal', 'encoding-option', 'unclassifiable']],
  ['const { ["to" + "String"]: f } = buf;', D], ['(function () {}).constructor("return b.toString()");', U],
  ["import readline from 'node:readline';", U], ["import { text } from 'node:stream/consumers';", U], ['new Blob([buf]).text();', D], ['new Response(buf).text();', D],
  ["import * as fs from 'node:fs';\nfs.globSync('*');", U], ["import * as fs from 'node:fs';\nfs.mkdtempDisposableSync(p);", U], ["process.binding('fs');", U],
  ["Reflect.get(buf, 'to' + 'String');", ['decoder-api', 'unclassifiable']], ["const k = 'toString'; buf[k]();", ['decoder-api', 'unclassifiable']],
  ["import { readdirSync as rd } from 'node:fs';\nconst x = rd;", U], ["import * as fs from 'node:fs';\nfs.readdirSync(d);", N],
  ["import fs from 'node:fs';\nfs.promises.readdir(d);", N], ["import { promises as P } from 'node:fs';\nP.readlink(d);", N], ["import fs from 'node:fs';\nfs.default.readdirSync(d);", N],
  ["import * as fs from 'node:fs';\nconst f = fs;", U], ["import * as fs from 'node:fs';\nfs.readdirSync.call(null, d);", U],
  ["import * as fs from 'node:fs';\n(0, fs.readdirSync)(d);", U], ["import { readdirSync } from 'node:fs';\nnew readdirSync(d);", U],
  ["import { readdirSync } from 'node:fs';\nexport { readdirSync };", U], ['export { readdirSync };', U], ["export * from 'node:fs';", U],
  ['execFile(f, [], (e, out) => out);', ['cp-encoding']], ['execFile(f, [], cb);', U], ['spawn(b, []);', U], ["import cp from 'node:child_process';\ncp.fork(m);", U],
  ["new TextDecoder('utf-8', { fatal: false });", ['decoder-api', 'decoder-lossy', 'encoding-literal']],
  ["new TextDecoder('utf-8', { fatal: true, fatal: false });", ['decoder-api', 'decoder-lossy', 'encoding-literal']],
  ["new TextDecoder('utf-8', { fatal: true });", ['decoder-api', 'decoder-lossy', 'encoding-literal']],
  ["new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });", ['decoder-api', 'decoder-lossy', 'encoding-literal']],
  ["new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });", ['decoder-api', 'encoding-literal']],
  ["spawnSync(b, [], { [k]: 'utf8' });", ['encoding-literal', 'unclassifiable']], ["readdirSync(d, { [k]: 'x', encoding: 'buffer' });", U],
  ["import * as os from 'node:os';", U], ["import { mkdirSync } from 'node:fs';", U], ["import * as fs from 'node:fs';\nfs.mkdir(d, cb);", U],
  ["new TextDecoder(...['utf-8', {}], { fatal: true, ignoreBOM: true });", ['decoder-api', 'decoder-lossy', 'encoding-literal']],
  ['const { constructor: F } = () => {};', U],
  // one literal case per deny-list member (deleting a member must turn one red)
  ['Function("x");', U], ['module.exports = 1;', U], ['exports.x = 1;', U], ['WebAssembly.compile(b);', U], ['self.x;', U], ['window.x;', U],
  ['global.x;', U], ['require.resolve(x);', U], ['createRequire;', U], ['getBuiltinModule;', U], ['process.mainModule;', U],
  ['const d = new StringDecoder();', D], ['new TextDecoderStream();', D], ['atob(s);', D], ['new File([b], "n").text();', D],
  ['b.base64Slice(); b.base64urlSlice(); b.hexSlice(); b.latin1Slice(); b.asciiSlice(); b.ucs2Slice(); b.utf16leSlice(); b.binarySlice();', Array(8).fill('decoder-api')],
  ["const e = ['ascii', 'binary', 'ucs2', 'ucs-2', 'utf16le', 'utf-16le', 'UTF8', 'Latin1'];", Array(8).fill('encoding-literal')],
  ['opendirSync(d);', N], ['opendir(d, (e, x) => x);', N], ['mkdtemp(p, (e, x) => x);', N], ['readlink(p, (e, x) => x);', N], ['realpath(p, (e, x) => x);', N],
  ['readdir(d, (e, x) => x);', N], ["import { readdir } from 'fs/promises';\nreaddir(d);", N], ["import { opendir } from 'node:fs/promises';\nopendir(d);", N],
  ["readFile(p, 'utf8', cb);", ['encoding-literal', 'read-encoding']], ["import { readFile } from 'node:fs/promises';\nawait readFile(p, 'latin1');", ['encoding-literal', 'read-encoding']],
  ["import { execSync } from 'child_process';\nexecSync(c, { encoding: 'utf8' });", ['cp-encoding', 'encoding-literal', 'encoding-option']],
  ["execFileSync(f, [], { encoding: 'ascii' });", ['cp-encoding', 'encoding-literal', 'encoding-option']], ['exec(c, (e, out) => out);', ['cp-encoding']], ["exec(c, 'buffer', cb);", U], ["execSync(c, 'buffer');", U], ["spawnSync(b, [...a], { encoding: 'utf8' })", ['cp-encoding', 'encoding-literal', 'encoding-option']],
  ["import path from 'node:path';\nexport const f = (path) => path.readdirSync('.');", N], ["import { statSync } from 'node:fs';\nfunction f(statSync) { return statSync.readdirSync(d); }", N], ["import { x } from './x.cjs';", U], ["import { x } from './x.test.mjs';", U], ['String.raw({ raw: [buf] });', ['string-coercion']], ['buf[`to${s}`]();', U.concat(U)], ['const e = `latin1`;', ['encoding-literal']], ["const v = x['utf8'];", ['encoding-literal']], ["import { x } from '../outside.mjs';", U], ['process.argv;', U], ['typeof process;', U],
];
// Round 5 (invariant level). Import and re-export specifiers resolve as Node resolves them (MEASURED, Node 18 and 22)
// and must land on a file of the scanned set (fixtures: lib/m.mjs in FIXTURE_SET).
const RESOLVE = [
  ["import { r } from './%2e%2e/bridge.mjs';\nr(dir);", U], ["import { r } from './%2E%2E/bridge.mjs';", U], ["import { r } from './.%2e/bridge.mjs';", U],
  ["export { r } from './%2e%2e/bridge.mjs';", U], ["export * from './sub/%2e%2e/%2e%2e/x.mjs';", U], ["import { r } from './git-exec';", U],
  ["import { r } from './sub%2fx.mjs';", U], ["import { r } from 'file:///etc/x.mjs';", U], ["import { r } from '#internal';", U],
  ["import r from 'data:text/javascript,export default 1';", U], ["import { r } from './GIT-EXEC.mjs';", U], ["import { r } from 'node:fs?x';", U],
  ["import { r } from './sub/';", U], ["import { r } from './m.test.mjs';", U],
  ["import { r } from 'file:git-exec.mjs';", U], ["import { r } from 'file:./git-exec.mjs';", U], ["export * from 'file:sub/x.mjs';", U],
  // round 6 (codex r5 #2): an inherited dictionary name is not a watched builtin (the table is a Map)
  ...['constructor', '__defineGetter__', '__defineSetter__', 'hasOwnProperty', '__lookupGetter__', '__lookupSetter__', 'isPrototypeOf', 'propertyIsEnumerable',
    'toString', 'valueOf', '__proto__', 'toLocaleString'].map((x) => [`import '${x}';`, U]),
  // round 6 (opus r5 B1): a compound or logical assignment reads the name, so a refused global stays refused
  ['Function ||= 0;', U], ['eval ??= 0;', U], ['process += 1;', U], ['Buffer ||= 0;', U], ['Reflect &&= 0;', U],
];
const RESOLVE_FINE = ["import { decodeStrict } from './sub/%2e%2e/git-exec.mjs';", "import { decodeStrict } from './git%2Dexec.mjs';",
  "import { decodeStrict } from './git-exec.mjs?v=1#f';", "export * from './sub/../sub/x.mjs';",
  `import { decodeStrict } from ${JSON.stringify(pathToFileURL(join(here, 'git-exec.mjs')).href)};`];
// Reflection by any key form fails closed (never allowlisted); the reviews' descriptor escapes verbatim first.
const REFLECT = [
  ["const s = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(() => {}), 'constructor').value('b', 'return b.toString()')(buf);", U.concat(U, U)],
  ["Object.getOwnPropertyDescriptor(Object.getPrototypeOf(() => {}), 'constructor').value('return b.toString()')();", U.concat(U, U)],
  ["Object.getOwnPropertyDescriptor(Object.getPrototypeOf(buf), 'to' + 'String').value.call(buf);", ['decoder-api', 'unclassifiable', 'unclassifiable']],
  ['Object.values(Object.getOwnPropertyDescriptors(Object.getPrototypeOf(buf))).find((d) => d).value.call(buf);', U.concat(U)],
  ["x['constructor'];", U], ['x[`constructor`];', U], ["x['con' + 'structor'];", U], ['x.prototype;', U], ['x.__proto__;', U], ["x['__proto__'];", U],
  ['const { prototype: p } = F;', U], ["const { ['__pro' + 'to__']: p } = o;", U], ["const k = 'constructor';", U], ["const k = 'con' + 'structor';", U],
  ["const k = `con${'structor'}`;", U], ["const k = `to${'String'}`;", D], ['new Proxy(o, {});', U], ['Object.setPrototypeOf(a, b);', U], ['Object.defineProperties(a, {});', U],
  ["x.__lookupGetter__('a');", U], ['const o = { __proto__: p };', U], ['const O = Object;', U], ['Object.getOwnPropertyNames(o);', U], ['[o].map(Object);', U],
  ['class A extends B { m() { return super.constructor; } }', U], ["Object.defineProperty(o, 'x', { value: 1 });", U], ["Object.defineProperty(this, 'x', { get() { return 1; } });", U],
  ["Object.defineProperty(this, 'toString', { value: 1 });", ['decoder-api', 'unclassifiable']], ["Object.defineProperty(this, 'x', { value: v });", U],
  ["Object.defineProperty(this, 'x', { value: 1 }, 2);", U], ['const Object = o; Object.getPrototypeOf(x);', U],
  // the same names on a receiver other than Object, and Buffer members outside its list
  ['o.getOwnPropertyDescriptors(x);', U], ['o.getOwnPropertyDescriptor(x, k);', U], ['o.setPrototypeOf(x, y);', U], ['Buffer.of(1);', U], ['Buffer.poolSize;', U],
];
// The one own-data reader production, and each one-step deviation from it.
const OWN_VALUE = `const ownValue = ${OWN_VALUE_SRC};`;
const OWN_VALUE_BAD = [['Object.getOwnPropertyDescriptor(o, k)', 'Object.getOwnPropertyDescriptor(f(o), k)'], ['Object.getOwnPropertyDescriptor(o, k)', "Object.getOwnPropertyDescriptor(o, 'x')"],
  ['? d.value :', '? d.value() :'], ['(o, k) =>', '(o, k, j) =>'], ["own(d, 'value')", "own(d, 'get')"], ['const d = ', 'let d = ']].map(([a, b]) => OWN_VALUE.replace(a, b));
// A read through a computed key: only a provably numeric key, a for-let counter, or a frozen null-prototype literal table.
const COMPUTED = [
  ['const v = buf[k];', U], ['const m = buf[k]; m.call(buf);', U], ['const { [k]: f } = buf;', U], ['buf[k] += 1;', U], ['x[n + 1];', U], ['x[i];', U],
  ['for (var i = 0; i < n; i++) x[i];', U], ['for (let i = 0; i < n; i++) { i = j; x[i]; }', U], ['for (let i = 0; i < n; i++) { const f = (i) => x[i]; }', U],
  ['for (let i = 0; i < n; i++) { [i] = a; x[i]; }', U], ['for (let i = 0; i < n; i += 1) x[i += 2];', U], ['for (let i = j; i < n; i++) x[i];', U],
  ['for (let i = 0; i < n; i = k) x[i];', U], ['for (let i = 0, j = 0; i < n; i++) x[i];', U],
  ["const o = { __proto__: null, A: 'a' }; o[k];", U], ['const o = Object.freeze({ __proto__: null, A: f }); o[k];', U],
  ["let o = Object.freeze({ __proto__: null, A: 'a' }); o[k];", U], ["const o = Object.freeze({ __proto__: null, A: 'a' }); function g(o) { return o[k]; }", U],
  ["const o = Object.freeze({ A: 'a' }); o[k];", U], ['const o = Object.freeze({ __proto__: null, ...p }); o[k];', U],
  ["const o = Object.freeze({ __proto__: null, A: 'a' }); const Object = q; o[k];", U],
  ["const o = Object.assign({ __proto__: null, A: 'a' }); o[k];", U], ["const o = f({ __proto__: null, A: 'a' }); o[k];", U],
  // round 6: the frozen-table exemption is gone (its spelling was trusted, codex r5 #1; module-wide, opus r5 M1), so a
  // read through a non-numeric key is refused whatever the table looks like (this was a FINE fixture in round 5).
  ["const o = Object.freeze({ __proto__: null, A: 'a', B: 1 }); const v = o[k] ?? 'z';", U],
];
const COMPUTED_FINE = ['for (let i = 0; i < n; i++) x[i];', 'for (let i = 0; x[i]; i++);', 'for (let i = 0; i < 3; i++) if (a[i] !== b[i]) f(a[i] > b[i]);',
  'x[b >> 4]; x[b & 15]; x[-1]; x[n - 1]; x[i++]; x[~i]; x[+k]; x[2n];', 'delete o[k];', 'o[k] = v;',
  // layer 2 treats a module-local `Object` as a local (layer 1 refuses the declaration: GRAMMAR_REFUSED)
  'const Object = q; Object.foo;',
  OWN_VALUE, "Object.defineProperty(this, 'name', { value: 'n', enumerable: false });", 'class C { constructor(a) { this.a = a; } }', 'const o = Object.freeze(Object.keys(p).map(Object.freeze));'];
// What the coverage statement declares NOT CHECKED: asserted to give no hit, so the statement stays true.
const UNCHECKED = ['const s = `${buf}`;', "const s = buf + '';", 'const s = [buf].join();', 'const s = [buf].sort();', "const s = 'a'.startsWith(buf);", 'const o = JSON.parse(buf);', 'const s = String.fromCharCode(...buf);',
  'const m = re.exec(buf);', "import path from 'node:path';\nconst r = path.resolve('x');"];
const FINE = [...RESOLVE_FINE, ...COMPUTED_FINE, '// buf.toString() in a comment', "const n = decodeStrict(buf, 'path_not_utf8');",
  "const r = realpathSync.native(dir, { encoding: 'buffer' });", "const l = readdirSync(dir, { encoding: 'buffer' });", 'const s = statSync(cwd);',
  "const l = readdirSync(dir, 'buffer');", "const r = await fs.promises.readlink(p, { encoding: 'buffer' });",
  'const m = /utf8/.exec(s);', 'const s = `utf8 is ${n} bytes`;', 'const n = String.fromCharCode(b);', 'const s = "it\'s // not a comment";',
  'env[`GIT_CONFIG_KEY_${i}`] = k;', 'x = a / b;', 'readFileSync(p)', "spawnSync(b, ['--version'], { cwd, env })", 'const o = { cwd: process.env.HOME };',
  "spawnSync(b, ['x'], { encoding: 'buffer' })", "spawnSync(b, [...args], { cwd, env });", "import { readdirSync } from 'node:fs';\nimport { spawnSync } from 'node:child_process';",
  "exec(c, { encoding: 'buffer' }, cb);", "execFileSync(f, ['-v']);", "spawnSync(b, null, { encoding: 'buffer' });", 'spawnSync(b, { cwd });',
  "import cp from 'node:child_process';\ncp.spawnSync(b, ['x'], { encoding: 'buffer' });", "import * as fs from 'node:fs';\nfs.readdirSync(d, { encoding: 'buffer' });",
  "import { readFile } from 'node:fs/promises';\nawait readFile(p);", 'readFileSync(p, (e, b) => b);', 'decodeStrict(b);',
  'const x = 4 / 2, y = (a) / 2, z = i++ / 2;', 'const o = { toJSON() { return 1; } };', 'function f(readdirSync, exec) { return 1; }', "import { decodeStrict } from './git-exec.mjs';\nexport * from './sub/x.mjs';", "import { statSync, constants } from 'node:fs';\nstatSync(p, constants);"];

test('T4a checker flags every planted form and reviewer escape with exactly its rules, and only what it claims', () => {
  const cases = [...PLANTED, ...ESCAPES, ...RESOLVE, ...REFLECT, ...COMPUTED, ...OWN_VALUE_BAD.map((p) => [p, U]), ...[...UNCHECKED, ...FINE].map((p) => [p, []])];
  assert.ok(cases.length > 250, 'every fixture list is present');
  const wrong = cases.map(([p, want]) => [p, rulesOf(p), [...want].sort()]).filter(([, got, want]) => got.join() !== want.join());
  assert.deepEqual(wrong, [], 'each case: [source, rules found, rules expected]');
  assert.deepEqual(decodeSites('m.mjs', 'const a = 1;\nconst s = buf\n  .toString();').map((h) => h.line), [2], 'a site reports its own line');
  const fns = decodeSites('m.mjs', 'const o = { f(x) { return x.toString(); } };\nfunction g() { const h = () => String(1); }\nclass C { m() { return process.cwd(); } }');
  assert.deepEqual(fns.map((h) => h.fn), ['o.f', 'g.h', 'C.m'], 'sites are keyed by their enclosing named functions');
});

test('T4a partitions every lib/ JS module (.mjs, .cjs, .js, recursively) and skips only *.test.*', (t) => {
  const d = tmp(t);
  mkdirSync(join(d, 'sub', 'deeper'), { recursive: true });
  for (const f of ['a.mjs', 'a.test.mjs', 'n.js', 'c.cjs', 'c.test.cjs', 'r.md', 'sub/b.mjs', 'sub/deeper/c.mjs', 'sub/b.test.mjs', 'sub/b.test.js']) writeFileSync(join(d, f), '');
  assert.deepEqual(libModules(d), ['a.mjs', 'c.cjs', 'n.js', 'sub/b.mjs', 'sub/deeper/c.mjs']);
});

test('T4a: every non-test lib/ module is either scanned or named out of scope with a reason, and the out-of-scope git-output finding is real', () => {
  assert.deepEqual(libModules(), [...SCANNED, ...Object.keys(OUT_OF_SCOPE)].sort(), 'a new lib module must be scanned or named in OUT_OF_SCOPE');
  assert.deepEqual(unpartitioned(libModules()), []);
  assert.deepEqual(unpartitioned([...libModules(), 'new.mjs', 'sub/x.mjs']), ['new.mjs', 'sub/x.mjs'], 'an unnamed module is caught');
  assert.ok(SCANNED.every((f) => !(f in OUT_OF_SCOPE)) && Object.values(OUT_OF_SCOPE).every((why) => why.length > 40));
  // durable-io.mjs is out of scope as a NAMED finding: its gitPath decodes git output with utf8. When that is fixed or
  // adopted this assertion turns red, and the entry must be revisited (scan it, or restate the reason).
  const dio = decodeSites('durable-io.mjs', readFileSync(join(here, 'durable-io.mjs'), 'utf8'), [...SCANNED, 'durable-io.mjs']);
  assert.ok(dio.some((h) => h.fn === 'gitPath' && h.rule === 'cp-encoding'), JSON.stringify(dio.filter((h) => h.fn === 'gitPath')));
});

// acorn exports no node-type list: derive it from the vendored source (every type passed to finishNode/finishNodeAt,
// ternary branches included, and every `x.type = '...'` assignment).
function acornNodeTypes() {
  const types = new Set();
  const lits = (n) => (n?.type === 'Literal' && typeof n.value === 'string' ? [n.value] : n?.type === 'ConditionalExpression' ? [...lits(n.consequent), ...lits(n.alternate)] : []);
  walk(acorn.parse(readFileSync(join(VENDOR, 'acorn.mjs'), 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' }), (n) => {
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && /^finishNode(?:At)?$/.test(n.callee.property.name)) {
      const got = lits(n.arguments[1]);
      assert.ok(got.length, `a finishNode call with a non-literal type: ${n.start}`);
      got.forEach((x) => types.add(x));
    }
    // (`this.type = ""` is the Node constructor's placeholder before finishNode, not a type.)
    if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' && !n.left.computed && n.left.property.name === 'type') lits(n.right).filter((x) => x !== '').forEach((x) => types.add(x));
  });
  return types;
}
// One source per parse mode that together produce every node type acorn has.
const TYPE_CORPUS = [
  [`import d, * as ns from './a.mjs'; import { a as b } from './a.json' with { type: 'json' }; export * from './a.mjs'; export { b as c };
export default class K extends B { static { this.x = 1; } #p = 1; m() { return super.m() ?? this.#p; } }
label: for (let i = 0; i < 1; i++) { if (i) break label; else continue label; }
for (const k in o) {} for (const v of o) {} while (0) {} do {} while (0); debugger; ;
switch (x) { case 1: break; default: }
try { throw new Error(); } catch (e) {} finally {}
function* g(a = 1, ...r) { yield a; } async function h() { await import('./a.mjs'); return new.target; }
const [p1, ...p2] = [1, ...o]; const { q1, ...q2 } = { q1: 1 }; ({ q1 } = o);
const f = (a) => a, fe = function () {}, ce = class {};
x = a ? b : c; x = a || b; x = a + b; x = -a; x++; x = (a, b); x = t\`s\${1}\`; x = o?.p; x = import.meta;`, { sourceType: 'module' }],
  ['(a);', { sourceType: 'module', preserveParens: true }],
  ['with (o) { x; }', { sourceType: 'script' }],
];

test('T4a layer 2: the legacy walker\'s type table classifies exactly the node types acorn can produce (rule, walk or fail)', () => {
  assert.ok(acorn, 'the vendored acorn failed its integrity check (UPSTREAM.json)');
  const types = acornNodeTypes();
  assert.equal(types.size, 73, `acorn ${UPSTREAM.version} produces 73 node types (re-derive NODE_RULES on any upgrade)`);
  assert.deepEqual(Object.keys(NODE_RULES).sort(), [...types].sort(), 'NODE_RULES classifies exactly the types acorn produces');
  assert.ok(Object.values(NODE_RULES).every((r) => ['rule', 'walk', 'fail'].includes(r)));
  assert.deepEqual(Object.keys(NODE_RULES).filter((t) => NODE_RULES[t] === 'fail'), ['WithStatement'], 'with defeats static name resolution: refused (and a parse error in a module)');
  // The derivation is not vacuous: a corpus that parses to every listed type, and to nothing outside the list.
  const seen = new Set();
  for (const [src, opts] of TYPE_CORPUS) walk(acorn.parse(src, { ecmaVersion: 'latest', ...opts }), (n) => seen.add(n.type));
  assert.deepEqual([...seen].sort(), [...types].sort());
  // Fail closed: a type outside the table, or one classified 'fail', is unclassifiable; the same source with the
  // full table gives no hit.
  const { ExpressionStatement, ...missing } = NODE_RULES;
  assert.equal(ExpressionStatement, 'walk');
  assert.deepEqual(decodeSites('m.mjs', 'x;'), []);
  assert.deepEqual(decodeSites('m.mjs', 'x;', FIXTURE_SET, missing).map((h) => [h.rule, h.why]), [['unclassifiable', 'node type ExpressionStatement is not classified']]);
  assert.deepEqual(decodeSites('m.mjs', 'x;', FIXTURE_SET, { ...NODE_RULES, ExpressionStatement: 'fail' }).map((h) => [h.rule, h.why]), [['unclassifiable', 'ExpressionStatement is refused']]);
});

// ------------------------------------------------------------------ T4a grammar layer: tests

/** Every entry of the grammar tables, as the `used` keys the descent records when it admits that entry. */
function grammarEntries() {
  const e = new Set(['proto:null', 'computed:numeric', 'super()', 'assign:this']);
  for (const t of GRAMMAR_TYPES) e.add(`type:${t}`);
  for (const [type, ops] of GRAMMAR_OPS) for (const o of ops) e.add(`op:${type}:${o}`);
  for (const [name, g] of GRAMMAR_GLOBALS) {
    e.add(`global:${name}`);
    for (const m of g.members?.keys() ?? []) e.add(`global:${name}.${m}`);
    for (const [flag, pos] of [['call', 'callee'], ['new', 'new'], ['newSrc', 'new'], ['value', 'value'], ['instanceof', 'instanceof'], ['extends', 'extends']]) if (g[flag]) e.add(`global:${name}:${pos}`);
  }
  for (const [file, specs] of GRAMMAR_IMPORTS) {
    for (const [spec, names] of specs) {
      for (const [name, u] of names) {
        e.add(`import:${file}:${spec}:${name}`);
        if (/^(?:member|callMember):/.test(u)) e.add(`import-member:${name}.${u.split(':')[1]}`);
      }
    }
  }
  for (const m of GRAMMAR_MEMBERS) e.add(`member:${m}`);
  for (const m of GRAMMAR_SITE_PINNED.keys()) e.add(`pinned:${m}`);
  for (const k of GRAMMAR_DATA_KEYS) e.add(`key:${k}`);
  e.add('pin:decoder-call').add('pin:decoder-binding');
  for (const n of GRAMMAR_PINNED_NAMES.keys()) e.add(`pinned-name:${n}`);
  for (const k of GRAMMAR_METHOD_KEYS) e.add(`method:${k}`);
  return e;
}

test('T4a grammar: the guarded files are written in the allowlisted grammar, and every allowlist entry is used by them (no slack)', () => {
  const used = new Set();
  for (const f of SCANNED) {
    for (const nl of ['\n', '\r\n']) {
      const r = grammarSites(f, readFileSync(join(here, f), 'utf8').replace(/\r?\n/g, nl));
      assert.deepEqual(r.hits, [], `${f} (${nl === '\n' ? 'LF' : 'CRLF'})`);
      r.used.forEach((x) => used.add(x));
    }
  }
  const entries = grammarEntries();
  assert.deepEqual([...entries].filter((x) => !used.has(x)).sort(), [], 'an allowlist entry no guarded file uses (remove it)');
  assert.deepEqual([...used].filter((x) => !entries.has(x)).sort(), [], 'a use the tables do not list');
  // The member allowlist names nothing reflective, call-forwarding or decoding (the site-pinned decoders are separate).
  const FORBIDDEN = /^(?:call|apply|bind|caller|callee|arguments|valueOf|toJSON|text|json|arrayBuffer|blob|formData|readAsText)$/;
  assert.deepEqual([...GRAMMAR_MEMBERS].filter((m) => REFLECT_NAME.test(m) || DECODER_NAME.test(m) || FORBIDDEN.test(m) || GRAMMAR_SITE_PINNED.has(m)), []);
  // No declared name of a guarded file is a global name (the rule is live on this Node, not vacuous).
  assert.ok(RESERVED_NAME('constructor') && RESERVED_NAME('Function') && RESERVED_NAME('fetch') && RESERVED_NAME('Object') && !RESERVED_NAME('ownValue'));
});

// Each refused module (checked as git-exec.mjs, so its import table applies) must give a grammar refusal whose reason
// matches. The reviewers' round-5 findings come first, verbatim or as complete modules.
const GRAMMAR_REFUSED = [
  // codex r5 #1: the frozen-table spelling was trusted; here every step is refused on its own
  ["Object.freeze = () => () => {};\nconst T = Object.freeze({ __proto__: null, A: 1 });\nconst k = ['con', 'structor'].join('');\nconst F = T[k];\nF('b', 'return b.toString()')(Buffer.from([0xff]));", /assignment target/],
  ["const T = Object.freeze({ __proto__: null, A: 1 });\nconst k = ['con', 'structor'].join('');\nconst F = T[k];", /not provably numeric/],
  ['const f = () => () => 0;\nf()();', /a call of a CallExpression/],
  // codex r5 #2: inherited dictionary names as specifiers (all 12)
  ...['constructor', '__defineGetter__', '__defineSetter__', 'hasOwnProperty', '__lookupGetter__', '__lookupSetter__', 'isPrototypeOf', 'propertyIsEnumerable',
    'toString', 'valueOf', '__proto__', 'toLocaleString'].map((x) => [`import '${x}';`, /not an allowlisted specifier/]),
  // opus r5 B1: compound or logical assignment to a refused global
  ['Function ||= 0;', /operator \|\|=|free identifier Function/], ['TextDecoder ??= 0;', /operator \?\?=/], ["process += '';", /operator \+=/], ['Reflect &&= 0;', /operator &&=/],
  ['Buffer ||= 0;', /operator \|\|=/], ['Function = 0;', /assignment to Function/], ['globalThis = 0;', /assignment to globalThis/],
  // opus r5 M1: a block-scoped shadow; and any declaration that shadows a global
  ["const T = Object.freeze({ __proto__: null, A: 'a' });\nconst k = 'constructor';\n{ const T = () => {}; T[k]; }", /not provably numeric/],
  ['{ const Object = { freeze: (x) => x }; }', /declaration of Object/], ['function f(Buffer) { return Buffer; }', /declaration of Buffer/],
  ['const constructor = 1;', /declaration of constructor/], ['let toString = 1;', /declaration of toString/], ['const fetch = 1;', /declaration of fetch/],
  ['try { } catch (globalThis) { }', /declaration of globalThis/], ['class Function { }', /declaration of Function/],
  // opus r5 M2: writes to members of Object or Buffer
  ['Object.freeze = (x) => x;', /assignment target/], ['Buffer.from = (x) => x;', /assignment target/], ['Object.keys.x = 1;', /assignment target/],
  // opus r5 M3: decoders the old deny list missed (an allowlist refuses every unlisted global)
  ["const r = new Request('x');", /free identifier Request/], ["fetch('x');", /free identifier fetch/], ['const r = new Response(Buffer.from([0]));', /free identifier Response/],
  ['const b = new Blob([]);', /free identifier Blob/], ["atob('x');", /free identifier atob/], ['const d = new TextDecoderStream();', /free identifier TextDecoderStream/],
  ['structuredClone(0);', /free identifier structuredClone/], ["new Function('x');", /free identifier Function/], ["eval('x');", /free identifier eval/],
  ['globalThis.x;', /free identifier globalThis/], ['Reflect.ownKeys({});', /free identifier Reflect/], ['const p = new Proxy({}, {});', /free identifier Proxy/],
  ['const c = constructor;', /free identifier constructor/], ['const t = toString;', /free identifier toString/],
  // opus r5: computed-key write, delete, call and new through a computed member; tagged template
  ["const o = {};\nconst p = 'toString';\no[p] = Buffer.from('x');", /assignment target/], ['const o = {};\nconst p = 0;\no[p] = 1;', /assignment target/],
  ["const o = { a: 1 };\ndelete o.a;", /operator delete/], ["const o = {};\nconst k = 'f';\no[k]();", /computed member used as callee/],
  ['const o = [];\no[0]();', /computed member used as callee/], ["const o = {};\nconst k = 'C';\nnew o[k]();", /new through a MemberExpression/],
  ['const f = () => 0;\nnew (f())();', /new through a CallExpression/], ['String.raw`x`;', /TaggedTemplateExpression/], ['const t = (s) => s;\nt`x`;', /TaggedTemplateExpression/],
  // imports: exact specifier and name, unrenamed, declared once
  ["import { spawnSync as s } from 'node:child_process';", /renamed/], ["import { execSync } from 'node:child_process';", /export execSync is not allowlisted/],
  ["import { probeGit } from './git%2Dcapability.mjs';", /not an allowlisted specifier/], ["import { probeGit } from './git-capability.mjs?x';", /not an allowlisted specifier/],
  ["import * as fs from 'node:fs';", /ImportNamespaceSpecifier/], ["import { statSync } from 'node:fs' with { type: 'json' };", /import attributes/],
  ["import { statSync } from 'node:fs';\n{ const statSync = 1; }", /redeclared/], ["import 'node:fs';", /side-effect import/],
  ["import path from 'node:path';", /not an allowlisted specifier/],
  // import uses
  ["import { statSync } from 'node:fs';\nconst s = statSync;", /import statSync used as value/], ["import { probeGit } from './git-capability.mjs';\nprobeGit.x;", /import probeGit used as object/],
  ["import { spawnSync } from 'node:child_process';\nspawnSync('g', [], { encoding: 'utf8' });", /spawnSync other than/],
  ["import { spawnSync } from 'node:child_process';\nspawnSync('g', []);", /spawnSync other than/], ["import { spawnSync } from 'node:child_process';\nconst a = [];\nspawnSync('g', a, {});", /spawnSync other than/],
  ["import { spawnSync } from 'node:child_process';\nconst o = {};\nspawnSync('g', [], o);", /spawnSync other than/],
  ["import { spawnSync } from 'node:child_process';\nconst o = {};\nspawnSync('g', [], { ...o });", /spawnSync other than/],
  ["import { spawnSync } from 'node:child_process';\nconst k = 'encoding';\nspawnSync('g', [], { [k]: 'utf8' });", /spawnSync other than|computed object key/],
  ["import { spawnSync } from 'node:child_process';\nconst o = {};\nspawnSync('g', [], { __proto__: o });", /spawnSync other than/],
  ["import { spawnSync } from 'node:child_process';\nconst a = [];\nspawnSync(...a);", /spawnSync other than/],
  // exports
  ['const a = 1;\nexport { a };', /an export other than/], ["export * from './git-capability.mjs';", /ExportAllDeclaration/], ['export default 1;', /ExportDefaultDeclaration/],
  // globals in a form they do not allow
  ['foo;', /free identifier foo/], ['const O = Object;', /global Object used as value/], ['const o = {};\nObject.getPrototypeOf(o);', /Object.getPrototypeOf is not allowlisted/],
  ['Object.assign({}, {});', /Object.assign is not allowlisted/], ['Buffer.alloc(1);', /Buffer.alloc is not allowlisted/], ["process.binding('fs');", /process.binding is not allowlisted/],
  ['process.mainModule;', /process.mainModule is not allowlisted/], ['const k = Object.keys;', /Object.keys used as value/], ['const c = process.cwd;', /process.cwd used as value/],
  ['String.raw;', /String.raw is not allowlisted/], ["const s = new String('x');", /global String used as new/], ['Map();', /global Map used as callee/],
  ['const o = {};\no instanceof Object;', /global Object used as instanceof/], ['class A extends Object { }', /global Object used as extends/],
  ["const t = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });", /new TextDecoder other than exactly/], ['const t = new TextDecoder();', /new TextDecoder other than exactly/],
  ["const t = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true, x: 1 });", /new TextDecoder other than exactly/],
  ['Symbol.for;', /Symbol.for used as value/], ['Number.isSafeInteger;', /used as value/], ['const u = Infinity.x;', /global Infinity used as object/],
  // the two pinned reflective productions, and nothing else
  ["const o = {};\nObject.getOwnPropertyDescriptor(o, 'x');", /outside the own-data reader production/],
  [`const own = (o, k) => Object.hasOwn(o, k);\nconst ownValue2 = ${OWN_VALUE_SRC};`, /outside the own-data reader production/],
  [`const own = (o, k) => Object.hasOwn(o, k);\nfunction g() { const ownValue = ${OWN_VALUE_SRC}; return ownValue; }`, /outside the own-data reader production/],
  [`const own = (o, k) => Object.hasOwn(o, k);\nlet ownValue = ${OWN_VALUE_SRC};`, /outside the own-data reader production/],
  [`const own = (o, k) => Object.hasOwn(o, k);\nconst ownValue = ${OWN_VALUE_SRC.replace('d.value :', 'd.get :')};`, /outside the own-data reader production|member \.get/],
  ["const o = {};\nObject.defineProperty(o, 'name', { value: 1 });", /pinned constructor form/], ["function f() { Object.defineProperty(this, 'name', { value: 1 }); }", /pinned constructor form/],
  ["class A { constructor() { Object.defineProperty(this, 'name', { get: () => 1 }); } }", /pinned constructor form/],
  ["class A { constructor() { Object.defineProperty(this, 'constructor', { value: 1 }); } }", /pinned constructor form/],
  // members: only the allowlist; reflective, forwarding and decoding names are not on it
  ...['constructor', '__proto__', 'prototype', 'call', 'apply', 'bind', 'text', 'valueOf', 'toJSON', 'toLocaleString', 'utf8Slice', 'setEncoding', 'caller', 'arguments']
    .map((m) => [`const x = {};\nx.${m};`, new RegExp(`member \\.${m} is not allowlisted`)]),
  ['class A { #p = 1; m() { return this.#p; } }', /PropertyDefinition|private member/], ['class A extends Error { toJSON() { return super.message; } }', /super member/],
  // destructuring keys are member reads
  ['const x = {};\nconst { constructor: c } = x;', /destructuring key constructor/], ["const x = {};\nconst k = 'a';\nconst { [k]: v } = x;", /not a plain name/],
  // assignment targets: a local name, or this.<member> in a constructor
  ['const x = {};\nx.code = 1;', /assignment target/], ['function f() { this.code = 1; }', /assignment target/], ['class A { constructor() { this.foo = 1; } }', /assignment target/],
  ['undeclared = 1;', /assignment to undeclared/], ["import { statSync } from 'node:fs';\nstatSync = 1;", /assignment to statSync/],
  ['let a = 1;\na += 1;', /operator \+=/], ['let a = 1;\na ||= 1;', /operator \|\|=/], ['let a = 1;\n[a] = [1];', /assignment target/], ['let a = 1;\n({ a } = { a: 2 });', /assignment target/],
  ['const x = { y: 1 };\nx.y++;', /an update of something other than a local name/], ['let i = 0;\ni--;', /operator --/], ['Infinity++;', /an update of something other than a local name/],
  // operators outside the list
  ['void 0;', /operator void/], ['let x = 1;\nx = -x;', /operator -/], ['let x = 1;\nx = ~x;', /operator ~/], ["const o = {};\n'a' in o;", /operator in/],
  ['let a = 1;\na == 1;', /operator ==/], ['let a = 1;\na = a - 1;', /operator -/],
  // calls and new
  ['const f = () => 0;\n(0, f)();', /SequenceExpression/], ['const f = () => 0;\nconst g = f;\n(f || g)();', /a call of a LogicalExpression/], ['const o = { C: class {} };\nnew o.C();', /new through a MemberExpression|ClassExpression/],
  ['function f() { super.x(); }', /super member|'super' keyword/],
  // functions, classes and objects
  ['async function f() { }', /async or generator/], ['function* g() { }', /async or generator/], ['const f = async () => 1;', /async or generator/],
  ['class A { get x() { return 1; } }', /kind get/], ['class A { static m() { } }', /class member/], ['class A { x = 1; }', /PropertyDefinition/], ['class A { static { } }', /StaticBlock/],
  ["class A { ['toJSON']() { } }", /computed class member key/], ['class A { foo() { } }', /class method foo is not allowlisted/],
  ["class A { [Symbol.for(String('x'))]() { } }", /computed class member key/],
  ['const o = { get x() { return 1; } };', /object getter/], ["const k = 'a';\nconst o = { [k]: 1 };", /computed object key/], ['const p = {};\nconst o = { __proto__: p };', /__proto__ other than null/],
  ["const p = {};\nconst o = { '__proto__': p };", /__proto__ other than null/],
  // statements and expressions outside the grammar
  ['var v = 1;', /a var declaration/], ['while (false) { }', /WhileStatement/], ['do { } while (false);', /DoWhileStatement/], ['for (const k in {}) { }', /ForInStatement/],
  ['switch (1) { case 1: }', /SwitchStatement/], ['l: for (const x of []) continue l;', /LabeledStatement/], ['for (const x of []) break;', /BreakStatement/], ['debugger;', /DebuggerStatement/],
  [';', /EmptyStatement/], ['let x = 0;\nfor (x of []) { }', /for-of head/], ['await 0;', /AwaitExpression/], ['function* g() { yield 1; }', /async or generator/],
  ["import('node:fs');", /ImportExpression/], ['const u = import.meta;', /MetaProperty/], ['function f() { return new.target; }', /MetaProperty/], ['const C = class { };', /ClassExpression/],
  ['const a = (1, 2);', /SequenceExpression/], ['with (o) { }', /parse error/], ['function f() { super(); }', /super/], ['class A extends Error { constructor() { const f = () => super(); f(); } }', /super\(\) outside a constructor/],
];
// Supported forms that must give no grammar refusal (each a complete module, checked as git-exec.mjs).
const GRAMMAR_FINE = [
  `const own = (o, k) => Object.hasOwn(o, k);\nconst ownValue = ${OWN_VALUE_SRC};\nownValue({ a: 1 }, 'a');`,
  "class E extends Error { constructor(c) { super(c); Object.defineProperty(this, 'name', { value: 'E', enumerable: false }); this.code = c; } toJSON() { return { code: this.code }; } [Symbol.for('nodejs.util.inspect.custom')]() { return 'E'; } }",
  'const x = [1, 2];\nfor (let i = 0; i < x.length; i++) if (x[i]) continue;',
  "import { spawnSync } from 'node:child_process';\nimport { probeGit } from './git-capability.mjs';\nconst r = spawnSync(probeGit().path, ['--version'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });",
  "import { statSync } from 'node:fs';\nlet isDir = false;\ntry { isDir = statSync('/').isDirectory(); } catch { /* refused */ }",
  "const DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });\nexport function decodeStrict(bytes) { let s = null; try { s = DECODER.decode(bytes); } catch { /* typed */ } return s; }",
  "const m = new Map([['a', 'b']]);\nconst v = m.get('a') ?? 'c';\nconst w = new WeakMap();\nconst st = new Set(['x']);",
  'const b = Buffer.from([1]);\nconst isBytes = b instanceof Uint8Array && Buffer.isBuffer(b) && Array.isArray([]) && Number.isSafeInteger(1);',
  "export function f({ platform = process.platform } = {}) { return platform === 'win32' ? process.env : Infinity; }",
  'const o = { __proto__: null, ...Object.fromEntries(Object.entries({ a: 1 })) };\nconst p = Object.freeze([o].map(Object.freeze));',
  "const HEX = '0123456789abcdef';\nexport const label = (bytes) => [...bytes].map((b) => (b < 0x7f ? String.fromCharCode(b) : `\\\\x${HEX[b >> 4]}${HEX[b & 15]}`)).join('');",
  'const xs = [[1, 2]];\nconst [[a, b]] = xs;\nconst { length, ...rest } = xs;\nconst t = typeof a === `number` && !b && +a > 0 && a * 2 >= 1 && a !== b;',
  "const s = 'a';\nconst ok = s?.startsWith('a') || [].filter(Boolean).length <= 0;",
];

test('T4a grammar: each refusal class has counterexamples (every round-5 reviewer finding among them), and supported forms pass', () => {
  assert.ok(GRAMMAR_REFUSED.length > 150);
  const wrong = GRAMMAR_REFUSED.map(([src, why]) => [src, grammarSites('git-exec.mjs', src).hits.map((h) => h.why)])
    .filter(([src, whys], i) => !whys.some((w) => GRAMMAR_REFUSED[i][1].test(w)));
  assert.deepEqual(wrong, [], 'each case: [source, the grammar refusals it got] (none matched the expected class)');
  assert.deepEqual(GRAMMAR_FINE.map((src) => [src, grammarSites('git-exec.mjs', src).hits.map((h) => h.why)]).filter(([, w]) => w.length), []);
  // The import table is per file: a specifier allowed for git-capability.mjs is refused for git-exec.mjs, and a module
  // outside the guarded set has no imports at all.
  assert.deepEqual(grammarSites('git-capability.mjs', "import path from 'node:path';\npath.sep;").hits, []);
  assert.ok(grammarSites('m.mjs', "import { statSync } from 'node:fs';\nstatSync('/');").hits.some((h) => /not an allowlisted specifier for m\.mjs/.test(h.why)));
  // A restricted import admits only its one member form.
  for (const [src, why] of [["import { constants } from 'node:fs';\nconstants.F_OK;", /constants\.F_OK is not allowlisted/],
    ["import { realpathSync } from 'node:fs';\nconst n = realpathSync.native;", /realpathSync\.native is not allowlisted/],
    ["import { realpathSync } from 'node:fs';\nrealpathSync.x('/');", /realpathSync\.x is not allowlisted/]]) {
    assert.ok(grammarSites('git-capability.mjs', src).hits.some((h) => why.test(h.why)), src);
  }
});

// One module per acorn node type the grammar refuses, each parsing to that type (or, for `with`, failing to parse).
const GRAMMAR_REFUSED_TYPES = {
  AwaitExpression: 'await 0;', BreakStatement: 'for (const x of []) break;', ClassExpression: 'const C = class {};', DebuggerStatement: 'debugger;',
  DoWhileStatement: 'do {} while (false);', EmptyStatement: ';', ExportAllDeclaration: "export * from './git-capability.mjs';", ExportDefaultDeclaration: 'export default 1;',
  ExportSpecifier: 'const a = 1;\nexport { a };', ForInStatement: 'for (const k in {}) {}', ImportAttribute: "import { statSync } from 'node:fs' with { type: 'json' };",
  ImportExpression: "import('node:fs');", ImportNamespaceSpecifier: "import * as fs from 'node:fs';", LabeledStatement: 'l: for (const x of []) continue l;',
  MetaProperty: 'const u = import.meta;', PrivateIdentifier: 'class A { #p; }', PropertyDefinition: 'class A { x = 1; }', SequenceExpression: 'const a = (1, 2);',
  StaticBlock: 'class A { static {} }', SwitchCase: 'switch (1) { case 1: }', SwitchStatement: 'switch (1) {}', TaggedTemplateExpression: 'String.raw`x`;',
  WhileStatement: 'while (false) {}', WithStatement: 'with (o) {}', YieldExpression: 'function* g() { yield 1; }',
  // acorn builds this type only under preserveParens, which the grammar's parse never sets: `(0)` parses to a Literal.
  ParenthesizedExpression: '(0);',
};
test('T4a grammar: every node type acorn can produce is either admitted (and used by the guarded files) or refused wherever it appears', () => {
  const types = acornNodeTypes();
  const admitted = [...GRAMMAR_TYPES];
  const refused = Object.keys(GRAMMAR_REFUSED_TYPES);
  assert.deepEqual([...admitted, ...refused].sort(), [...types].sort(), 'the two lists partition acorn\'s 73 types');
  assert.equal(new Set([...admitted, ...refused]).size, admitted.length + refused.length, 'and are disjoint');
  for (const [type, src] of Object.entries(GRAMMAR_REFUSED_TYPES)) {
    const hits = grammarSites('git-exec.mjs', src).hits;
    if (type === 'ParenthesizedExpression') {
      assert.deepEqual(hits, []);
      let present = false;
      walk(acorn.parse(src, PARSE), (n) => { if (n.type === type) present = true; });
      assert.equal(present, false, 'the grammar parse never yields ParenthesizedExpression');
      continue;
    }
    if (type === 'WithStatement') { assert.match(hits[0]?.why ?? '', /parse error/); continue; }
    let present = false;
    walk(acorn.parse(src, PARSE), (n) => { if (n.type === type) present = true; });
    assert.ok(present, `${type}: the fixture parses to that type (not vacuous)`);
    assert.ok(hits.length > 0, `${type} is refused`);
  }
  // Admitted types are the ones the guarded files use (the tightness test checks it entry by entry).
  assert.equal(admitted.length, 47);
});

// Each grammar-capable decode is ALSO a legacy-rule hit, so ALLOWED_SITES pins every site of it (the layer link).
const LAYER_LINK = [
  ['member .toString', 'x.toString();', 'decoder-api'], ['member .realpath', 'seam.realpath(d);', 'name-api-no-buffer'],
  ['realpathSync.native(...)', 'realpathSync.native(p);', 'name-api-no-buffer'], ['String(...)', 'String(b);', 'string-coercion'],
  ['process.cwd()', 'process.cwd();', 'cwd'], ['new TextDecoder(...)', "new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });", 'decoder-api'],
];
test('T4a grammar: every decode-capable form the grammar admits is a legacy-rule hit, so only an ALLOWED_SITES entry can admit it', () => {
  for (const [what, src, rule] of LAYER_LINK) assert.ok(rulesOf(src).includes(rule), `${what} -> ${rule}`);
  assert.deepEqual([...GRAMMAR_SITE_PINNED].map(([m, rule]) => [m, LAYER_LINK.find(([w]) => w === `member .${m}`)?.[2]]), [...GRAMMAR_SITE_PINNED]);
  assert.equal(GRAMMAR_GLOBALS.get('String').call, true);
  assert.equal(GRAMMAR_GLOBALS.get('process').members.get('cwd'), 'call');
  assert.equal(GRAMMAR_IMPORTS.get('git-capability.mjs').get('node:fs').get('realpathSync'), 'callMember:native');
});

// Round 7 (opus r6 Major): `.decode` reached any value with any arguments. The one decoder is now unaliasable and its
// one call is pinned: `DECODER.decode(bytes)` as the statement `s = DECODER.decode(bytes);` in decodeStrict.
const TD = "const DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });\n";
const DECODE_ESCAPES = [
  ['a1: stream option', `${TD}export function decodeStrict(bytes) { let s = null; s = DECODER.decode(bytes, { stream: true }); return s; }`],
  ['a2: options in a variable', `${TD}export function decodeStrict(bytes) { const o = { stream: true }; let s = null; s = DECODER.decode(bytes, o); return s; }`],
  ['a6: destructured', `${TD}const { decode } = DECODER;`],
  ['a11: plain call outside decodeStrict', `${TD}const b = Buffer.from([0x61]);\nconst t = DECODER.decode(b);`],
  ['aliased decoder', `${TD}const D = DECODER;`], ['decoder passed as a value', `${TD}const xs = [DECODER];`],
  ['spread argument', `${TD}export function decodeStrict(bytes) { let s = null; s = DECODER.decode(...[bytes]); return s; }`],
  ['other consumer statement', `${TD}export function decodeStrict(bytes) { return DECODER.decode(bytes); }`],
  ['.decode on another value', 'const x = { decode: (b) => b };\nconst y = x.decode(1);'],
  ['.decode read as a value', 'const x = {};\nconst y = x.decode;'],
  ['a second decoder', "const D2 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });"],
  ['the pinned call text in another statement', `${TD}export function decodeStrict(bytes) { let t = null; t = DECODER.decode(bytes); return t; }`],
  ['the pinned statement in another function', `${TD}export function other(bytes) { let s = null; s = DECODER.decode(bytes); return s; }`],
  ['the pinned statement in a closure inside decodeStrict', `${TD}export function decodeStrict(bytes) { const g = () => { let s = null; s = DECODER.decode(bytes); return s; }; return g(); }`],
  ['a second pinned statement in decodeStrict', `${TD}export function decodeStrict(bytes) { let s = null; s = DECODER.decode(bytes); s = DECODER.decode(bytes); return s; }`],
  ['decodeStrict nested in another function', `${TD}function outer() { function decodeStrict(bytes) { let s = null; s = DECODER.decode(bytes); return s; } return decodeStrict; }`],
];
test('T4a grammar (round 7): the decoder is unaliasable and `.decode` exists only as the pinned call in decodeStrict', () => {
  for (const [what, src] of DECODE_ESCAPES) assert.ok(grammarSites('git-exec.mjs', src).hits.length > 0, `${what} is refused`);
  // Opus r6 live proof: a stream-mode decode swapped into neutralisationPairs is refused in the real file.
  const real = readFileSync(join(here, 'git-exec.mjs'), 'utf8');
  const swap = "const key = decodeStrict(rec, 'filter_name_not_utf8');";
  assert.equal(real.split(swap).length, 2);
  const swapped = real.replace(swap, "let key; try { key = DECODER.decode(rec, { stream: true }); } catch { key = decodeStrict(rec, 'filter_name_not_utf8'); }");
  assert.ok(grammarSites('git-exec.mjs', swapped).hits.some((h) => /decode/.test(h.why)), 'the neutralisationPairs swap is refused');
  // The real pinned call passes (control).
  assert.deepEqual(grammarSites('git-exec.mjs', real).hits, []);
});

// Round 8 (opus r7 Major): a pinned construct named a NAME, not a binding. Every pinned name must resolve to its one
// pinned top-level declaration in the file that pins it, and is refused anywhere else (any declaration, any file).
const OPUS_R7 = 'function decodeStrict(bytes, DECODER) { let s = null; s = DECODER.decode(bytes); return s; }\nexport function versionText(out, opts) { return decodeStrict(out, opts.value); }\n';
const PINNED_NAME_ESCAPES = [
  ['git-capability.mjs', 'opus r7 repro appended to git-capability.mjs', null],
  ['git-exec.mjs', 'no decoder site, DECODER a parameter', 'export function decodeStrict(bytes, DECODER) { let s = null; s = DECODER.decode(bytes); return s; }'],
  ['git-exec.mjs', 'let DECODER set by an exported setter', 'let DECODER = null;\nexport function setDecoder(d) { DECODER = d; }\nexport function decodeStrict(bytes) { let s = null; s = DECODER.decode(bytes); return s; }'],
  ['git-exec.mjs', 'DECODER a local inside decodeStrict', 'export function decodeStrict(bytes) { const DECODER = bytes.value; let s = null; s = DECODER.decode(bytes); return s; }'],
  ['git-exec.mjs', 'DECODER a catch parameter', 'export function decodeStrict(bytes) { let s = null; try { s = 1; } catch (DECODER) { s = DECODER.decode(bytes); } return s; }'],
  ['git-exec.mjs', 'DECODER destructured', 'export function decodeStrict(bytes, { value: DECODER }) { let s = null; s = DECODER.decode(bytes); return s; }'],
  ['git-exec.mjs', 'DECODER imported', "import { DECODER } from './git-capability.mjs';"],
  ['git-exec.mjs', 'decodeStrict a parameter', 'function f(decodeStrict) { return decodeStrict; }'],
  ['git-exec.mjs', 'decodeStrict reassigned', 'export function decodeStrict(bytes) { return bytes; }\nfunction f() { decodeStrict = null; }'],
  ['git-exec.mjs', 'decodeStrict a block local', '{ const decodeStrict = 1; }'],
  ['git-exec.mjs', 'ownValue a parameter', 'function f(ownValue) { return ownValue; }'],
  ['git-exec.mjs', 'own a parameter', 'function f(own) { return own; }'],
  ['git-exec.mjs', 'own reassigned', 'let own = (o, k) => Object.hasOwn(o, k);\nown = null;'],
  ['git-capability.mjs', 'realFs a parameter', 'function f(realFs) { return realFs; }'],
  ['git-capability.mjs', 'resolveGitBinary a block local', '{ let resolveGitBinary = 1; }'],
  ['git-capability.mjs', 'parseGitVersion a parameter', 'function f(parseGitVersion) { return parseGitVersion; }'],
  ['git-capability.mjs', 'DECODER declared in the file that does not pin it', "const DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });"],
  ['git-capability.mjs', 'decodeStrict declared in the file that does not pin it', 'export function decodeStrict(bytes) { return bytes; }'],
  ['git-exec.mjs', 'DECODER a top-level const with another initialiser', 'const DECODER = { decode: (b) => b };\nexport function decodeStrict(bytes) { let s = null; s = DECODER.decode(bytes); return s; }'],
  ['git-exec.mjs', 'own a block-level const', '{ const own = (o, k) => Object.hasOwn(o, k); }'],
  ['git-exec.mjs', 'decodeStrict a const, not a function declaration', 'export const decodeStrict = (bytes) => bytes;'],
  ['git-exec.mjs', 'decodeStrict updated', 'export function decodeStrict(bytes) { return bytes; }\nfunction f() { decodeStrict++; }'],
  ['git-exec.mjs', 'ownValue declared twice (top level and a parameter)', `const own = (o, k) => Object.hasOwn(o, k);\nconst ownValue = ${OWN_VALUE_SRC};\nfunction f(ownValue) { return ownValue; }`],
];
test('T4a grammar (round 8): every pinned name resolves to its one pinned top-level declaration, in the file that pins it', () => {
  const cap = readFileSync(join(here, 'git-capability.mjs'), 'utf8');
  for (const [file, what, src] of PINNED_NAME_ESCAPES) {
    const code = src ?? `${cap}\n${OPUS_R7}`;
    assert.ok(grammarSites(file, code).hits.length > 0, `${file}: ${what} is refused`);
  }
  // Controls: each pinned name declared as its pin, in its file, is admitted.
  const ok = [['git-exec.mjs', `${TD}const own = (o, k) => Object.hasOwn(o, k);\nconst ownValue = ${OWN_VALUE_SRC};\nexport function decodeStrict(bytes) { let s = null; s = DECODER.decode(bytes); return s; }`],
    ['git-capability.mjs', 'const realFs = { a: 1 };\nexport function resolveGitBinary() { return realFs; }\nexport function parseGitVersion(out) { return out; }']];
  for (const [file, src] of ok) assert.deepEqual(grammarSites(file, src).hits.map((h) => h.why), [], file);
});

test('T4a grammar (round 7): every member name is audited: none is a decoder on a byte holder, and each one a byte holder defines has a reason', () => {
  const defines = (proto, n) => { for (let o = proto; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) if (Object.getOwnPropertyNames(o).includes(n)) return true; return false; };
  const holders = [Buffer.prototype, Uint8Array.prototype, ArrayBuffer.prototype, TextDecoder.prototype];
  const readable = [...GRAMMAR_MEMBERS, ...GRAMMAR_DATA_KEYS];
  assert.deepEqual(readable.filter((n) => defines(TextDecoder.prototype, n)), ['decode'], 'only `decode` names a TextDecoder method, and it is a data key (destructuring only)');
  assert.deepEqual([...GRAMMAR_MEMBERS].filter((n) => holders.some((h) => defines(h, n))).sort(), [...GRAMMAR_BYTE_MEMBER_AUDIT.keys()].sort(), 'audit table = member names a byte holder defines');
  assert.ok([...GRAMMAR_BYTE_MEMBER_AUDIT.values()].every((why) => why.length >= 8), "each audit entry carries a reason");
  // The decode-capable names are never plain members: toString and realpath are callee-only and site-pinned; decode is pinned.
  assert.deepEqual([...GRAMMAR_SITE_PINNED.keys(), 'decode', 'toLocaleString', 'valueOf', 'text'].filter((n) => GRAMMAR_MEMBERS.has(n)), []);
  // Behavioural spot check of the two surprising entries: on bytes they do not decode.
  const b = Buffer.from([0xff, 0x61]);
  assert.equal(b.join(), '255,97');
  assert.deepEqual([...Buffer.from([2, 1]).sort()], [1, 2]);
  // A site-pinned name read as a value is refused by the grammar itself (not only by layer 2).
  for (const src of ['const x = {};\nconst f = x.toString;', 'const x = {};\nconst f = x.realpath;']) assert.ok(grammarSites('git-exec.mjs', src).hits.some((h) => /other than as a callee/.test(h.why)), src);
});

// [form, the refusal reason it must raise in place, top level only]: grammar counterexamples injected into the real sources.
const GRAMMAR_INJECT = [
  ['Object.freeze = (x) => x;', /assignment target/], ['Function ||= 0;', /operator \|\|=/], ["{ const r__ = new Request('x'); }", /free identifier Request/],
  ["fetch('x');", /free identifier fetch/], ["{ const o__ = {}; const k__ = 'toString'; o__[k__] = 1; }", /assignment target/],
  ["{ const o__ = {}; const k__ = 'constructor'; const f__ = o__[k__]; }", /not provably numeric/], ['String.raw`x`;', /TaggedTemplateExpression/],
  ["{ const o__ = {}; const k__ = 'C'; const c__ = new o__[k__](); }", /new through a MemberExpression/], ['{ const Object = 1; }', /declaration of Object/],
  ["{ const x__ = {}; const c__ = x__.constructor; }", /member \.constructor/], ['{ let a__ = 1; a__ += 1; }', /operator \+=/],
  ["{ const t__ = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }); }", /new TextDecoder other than exactly/],
  ["import 'constructor';", /not an allowlisted specifier/, true], ["import { execSync } from 'node:child_process';", /not allowlisted/, true],
  ["export * from './git-capability.mjs';", /ExportAllDeclaration/, true],
];
test('T4a grammar property: each counterexample injected at seeded random statement boundaries of the guarded sources is refused in place', () => {
  const SEED = 0x6a0b6;
  const rnd = prng(SEED);
  const RUNS = 6;
  let checked = 0;
  for (const f of SCANNED) {
    for (const nl of ['\n', '\r\n']) {
      const src = readFileSync(join(here, f), 'utf8').replace(/\r?\n/g, nl);
      const top = [];
      const all = [];
      walk(acorn.parse(src, PARSE), (n) => {
        const list = ['Program', 'BlockStatement'].includes(n.type) ? n.body : [];
        for (const s of list) (n.type === 'Program' ? top : all).push(s.start);
      });
      all.push(...top);
      for (const [form, why, topOnly] of GRAMMAR_INJECT) {
        for (let r = 0; r < RUNS; r++) {
          const pool = topOnly ? top : all;
          const at = pool[Math.floor(rnd() * pool.length)];
          const where = `seed ${SEED}: ${JSON.stringify(form)} at ${f}:${at}`;
          const put = (text) => src.slice(0, at) + text + src.slice(at);
          const text = `${form}${nl}`;
          assert.doesNotThrow(() => acorn.parse(put(text), PARSE), `${where}: parses`);
          const inPlace = (t) => grammarSites(f, put(t)).hits.filter((h) => h.pos >= at && h.pos < at + t.length);
          assert.ok(inPlace(text).some((h) => why.test(h.why)), `${where} not refused (${JSON.stringify(inPlace(text).map((h) => h.why))})`);
          for (const ctl of [`/* ${form} */ `, `// ${form}${nl}`, `{ const c__ = ${JSON.stringify(form)}; }${nl}`, `{ const c__ = 0; }${nl}`]) {
            assert.deepEqual(inPlace(ctl), [], `${where}: control ${JSON.stringify(ctl)}`);
          }
          checked++;
        }
      }
    }
  }
  assert.equal(checked, SCANNED.length * 2 * GRAMMAR_INJECT.length * RUNS, 'every injection ran');
});

// ------------------------------------------------------------------ the vendored parser stays test-only (AGENTS.md vendoring rule)
// WHAT THIS CHECKS, for every runtime JS module of EVERY skill (.mjs/.cjs/.js outside vendor/ and node_modules, not
// *.test.* or *.test-helper.*), and for every JS file reached from one through its constant specifiers, transitively (a
// test or test helper included; reaching a benign one is allowed): (1) no import/export-from declaration, import() or
// require() specifier lands in a vendor/ directory (a constant specifier: a literal, a `+` chain or template folded by
// staticStr, or a top-level `const X = new URL('<literal>', import.meta.url).href`; relative and file: specifiers are
// resolved by WHATWG URL rules, percent-decoding included; an extensionless one is also tried with .js, .cjs, .mjs and
// a directory's index.js/.cjs (NOT a directory's package.json `main` or `exports`, which CommonJS would also use);
// containment uses the platform's path rules, so another drive is outside); (2)
// every import()/require() whose specifier is not such a constant is an offender unless pinned in DYNAMIC_LOADERS;
// (3) no string piece, percent-decoded, names the package or a vendor/ path. It does NOT cover other ways to run the
// file: createRequire, module.require, eval or Function, vm, a child process, a Worker, or reading it from disk.

/** Whether `child` is `parent` or inside it, by the rules of path module P: a different drive or UNC root is outside. */
const within = (child, parent, P) => { const rel = P.relative(parent, child); return rel === '' || (rel !== '..' && !rel.startsWith(`..${P.sep}`) && !P.isAbsolute(rel)); };
const TEST_FILE = /\.test(?:-helper)?\.(?:mjs|cjs|js)$/;
/** Runtime JS modules under root, and the vendor/ directories there. */
function skillTree(root) {
  const modules = [];
  const vendors = [];
  const go = (dir) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const f = join(dir, d.name);
      if (d.isDirectory()) { if (d.name === 'vendor') vendors.push(f); else if (d.name !== 'node_modules' && d.name !== '.git') go(f); } else if (/\.(?:mjs|cjs|js)$/.test(d.name) && !TEST_FILE.test(d.name)) modules.push(f);
    }
  };
  go(root);
  return { modules: modules.sort(), vendors };
}
/** Where a specifier lands as a file path (relative or file:, WHATWG URL rules), else null (a builtin or a package). */
function landing(spec, from) {
  try {
    const rel = /^\.{0,2}\//.test(spec);
    if (!rel && !/^file:/i.test(spec)) return null;
    const u = rel ? new URL(spec, pathToFileURL(from)) : new URL(spec);
    u.search = ''; u.hash = '';
    return fileURLToPath(u);
  } catch { return null; }
}
/** One module's loader edges: constant specifiers, non-constant loader calls (their source), and every string piece. */
function loaderEdges(file, src) {
  let ast;
  try { ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true }); } catch { ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true }); }
  const urlConst = new Map();
  for (const d of ast.body) {
    for (const x of d.type === 'VariableDeclaration' && d.kind === 'const' ? d.declarations : []) {
      const i = x.init;
      if (x.id.type === 'Identifier' && i?.type === 'MemberExpression' && !i.computed && i.property.name === 'href' && i.object.type === 'NewExpression' && i.object.callee.name === 'URL'
        && i.object.arguments.length === 2 && staticStr(i.object.arguments[0]) !== null && src.slice(i.object.arguments[1].start, i.object.arguments[1].end) === 'import.meta.url') {
        urlConst.set(x.id.name, new URL(staticStr(i.object.arguments[0]), pathToFileURL(file)).href);
      }
    }
  }
  const specs = [];
  const dynamic = [];
  const strings = [];
  const loader = (arg, n) => {
    const v = staticStr(arg) ?? (arg?.type === 'Identifier' ? urlConst.get(arg.name) : undefined);
    if (typeof v === 'string') specs.push(v); else dynamic.push(src.slice(n.start, n.end));
  };
  walk(ast, (n) => {
    if (/^(?:Import|ExportAll|ExportNamed)Declaration$/.test(n.type) && n.source) specs.push(n.source.value);
    if (n.type === 'ImportExpression') loader(n.source, n);
    if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'require') loader(n.arguments[0], n);
    if (n.type === 'Literal' && typeof n.value === 'string') strings.push(n.value);
    if (n.type === 'TemplateElement') strings.push(n.value.cooked ?? '');
  });
  return { specs, dynamic, strings };
}
const pctDecode = (x) => { try { return decodeURIComponent(x); } catch { return x; } };
const namesVendor = (x) => ((d) => /acorn/i.test(d) || /(?:^|[\\/])vendor[\\/]|[\\/]vendor$/.test(d))(pctDecode(x));
// The non-constant loaders that exist, each pinned to its file and exact source: a new one, or an edit to one, fails.
// A pinned loader is a gap in this check by construction; its reason says why it cannot reach vendor/.
const DYNAMIC_LOADERS = [
  ['ship-ticket/scripts/legacy-golden.capture.test-helper.mjs', 'import(pathToFileURL(join(scriptsDir, name)).href)',
    "load(name): its only calls pass the literals 'eval.mjs' and 'run-summary.mjs', joined to the scripts dir its caller gives (the work tree, or legacy-golden.mjs's git-archive extraction of the pinned base)"],
];
/**
 * [runtime module (relative to root), kind, detail] for every violation in the tree at root. Each runtime module's
 * constant edges are followed TRANSITIVELY through every JS file they land on (a test or test helper included), and every
 * reached file is held to the same three rules: no edge into vendor/, no unpinned non-constant loader, no vendor string.
 */
function vendorOffenders(root, P = path, pinned = DYNAMIC_LOADERS) {
  const { modules, vendors } = skillTree(root);
  const cache = new Map();
  const edgesOf = (f) => { if (!cache.has(f)) cache.set(f, loaderEdges(f, readFileSync(f, 'utf8'))); return cache.get(f); };
  const rel = (f) => relative(root, f).split(sep).join('/');
  const out = [];
  for (const m of modules) {
    const reached = new Set([m]);
    const queue = [m];
    while (queue.length) {
      const f = queue.shift();
      const e = edgesOf(f);
      const via = f === m ? '' : ` (via ${rel(f)})`;
      for (const spec of e.specs) {
        const to = landing(spec, f);
        if (!to) continue;
        if (vendors.some((v) => within(to, v, P))) out.push([rel(m), 'vendor', spec + via]);
        else {
          // ESM needs the exact file; CommonJS also tries extensions and a directory index (and a package.json `main`,
          // which this does NOT follow). Every candidate below that exists is followed, which only adds files to check.
          for (const c of [to, `${to}.js`, `${to}.cjs`, `${to}.mjs`, join(to, 'index.js'), join(to, 'index.cjs')]) {
            if (/\.(?:mjs|cjs|js)$/.test(c) && !reached.has(c) && existsSync(c) && statSync(c).isFile()) { reached.add(c); queue.push(c); }
          }
        }
      }
      for (const d of e.dynamic) if (!pinned.some(([pf, ps]) => pf === rel(f) && ps === d)) out.push([rel(m), 'dynamic', d + via]);
      for (const x of e.strings) if (namesVendor(x)) out.push([rel(m), 'string', x + via]);
    }
  }
  return out;
}

test('T4a: the vendored parser is test-only as far as loader specifiers go: no runtime module of any skill reaches vendor/ through them, transitively', () => {
  const skills = join(here, '..', '..', '..');
  const { modules, vendors } = skillTree(skills);
  assert.ok(modules.length > 50 && modules.includes(join(here, 'git-exec.mjs')) && vendors.includes(VENDOR.replace(/[\\/]acorn$/, '')), `runtime modules: ${modules.length}`);
  assert.ok(new Set(modules.map((m) => relative(skills, m).split(sep)[0])).size > 1, 'every skill is scanned, not only ship-ticket');
  assert.deepEqual(vendorOffenders(skills), []);
  // Every pinned loader still exists exactly (an edited or removed one is stale), and is reached from a runtime module.
  for (const [f, src] of DYNAMIC_LOADERS) assert.ok(loaderEdges(join(skills, f), readFileSync(join(skills, f), 'utf8')).dynamic.includes(src), `stale pin: ${f}`);
  assert.ok(vendorOffenders(skills, path, []).some(([, k, d]) => k === 'dynamic' && d.startsWith(DYNAMIC_LOADERS[0][1])), 'the pin is load-bearing');
  // Control: the same edge reader sees this test file's own (non-constant) import of the parser and its strings.
  const self = loaderEdges(join(here, 'git-exec.test.mjs'), readFileSync(join(here, 'git-exec.test.mjs'), 'utf8'));
  assert.ok(self.dynamic.some((d) => /acorn\.mjs/.test(d)) && self.strings.filter(namesVendor).length >= 2);
});

test('T4a: the test-only check flags each leg: relative, folded, template, file: URL (percent-encoded), URL constant, require, re-export, non-constant loader, via a test file, string; containment is per platform', (t) => {
  const root = tmp(t);
  const sk = join(root, 's');
  mkdirSync(join(sk, 'vendor', 'acorn'), { recursive: true });
  mkdirSync(join(sk, 'scripts'), { recursive: true });
  writeFileSync(join(sk, 'vendor', 'acorn', 'acorn.mjs'), 'export const v = 1;\n');
  const encoded = pathToFileURL(join(sk, 'vendor', 'acorn', 'x.mjs')).href.replace('/vendor/', '/%76endor/').replace('/acorn/', '/%61corn/');
  const legs = {
    'rel.mjs': ["import '../vendor/acorn/acorn.mjs';", 'vendor'], 'fold.mjs': ["await import('../ven' + 'dor/x/y.mjs');", 'vendor'],
    'tpl.mjs': ["await import(`../vendor/${'x'}/y.mjs`);", 'vendor'], 'enc.mjs': [`await import(${JSON.stringify(encoded)});`, 'vendor'],
    'url.mjs': ["const U = new URL('../ve' + 'ndor/x/y.mjs', import.meta.url).href;\nawait import(U);", 'vendor'],
    'req.cjs': ["require('../vendor/x/y.js');", 'vendor'], 'reexp.mjs': ["export * from '../vendor/x/y.mjs';", 'vendor'],
    'dyn.mjs': ['const p = globalThis.p;\nawait import(p);', 'dynamic'], 'dynreq.cjs': ['require(process.argv[2]);', 'dynamic'],
    'tst.mjs': ["import './t.test.mjs';", 'vendor'], 'hlp.mjs': ["import { h } from './h.test-helper.mjs';", 'dynamic'], 'deep.mjs': ["import './ok.mjs';\nimport './tst.mjs';", 'vendor'],
    'str.mjs': ["const s = '%61corn';", 'string'], 'cjsx.cjs': ["require('./ext.test');", 'vendor'], 'cjsdir.cjs': ["require('./pkg');", 'vendor'], 'ok.mjs': ["import './benign.mjs';\nimport 'node:fs';\nconst s = 'vendors are fine';", null],
  };
  for (const [f, [src]] of Object.entries(legs)) writeFileSync(join(sk, 'scripts', f), `${src}\n`);
  writeFileSync(join(sk, 'scripts', 'a.test.mjs'), "import '../vendor/acorn/acorn.mjs';\n");
  // Reached test files: one imports the parser, one loads by a non-constant specifier, one is benign.
  writeFileSync(join(sk, 'scripts', 't.test.mjs'), "import '../vendor/acorn/acorn.mjs';\n");
  writeFileSync(join(sk, 'scripts', 'h.test-helper.mjs'), 'export const h = (n) => import(n);\n');
  writeFileSync(join(sk, 'scripts', 'b.test-helper.mjs'), "import 'node:fs';\nexport const b = 1;\n");
  writeFileSync(join(sk, 'scripts', 'benign.mjs'), "import { b } from './b.test-helper.mjs';\n");
  // CommonJS: an extensionless require of a test file, and of a directory index, each reaching the parser.
  writeFileSync(join(sk, 'scripts', 'ext.test.js'), "require('../vendor/acorn/acorn.mjs');\n");
  mkdirSync(join(sk, 'scripts', 'pkg'));
  writeFileSync(join(sk, 'scripts', 'pkg', 'index.js'), "require('../../vendor/acorn/acorn.mjs');\n");
  const got = vendorOffenders(root);
  for (const [f, [, kind]] of Object.entries(legs)) {
    const mine = got.filter(([m]) => m === `s/scripts/${f}`).map(([, k]) => k);
    assert.deepEqual(mine.includes(kind) || (kind === null && mine.length === 0), true, `${f}: ${JSON.stringify(mine)}`);
  }
  assert.ok(!got.some(([m]) => m.endsWith('a.test.mjs')), 'a test file is not a runtime module');
  assert.deepEqual(got.filter(([m]) => m === 's/scripts/benign.mjs'), [], 'a runtime module may reach a benign test helper');
  assert.deepEqual(got.find(([m]) => m === 's/scripts/tst.mjs'), ['s/scripts/tst.mjs', 'vendor', '../vendor/acorn/acorn.mjs (via s/scripts/t.test.mjs)']);
  assert.deepEqual(vendorOffenders(root, path, [['s/scripts/h.test-helper.mjs', 'import(n)']]).filter(([m]) => m === 's/scripts/hlp.mjs'), [], 'a pinned loader is not reported');
  // Containment by the platform's rules: on win32 another drive is outside, and the parent itself is inside.
  assert.equal(within('D:\\safe\\x.mjs', 'C:\\repo\\vendor\\acorn', path.win32), false, 'cross-drive (codex r5 #7)');
  assert.equal(within('C:\\repo\\vendor\\acorn\\a.mjs', 'C:\\repo\\vendor\\acorn', path.win32), true);
  assert.equal(within('C:\\repo\\vendor\\acornx\\a.mjs', 'C:\\repo\\vendor\\acorn', path.win32), false);
  assert.equal(within('\\\\srv\\share\\vendor\\a.mjs', 'C:\\repo\\vendor', path.win32), false, 'UNC root');
  assert.equal(within('/r/vendor/a.mjs', '/r/vendor', path.posix), true);
  assert.equal(within('/r/vendor/../x.mjs', '/r/vendor', path.posix), false);
});

/** Deterministic PRNG (mulberry32) for the seeded property test. */
const prng = (seed) => () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const PARSE = { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true };
// [form, the rule it must raise in place, top level only (an import)]: the listed forms and the reviewer escapes.
const INJECT = [
  ['b.toString()', 'decoder-api'], ["b['toLocaleString']()", 'decoder-api'], ['new TextDecoder()', 'decoder-lossy'], ['b\n  .toString()', 'decoder-api'],
  ['String(b)', 'string-coercion'], ["readFileSync(p, 'utf8')", 'read-encoding'], ["spawnSync(g, [], { encoding: 'latin1' })", 'cp-encoding'],
  ['readdirSync(d)', 'name-api-no-buffer'], ['realpathSync.native(\n  d)', 'name-api-no-buffer'], ["readdirSync(d); const __t4a = { encoding: 'buffer' }", 'name-api-no-buffer'],
  ['readlinkSync(p, {})', 'name-api-no-buffer'], ['process.cwd()', 'cwd'], ['execFileSync(g, a)', 'unclassifiable'], ['const __t4a = readdirSync', 'unclassifiable'],
  ["exec(c, 'buffer', f)", 'unclassifiable'],
  ['const 𝑥 = 1, __t4a = 𝑥 / 2 + b.toString()', 'decoder-api'], ["b['to' + 'String']()", 'decoder-api'], ["while (false) { break\n/'/; } b.toString(); /'/", 'decoder-api'],
  ["readdirSync(d, {}, 'buffer')", 'name-api-no-buffer'], ["globalThis.eval('b.toString()')", 'unclassifiable'],
  ["(function () {}).constructor('return b.toString()')", 'unclassifiable'], ["process.getBuiltinModule('node:child_process')", 'unclassifiable'],
  ["spawnSync(g, [], { __proto__: o })", 'unclassifiable'],
  ["import { default as __t4a } from 'node:child_process';\n__t4a.exec(c)", 'cp-encoding', true], ["import { createRequire as __t4a } from 'node:module'", 'unclassifiable', true],
  ["import * as __t4a from 'node:fs';\n__t4a.readdirSync(d)", 'name-api-no-buffer', true],
  // round 5: encoded specifier, descriptor reflection, a dynamic-key read, Object as a value, Proxy
  ["import { r as __t4a } from './%2e%2e/bridge.mjs'", 'unclassifiable', true], ["export * from './%2e%2e/bridge.mjs'", 'unclassifiable', true],
  ["Object.getOwnPropertyDescriptor(Object.getPrototypeOf(() => {}), 'constructor')", 'unclassifiable'], ["const __t4a = b['con' + 'structor']", 'unclassifiable'],
  ['const __t4a = b[k]', 'unclassifiable'], ['const __t4a = Object', 'unclassifiable'], ['new Proxy(b, {})', 'unclassifiable'],
];
test('T4a property: each listed form and reviewer escape injected at seeded random statement boundaries of the scanned lib sources is flagged in place', () => {
  assert.ok(acorn, 'the vendored acorn failed its integrity check (UPSTREAM.json)');
  const SEED = 0x5021b;
  const rnd = prng(SEED);
  const RUNS = 8;
  let checked = 0;
  for (const f of SCANNED) {
    for (const nl of ['\n', '\r\n']) {
      const src = readFileSync(join(here, f), 'utf8').replace(/\r?\n/g, nl);
      const top = [];
      const all = [];
      walk(acorn.parse(src, PARSE), (n) => {
        const list = n.type === 'SwitchCase' ? n.consequent : ['Program', 'BlockStatement', 'StaticBlock'].includes(n.type) ? n.body : [];
        for (const s of list) (n.type === 'Program' ? top : all).push(s.start);
      });
      all.push(...top);
      assert.ok(top.length > 10 && all.length > 50, `${f}: statement boundaries found`);
      for (const [form, rule, topOnly] of INJECT) {
        for (let r = 0; r < RUNS; r++) {
          const pool = topOnly ? top : all;
          const at = pool[Math.floor(rnd() * pool.length)];
          const where = `seed ${SEED}: ${JSON.stringify(form)} at ${f}:${at} (${nl === '\n' ? 'LF' : 'CRLF'})`;
          const put = (text) => src.slice(0, at) + text + src.slice(at);
          const text = `;${form.replace(/\n/g, nl)};${nl}`;
          assert.doesNotThrow(() => acorn.parse(put(text), PARSE), `${where}: the injected source must parse (a parse error would make the check vacuous)`);
          assert.ok(decodeSites(f, put(text), SCANNED).some((h) => h.pos >= at && h.pos < at + text.length && h.rule === rule), `${where} not flagged as ${rule}`);
          // controls: the same text as a comment, string or template text, or neutral code, adds no hit in place.
          const tplText = form.replace(/[\\`$]/g, '\\$&');
          for (const ctl of [`/* ${form} */ `, `// ${form.replace(/\n/g, ' ')}${nl}`, `;${JSON.stringify(form)};${nl}`, `;\`${tplText}\`;${nl}`, `;void 0;${nl}`]) {
            assert.doesNotThrow(() => acorn.parse(put(ctl), PARSE), `${where}: control parses`);
            assert.deepEqual(decodeSites(f, put(ctl), SCANNED).filter((h) => h.pos >= at && h.pos < at + ctl.length), [], `${where}: control ${JSON.stringify(ctl)}`);
          }
          checked++;
        }
      }
    }
  }
  assert.equal(checked, SCANNED.length * 2 * INJECT.length * RUNS, 'every injection ran');
});

// ------------------------------------------------------------------ mutation evidence (AC6)
// ROUND 6 (current): the harness, its full log, the tally and the sha256 of every file under test are in
// .specs/reviews/S-02a0b/round-6/ (kept out of this file, so the tested bytes are the committed bytes). The round-5
// record below is historical: it describes the checker before the grammar layer.
// Harness (round 5): session scratchpad s02b-repair/mutation-round5/mutate5.py (+ lib_mutants.py; round 4's set re-anchored, plus
// one or more mutants per round-5 rule). Each run gets a copy of the whole skill folder (the runtime-module scan needs
// it); anchors are LF-normalised and must match exactly once. A mutant counts as KILLED only when the baseline test
// count ran and a failing test reports ERR_ASSERTION; a load failure, changed test count or timeout is INVALID.
// Round 5 (Node 22.23.1), final: ONE full run on this file (mutants-round5-final.log; an earlier full run found four
// test gaps, since closed by fixtures): 177 mutants (63 git-exec + 5 git-capability + 107 checker + 2 vendor), 174
// killed, 0 invalid, 3 EQUIVALENT survivors: the round-trip check (a fatal decoder already refuses every non-UTF-8
// input); in resolveSpecifier the file:-protocol check (fileURLToPath already throws ERR_INVALID_URL_SCHEME) and the
// bare/# guard (such a specifier then reaches new URL(spec) without a base, which throws). This paragraph was filled
// in after the run (comment only; the pre-fill copy is kept beside the log).
// Round 5 adds: resolution (string check instead of URL resolution, any file, bare/# specifiers URL-resolved,
// percent-encoding not decoded, re-export from a builtin); reflection (Proxy, prototype, descriptors, reflective
// strings, + and template folding, own-value production, defineProperty shape, object-literal __proto__, Object as a
// value or any member, Object binding); computed keys (any read, dynamic destructuring, + as numeric, compound
// assignment as a write, loop counter rebinding / var / non-numeric init / any update, table prototype / freeze /
// values / rebinding / let); node types (unknown or refused types walked, WithStatement walked); the complete-
// invocation pin (site = node, arguments detached); the scan partition; lib: the argless decode, unfrozen or
// prototyped launch and ERROR_ROW tables, ownValue as a plain read, classify reading the status map directly.
// | Area                 | Mutants (each killed by a named assertion)                                          |
// |----------------------|-------------------------------------------------------------------------------------|
// | scrub / compose      | case-sensitive GIT_* scrub; SSH_ASKPASS kept; BASE key dropped; no ambient scrub;   |
// |                      | COUNT clobbered; neutralisation before policy pairs; Windows collapse keeps last;  |
// |                      | set keeps case variants; policy sets any GIT_* / overrides BASE; caller pair        |
// |                      | overrides a BASE pair; neutralisation pairs unrestricted; NO_LAZY_FETCH always;    |
// |                      | hermetic keeps HOMEDRIVE/HOMEPATH; ambient NUL/'=' entries kept                    |
// | target-platform paths| POSIX accepts C:\ or \ forms; win32 accepts rooted-relative; union of both;       |
// |                      | ceiling selection not path-checked                                                  |
// | filter discovery     | drops clean / smudge / process / required (each alone); accepts any attribute;     |
// |                      | required neutralised to ''; upstream `>` bound (empty driver)                       |
// | prototype keys       | Object.prototype accumulator (__proto__ shrinks the env size); getter-read values  |
// | decoding             | fatal:false and BOM stripped (both killed by the T4a decoder-lossy rule; with the  |
// |                      | round-trip present they are behaviourally equivalent or throw a typed error);     |
// |                      | zSplit drops empties; strings accepted; label backslash. EQUIVALENT: round-trip    |
// |                      | removed (a fatal decoder already refuses every non-UTF-8 input; defence in depth)  |
// | outcomes             | signal before error rows; stderr before status; swallowed decode error; ENOBUFS /  |
// |                      | ETIMEDOUT unmapped; killSignal SIGTERM; Windows bound off; size +1 per entry;      |
// |                      | bound `>=`; missing cwd not pre-checked; env platform not matched; non-composed    |
// |                      | env accepted; unknown run keys accepted; args array check removed                  |
// | serialisation        | stderr stored on the object; stderr not capped; toJSON carries stderr; inspect     |
// |                      | redaction removed; op not validated                                                  |
// | T4a on the real lib  | toString / toLocaleString / String(bytes) / process.cwd() site added; spawn args   |
// |                      | passed as a variable; spawn options from a variable; git-capability: latin1 map    |
// |                      | swapped for utf8 at its allowlisted site; a second toString in parseGitVersion     |
// | T4a checker (round 4| parse error passes; walker skips arrays; bindings ignored; alias bound under the   |
// | set, 70; round 5 adds| imported name; namespace/default not bound; unclassified module, ../ and non-.mjs  |
// |                      | imports pass; buffer accepted at any later argument; name options read at index 0;|
// |                      | __proto__ / computed / accessor options accepted; options encoding value          |
// |                      | unchecked; spread passes; dynamic cp args pass; string cp options accepted; cp     |
// |                      | array args not recognised; exec/execFile default taken as buffer; cp encoding     |
// |                      | never reported; spawn/fork pass; read encoding unchecked; non-call API use passes;|
// |                      | .native not followed; namespace as a value passes; unclassified fs member passes; |
// |                      | dynamic import, re-export, export of a binding pass; opaque / decoder globals pass;|
// |                      | decoder-lossy never raised; any fatal value; ignoreBOM not required; String member|
// |                      | calls exempt; String.raw exempt; process any member; cwd call not flagged; Buffer |
// |                      | any member; .constructor passes; no constant folding; string-built key passes;    |
// |                      | assignment target not exempt; template pieces not string pieces; computed call    |
// |                      | passes; member decoder names missed; unbound names and unknown receivers ignored;  |
// |                      | bound receivers double-checked; any bound root silences the by-name rule;         |
// |                      | destructured API / decoder pass; binding positions read as uses; encoding entry   |
// |                      | value unchecked; encoding member passes; encoding-literal removed; template chunks|
// |                      | ignored; utf-8 spelling; toLocaleString; import specifier tripwire; allowlist     |
// |                      | ignores ordinal / node text; fnName ignores object names; subdirectories skipped;  |
// |                      | mkdirSync classified safe; spread TextDecoder args; constructor destructuring;    |
// |                      | Function / atob / opendir dropped from their lists                                 |
// | vendored acorn       | one byte of acorn.mjs changed; an extra file in vendor/acorn                        |

