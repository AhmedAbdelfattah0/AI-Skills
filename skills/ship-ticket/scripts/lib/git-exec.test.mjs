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

// ------------------------------------------------------------------ T4a: decode-site scanner (AC4)

// WHAT T4a CHECKS. Every non-test .mjs module under lib/, subdirectories included (a new module is scanned
// without edits), is tokenised: strings and their escapes, template literals with nested `${}` code,
// regex literals with character classes, and both comment forms. Rules then run per token and per CALL
// EXPRESSION, so neither the line a site sits on nor its line breaks matter:
//  - decoder-api: the names toString, toLocaleString, TextDecoder(Stream), StringDecoder, setEncoding and
//    Buffer's *Slice decoders, as an identifier, a member, a literal computed member, or any string equal to one;
//  - string-coercion: `String` anywhere except `String.fromCharCode`, `.fromCodePoint` or `.raw`;
//  - encoding-literal: a string or template text equal to a text encoding (utf8, utf-8, latin1, binary,
//    ascii, ucs2, utf16le; any case);
//  - encoding-option: `encoding` anywhere except as an `encoding: 'buffer'` entry of an object literal;
//  - name-api-no-buffer: each call of realpath, readdir, readlink, mkdtemp or opendir (Sync, .native, bare
//    or member; a method of that name counts too) whose OWN argument list holds, from its second argument on,
//    neither 'buffer' nor an inline object literal with a direct `encoding: 'buffer'` entry;
//  - cwd: each `.cwd()` call (no exact-bytes form exists);
//  - read-encoding: readFile(Sync) given a string encoding other than 'buffer'.
// FAIL CLOSED ('unclassifiable'; never allowlistable): an unterminated string, template, regex or comment;
// `/` after `)`, `}`, `++`, `--` or `of` (regex or division is undecidable without a parser); an escaped identifier;
// a name-returning fs, readFile or child_process API referenced other than as a call (alias, destructuring,
// passed as a value); an aliased import or export of a watched name; a child_process import that is not
// named; require, dynamic import, eval, Function; `process` used other than as `process.<name>`; a
// child_process call whose last argument is not an inline object literal; a spread argument to any checked
// call, or a checked options literal with a spread or computed key; a computed member key built from string pieces (unless only assigned to).
// NOT CHECKED: anything not named above. In particular (review items, backed behaviourally by T4b): ANY
// implicit ToString of a Buffer, for example `${buf}`, `buf + ''`, Array#join, RegExp#exec/test(buf), loose
// equality, use as a property key; a computed key held in a variable (`b[k]()`, Reflect.get); `x.exec(...)`
// as a member (taken to be RegExp#exec); other name sources (fs.watch, os.homedir/tmpdir, the implicit cwd
// of path.resolve, process.argv); data flow (which value is a Buffer); anything outside lib/. Evidence: the planted-regression and seeded property
// tests below, and the scanner mutants in the AC6 table.
const ENC_NAME = /^(?:utf-?8|latin1|binary|ascii|ucs-?2|utf-?16le)$/i;
const DECODER_NAME = /^(?:toString|toLocaleString|TextDecoder(?:Stream)?|StringDecoder|setEncoding|(?:utf8|latin1|ascii|ucs2|utf16le|binary|hex|base64|base64url)Slice)$/;
const NAME_API = /^(?:realpath|readdir|readlink|mkdtemp|opendir)(?:Sync)?$/;
const CP_API = /^(?:spawnSync|execFileSync|execSync|spawn|execFile|exec|fork)$/;
const READ_API = /^readFile(?:Sync)?$/;
const CP_MODULE = /^(?:node:)?child_process$/;
const WATCHED = (n) => NAME_API.test(n) || CP_API.test(n) || READ_API.test(n) || DECODER_NAME.test(n) || ['String', 'encoding', 'cwd', 'process'].includes(n);
// After these keywords a `/` starts a regex; after any other identifier it divides.
const EXPR_KW = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await', 'extends', 'default']);
const LT = /[\n\r\u2028\u2029]/;
const ID_START = /[\p{ID_Start}$_\\]/u;
const ID_PART = /[\p{ID_Continue}$\u200c\u200d\\]/u;
const NUM = /0[xXoObB][\da-fA-F_]+n?|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?n?/y;
const PUNCT = /\.\.\.|\?\.(?!\d)|=>|\+\+|--|[^\s]/y;
const ESC = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };
/** The cooked value of a string or template body, so an escape cannot hide a name (`'to\x53tring'`). */
const cook = (raw) => raw.replace(/\\(?:x([0-9a-fA-F]{2})|u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|(\r\n|[\n\r\u2028\u2029])|([\s\S]))/g,
  (m, x, ub, u, lt, ch) => (x || u ? String.fromCharCode(parseInt(x || u, 16)) : ub ? String.fromCodePoint(Math.min(parseInt(ub, 16), 0x10ffff)) : lt ? '' : ESC[ch] ?? ch));

/** Tokens {t: id|str|tpl|re|num|p, v, s, e}; `bad` collects what cannot be lexed with certainty. */
function lexJs(src) {
  const toks = [];
  const bad = [];
  const subs = [];
  let depth = 0;
  let i = 0;
  const n = src.length;
  const push = (t, v, s, x) => toks.push({ t, v, s, e: i, ...x });
  const chunk = (s, cont) => { // i is just past the opening ` or the `}` closing a substitution
    for (let j = i; ;) {
      if (j >= n) { bad.push({ pos: s, why: 'unterminated template literal' }); i = n; return false; }
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === '`') { const raw = src.slice(i, j); i = j + 1; push('tpl', cook(raw), s, { cont, close: true }); return true; }
      if (src[j] === '$' && src[j + 1] === '{') {
        const raw = src.slice(i, j); i = j + 2; push('tpl', cook(raw), s, { cont, close: false });
        depth++; subs.push(depth); push('p', '${', j); return true;
      }
      j++;
    }
  };
  const regexOk = (p) => (!p ? true : p.t === 'id' ? (p.member ? false : p.v === 'of' ? null : EXPR_KW.has(p.v)) : p.t === 'p' ? ([')', '}', '++', '--'].includes(p.v) ? null : p.v !== ']') : false);
  if (src.startsWith('#!')) while (i < n && !LT.test(src[i])) i++;
  while (i < n) {
    const c = src[i];
    const s = i;
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && !LT.test(src[i])) i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      const j = src.indexOf('*/', i + 2);
      if (j < 0) { bad.push({ pos: s, why: 'unterminated comment' }); break; }
      i = j + 2; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && !LT.test(src[j])) j += src[j] === '\\' ? (src[j + 1] === '\r' && src[j + 2] === '\n' ? 3 : 2) : 1;
      if (j >= n || src[j] !== c) { bad.push({ pos: s, why: 'unterminated string' }); break; }
      i = j + 1; push('str', cook(src.slice(s + 1, j)), s); continue;
    }
    if (c === '`') { i++; if (!chunk(s, false)) break; continue; }
    if (ID_START.test(c) || (c === '#' && ID_START.test(src[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < n && ID_PART.test(src[j])) j++;
      const v = src.slice(i, j);
      const p = toks[toks.length - 1];
      i = j;
      if (v.includes('\\')) bad.push({ pos: s, why: 'escaped identifier' });
      push('id', v, s, { member: v[0] === '#' || (p?.t === 'p' && (p.v === '.' || p.v === '?.')) });
      continue;
    }
    if (/\d/.test(c) || (c === '.' && /\d/.test(src[i + 1] ?? ''))) { NUM.lastIndex = i; const m = NUM.exec(src); i += m[0].length; push('num', m[0], s); continue; }
    if (c === '/') {
      const ok = regexOk(toks[toks.length - 1]);
      if (ok === null) bad.push({ pos: s, why: 'ambiguous / after ) } ++ -- or of' });
      if (ok) {
        let j = i + 1;
        let cls = false;
        for (; ; j++) {
          if (j >= n || LT.test(src[j])) { j = -1; break; }
          if (src[j] === '\\') j++;
          else if (src[j] === '[') cls = true;
          else if (src[j] === ']') cls = false;
          else if (src[j] === '/' && !cls) break;
        }
        if (j < 0) { bad.push({ pos: s, why: 'unterminated regex' }); break; }
        j++;
        while (j < n && ID_PART.test(src[j])) j++;
        i = j; push('re', src.slice(s, j), s); continue;
      }
      i += src[i + 1] === '=' ? 2 : 1; push('p', '/', s); continue;
    }
    if (c === '{') { depth++; i++; push('p', '{', s); continue; }
    if (c === '}') {
      i++;
      if (subs.length && subs[subs.length - 1] === depth) { subs.pop(); depth--; push('p', '}', s, { sub: true }); if (!chunk(i, true)) break; continue; }
      depth--; push('p', '}', s); continue;
    }
    PUNCT.lastIndex = i;
    const p = PUNCT.exec(src)[0];
    i += p.length; push('p', p, s);
  }
  if (subs.length && !bad.length) bad.push({ pos: n, why: 'unterminated template substitution' });
  return { toks, bad };
}

const isP = (t, v) => t?.t === 'p' && t.v === v;
const PAIR = { '(': ')', '[': ']', '{': '}', '${': '}' };
/** Index of the closer of the opener at k (typed nesting), or -1. */
function closerOf(toks, k) {
  const st = [];
  for (let j = k; j < toks.length; j++) {
    const t = toks[j];
    if (t.t !== 'p') continue;
    if (PAIR[t.v]) st.push(PAIR[t.v]);
    else if (t.v === ')' || t.v === ']' || t.v === '}') { if (st.pop() !== t.v) return -1; if (!st.length) return j; }
  }
  return -1;
}
/** Top-level comma-separated [from, to) ranges strictly inside the opener at a and closer at b. */
function splitTop(toks, a, b) {
  const out = [];
  let d = 0;
  let at = a + 1;
  for (let j = a + 1; j < b; j++) {
    const t = toks[j];
    if (t.t === 'p' && PAIR[t.v]) d++;
    else if (t.t === 'p' && (t.v === ')' || t.v === ']' || t.v === '}')) d--;
    else if (d === 0 && isP(t, ',')) { out.push([at, j]); at = j + 1; }
  }
  out.push([at, b]);
  return out.filter(([x, y]) => y > x);
}
/** An argument that is exactly an inline object literal: its entries' shape, else null. */
function objectArg(toks, [a, b]) {
  if (!isP(toks[a], '{') || closerOf(toks, a) !== b - 1) return null;
  const entries = splitTop(toks, a, b - 1);
  const keyIs = (t, v) => (t.t === 'id' || t.t === 'str') && t.v === v;
  return {
    spreadOrComputed: entries.some(([x]) => isP(toks[x], '...') || isP(toks[x], '[')),
    bufferEnc: entries.some(([x, y]) => y - x === 3 && keyIs(toks[x], 'encoding') && isP(toks[x + 1], ':') && toks[x + 2].t === 'str' && toks[x + 2].v === 'buffer'),
  };
}
const exprEnd = (p) => !!p && ((p.t === 'id' && !EXPR_KW.has(p.v)) || p.t === 'num' || p.t === 'str' || p.t === 're' || (p.t === 'tpl' && p.close)
  || (p.t === 'p' && [')', ']', '?.'].includes(p.v)));

/** Every decode site in one module's source: [{file, line, rule, why, code}]. */
function decodeSites(file, src) {
  const { toks, bad } = lexJs(src);
  const hits = bad.map(({ pos, why }) => ({ pos, rule: 'unclassifiable', why }));
  const hit = (k, rule, why = rule) => hits.push({ pos: toks[k].s, rule, why });
  const skip = new Set(); // unaliased import specifiers of a watched API
  const name = toks.map((t) => (t.t === 'id' || t.t === 'str' || t.t === 'tpl' ? t.v : null));
  const member = toks.map((t) => t.t === 'id' && t.member);
  // Computed member access: a single literal key is a member name; a key built from string pieces fails closed.
  toks.forEach((t, k) => {
    if (!isP(t, '[') || !exprEnd(toks[k - 1])) return;
    const end = closerOf(toks, k);
    if (end < 0) return hit(k, 'unclassifiable', 'unbalanced computed member');
    const key = toks.slice(k + 1, end);
    if (key.length === 1 && (key[0].t === 'str' || (key[0].t === 'tpl' && !key[0].cont && key[0].close))) { member[k + 1] = true; return; }
    const assigned = isP(toks[end + 1], '=') && !isP(toks[end + 2], '=');
    if (key.some((x) => x.t === 'str' || x.t === 'tpl') && !assigned) hit(k, 'unclassifiable', 'computed member key built from string pieces');
  });
  // import / export statements: the specifier tokens of a well-formed one are not references (skip).
  toks.forEach((t, k) => {
    if (t.t !== 'id' || t.member || (t.v !== 'import' && t.v !== 'export')) return;
    if (t.v === 'import' && isP(toks[k + 1], '(')) return hit(k, 'unclassifiable', 'dynamic import');
    if (t.v === 'import' && isP(toks[k + 1], '.')) return;
    if (t.v === 'export' && !isP(toks[k + 1], '{') && !isP(toks[k + 1], '*')) return;
    const specs = [];
    const mine = [];
    let ns = false;
    let dflt = false;
    let j = k + 1;
    for (; j < toks.length; j++) {
      const x = toks[j];
      if (x.t === 'str' || (x.t === 'id' && x.v === 'from')) break;
      mine.push(j);
      if (isP(x, '*')) ns = true;
      else if (isP(x, '{')) {
        const end = closerOf(toks, j);
        if (end < 0) return hit(k, 'unclassifiable', 'malformed import or export');
        const list = splitTop(toks, j, end);
        if (!list.every(([a, b]) => toks.slice(a, b).every((y) => y.t === 'id' || y.t === 'str'))) return hit(k, 'unclassifiable', 'malformed import or export');
        for (const [a, b] of list) specs.push(toks.slice(a, b).map((y, o) => [a + o, y]));
        for (let y = j + 1; y <= end; y++) mine.push(y);
        if (!list.length) specs.push([]);
        j = end;
        if (t.v === 'export' && toks[end + 1]?.v !== 'from') break; // `export { a };`
      } else if (x.t === 'id') { if (x.v !== 'as' && !isP(toks[j - 1], '*') && toks[j - 1]?.v !== 'as') dflt = true; } else if (!isP(x, ',')) return hit(k, 'unclassifiable', 'malformed import or export');
    }
    const at = toks[j]?.t === 'str' ? j : toks[j]?.v === 'from' && toks[j + 1]?.t === 'str' ? j + 1 : -1;
    if (t.v === 'import' && at < 0) return hit(k, 'unclassifiable', 'malformed import');
    if (at >= 0 && CP_MODULE.test(toks[at].v) && (ns || dflt)) return hit(k, 'unclassifiable', 'child_process imported or exported other than by name');
    for (const r of specs) {
      if (r.length === 3 && r[1][1].v === 'as' && (WATCHED(r[0][1].v) || WATCHED(r[2][1].v))) hit(r[0][0], 'unclassifiable', `aliased ${t.v} of ${r[0][1].v}`);
      if (r.length !== 0 && r.length !== 1 && r.length !== 3) return hit(k, 'unclassifiable', 'malformed import or export');
    }
    for (const y of mine) skip.add(y);
  });
  /** The `(` index of a call of the name at k (`name`, `name.native`, `name?.`), or -1. */
  const callAt = (k) => {
    let j = k + (member[k] && toks[k].t === 'str' ? 2 : 1);
    if (/^realpath/.test(toks[k].v) && isP(toks[j], '.') && toks[j + 1]?.v === 'native') j += 2;
    if (isP(toks[j], '?.')) j++;
    return isP(toks[j], '(') ? j : -1;
  };
  const args = (open) => { const close = closerOf(toks, open); return close < 0 ? null : { close, list: splitTop(toks, open, close) }; };
  const single = (r, v) => r[1] - r[0] === 1 && toks[r[0]].t === 'str' && (v === undefined || toks[r[0]].v === v);
  toks.forEach((t, k) => {
    const v = name[k];
    if (v === null) return;
    const isMember = member[k];
    const bare = t.t === 'id' && !isMember;
    if (DECODER_NAME.test(v)) hit(k, 'decoder-api');
    if (skip.has(k)) return; // an import/export specifier: only the decoder-name rule applies
    if (t.t !== 'id' && ENC_NAME.test(v)) hit(k, 'encoding-literal');
    if (v === 'encoding') {
      const ok = t.t !== 'tpl' && (isP(toks[k - 1], '{') || isP(toks[k - 1], ',')) && isP(toks[k + 1], ':')
        && toks[k + 2]?.t === 'str' && toks[k + 2].v === 'buffer' && (isP(toks[k + 3], ',') || isP(toks[k + 3], '}'));
      if (!ok) hit(k, 'encoding-option');
      return;
    }
    if (t.t !== 'id' && !isMember) return; // any other string or template text: only the two literal rules above
    if (v === 'String' && (bare || isMember) && !(isP(toks[k + 1], '.') && ['fromCharCode', 'fromCodePoint', 'raw'].includes(toks[k + 2]?.v))) hit(k, 'string-coercion');
    if (bare && ['require', 'eval', 'Function'].includes(v)) hit(k, 'unclassifiable', `${v} is not analysable`);
    if (bare && v === 'process' && !(((isP(toks[k + 1], '.') || isP(toks[k + 1], '?.')) && toks[k + 2]?.t === 'id') || (isP(toks[k + 1], '[') && member[k + 2]))) {
      hit(k, 'unclassifiable', 'process used as a value');
    }
    if (isMember && v === 'cwd') {
      if (callAt(k) >= 0) hit(k, 'cwd');
      else if (toks[k - 2]?.v === 'process') hit(k, 'unclassifiable', 'process.cwd used as a value');
    }
    const kind = NAME_API.test(v) ? 'name' : READ_API.test(v) ? 'read' : CP_API.test(v) && !(isMember && v === 'exec') ? 'cp' : null;
    if (!kind || !(bare || isMember)) return;
    const open = callAt(k);
    if (open < 0) return hit(k, 'unclassifiable', `${v} referenced other than as a call`);
    const a = args(open);
    if (!a) return hit(k, 'unclassifiable', 'unbalanced call');
    if (a.list.some(([x]) => isP(toks[x], '...'))) return hit(k, 'unclassifiable', 'spread argument');
    const objs = a.list.map((r) => objectArg(toks, r));
    if (objs.some((o) => o?.spreadOrComputed)) return hit(k, 'unclassifiable', 'options literal with a spread or computed key');
    if (kind === 'name' && !a.list.some((r, x) => x >= 1 && (single(r, 'buffer') || objs[x]?.bufferEnc))) hit(k, 'name-api-no-buffer');
    if (kind === 'cp' && !objs[a.list.length - 1]) hit(k, 'unclassifiable', `${v} options are not an inline object literal`);
    if (kind === 'read' && a.list.length >= 2) {
      const r = a.list[1];
      if (single(r)) { if (toks[r[0]].v !== 'buffer') hit(k, 'read-encoding'); } else if (!objs[1]) hit(k, 'unclassifiable', `${v} options are not an inline literal`);
    }
  });
  const breaks = [...src.matchAll(/\r\n|[\n\r\u2028\u2029]/g)].map((m) => [m.index, m.index + m[0].length]);
  return hits.sort((x, y) => x.pos - y.pos).map(({ pos, rule, why }) => {
    const before = breaks.filter(([b]) => b < pos);
    const from = before.length ? before[before.length - 1][1] : 0;
    const to = breaks[before.length]?.[0] ?? src.length;
    return { file, line: before.length + 1, rule, why, code: src.slice(from, to).trim(), pos };
  });
}

/** lib/ modules (recursive), excluding tests, as paths relative to lib/ with `/` separators. */
function libModules(dir = here, rel = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? libModules(join(dir, d.name), `${rel}${d.name}/`)
    : d.name.endsWith('.mjs') && !d.name.endsWith('.test.mjs') ? [`${rel}${d.name}`] : [])).sort();
}
// Exact sites allowed, each with its reason: [file, the site's trimmed line, the EXACT rule multiset of that
// line, reason]. Any extra hit on an allowlisted line fails, and so does a stale entry.
const ALLOWED_SITES = [
  ['git-exec.mjs', "const DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });", ['decoder-api', 'encoding-literal'], 'the one strict decoder'],
  ['git-capability.mjs', "const bytes = Buffer.isBuffer(out) ? out : Buffer.from(String(out), 'utf8');", ['encoding-literal', 'string-coercion'], 'encodes (string to bytes); not a decode'],
  ['git-capability.mjs', "for (const raw of String(pathVar ?? '').split(win ? ';' : ':')) {", ['string-coercion'], 'coerces the PATH env value (already a string), not bytes'],
  ['git-capability.mjs', 'realpath(p) { try { return realpathSync.native(p); } catch { return null; } },', ['name-api-no-buffer', 'name-api-no-buffer'], 'resolves PATH entries (already strings) to the spawn executable; never compared with git output (S-02a0a, owned there)'],
  ['git-capability.mjs', 'export function resolveGitBinary({ env = process.env, cwd = process.cwd(), exclude = [], platform = process.platform, fs = realFs } = {}) {', ['cwd'], 'default cwd used only to ban PATH dirs inside it; never compared with git output (S-02a0a, owned there)'],
  ['git-capability.mjs', 'const banned = [cwd, ...exclude].flatMap((d) => [P.resolve(d), fs.realpath(d)]).filter(Boolean);', ['name-api-no-buffer'], 'the resolver seam above: realpath of caller-supplied string dirs, compared only with other PATH strings (S-02a0a)'],
  ['git-capability.mjs', 'const real = fs.realpath(file);', ['name-api-no-buffer'], 'the resolver seam above: the spawn executable, never compared with git output (S-02a0a)'],
  ['git-capability.mjs', 'const m = VERSION.exec(bytes.toString(\'latin1\'));', ['decoder-api', 'encoding-literal'], 'lossless byte-to-code-point map feeding an ASCII-only anchored regex; any non-ASCII byte fails it (S-02a0a, owned there)'],
];
/** Hits grouped per (file, line text) as sorted rule lists. */
const byLine = (hits) => {
  const m = new Map();
  for (const h of hits) { const k = `${h.file}\0${h.code}`; m.set(k, [...(m.get(k) ?? []), h.rule].sort()); }
  return m;
};
/** unexplained: lines whose rule multiset no entry allows exactly; stale: entries with no exactly-matching line. */
function allowVerdict(hits, allowed = ALLOWED_SITES) {
  const lines = byLine(hits);
  const unexplained = [...lines].filter(([k, rules]) => !allowed.some(([f, c, r]) => `${f}\0${c}` === k && r.join() === rules.join()));
  const stale = allowed.filter(([f, c, r]) => lines.get(`${f}\0${c}`)?.join() !== [...r].sort().join());
  return { unexplained, stale };
}

test('T4a: no listed lossy decode form appears in lib/ outside the strict decoder or an allowlisted, reasoned site', () => {
  const files = libModules();
  assert.ok(files.includes('git-exec.mjs') && files.includes('git-capability.mjs'), `scanned: ${files}`);
  const hits = files.flatMap((f) => decodeSites(f, readFileSync(join(here, f), 'utf8')));
  assert.deepEqual(hits.filter((h) => h.rule === 'unclassifiable'), [], 'no site the scanner cannot classify (fail closed; never allowlisted)');
  const { unexplained, stale } = allowVerdict(hits);
  assert.deepEqual(unexplained, []);
  assert.deepEqual(stale, [], 'every allowlist entry matches a real line with exactly its rules');
  // An allowlisted line with one extra hit is unexplained (Codex: one site must not cover a second on its line).
  const line = "const real = fs.realpath(file);";
  const extra = allowVerdict([{ file: 'git-capability.mjs', code: line, rule: 'name-api-no-buffer' }, { file: 'git-capability.mjs', code: line, rule: 'decoder-api' }]);
  assert.deepEqual(extra.unexplained, [[`git-capability.mjs\0${line}`, ['decoder-api', 'name-api-no-buffer']]]);
  assert.ok(hits.some((h) => h.file === 'git-exec.mjs' && h.rule === 'decoder-api' && /TextDecoder/.test(h.code)), 'positive control: the decoder site itself was seen');
  // L10: a CRLF checkout (Windows) must give the same verdict.
  const crlf = files.flatMap((f) => decodeSites(f, readFileSync(join(here, f), 'utf8').replace(/\r?\n/g, '\r\n')));
  assert.deepEqual(crlf.map((h) => [h.file, h.line, h.rule, h.code]), hits.map((h) => [h.file, h.line, h.rule, h.code]));
});

const rulesOf = (src) => decodeSites('m.mjs', src).map((h) => h.rule).sort();
test('T4a scanner flags each planted lossy form with exactly its rules (the scan is not vacuous)', () => {
  const D = ['decoder-api'];
  const N = ['name-api-no-buffer'];
  const planted = [
    ['const s = r.stdout.toString();', D], ["const s = buf.toString('utf8');", ['decoder-api', 'encoding-literal']],
    ["spawnSync(b, a, { encoding: 'utf8' })", ['encoding-literal', 'encoding-option']], ['spawnSync(b, a, { encoding: "latin1" })', ['encoding-literal', 'encoding-option']],
    ['const d = new TextDecoder();', D], ["readFileSync(p, 'utf-8')", ['encoding-literal', 'read-encoding']], ['x.utf8Slice(0)', D], ["child.stdout.setEncoding('x')", D],
    ['const z = buf.toString("latin1")', ['decoder-api', 'encoding-literal']], ['const t = String(r.stdout);', ['string-coercion']], ['const u = Buffer.prototype.toString.call(b);', D],
    ['const l = buf.toLocaleString();', D], ["const m = buf['toString']();", D], ['const n = buf[ "toLocaleString" ]();', D], ['const d = new globalThis.TextDecoder();', D],
    ['const D = TextDecoder; const d = new D();', D], ['const r = realpathSync.native(dir);', N], ['const r = realpathSync(dir, {});', N], ['const l = readdirSync(dir);', N],
    ['const t = readlinkSync(p);', N], ['const m = mkdtempSync(prefix);', N], ['const c = process.cwd();', ['cwd']], ['const r = fs.realpath (p, cb);', N],
    // Codex confirm round: an unrelated `encoding: 'buffer'` on the same line no longer exempts a call.
    ["const cwd = process.cwd(); const names = readdirSync(dir, { encoding: 'buffer' });", ['cwd']],
    ["const names = readdirSync(dir); const o = { encoding: 'buffer' };", N], ["const names = readdirSync(dir, f({ encoding: 'buffer' }));", N],
    ["const a = readdirSync(d, { encoding: 'buffer' }), b = readlinkSync(p);", N],
    // `//` and `/*` inside strings, templates and regexes no longer hide what follows; comments are exact.
    ["const u = 'a//b', s = buf.toString();", D], ['const u = "a//b", s = buf.toString();', D], ['const u = `a//b`, s = buf.toString();', D],
    ['const u = "/*", s = buf.toString(); // */', D], ['/* x */ buf.toString()', D], ['const re = /\\/\\//; const s = buf.toString();', D],
    ['const re = /[/]/; buf.toString()', D], ['* buf.toString()', D], ['const t = `${buf.toString()}`;', D], ['const t = `${ { a: 1 }.a }${String(b)}`;', ['string-coercion']],
    ['const t = `a${`b${b.toString()}`}`;', D],
    // multi-line calls and members
    ['readdirSync(\n  dir,\n  {}\n)', N], ['const s = buf\n  .toString();', D], ["readdirSync(\r\n  dir,\r\n  { encoding:\r\n 'buffer' }\r\n)", []],
    // escapes, computed and aliased names, values
    ["buf['to\\x53tring']()", D], ["const e = 'utf\\x38';", ['encoding-literal']], ["buf[k + 'String']()", ['unclassifiable']], ['buf.\\u0074oString()', ['unclassifiable']],
    ["import { readdirSync as rd } from 'node:fs';\nrd(dir);", ['unclassifiable']], ['const { readdirSync: rd } = fs;', ['unclassifiable']],
    ['const f = readdirSync; f(dir);', ['unclassifiable']], ['[a].map(realpathSync)', ['unclassifiable']], ["import * as cp from 'node:child_process';", ['unclassifiable']],
    ["import cp from 'child_process';", ['unclassifiable']], ["const fs = require('node:fs');", ['unclassifiable']], ["const fs = await import('node:fs');", ['unclassifiable']],
    ["export { realpathSync as rp } from 'node:fs';", ['unclassifiable']], ["import { TextDecoder } from 'node:util';", D],
    ['spawnSync(b, a, opts)', ['unclassifiable']], ['spawnSync(b, a, { ...opts })', ['unclassifiable']], ['spawnSync(b, a, { encoding })', ['encoding-option']],
    ['readFileSync(p, enc)', ['unclassifiable']], ["readFileSync(p, { encoding: 'utf8' })", ['encoding-literal', 'encoding-option']], ["const o = { encoding: 'buffer' + x };", ['encoding-option']],
    ["x.encoding = 'buffer';", ['encoding-option']], ["const o = { ['encoding']: 'utf8' };", ['encoding-literal', 'encoding-option']], ['arr.map(String)', ['string-coercion']],
    ["process['cwd']()", ['cwd']], ['const { cwd } = process;', ['unclassifiable']], ['const g = process.cwd;', ['unclassifiable']], ['eval(s)', ['unclassifiable']],
    // what cannot be classified fails closed
    ['const x = (a) / 2; buf.toString();', ['decoder-api', 'unclassifiable']], ["const s = 'it\\'s', t = buf.toString();", D],
    ["function f() { return /'/.test(x) && buf.toString(); }", D],
    // Opus advisor round: forms the per-call rules must not let through.
    ['const l = fs.readdirSync(dir)\n{ x() }', N], ['realpath(p) { return p; }', N], ['const of = 2, q = of / 2, s = buf.toString(), r = 4 / 2;', ['decoder-api', 'unclassifiable']],
    ["export default /'/.test(buf.toString()) || /'/.test(x);", D], ["mkdtempSync('buffer')", N], ["readdirSync('buffer')", N], ['String.call(null, buf)', ['string-coercion']],
    ['String.apply(null, [buf])', ['string-coercion']], ['readFileSync(...a)', ['unclassifiable']], ["readdirSync(...a, { encoding: 'buffer' })", ['unclassifiable']], ["const s = 'open", ['unclassifiable']], ['/* open', ['unclassifiable']],
    ['const t = `open', ['unclassifiable']], ['const t = `${open', ['unclassifiable']], ['const r = /open', ['unclassifiable']], ['i++ / 2', ['unclassifiable']],
  ];
  for (const [p, want] of planted) assert.deepEqual(rulesOf(p), [...want].sort(), p);
  assert.deepEqual(decodeSites('m.mjs', 'const a = 1;\nconst s = buf\n  .toString();').map((h) => h.line), [3], 'a site reports its own line');
  for (const fine of ["spawnSync(b, a, { encoding: 'buffer' })", '// buf.toString() in a comment', "const n = decodeStrict(buf, 'path_not_utf8');",
    "const r = realpathSync.native(dir, { encoding: 'buffer' });", "const l = readdirSync(dir, { encoding: 'buffer' });", 'const s = statSync(cwd);',
    "const l = readdirSync(dir, 'buffer');", "const r = await fs.promises.readlink(p, { encoding: 'buffer' });", "import { readdirSync, spawnSync } from 'node:fs';",
'const m = /utf8/.exec(s);', 'const s = `utf8 is ${n} bytes`;', 'const n = String.fromCharCode(b);', 'const s = "it\'s // not a comment";',
    "env[`GIT_CONFIG_KEY_${i}`] = k;", 'x = a / b;', "readFileSync(p)", "spawnSync(b, ['--version'], { cwd, env })", 'const o = { cwd: process.env.HOME };']) {
    assert.deepEqual(rulesOf(fine), [], fine);
  }
});

test('T4a scans lib/ recursively and skips only *.test.mjs', (t) => {
  const d = tmp(t);
  mkdirSync(join(d, 'sub', 'deeper'), { recursive: true });
  for (const f of ['a.mjs', 'a.test.mjs', 'n.js', 'sub/b.mjs', 'sub/deeper/c.mjs', 'sub/b.test.mjs']) writeFileSync(join(d, f), '');
  assert.deepEqual(libModules(d), ['a.mjs', 'sub/b.mjs', 'sub/deeper/c.mjs']);
});

/** Deterministic PRNG (mulberry32) for the seeded property test. */
const prng = (seed) => () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const INJECT = [
  ['b.toString()', 'decoder-api'], ["b['toLocaleString']()", 'decoder-api'], ['new TextDecoder()', 'decoder-api'], ['b\n  .toString()', 'decoder-api'],
  ['String(b)', 'string-coercion'], ["readFileSync(p, 'utf8')", 'encoding-literal'], ["spawnSync(g, a, { encoding: 'latin1' })", 'encoding-option'],
  ['readdirSync(d)', 'name-api-no-buffer'], ['realpathSync.native(\n  d)', 'name-api-no-buffer'], ["readdirSync(d); const o = { encoding: 'buffer' }", 'name-api-no-buffer'],
  ['readlinkSync(p, {})', 'name-api-no-buffer'], ['process.cwd()', 'cwd'], ['execFileSync(g, a)', 'unclassifiable'], ['const f = readdirSync', 'unclassifiable'],
];
test('T4a property: each listed form injected at seeded random code-token boundaries of the real lib sources is flagged in place', () => {
  const SEED = 0x5021b;
  const rnd = prng(SEED);
  let checked = 0;
  for (const f of libModules()) {
    for (const nl of ['\n', '\r\n']) {
      const src = readFileSync(join(here, f), 'utf8').replace(/\r?\n/g, nl);
      const bounds = lexJs(src).toks.filter((t) => !(t.t === 'tpl' && t.cont) && !isP(t, '${')).map((t) => t.s);
      assert.ok(bounds.length > 100, `${f}: tokenised`);
      for (const [form, rule] of INJECT) {
        for (let n = 0; n < 12; n++) {
          const at = bounds[Math.floor(rnd() * bounds.length)];
          const text = ` ;${form.replace(/\n/g, nl)}; `;
          const span = (h) => h.pos >= at && h.pos < at + text.length;
          const out = decodeSites(f, src.slice(0, at) + text + src.slice(at));
          assert.ok(out.some((h) => span(h) && h.rule === rule), `seed ${SEED}: ${JSON.stringify(form)} at ${f}:${at} (${nl === '\n' ? 'LF' : 'CRLF'}) not flagged as ${rule}`);
          // controls: the same text as a comment, string or template text, or neutral code, adds no hit in place.
          const tplText = form.replace(/[\\`$]/g, '\\$&');
          for (const ctl of [` /* ${form} */ `, ` // ${form.replace(/\n/g, ' ')}${nl}`, ` ;${JSON.stringify(form)}; `, ` ;\`${tplText}\`; `, ' ;void 0; ']) {
            const o = decodeSites(f, src.slice(0, at) + ctl + src.slice(at));
            assert.deepEqual(o.filter((h) => h.pos >= at && h.pos < at + ctl.length), [], `seed ${SEED}: control ${JSON.stringify(ctl)} at ${f}:${at}`);
          }
          checked++;
        }
      }
    }
  }
  assert.equal(checked, libModules().length * 2 * INJECT.length * 12, 'every injection ran');
});

// ------------------------------------------------------------------ mutation evidence (AC6)
// Harness: scratchpad mut-a0b/mutate3.py (copies all of lib/, LF-normalised anchors, each anchor must match
// exactly once). A mutant counts as KILLED only when the baseline test count ran and a failing test reports
// ERR_ASSERTION; a load failure, changed test count or timeout is INVALID. Round 3, ONE run against this final
// file (log mutants-round3.log): 99 mutants (the 56 lib mutants below + 43 scanner mutants), 98 killed,
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
// | T4a scanner (test    | line comment to EOF; block comment to line end; string escapes ignored; strings    |
// | file, 43)            | not cooked; \x not cooked; `${}` not code; regex class ignored; `/` after ) } ++ -- |
// |                      | not ambiguous; no regex after keywords; unterminated string / substitution and     |
// |                      | escaped identifier pass; 'buffer' anywhere in the call or the file accepted;        |
// |                      | .native not followed; method-definition skip; literal computed key not a member;  |
// |                      | string-built key passes; assignment target not exempt; aliased import,    |
// |                      | child_process namespace import, require/eval, dynamic import pass; specifiers not |
// |                      | skipped; decoder names skipped in imports; encoding value unchecked; String as a   |
// |                      | value; process as a value; cwd call; non-call API reference; child_process options|
// |                      | unchecked; spread options; readFile encoding; utf-8 spelling; toLocaleString;      |
// |                      | CRLF as two lines; allowlist by line only (rules ignored); subdirectories skipped; |
// |                      | `/` after `of` not ambiguous; no regex after default; 'buffer' as first argument; |
// |                      | String.call/apply exempt; spread argument passes                                   |
