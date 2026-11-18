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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

// ------------------------------------------------------------------ T4a: decode-site check on the AST (AC4)

// HOW. Every non-test .mjs module under lib/ (subdirectories included) is PARSED by the vendored acorn 8.19.0
// (skills/ship-ticket/vendor/acorn, MIT, byte-identical to the registry tarball, hash-checked against
// UPSTREAM.json before it is imported; test-only, never imported by production code) as an ES module
// (ecmaVersion latest). A source acorn cannot parse is one `unclassifiable` hit. A tiny walker visits every
// node that has a `type` (no per-node-type list, so an unforeseen node kind is still walked). Imports of
// fs, fs/promises and child_process (bare or node:) are resolved through the module's own BINDINGS: named,
// aliased (`{ readdirSync as rd }`, `{ default as cp }`), default and namespace imports, and `ns.member`,
// `ns.promises.member` and `ns.default.member` chains. Resolution is by name, not by scope: a local that
// shadows an import is treated as the import, and a watched API name used as a member keeps its by-name rule
// unless its root is a checked module's namespace (so a shadowing `path` or `statSync` hides nothing). A
// watched API name with no import binding (a parameter, a seam object, a local) is treated as the API it
// names (`seam.realpath(d)`). What a caller outside lib/ passes in is data flow (not checked).
//
// WHAT IT CHECKS (one rule each; the allowlist pins rule names):
//  - decoder-api: a member, a constant computed member (`b['to' + 'String']`, `b['to\x53tring']`), a
//    destructured key, an import specifier or a string that names toString, toLocaleString, setEncoding, a
//    Buffer *Slice decoder, TextDecoder(Stream) or StringDecoder; any reference to TextDecoder(Stream),
//    StringDecoder, Response, Blob, File or atob;
//  - decoder-lossy: a TextDecoder that is not `new TextDecoder(x, {...})` (no spread) with exactly one
//    `fatal: true` and exactly one `ignoreBOM: true` (a static literal);
//  - string-coercion: any reference to the global String other than String.fromCharCode or .fromCodePoint
//    (String.raw included: it converts its raw elements to strings);
//  - encoding-literal: a string or template chunk equal to a text encoding (utf8, utf-8, latin1, binary, ascii,
//    ucs2, utf16le; any case); encoding-option: an `encoding` key, member or variable that is not an object
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
// FAIL CLOSED ('unclassifiable'; never allowlisted):
//  - a parse error;
//  - an import of any module other than fs, fs/promises, child_process or path, or a scanned lib module
//    (`./*.mjs`, not a test; so `../`, `.cjs`, `.js` and `.json` fail);
//  - a re-export from any of those modules; an export of a watched binding or name;
//  - an fs or child_process name not classified as checked or known not to return text;
//  - a watched API or namespace used other than as a direct call or `ns.member` (aliased to a variable,
//    destructured, `.call/.apply/.bind`, `(0, f)()`, `new`, passed or exported as a value);
//  - a spread argument to a checked call, or options that are not static: an identifier, a call, a spread,
//    a computed key, `__proto__` or an accessor;
//  - spawnSync or execFile(Sync) args that are neither an array literal nor an object literal (Node then may
//    take the args as the options and ignore the literal after them, MEASURED Node 18 and 22), and
//    child_process options given as a string (exec ignores 'buffer' and returns a string, MEASURED);
//  - spawn and fork (asynchronous output is not analysed); dynamic import;
//  - require, module, exports, eval, Function, globalThis, global, self, window, Reflect, WebAssembly,
//    createRequire and getBuiltinModule as names;
//  - `process` other than process.env, process.platform or a process.cwd() call (so process.binding,
//    .getBuiltinModule, .mainModule, .argv), and Buffer other than from, isBuffer, alloc, allocUnsafe,
//    concat, byteLength and compare;
//  - any `.constructor` member or destructured `constructor` key;
//  - a computed key built from string pieces that does not fold to a constant (unless only assigned to);
//  - a call through a computed member whose key is not a constant (`b[k]()`).
// NOT CHECKED: anything not named above. In particular (review items; T4b is the behavioural backstop; each
// example is asserted to give no hit below):
//  - ANY implicit ToString of a Buffer: `${buf}`, `buf + ''`, Array#join, JSON.parse(buf), RegExp#exec or
//    #test(buf), loose equality, use as a property key;
//  - String.fromCharCode and .fromCodePoint in any call form (exempt by design: a latin1 map);
//  - a READ through a computed key held in a variable (`b[k]`; a CALL through one fails closed);
//  - `x.exec(...)` as a member (taken to be RegExp#exec);
//  - process.env values (decoded by the OS and Node; the lib copies them, never compares them with git bytes);
//  - the implicit cwd of path.resolve; data flow (which value is a Buffer); anything outside lib/.
// Evidence: the planted, escape, unchecked and fine fixtures and the seeded property test below; the checker
// mutants in the AC6 table.
const VENDOR = join(here, '..', '..', 'vendor', 'acorn');
const UPSTREAM = JSON.parse(readFileSync(join(VENDOR, 'UPSTREAM.json'), 'utf8'));
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
// Integrity BEFORE load: acorn is imported only when every pinned file hashes to UPSTREAM.json. On a hash mismatch
// every T4a test fails on an assertion (not at module load), so the suite keeps its test count. A MISSING
// UPSTREAM.json or pinned file throws at module load instead: the whole suite then fails to start.
const VENDOR_OK = Object.entries(UPSTREAM.files).every(([f, { sha256: h }]) => sha256(join(VENDOR, f)) === h);
const acorn = VENDOR_OK ? await import(pathToFileURL(join(VENDOR, 'acorn.mjs')).href) : null;

test('T4a: the vendored acorn is exactly the pinned upstream bytes, and nothing else is in its directory', () => {
  assert.equal(UPSTREAM.name, 'acorn');
  assert.equal(UPSTREAM.version, '8.19.0');
  assert.deepEqual(readdirSync(VENDOR).sort(), [...Object.keys(UPSTREAM.files), 'UPSTREAM.json'].sort());
  for (const [f, { sha256: h }] of Object.entries(UPSTREAM.files)) assert.equal(sha256(join(VENDOR, f)), h, f);
  assert.equal(acorn?.version, UPSTREAM.version, 'the loaded parser is the pinned one');
});

const ENC_NAME = /^(?:utf-?8|latin1|binary|ascii|ucs-?2|utf-?16le)$/i;
const DECODER_NAME = /^(?:toString|toLocaleString|setEncoding|(?:utf8|latin1|ascii|ucs2|utf16le|binary|hex|base64|base64url)Slice|TextDecoder(?:Stream)?|StringDecoder)$/;
const DECODER_GLOBAL = new Set(['TextDecoder', 'TextDecoderStream', 'StringDecoder', 'Response', 'Blob', 'File', 'atob']);
const OPAQUE_GLOBAL = new Set(['require', 'module', 'exports', 'eval', 'Function', 'globalThis', 'global', 'self', 'window', 'Reflect', 'WebAssembly', 'createRequire', 'getBuiltinModule']);
const NAME_API = /^(?:realpath|readdir|readlink|mkdtemp|opendir)(?:Sync)?$/;
const READ_API = /^readFile(?:Sync)?$/;
const CP_API = /^(?:spawnSync|execFileSync|execSync|spawn|execFile|exec|fork)$/;
const MODULES = { fs: 'fs', 'node:fs': 'fs', 'fs/promises': 'fsp', 'node:fs/promises': 'fsp', child_process: 'cp', 'node:child_process': 'cp', path: 'path', 'node:path': 'path' };
// fs names that return no text: anything not here, not checked and not `promises` is unclassifiable. mkdir(Sync)
// is NOT here: with `recursive` it returns the first directory created as a string (MEASURED, Node 18 and 22).
const FS_SAFE = new Set(['statSync', 'lstatSync', 'fstatSync', 'stat', 'lstat', 'accessSync', 'access', 'existsSync', 'constants',
  'rmSync', 'rm', 'rmdirSync', 'unlinkSync', 'unlink', 'writeFileSync', 'writeFile', 'appendFileSync', 'renameSync', 'rename', 'chmodSync', 'chmod',
  'copyFileSync', 'openSync', 'closeSync', 'writeSync', 'readSync', 'fsyncSync', 'symlinkSync', 'linkSync', 'truncateSync', 'utimesSync']);
// A lib module the scan itself reads: `./`, no `..`, `.mjs`, not a test (a `.cjs`/`.js` there would go unscanned).
const isRel = (s) => s.startsWith('./') && !/(?:^|\/)\.\.(?:\/|$)/.test(s) && s.endsWith('.mjs') && !s.endsWith('.test.mjs');
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
/** The string an expression always evaluates to (string literal, template without substitutions, `+` of those). */
const staticStr = (n) => (n?.type === 'Literal' && typeof n.value === 'string' ? n.value
  : n?.type === 'TemplateLiteral' && !n.expressions.length ? n.quasis[0].value.cooked
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
      || (p.type === 'CatchClause' && k === 'param') || (p.type === 'AssignmentExpression' && k === 'left') || (/^For(?:In|Of)Statement$/.test(p.type) && k === 'left')) return true;
    if (p.type === 'AssignmentPattern' ? k !== 'left' : !(['ArrayPattern', 'ObjectPattern', 'RestElement'].includes(p.type)
      || (p.type === 'Property' && k === 'value' && anc[i - 1]?.node.type === 'ObjectPattern'))) return false;
  }
  return false;
}
const NOT_REF_KEY = { MemberExpression: 'property', Property: 'key', MethodDefinition: 'key', PropertyDefinition: 'key' };

/** Every decode site in one module's source: [{file, fn, rule, why, line, pos, text (the flagged node's own source)}] in source order. */
function decodeSites(file, src) {
  assert.ok(acorn, 'the vendored acorn failed its integrity check (UPSTREAM.json)');
  let ast;
  try { ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true }); } catch (e) {
    return [{ file, fn: '<module>', rule: 'unclassifiable', why: `parse error: ${e.message}`, line: e.loc?.line ?? 1, pos: e.pos ?? 0, text: '' }];
  }
  const hits = [];
  let anc = [];
  const hit = (n, rule, why = rule) => hits.push({ file, fn: fnName(anc), rule, why, line: n.loc.start.line, pos: n.start, text: src.slice(n.start, n.end).replace(/\s+/g, ' ') });
  // Import bindings of the watched modules: local name -> {mod, name (null for a namespace or default)}.
  const binds = new Map();
  for (const d of ast.body) {
    if (d.type !== 'ImportDeclaration') continue;
    const mod = MODULES[d.source.value];
    if (!mod && !isRel(d.source.value)) hit(d, 'unclassifiable', `import of unclassified module ${d.source.value}`);
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
      case 'ExportAllDeclaration': case 'ExportNamedDeclaration':
        if (n.source && !isRel(n.source.value)) hit(n, 'unclassifiable', `re-export from ${n.source.value}`);
        if (!n.source) for (const s of n.specifiers ?? []) if (binds.has(s.local.name) || byName(s.local.name)) hit(s, 'unclassifiable', `export of ${s.local.name}`);
        return undefined;
      case 'Literal': case 'TemplateLiteral': {
        if (k === 'source') return undefined;
        const texts = n.type === 'Literal' ? (typeof n.value === 'string' ? [n.value] : []) : n.quasis.map((q) => q.value.cooked ?? '');
        // A literal computed key is checked as the member or property name it is; only the encoding tripwire runs here.
        for (const t of texts) { if (ENC_NAME.test(t)) hit(n, 'encoding-literal'); if (!computedKey && DECODER_NAME.test(t)) hit(n, 'decoder-api'); }
        return undefined;
      }
      case 'CallExpression':
        if (n.callee.type === 'MemberExpression' && n.callee.computed && staticKey(n.callee) === null) hit(n.callee, 'unclassifiable', 'call through a computed member');
        return undefined;
      case 'MemberExpression': {
        const key = staticKey(n);
        if (key === null) {
          if (hasStringPiece(n.property) && !(p.type === 'AssignmentExpression' && k === 'left' && p.operator === '=')) hit(n, 'unclassifiable', 'computed key built from string pieces');
          return undefined;
        }
        if (DECODER_NAME.test(key)) hit(n, 'decoder-api');
        if (key === 'constructor') hit(n, 'unclassifiable', '.constructor reaches Function');
        if (key === 'encoding') hit(n, 'encoding-option');
        const mod = byName(key);
        if (mod && key !== 'exec' && !rootBound(n.object)) useOf(mod, key, n, a.length - 1);
        return undefined;
      }
      case 'Property': {
        const name = propName(n);
        if (name === null) { if (hasStringPiece(n.key)) hit(n, 'unclassifiable', 'computed key built from string pieces'); return undefined; }
        if (p.type === 'ObjectPattern') {
          if (DECODER_NAME.test(name)) hit(n, 'decoder-api');
          if (byName(name)) hit(n, 'unclassifiable', `${name} destructured`);
          if (name === 'constructor') hit(n, 'unclassifiable', 'constructor destructured (reaches Function)');
        }
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
          return hit(n, 'unclassifiable', member === null ? 'process used as a value' : `process.${member} is not classified`);
        }
        if (v === 'Buffer') return ['from', 'isBuffer', 'alloc', 'allocUnsafe', 'concat', 'byteLength', 'compare'].includes(member) ? undefined : hit(n, 'unclassifiable', `Buffer.${member} is not classified`);
        if (v === 'encoding' && !(p?.type === 'Property' && p.shorthand)) hit(n, 'encoding-option');
        const mod = byName(v);
        return mod ? useOf(mod, v, n, a.length - 1) : undefined;
      }
      default: return undefined;
    }
  });
  return hits.sort((x, y) => x.pos - y.pos);
}

/** lib/ modules (recursive), excluding tests, as paths relative to lib/ with `/` separators. */
function libModules(dir = here, rel = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? libModules(join(dir, d.name), `${rel}${d.name}/`)
    : d.name.endsWith('.mjs') && !d.name.endsWith('.test.mjs') ? [`${rel}${d.name}`] : [])).sort();
}
// Sanctioned sites: [file, enclosing function, rule, ordinal of that rule in that function (source order), the
// flagged node's own source text (whitespace-normalised), reason]. A hit no entry names exactly fails, and so does
// an entry no hit matches (stale): a second same-rule site in the function is a new ordinal, and swapping a site
// for another (`toString('latin1')` -> `toString('utf8')`) changes its text. The LINE is not pinned, so CRLF and
// reformatting elsewhere do not matter. `unclassifiable` is never allowlisted.
const ALLOWED_SITES = [
  ['git-exec.mjs', '<module>', 'decoder-api', 0, 'TextDecoder', 'the one strict decoder (fatal and ignoreBOM true; decoder-lossy fires otherwise)'],
  ['git-exec.mjs', '<module>', 'encoding-literal', 0, "'utf-8'", 'its label'],
  ['git-capability.mjs', 'realFs.realpath', 'name-api-no-buffer', 0, 'realpathSync', 'resolves PATH entries (already strings) to the spawn executable; never compared with git output (S-02a0a, owned there)'],
  ['git-capability.mjs', 'resolveGitBinary', 'cwd', 0, 'process.cwd', 'default cwd used only to ban PATH dirs inside it; never compared with git output (S-02a0a, owned there)'],
  ['git-capability.mjs', 'resolveGitBinary', 'name-api-no-buffer', 0, 'fs.realpath', 'the resolver seam: realpath of caller-supplied string dirs, compared only with other PATH strings (S-02a0a)'],
  ['git-capability.mjs', 'resolveGitBinary', 'string-coercion', 0, 'String', 'coerces the PATH env value (already a string), not bytes'],
  ['git-capability.mjs', 'resolveGitBinary', 'name-api-no-buffer', 1, 'fs.realpath', 'the resolver seam: the spawn executable, never compared with git output (S-02a0a)'],
  ['git-capability.mjs', 'parseGitVersion', 'string-coercion', 0, 'String', 'encodes (string to bytes); not a decode'],
  ['git-capability.mjs', 'parseGitVersion', 'encoding-literal', 0, "'utf8'", 'Buffer.from(string, utf8): string to bytes'],
  ['git-capability.mjs', 'parseGitVersion', 'decoder-api', 0, 'bytes.toString', 'lossless byte-to-code-point map feeding an ASCII-only anchored regex; any non-ASCII byte fails it (S-02a0a, owned there)'],
  ['git-capability.mjs', 'parseGitVersion', 'encoding-literal', 1, "'latin1'", 'the encoding of that map'],
];
/** Each hit's site key: file, function, rule, its ordinal among same-(file, function, rule) hits in order, and its text. */
const siteKeys = (hits) => { const seen = new Map(); return hits.map((h) => { const b = `${h.file}\0${h.fn}\0${h.rule}`; const n = seen.get(b) ?? 0; seen.set(b, n + 1); return `${b}\0${n}\0${h.text}`; }); };
/** unexplained: hits no entry names; stale: entries no hit matches. */
function allowVerdict(hits, allowed = ALLOWED_SITES) {
  const keys = siteKeys(hits);
  const want = allowed.map(([f, fn, r, n, text]) => `${f}\0${fn}\0${r}\0${n}\0${text}`);
  return { unexplained: keys.filter((x) => !want.includes(x)), stale: want.filter((x) => !keys.includes(x)) };
}

test('T4a: no listed lossy decode form appears in lib/ outside the strict decoder or an allowlisted, reasoned site', () => {
  const files = libModules();
  assert.ok(files.includes('git-exec.mjs') && files.includes('git-capability.mjs'), `scanned: ${files}`);
  const hits = files.flatMap((f) => decodeSites(f, readFileSync(join(here, f), 'utf8')));
  assert.deepEqual(hits.filter((h) => h.rule === 'unclassifiable'), [], 'no site the checker cannot classify (fail closed; never allowlisted)');
  const { unexplained, stale } = allowVerdict(hits);
  assert.deepEqual(unexplained, []);
  assert.deepEqual(stale, [], 'every allowlist entry matches a real site');
  assert.ok(!ALLOWED_SITES.some(([, , r]) => r === 'unclassifiable'));
  // One more site of an allowlisted rule in the same function is a new ordinal, so it is unexplained.
  const extra = allowVerdict([...hits, { ...hits.find((h) => h.fn === 'parseGitVersion' && h.rule === 'decoder-api'), pos: Infinity }]);
  assert.deepEqual(extra.unexplained, ['git-capability.mjs\0parseGitVersion\0decoder-api\x001\0bytes.toString']);
  // Swapping an allowlisted site for another of the same rule in the same function changes its text, so it fails.
  const swapped = allowVerdict(hits.map((h) => (h.text === "'latin1'" ? { ...h, text: "'utf8'" } : h)));
  assert.deepEqual([swapped.unexplained, swapped.stale], [["git-capability.mjs\0parseGitVersion\0encoding-literal\x001\0'utf8'"], ["git-capability.mjs\0parseGitVersion\0encoding-literal\x001\0'latin1'"]]);
  assert.ok(hits.some((h) => h.file === 'git-exec.mjs' && h.rule === 'decoder-api' && h.fn === '<module>'), 'positive control: the decoder site itself was seen');
  // L10: a CRLF checkout (Windows) gives the same verdict.
  const crlf = files.flatMap((f) => decodeSites(f, readFileSync(join(here, f), 'utf8').replace(/\r?\n/g, '\r\n')));
  assert.deepEqual(crlf.map((h) => [h.file, h.line, h.fn, h.rule, h.text]), hits.map((h) => [h.file, h.line, h.fn, h.rule, h.text]));
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
  ["spawnSync(b, [], { __proto__: o });", U], ["spawnSync(b, [], { get encoding() { return 'utf8'; } });", ['encoding-literal', 'encoding-option', 'unclassifiable']],
  ['const { ["to" + "String"]: f } = buf;', D], ['(function () {}).constructor("return b.toString()");', U],
  ["import readline from 'node:readline';", U], ["import { text } from 'node:stream/consumers';", U], ['new Blob([buf]).text();', D], ['new Response(buf).text();', D],
  ["import * as fs from 'node:fs';\nfs.globSync('*');", U], ["import * as fs from 'node:fs';\nfs.mkdtempDisposableSync(p);", U], ["process.binding('fs');", U],
  ["Reflect.get(buf, 'to' + 'String');", U], ["const k = 'toString'; buf[k]();", ['decoder-api', 'unclassifiable']],
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
// What the coverage statement declares NOT CHECKED: asserted to give no hit, so the statement stays true.
const UNCHECKED = ['const s = `${buf}`;', "const s = buf + '';", 'const s = [buf].join();', 'const o = JSON.parse(buf);', 'const s = String.fromCharCode(...buf);',
  'const v = buf[k];', 'const m = buf[k]; m.call(buf);', 'const m = re.exec(buf);', "import path from 'node:path';\nconst r = path.resolve('x');"];
const FINE = ['// buf.toString() in a comment', "const n = decodeStrict(buf, 'path_not_utf8');",
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
  const cases = [...PLANTED, ...ESCAPES, ...[...UNCHECKED, ...FINE].map((p) => [p, []])];
  assert.ok(cases.length > 150, 'every fixture list is present');
  const wrong = cases.map(([p, want]) => [p, rulesOf(p), [...want].sort()]).filter(([, got, want]) => got.join() !== want.join());
  assert.deepEqual(wrong, [], 'each case: [source, rules found, rules expected]');
  assert.deepEqual(decodeSites('m.mjs', 'const a = 1;\nconst s = buf\n  .toString();').map((h) => h.line), [2], 'a site reports its own line');
  const fns = decodeSites('m.mjs', 'const o = { f(x) { return x.toString(); } };\nfunction g() { const h = () => String(1); }\nclass C { m() { return process.cwd(); } }');
  assert.deepEqual(fns.map((h) => h.fn), ['o.f', 'g.h', 'C.m'], 'sites are keyed by their enclosing named functions');
});

test('T4a scans lib/ recursively and skips only *.test.mjs', (t) => {
  const d = tmp(t);
  mkdirSync(join(d, 'sub', 'deeper'), { recursive: true });
  for (const f of ['a.mjs', 'a.test.mjs', 'n.js', 'sub/b.mjs', 'sub/deeper/c.mjs', 'sub/b.test.mjs']) writeFileSync(join(d, f), '');
  assert.deepEqual(libModules(d), ['a.mjs', 'sub/b.mjs', 'sub/deeper/c.mjs']);
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
];
test('T4a property: each listed form and reviewer escape injected at seeded random statement boundaries of the real lib sources is flagged in place', () => {
  assert.ok(acorn, 'the vendored acorn failed its integrity check (UPSTREAM.json)');
  const SEED = 0x5021b;
  const rnd = prng(SEED);
  const RUNS = 8;
  let checked = 0;
  for (const f of libModules()) {
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
          assert.ok(decodeSites(f, put(text)).some((h) => h.pos >= at && h.pos < at + text.length && h.rule === rule), `${where} not flagged as ${rule}`);
          // controls: the same text as a comment, string or template text, or neutral code, adds no hit in place.
          const tplText = form.replace(/[\\`$]/g, '\\$&');
          for (const ctl of [`/* ${form} */ `, `// ${form.replace(/\n/g, ' ')}${nl}`, `;${JSON.stringify(form)};${nl}`, `;\`${tplText}\`;${nl}`, `;void 0;${nl}`]) {
            assert.doesNotThrow(() => acorn.parse(put(ctl), PARSE), `${where}: control parses`);
            assert.deepEqual(decodeSites(f, put(ctl)).filter((h) => h.pos >= at && h.pos < at + ctl.length), [], `${where}: control ${JSON.stringify(ctl)}`);
          }
          checked++;
        }
      }
    }
  }
  assert.equal(checked, libModules().length * 2 * INJECT.length * RUNS, 'every injection ran');
});

// ------------------------------------------------------------------ mutation evidence (AC6)
// Harness: session scratchpad review-s02b/acorn-evidence/mutation-round4/mutate4.py (+ lib_mutants.py). Each run gets
// a mirrored tree <tmp>/scripts/lib + <tmp>/vendor/acorn, so the vendored parser and every imported lib module come
// along; anchors are LF-normalised and must match exactly once. A mutant counts as KILLED only when the baseline
// test count ran and a failing test reports ERR_ASSERTION; a load failure, changed test count or timeout is
// INVALID. Round 4, ONE run against this file (log mutants-round4.log, Node 22.23.1; this table's counts were filled
// in afterwards, comment only): 133 mutants (59 git-exec + 2 git-capability + 70 checker + 2 vendor), 132 killed,
// 0 invalid, 1 survived = the EQUIVALENT round-trip mutant.
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
// | T4a checker (test    | parse error passes; walker skips arrays; bindings ignored; alias bound under the   |
// | file, 70)            | imported name; namespace/default not bound; unclassified module, ../ and non-.mjs  |
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
