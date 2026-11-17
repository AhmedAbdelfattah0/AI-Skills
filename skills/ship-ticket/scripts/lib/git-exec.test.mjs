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
import { inspect } from 'node:util';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  const bad = [{ env: { ...ok.env } }, { env: process.env }, { env: composeEnv({ ambient: {}, platform: other, gitInfo: g.info, hooksDir: absFor(other, 'h') }) }, { cwd: 'rel' }, { args: ['a\0b'] }, { args: 'x' }, { bin: '/bin/sh' }, { spawn: () => ({}) }, { shell: true },
    { status: { 0: 'OK!' } }, { stderr: 'sometimes' }, { decode: 'git_failed' }, { timeoutMs: 0 }, { maxBuffer: -1 }, { envLimit: 10 }, { platform: 'win32' }];
  for (const o of bad) assert.throws(() => g.run({ ...ok, ...o }), code('git_op_invalid'), JSON.stringify(Object.keys(o)));
  assert.throws(() => gitRunner({ envLimit: 'x' }), code('git_op_invalid'));
  assert.throws(() => gitRunner({ envLimit: 10 }).run(ok), code('git_env_too_large'), 'the bound is fixed at construction, not per call');
});

// ------------------------------------------------------------------ T4a: no LISTED lossy decode form in lib/ (AC4)

// A lexical scan of every non-test module in lib/ for the forms listed below; a new lib module is scanned
// without edits. It does NOT type values: template interpolation (`${buf}`) and string concatenation
// (`buf + ''`) of a Buffer decode lossily and are NOT detected here; they stay a review item until an
// AST/type-aware check exists. Everything else listed is detected on any line outside an allowlisted site.
const FS_NAME = /\b(?:realpath|readdir|readlink|mkdtemp)(?:Sync)?(?:\s*\.\s*native)?\s*\(|\bprocess\s*\.\s*cwd\s*\(/;
const LOSSY = [
  [/\.to(?:Locale)?String\b|\[\s*['"`]to(?:Locale)?String['"`]\s*\]/, 'Buffer#toString / toLocaleString (called, borrowed or bracketed)'],
  [/\bTextDecoder\b/, 'a TextDecoder outside decodeStrict (with or without new, any global path)'],
  [/\bencoding\s*:\s*['"`](?!buffer['"`])/, 'a text encoding option on a spawn or fs call'],
  [/['"`]utf-?8['"`]/i, 'a utf8 encoding literal'],
  [/['"`](?:latin1|binary|ascii|ucs-?2|utf-?16le)['"`]/i, 'a byte-reinterpreting encoding literal'],
  [/\b(?:utf8|latin1|ascii|ucs2)Slice\b|\bStringDecoder\b|\bsetEncoding\s*\(/, 'a raw slice or stream decoder'],
  [/\bString\s*\(/, 'String() coercion (of a Buffer: an implicit utf8 decode)'],
  // fs name APIs and the cwd return names decoded as UTF-8 by default (lossy); only an explicit buffer encoding is exact.
  [{ test: (c) => FS_NAME.test(c) && !/\bencoding\s*:\s*['"`]buffer['"`]/.test(c) }, 'a name-returning fs call or process.cwd() without encoding: buffer'],
];
// Exact sites allowed, each with its reason. A stale entry fails.
const ALLOWED_SITES = [
  ['git-exec.mjs', "const DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });", 'the one strict decoder'],
  ['git-capability.mjs', "const bytes = Buffer.isBuffer(out) ? out : Buffer.from(String(out), 'utf8');", 'encodes (string to bytes); not a decode'],
  ['git-capability.mjs', "for (const raw of String(pathVar ?? '').split(win ? ';' : ':')) {", 'coerces the PATH env value (already a string), not bytes'],
  ['git-capability.mjs', 'realpath(p) { try { return realpathSync.native(p); } catch { return null; } },', 'resolves PATH entries (already strings) to the spawn executable; never compared with git output (S-02a0a, owned there)'],
  ['git-capability.mjs', 'export function resolveGitBinary({ env = process.env, cwd = process.cwd(), exclude = [], platform = process.platform, fs = realFs } = {}) {', 'default cwd used only to ban PATH dirs inside it; never compared with git output (S-02a0a, owned there)'],
  ['git-capability.mjs', 'const banned = [cwd, ...exclude].flatMap((d) => [P.resolve(d), fs.realpath(d)]).filter(Boolean);', 'the resolver seam above: realpath of caller-supplied string dirs, compared only with other PATH strings (S-02a0a)'],
  ['git-capability.mjs', 'const real = fs.realpath(file);', 'the resolver seam above: the spawn executable, never compared with git output (S-02a0a)'],
  ['git-capability.mjs', 'const m = VERSION.exec(bytes.toString(\'latin1\'));', 'lossless byte-to-code-point map feeding an ASCII-only anchored regex; any non-ASCII byte fails it (S-02a0a, owned there)'],
];
function lossySites(file, src) {
  const hits = [];
  src.split(/\r?\n/).forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '').trim();
    if (!code || code.startsWith('*') || code.startsWith('/*')) return;
    for (const [re, why] of LOSSY) if (re.test(code)) { hits.push({ file, line: i + 1, code, why }); break; }
  });
  return hits;
}

test('T4a: no listed lossy decode form appears in lib/ outside the strict decoder or an allowlisted, reasoned site', () => {
  const files = readdirSync(here).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs')).sort();
  assert.ok(files.includes('git-exec.mjs') && files.includes('git-capability.mjs'), `scanned: ${files}`);
  const hits = files.flatMap((f) => lossySites(f, readFileSync(join(here, f), 'utf8')));
  const unexplained = hits.filter((h) => !ALLOWED_SITES.some(([f, c]) => f === h.file && c === h.code));
  assert.deepEqual(unexplained, []);
  const stale = ALLOWED_SITES.filter(([f, c]) => !hits.some((h) => h.file === f && h.code === c));
  assert.deepEqual(stale, [], 'every allowlist entry still matches a real site');
  assert.ok(hits.some((h) => h.file === 'git-exec.mjs' && /TextDecoder/.test(h.code)), 'positive control: the decoder site itself was seen');
  // L10: a CRLF checkout (Windows) must give the same verdict.
  const crlf = files.flatMap((f) => lossySites(f, readFileSync(join(here, f), 'utf8').replace(/\r?\n/g, '\r\n')));
  assert.deepEqual(crlf.map((h) => [h.file, h.line, h.code]), hits.map((h) => [h.file, h.line, h.code]));
});

test('T4a scanner flags each planted lossy form (the scan is not vacuous)', () => {
  const planted = ["const s = r.stdout.toString();", "const s = buf.toString('utf8');", "spawnSync(b, a, { encoding: 'utf8' })",
    "spawnSync(b, a, { encoding: \"latin1\" })", "const d = new TextDecoder();", "readFileSync(p, 'utf-8')", "x.utf8Slice(0)", "child.stdout.setEncoding('x')",
    'const z = buf.toString("latin1")', 'const t = String(r.stdout);', 'const u = Buffer.prototype.toString.call(b);',
    'const l = buf.toLocaleString();', "const m = buf['toString']();", 'const n = buf[ "toLocaleString" ]();', 'const d = new globalThis.TextDecoder();',
    'const D = TextDecoder; const d = new D();', 'const r = realpathSync.native(dir);', 'const r = realpathSync(dir, {});', 'const l = readdirSync(dir);',
    'const t = readlinkSync(p);', 'const m = mkdtempSync(prefix);', 'const c = process.cwd();', 'const r = fs.realpath (p, cb);'];
  for (const p of planted) assert.equal(lossySites('m.mjs', p).length, 1, p);
  for (const fine of ["spawnSync(b, a, { encoding: 'buffer' })", '// buf.toString() in a comment', "const n = decodeStrict(buf, 'path_not_utf8');",
    "const r = realpathSync.native(dir, { encoding: 'buffer' });", "const l = readdirSync(dir, { encoding: 'buffer' });", 'const s = statSync(cwd);']) {
    assert.equal(lossySites('m.mjs', fine).length, 0, fine);
  }
});

// ------------------------------------------------------------------ mutation evidence (AC6)
// Harness: scratchpad mut-a0b/mutate2.py (copies all of lib/, LF-normalised anchors). A mutant counts as
// KILLED only when the baseline test count ran and a failing test reports ERR_ASSERTION; a load failure,
// changed test count or timeout is INVALID. Round 2: 56 mutants, 55 killed, 0 invalid, 1 EQUIVALENT.
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
// | decoding             | fatal:false (killed by the T4a source scan only: with the round-trip present it is |
// |                      | behaviourally equivalent); BOM stripped; zSplit drops empties; strings accepted;   |
// |                      | label backslash. EQUIVALENT: round-trip removed (a fatal decoder already refuses   |
// |                      | every non-UTF-8 input; kept as defence in depth)                                    |
// | outcomes             | signal before error rows; stderr before status; swallowed decode error; ENOBUFS /  |
// |                      | ETIMEDOUT unmapped; killSignal SIGTERM; Windows bound off; size +1 per entry;      |
// |                      | bound `>=`; missing cwd not pre-checked; env platform not matched; non-composed    |
// |                      | env accepted; unknown run keys accepted                                             |
// | serialisation        | stderr stored on the object; stderr not capped; toJSON carries stderr; inspect     |
// |                      | redaction removed; op not validated                                                  |
// | T4a scan             | toString / toLocaleString / String(bytes) / process.cwd() site added               |
