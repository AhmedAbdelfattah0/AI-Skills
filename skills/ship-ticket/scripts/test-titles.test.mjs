/**
 * S-01b2 P1: the test-title marker scanner (test-titles.mjs), against design rev 3 §2b. INV-E: evidence UNDER-recognises.
 * - [R1] grammar corpus: every GRAMMAR row has a positive and a negative fixture (coverage asserted, not assumed), and every
 *   rule fragment is crossed with every hostile context, outcomes derived from the grammar table (design §2b "Closure");
 * - [R2] every fixture also scans as a CRLF copy with the identical result, lines and digests included (L10);
 * - [R3] differential: a seeded generator composes programs from fragments whose expected result it knows BY CONSTRUCTION (the
 *   oracle never lexes text), and the scanner must equal it on every program and its CRLF copy;
 * - [R4] hostile inputs stop within the charged budget with a typed code (L3); assertions are on charged steps, never time (L2);
 * - [R5] strict UTF-8; [R6] totality: random soup never throws, steps <= 8 x bytes; [R7] output carries ids, enums, digests, counts.
 * The [R#] tests are what test-titles-mutation.test.mjs runs against each planted mutant (a kill is an ERR_ASSERTION only, L1).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { scanTitles, GRAMMAR, LIMITS, KIND_ID, ITEM_ID, EXTENSIONS, RUNNER_MODULES } from './test-titles.mjs';

const enc = (s) => new TextEncoder().encode(s);
const scan = (src, path = 'a.test.js', extra = {}) => scanTitles(typeof src === 'string' ? enc(src) : src, { path, ...extra });
const crlf = (s) => s.replace(/\r?\n/g, '\r\n');
const sum = (r) => r.status !== 'ok' ? { status: r.status, reason: r.reason } : { status: 'ok', counted: r.calls.flatMap((c) => c.markers) };
const OK = (...counted) => ({ status: 'ok', counted });
const UNSUP = (reason) => ({ status: 'unsupported', reason });
const UNSCAN = (reason) => ({ status: 'unscannable', reason });
const F = '() => {}';
const k = (...ids) => ids.map((i) => `kind:${i}`);
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const x65 = 'x'.repeat(65);

/** One positive and one negative fixture per GRAMMAR row: [source, expected, path?, expected lines of counted calls?, options?]. */
const CORPUS = {
  X1: { pos: [`it('[kind:a] t', ${F});`, OK(...k('a')), 'a.test.ts'], neg: [`it('[kind:a] t', ${F});`, UNSUP('unsupported_ext'), 'a.test.tsx'] },
  X2: { pos: [`it('[kind:a] ünï \u{1f600}', ${F});`, OK(...k('a'))], neg: [Uint8Array.from([...enc("it('[kind:a] "), 0xff, ...enc(`', ${F});`)]), UNSCAN('unscannable_utf8')] },
  X3: { pos: [`﻿#!/usr/bin/env node it('[kind:x]', ${F})\nit('[kind:a] t', ${F});`, OK(...k('a')), 'a.test.js', [2]],
    neg: [`it('[kind:a] t', ${F});\n#!x`, UNSUP('ambiguous_lex')] },
  X4: { pos: [`it('[kind:a] t', ${F});`, OK(...k('a'))], neg: [`it('[kind:a] t', ${F});`, UNSCAN('evidence_budget_exceeded'), 'a.test.js', null, { limits: { maxSteps: 10 } }] },
  L1: { pos: [`\r \r\n it('[kind:a] t', ${F});`, OK(...k('a')), 'a.test.js', [5]], neg: [`x = 'a\rb'; it('[kind:a] t', ${F});`, UNSCAN('unterminated')] },
  L2: { pos: [`it('[kind:a] t', ${F});\u000b\f\t`, OK(...k('a'))], neg: [`it('[kind:a] t', ${F});　`, UNSUP('ambiguous_lex')] },
  L3: { pos: [`// it('[kind:x] c', ${F})\n/* it('[kind:y]', ${F}) */it('[kind:a] t', ${F});`, OK(...k('a')), 'a.test.js', [2]], neg: [`it('[kind:a] t', ${F}); /* open`, UNSCAN('unterminated')] },
  L4: { pos: [`const s = "it('[kind:x] s', ${F})"; const q = 'a\\'b'; const c = 'x\\\ny'; it('[kind:a] t', ${F});`, OK(...k('a')), 'a.test.js', [2]],
    neg: [`const s = 'abc\nit('[kind:a] t', ${F});`, UNSCAN('unterminated')] },
  L5: { pos: ['const s = `it(\'[kind:x]\', () => {}) ${ `n ${ "x`" }` }`; it(\'[kind:a] t\', () => {});', OK(...k('a'))],
    neg: [`x = ${'`${'.repeat(17)}1${'}`'.repeat(17)};`, UNSUP('ambiguous_lex')] },
  L6: { pos: [`$it('[kind:x] t', ${F}); _test('[kind:y] t', ${F}); it('[kind:a] t', ${F});`, OK(...k('a'))], neg: [`\\u0069t('[kind:a] t', ${F});`, UNSUP('ambiguous_lex')] },
  L7: { pos: [`x = 1.5e-3 / 2; y = .5 / 1; z = 0x1f / 3; w = 10n / 2n; v = 1_000 / 0b1; it('[kind:a] t', ${F}); u = 4 / 5;`, OK(...k('a'))], neg: ['x = 0x;', UNSUP('ambiguous_lex')] },
  L8: { pos: [`const d = a / 2; it('[kind:a] t', ${F}); const e = 3 / 4; f = x.return / 2;`, OK(...k('a'))],
    neg: [`if (a) /it('[kind:x] t', () => {})/.test(s); while (b) /'/.exec(c);`, OK()] },
  L9: { pos: [`const r = /['"]/g; const q = /[/]"/; const e = /\\/'/; it('[kind:a] t', ${F});`, OK(...k('a'))], neg: ['x = /a\\\nb/;', UNSCAN('unterminated')] },
  L10: { pos: ['while (true) {\n  break\n  /;test("[kind:negative]",()=>{})/.source;\n}', UNSUP('ambiguous_lex')], neg: [`x = a++ ; y = 1 / 2; it('[kind:a] t', ${F});`, OK(...k('a'))] },
  L11: { pos: [`const el = <div>it('[kind:a] t', ${F})</div>;`, UNSUP('jsx_suspect')],
    neg: [`if (a < b && c > d) {} it('[kind:a] t', ${F}); const m = new Map<string, number>();`, OK(...k('a')), 'a.test.ts'] },
  L12: { pos: [`it('[kind:a] t', ${F}); f(`, UNSCAN('unterminated')], neg: [`it('[kind:a] t', ${F}); f();`, OK(...k('a'))] },
  L13: { pos: ['--> ;test("[kind:negative]",()=>{})', UNSUP('ambiguous_lex')], neg: [`x = a < !b; it('[kind:a] t', ${F});`, OK(...k('a'))] },
  L14: { pos: [`it('[kind:a] t', ${F}); f(];`, UNSUP('ambiguous_lex')], neg: [`f([{}]); it('[kind:a] t', ${F});`, OK(...k('a'))] },
  R1: { pos: [`test('[kind:a] t', ${F}); it('[kind:b] t', ${F}); {} it('[kind:c] t', ${F});`, OK(...k('a', 'b', 'c'))], neg: [`x = 1, it('[kind:a] t', ${F});`, UNSUP('ambiguous_callee')] },
  R2: { pos: [`it ('[kind:a] t', ${F});`, OK(...k('a'))], neg: ['it`[kind:a] t`;', UNSUP('ambiguous_callee')] },
  R3: { pos: ['it(`[kind:a] t`, () => {});', OK(...k('a'))], neg: ['it(\'[kind:a] t\' + s, () => {}); it(`[kind:b] ${x}`, () => {}); it(name, () => {}); it(tag`[kind:c]`, () => {});', OK()] },
  R4: { pos: [`it('[kind:a] t', ${F}); it('[kind:b] t', function () {},);`, OK(...k('a', 'b'))],
    neg: [`it('[kind:a] t'); it('[kind:b] t', options, ${F}); it('[kind:c] t', ${F}, 5000); it('[kind:d] t', ({ skip: true }), ${F}); it('[kind:e] t', make(), ${F}); it('[kind:f] t', { timeout: 1 }, ${F});`, OK()] },
  R5: { pos: [`describe('g', () => { suite('s', function () { it('[kind:a] t', ${F}); }); }); it('[kind:b] t', ${F});`, OK(...k('a', 'b'))],
    neg: [`helper(() => { it('[kind:a] t', ${F}); });`, UNSUP('ambiguous_callee')] },
  R6: { pos: [`it('[kind:a] t', async function named() {}); it('[kind:b] t', async t => {}); it('[kind:c] t', () => expect(1).toBe(1)); it('[kind:d] t', function* () {});`, OK(...k('a', 'b', 'c', 'd'))],
    neg: [`it('[kind:a] t', handler); it('[kind:b] t', () => {} || x); it('[kind:c] t', function () {}.bind(this)); it('[kind:d] t', (t): void => {});`, OK(), 'a.test.ts'] },
  R7: { pos: ['describe("d", () => { suite(`s ${n}`, function () { test("[kind:negative]", () => {}); }); });', OK('kind:negative')],
    neg: ['describe("d",{skip:true},()=>{test("[kind:negative]",()=>{})}); describe(name, () => { it("[kind:a] t", () => {}); }); suite("s", opts, () => { it("[kind:b] t", () => {}); });', OK()] },
  F1a: { pos: [`it('[kind:a] t', ${F}); xit('b', ${F});`, UNSUP('skip_form')], neg: [`it('[kind:a] t', ${F}); xitem('b');`, OK(...k('a'))] },
  F1b: { pos: [`it('[kind:a] t', ${F}); describe.skip('g', ${F});`, UNSUP('skip_form')], neg: [`it('[kind:a] t', ${F}); obj.skip(); t.only;`, OK(...k('a'))] },
  F2: { pos: [`function it(n, f) {} it('[kind:a] t', ${F});`, UNSUP('ambiguous_callee')],
    neg: [`import { test, describe } from 'node:test'; import it2 from 'x'; test('[kind:a] t', ${F});`, OK(...k('a'))] },
  F3: { pos: ['with (helpers) {test("[kind:negative]", () => {});}', UNSUP('dynamic_scope')], neg: [`helpers.with(1); x.eval(2); it('[kind:a] t', ${F});`, OK(...k('a'))] },
  M1: { pos: [`it('[kind:async-state] [plan:AC1] t', ${F});`, OK('kind:async-state', 'plan:AC1')],
    neg: [`it('[Kind:a] [kind: a] [kind:A] [plan:1x] [kind:a_b] ［kind:a］ [kind:${x65}] \\[kind:b\\]', ${F});`, OK()] },
  M2: { pos: [`it('[kind:a] t', ${F}); it('[kind:a] t', ${F});`, OK(...k('a', 'a')), 'a.test.js', [1, 1]], neg: [`it('[kind:a] t', ${F});\nit('[kind:a] u', ${F});`, OK(...k('a', 'a')), 'a.test.js', [1, 2]] },
};

function check(name, [src, expected, path = 'a.test.js', wantLines, extra = {}], variant = (s) => s) {
  const r = scan(typeof src === 'string' ? variant(src) : src, path, extra);
  assert.deepEqual(sum(r), expected, `${name}: ${JSON.stringify(src).slice(0, 160)}`);
  if (wantLines) assert.deepEqual(r.calls.map((c) => c.line), wantLines, `${name}: lines`);
  return r;
}

test('[R1] grammar corpus: every GRAMMAR row has a positive and a negative fixture, and each scans as expected', () => {
  assert.ok(GRAMMAR.length >= 29, 'the grammar is declared');
  assert.deepEqual([...GRAMMAR], Object.keys(CORPUS), 'fixture rows equal grammar rows, in order');
  for (const id of GRAMMAR) for (const side of ['pos', 'neg']) check(`${id} ${side}`, CORPUS[id][side]);
  assert.equal(check('dynamic', CORPUS.R3.neg).counts.dynamic_titles, 4);
  assert.equal(check('signatures', CORPUS.R4.neg).counts.rejected_signatures, 6);
  assert.equal(check('scoped', CORPUS.R7.neg).counts.option_scoped, 3);
  assert.equal(check('unknown', CORPUS.M1.neg).counts.unknown_markers, 3);
  const [a, b] = check('digest', CORPUS.M2.neg).calls;
  assert.equal(a.title_sha256, sha('[kind:a] t'));
  assert.notEqual(a.title_sha256, b.title_sha256);
  const two = scan(`it(\`[kind:a] one\ntwo\`, ${F});`).calls[0];
  assert.equal(two.title_sha256, sha('[kind:a] one\ntwo'));
  assert.equal(scan(crlf(`it(\`[kind:a] one\ntwo\`, ${F});`)).calls[0].title_sha256, two.title_sha256, 'a CRLF title digests as LF');
});

test('[R1] grammar edges: regex/division, angle brackets, callee bindings, skip forms, template depth', () => {
  for (const s of ['x = a++ / 2;', 'x = a-- / 2;', 'x = y! / 2;', 'lbl: for (;;) { break lbl\n/x/; }', 'for (;;) { break\n/x/; }', 'export default /x/;', 'x = {} / 1;',
    'for (;;) { continue\n/x/; }', 'debugger\n/x/;', 'function f() { return /x/; }', 'x = typeof /x/;', 'for (const x of /re/) {}', 'function* g() { yield /x/; }', 'async function f() { await /x/; }',
    'throw /x/;', 'x = void /x/;', 'x = a in /x/;', 'x = new /x/;', 'if (a) {} else /x/;', 'do /x/; while (a);', 'switch (a) { case /x/: }', 'x = a instanceof /x/;', 'delete /x/;',
    'async function f() { for await (const x of y) {} }', 'x = 1;\n<!-- c', 'x-->0;'])
    assert.deepEqual(sum(scan(s, 'a.test.ts')), UNSUP('ambiguous_lex'), s);
  for (const s of ['x = !/re/.test(s);', 'x = a !== /re/;', 'x = (a) / 2;', 'x = [a] / 2;', 'if (a) /re/.test(x);', 'x = a.return / 2;', 'x = `${a}` / 2;', 'x = "<!--" + `-->`; // <!-- -->'])
    assert.equal(scan(s).status, 'ok', s);
  for (const s of ['const f = <T,>(x: T) => x;', 'x = <any>y;', 'if (a) {} <b/>;', 'x = c ? <a/> : null;', 'return <a/>;'])
    assert.deepEqual(sum(scan(s, 'a.test.ts')), UNSUP('jsx_suspect'), s);
  for (const s of ['#x = 1;', 'x = a \\ b;', 'x = 1;\u0001', 'café = 1;'])
    assert.deepEqual(sum(scan(s)), UNSUP('ambiguous_lex'), JSON.stringify(s));
  assert.equal(scan(`x = ${'`${'.repeat(16)}1${'}`'.repeat(16)}; it('[kind:a] t', ${F});`).status, 'ok', '16 template frames are allowed');
  for (const s of ['const test = () => {};', '[1].map((it) => it);', 'for (const it of xs) {}', 'typeof it;', 'x = a ? it : b;', 'const o = { it: 1 };',
    'import { xtest as it } from "vitest";', 'import { test as t } from "node:test";', "import { it } from './my-wrapper';", "import it from 'vitest';",
    'import { it } from "node:test?x";', "const { it } = require('node:test');", 'class it {}', 'export { it };', 'test.describe("g", () => {});', 'it.beforeEach(() => {});',
    'test["only"]("x", () => {});', 'if (a) it("x", () => {});', 'x = `${it("x", () => {})}`;'])
    assert.ok(['ambiguous_callee', 'skip_form'].includes(scan(`${s}\nit('[kind:a] t', ${F});`, 'a.test.ts').reason), s);
  for (const s of ['it.only', 'it.skip', 'test.todo', 'test.skipIf(x)', 'it.runIf(x)', 'test.fixme', 'it.fails', 'test.failing', 'it.each([1])', 'test.concurrent', 'describe.sequential', 'test.extend({})', 'describe?.only', 'suite.skip'])
    assert.deepEqual(sum(scan(`it('[kind:a] t', ${F}); ${s}('x', ${F});`)), UNSUP('skip_form'), s);
  for (const s of ['xit', 'xtest', 'xdescribe', 'fit', 'fdescribe']) assert.deepEqual(sum(scan(`it('[kind:a] t', ${F}); const q = ${s};`)), UNSUP('skip_form'), s);
  for (const s of ['eval("var test = function () {}");\ntest("[kind:negative]", () => {});', '(0, eval)("var test = 1");', 'new Function("test = 1")();', 'globalThis.test = () => {};', 'global.it = 1;'])
    assert.deepEqual(sum(scan(s)), UNSUP('dynamic_scope'), s);
  for (const m of RUNNER_MODULES) assert.deepEqual(sum(scan(`import test, { it, describe, suite } from '${m}';\nit('[kind:a] t', ${F});`)), OK(...k('a')), m);
  assert.deepEqual(sum(scan(`import { it } from 'my-runner';\nit('[kind:a] t', ${F});`, 'a.test.js', { runnerModules: ['my-runner'] })), OK(...k('a')), 'a base-declared runner module');
  assert.deepEqual(sum(scan(`it('[plan:B2] [kind:a] [plan:B2]', ${F});`)), OK('plan:B2', 'kind:a'), 'one title reports a marker once');
  assert.deepEqual(sum(scan(`specify('[kind:a] t', ${F}); context('c', ${F});`)), OK(), 'specify/context are not callees');
});

test('[R1] the Codex rev-3 challenge examples, verbatim', () => {
  assert.deepEqual(sum(scan('while (true) {\n  break\n  /;test("[kind:negative]",()=>{})/.source;\n}')), UNSUP('ambiguous_lex'));
  assert.deepEqual(sum(scan('--> ;test("[kind:negative]",()=>{})')), UNSUP('ambiguous_lex'));
  assert.deepEqual(sum(scan('with (helpers) {\n  test("[kind:negative]", () => {});\n}')), UNSUP('dynamic_scope'));
  assert.deepEqual(sum(scan('eval("var test = function () {}");\ntest("[kind:negative]", () => {});')), UNSUP('dynamic_scope'));
  assert.deepEqual(sum(scan('describe("disabled", { skip: true }, () => {\n  test("[kind:negative]", () => {});\n});')), OK());
  assert.deepEqual(sum(scan('const options = { skip: true };\ntest("[kind:negative]", options, () => {});')), OK());
  assert.deepEqual(sum(scan('test("[kind:negative]");')), OK());
  assert.deepEqual(sum(scan('test("t", 0')), UNSCAN('unterminated'));
  assert.deepEqual(sum(scan('async function f() { for await (const x of y) /;test("[kind:negative]",()=>{})/; }')), UNSUP('ambiguous_lex'));
});

test('[R1] languages: only the six JS/TS extensions are scanned', () => {
  assert.deepEqual([...EXTENSIONS], ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts']);
  for (const p of ['a.test.js', 'a.test.mjs', 'a.test.cjs', 'a.test.ts', 'a.test.mts', 'a.test.cts', 'dir.x/a.spec.ts', 'd\\a.test.ts'])
    assert.equal(scan(`it('[kind:a] t', ${F});`, p).status, 'ok', p);
  for (const p of ['a.test.jsx', 'a.test.tsx', 'a.test.JS', 'a_test.py', 'a.test', 'test', 'dir.ts/a', 'a.test.js.map', 'a.test.vue', '.ts'])
    assert.deepEqual(sum(scan(`it('[kind:a] t', ${F});`, p)), UNSUP('unsupported_ext'), p);
});

// Closure (design §2b): every rule fragment crossed with every hostile context; the expectation is derived from the grammar.
const FRAGS = [
  { name: 'counted', code: "it('[kind:z] f', () => {});", stmt: 'count', nested: 'ambiguous_callee' },
  { name: 'dynamic', code: "it('[kind:z] f' + s, () => {});", stmt: 'none', nested: 'ambiguous_callee' },
  { name: 'x-id', code: "xit('[kind:z] f', () => {});", stmt: 'skip_form', nested: 'skip_form' },
  { name: 'member', code: "it.only('[kind:z] f', () => {});", stmt: 'skip_form', nested: 'skip_form' },
  { name: 'options', code: "it('[kind:z] f', { timeout: 1 }, () => {});", stmt: 'none', nested: 'ambiguous_callee' },
  { name: 'callback-less', code: "it('[kind:z] f');", stmt: 'none', nested: 'ambiguous_callee' },
  { name: 'group options', code: "describe('d', { skip: true }, () => { it('[kind:z] f', () => {}); });", stmt: 'none', nested: 'ambiguous_callee' },
  { name: 'with', code: 'with (h) {}', stmt: 'dynamic_scope', nested: 'dynamic_scope' },
  { name: 'eval', code: "eval('x');", stmt: 'dynamic_scope', nested: 'dynamic_scope' },
  { name: 'html close', code: 'x--> 0;', lex: 'ambiguous_lex' },
  { name: 'restricted slash', code: 'function f() { return /x/; }', lex: 'ambiguous_lex' },
  { name: 'shadow', code: 'function it() {}', stmt: 'ambiguous_callee', nested: 'ambiguous_callee' },
  { name: 'key', code: '({ it: 1 });', stmt: 'ambiguous_callee', nested: 'ambiguous_callee' },
  { name: 'jsx', code: 'x = <b/>;', lex: 'jsx_suspect' },
  { name: 'slash', code: 'x = {} / 1;', lex: 'ambiguous_lex' },
];
const CONTEXTS = [
  { name: 'statement', wrap: (f) => `describe('g', () => { ${f} });`, kind: 'stmt' },
  { name: 'line comment', wrap: (f) => `// ${f}\n`, kind: 'inert' },
  { name: 'block comment', wrap: (f) => `/* ${f} */`, kind: 'inert' },
  { name: 'string', wrap: (f) => `const s = "${f}";`, kind: 'inert' },
  { name: 'template text', wrap: (f) => `const t = \`${f}\`;`, kind: 'inert' },
  { name: 'regex', wrap: (f) => `const r = /${f.replace(/\//g, '\\/')}/;`, kind: 'inert' },
  { name: 'template expression', wrap: (f) => `const t = \`\${ (() => { ${f} })() }\`;`, kind: 'nested' },
  { name: 'non-describe call', wrap: (f) => `helper(() => { ${f} });`, kind: 'nested' },
  { name: 'skip scope', wrap: (f) => `describe.skip('g', () => { ${f} });`, kind: 'skip' },
];
test('[R1] closure: every rule fragment x every hostile context, outcome derived from the grammar', () => {
  let n = 0;
  for (const f of FRAGS) for (const c of CONTEXTS) {
    const src = `import { describe, it } from 'node:test';\nit('[kind:base] b', () => {});\n${c.wrap(f.code)}\n`;
    let want;
    if (c.kind === 'inert') want = OK('kind:base');
    else if (f.lex) want = UNSUP(f.lex);
    else if (c.kind === 'skip') want = UNSUP('skip_form');
    else { const e = c.kind === 'stmt' ? f.stmt : f.nested; want = e === 'count' ? OK('kind:base', 'kind:z') : e === 'none' ? OK('kind:base') : UNSUP(e); }
    for (const v of [src, crlf(src)]) assert.deepEqual(sum(scan(v)), want, `${f.name} in ${c.name}`);
    n++;
  }
  assert.equal(n, FRAGS.length * CONTEXTS.length);
});

test('[R2] CRLF: every fixture scans identically as a CRLF copy, lines and digests included (L10)', () => {
  let n = 0;
  for (const id of GRAMMAR) for (const side of ['pos', 'neg']) {
    const [src, , path = 'a.test.js', , extra = {}] = CORPUS[id][side];
    if (typeof src !== 'string' || extra.limits) continue;
    const a = scan(src, path), b = scan(crlf(src), path);
    assert.deepEqual({ ...b, steps: 0 }, { ...a, steps: 0 }, `${id} ${side}: LF and CRLF differ`);
    if (src.includes('\n')) n++;
  }
  assert.ok(n >= 8, `fixtures with a line break: ${n}`);
});

// ---------------------------------------------------------------------------------------------------------------------
// [R3] differential against an oracle BY CONSTRUCTION: the generator records, for each counted call it writes, the offset of the
// title literal and its markers; for the one voiding fragment it may write, the offset of the offending token and the reason.
function prng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const VALID = ['[kind:negative]', '[kind:async-state]', '[plan:AC1]', '[plan:item_2]', '[kind:a1]'];
const NEAR = ['[Kind:negative]', '[kind: x]', '[plan:9x]', '[kind:A]'];
const WORDS = ['alpha', 'does x', '%s', 'b-c', 'it(', 'xit(', 'test.only(', '/', '//', '/*', '*/', '{', '}', '<a>', '\\\\', '\\n'];
const VOIDS = [["xit('a', () => {});", 0, 'unsupported', 'skip_form'], ["it.skip('a', () => {});", 0, 'unsupported', 'skip_form'], ["describe.only('g', () => {});", 0, 'unsupported', 'skip_form'],
  ['with (h) {}', 0, 'unsupported', 'dynamic_scope'], ["eval('1');", 0, 'unsupported', 'dynamic_scope'], ['x--> 0;', 1, 'unsupported', 'ambiguous_lex'],
  ['function f() { return /x/; }', 22, 'unsupported', 'ambiguous_lex'], ['function test() {}', 9, 'unsupported', 'ambiguous_callee'], ['({ it: 1 });', 3, 'unsupported', 'ambiguous_callee'],
  ["if (a) it('a', () => {});", 7, 'unsupported', 'ambiguous_callee'], ["helper(() => { it('a', () => {}); });", 15, 'unsupported', 'ambiguous_callee'], ['x = {} / 1;', 7, 'unsupported', 'ambiguous_lex'],
  ['x = <b/>;', 4, 'unsupported', 'jsx_suspect'], ["x = 'é'; y = é;", 13, 'unsupported', 'ambiguous_lex'], ['x = 0x;', 4, 'unsupported', 'ambiguous_lex'], ['f(];', 2, 'unsupported', 'ambiguous_lex'],
  ["x = 'abc\n';", 4, 'unscannable', 'unterminated'], ['x = a++ / 2;', 9, 'unsupported', 'ambiguous_lex']];
const TAILS = [['/* never closed', 0, 'unscannable', 'unterminated'], ['f((', 3, 'unscannable', 'unterminated'], ['const z = `abc ${', 17, 'unscannable', 'unterminated']];
function generate(seed) {
  const R = prng(seed), pick = (a) => a[Math.floor(R() * a.length)];
  let text = '', voided = null;
  const calls = [];
  const put = (s) => { text += s; };
  const sep = () => put(pick([' ', '\n', '\t', '\r\n', ' ', ' /* c */ ', ' // c\n', '\n\n', ' ', '\n']));
  const title = (q) => {
    const parts = [], ms = [];
    for (let n = 1 + Math.floor(R() * 3); n > 0; n--) {
      const r = R();
      if (r < 0.35) { const m = pick(VALID); parts.push(m); if (!ms.includes(m.slice(1, -1))) ms.push(m.slice(1, -1)); } else if (r < 0.45) parts.push(pick(NEAR)); else parts.push(pick(WORDS));
    }
    return { raw: parts.join(' '), markers: ms };
  };
  const FN = [[', () => {})', true], [', async () => {})', true], [', function () {})', true], [', async function named() {})', true], [', t => {})', true],
    [', (t) => { t.diagnostic(1); })', true], [', () => {},)', true], [', () => 1)', true], [')', false], [', () => {}, 5000)', false], [', opts, () => {})', false], [', { timeout: 1 }, () => {})', false]];
  const NOISE = ["// it('[kind:negative] c', () => {})\n", "/* xit('[kind:negative] c', () => {}) */", 'const s1 = "it(\'[kind:negative] s\', () => {}) it.only";', "const s2 = 'a\\'b \"xit([kind:negative])\"';",
    'const t1 = `it(\'[kind:negative] t\', () => {}) ${ `n ${ "x`" }` }`;', "const r1 = /['\"]/g;", 'const r2 = /[/]it.skip("[kind:negative]")/;', 'const d1 = a / 2 / b;',
    "obj.test('[kind:negative] m', () => {});", "/re/.test('[kind:negative]');", "t.test('[kind:negative] sub', () => {});", 'x = .5 / 1e3;', "if (a) /it('[kind:negative]')/.test(b);",
    'x = a < b && c > d;', "it('[kind:negative] ' + x, () => {});", 'it(`[kind:negative] ${x}`, () => {});', 'x = a.return / 2;', 'helper(() => { t.skip(); });', 'x = `${ a / 2 }`;'];
  const call = (scoped) => {
    const q = pick(["'", '"', '`']), t = title(q), [tail, counted] = pick(FN);
    put(`${pick(['it', 'test', 'it', 'test ', 'it\t'])}(`);
    const pos = text.length;
    put(`${q}${t.raw}${q}${tail};`);
    if (counted && !scoped) calls.push({ pos, markers: t.markers });
  };
  const stmts = (depth, max, scoped = false) => {
    for (let n = 1 + Math.floor(R() * max); n > 0; n--) {
      const r = R();
      if (r < 0.4) call(scoped);
      else if (r < 0.55 && depth < 3) {
        const [head, clean] = pick([["'g'", true], ['`g ${x}`', true], ["'[kind:negative] g'", true], ['name', false], ["'g', { skip: true }", false], ["'g', opts", false]]);
        put(`${pick(['describe', 'suite'])}(${head}, ${pick(['() => {', 'function () {', 'async () => {'])}`); sep(); stmts(depth + 1, 3, scoped || !clean); sep(); put('});');
      } else if (r < 0.6 && depth < 3) { put('{'); sep(); stmts(depth + 1, 2, scoped); sep(); put('};'); } // `;`: a `/` right after `}` is ambiguous (L10)
      else put(pick(NOISE));
      sep();
      if (!voided && R() < 0.04) { const v = pick(VOIDS); voided = { pos: text.length + v[1], status: v[2], reason: v[3] }; put(`${v[0]};`); sep(); }
    }
  };
  put(pick(['', "import { test, it, describe } from 'node:test';\n", "import test, { suite } from 'vitest';\n", "import { describe, it } from '@jest/globals';\n"]));
  stmts(0, 6);
  if (!voided && R() < 0.06) { const v = pick(TAILS); voided = { pos: text.length + v[1], status: v[2], reason: v[3] }; put(v[0]); }
  const lineAt = (pos) => { let l = 1; for (let i = 0; i < pos; i++) { const c = text[i]; if (c === '\n' || c === ' ' || c === ' ' || (c === '\r' && text[i + 1] !== '\n')) l++; } return l; };
  const expected = voided ? { status: voided.status, reason: voided.reason, line: lineAt(voided.pos), calls: [] }
    : { status: 'ok', reason: null, line: null, calls: calls.map((c) => ({ line: lineAt(c.pos), markers: c.markers })) };
  return { text, expected };
}

test('[R3] differential: the scanner equals the by-construction oracle on 1500 seeded programs and their CRLF copies', () => {
  const SEEDS = Number(process.env.TEST_TITLES_SEEDS ?? 1500);
  let ok = 0, titles = 0, refused = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const { text, expected } = generate(seed);
    for (const variant of [text, crlf(text)]) {
      const r = scan(variant);
      const got = { status: r.status, reason: r.reason, line: r.line, calls: r.calls.map((c) => ({ line: c.line, markers: c.markers })) };
      if (JSON.stringify(got) !== JSON.stringify(expected)) assert.deepEqual(got, expected, `seed ${seed}${variant === text ? '' : ' (CRLF)'}:\n${variant}`);
    }
    if (expected.status === 'ok') { ok++; titles += expected.calls.filter((c) => c.markers.length).length; } else refused++;
  }
  // a green run must prove it ran: both outcomes and a meaningful number of marked calls were exercised
  assert.ok(ok > SEEDS * 0.5 && refused > SEEDS * 0.1 && titles > SEEDS / 3, `coverage ok=${ok} refused=${refused} marked=${titles}`);
});

// ---------------------------------------------------------------------------------------------------------------------
test('[R4] hostile inputs stop within the charged budget with a typed code', () => {
  const big = scan('x'.repeat(LIMITS.maxBytes + 1));
  assert.deepEqual([big.status, big.reason, big.steps], ['unscannable', 'evidence_budget_exceeded', 0]);
  assert.equal(scan('x;'.repeat(LIMITS.maxBytes / 2)).status, 'ok', 'exactly the per-file cap is scanned');
  const deep = scan('('.repeat(100000));
  assert.deepEqual([deep.status, deep.reason], ['unscannable', 'unterminated']);
  assert.equal(scan(`${'('.repeat(100000)}${')'.repeat(100000)}; it('[kind:a] t', ${F});`).status, 'ok', 'deep but balanced nesting is linear');
  assert.deepEqual(sum(scan('`${'.repeat(300))), UNSUP('ambiguous_lex'));
  const comments = `${'/**/'.repeat(100000)}it('[kind:a] t', ${F});`;
  assert.deepEqual(sum(scan(comments)), OK(...k('a')));
  const capped = scan(comments, 'a.test.js', { limits: { maxSteps: 10000 } });
  assert.deepEqual([capped.status, capped.reason], ['unscannable', 'evidence_budget_exceeded']);
  assert.ok(capped.steps <= 10001, `steps ${capped.steps} within the cap`);
  const titles = `${`it('${'[kind:a] '.repeat(400)}', ${F});`.repeat(200)}`;
  const heavy = scan(titles, 'a.test.js', { limits: { maxSteps: 100000 } });
  assert.deepEqual([heavy.status, heavy.reason], ['unscannable', 'evidence_budget_exceeded'], 'title work is charged');
  assert.equal(scan(titles).status, 'ok');
  for (const [s, reason] of [["'", 'unterminated'], ['"', 'unterminated'], ['`', 'unterminated'], ['/*', 'unterminated'], ['x = /ab', 'unterminated'], ['`${', 'unterminated'],
    ['(', 'unterminated'], ['{', 'unterminated'], ['[', 'unterminated'], ["'\\", 'unterminated'], ['`\\', 'unterminated'], ['x = /\\', 'unterminated'], [')', 'ambiguous_lex']])
    assert.equal(scan(s).reason, reason, JSON.stringify(s));
  const bangs = `x = ${'!'.repeat(50000)}/re/; it('[kind:a] t', ${F});`, b = scan(bangs);
  assert.deepEqual(sum(b), OK(...k('a')));
  assert.ok(b.steps <= LIMITS.stepsPerByte * bangs.length);
});

test('[R5] strict UTF-8: invalid bytes, overlongs and surrogates are unscannable; a leading BOM is accepted', () => {
  for (const bytes of [[0xff], [0xc0, 0x80], [0xed, 0xa0, 0x80], [0xe2, 0x82], [0xf8, 0x88, 0x80, 0x80, 0x80]]) {
    const r = scan(Uint8Array.from([...enc("it('[kind:a] "), ...bytes, ...enc(`', ${F});`)]));
    assert.deepEqual([r.status, r.reason, r.calls], ['unscannable', 'unscannable_utf8', []], JSON.stringify(bytes));
  }
  assert.deepEqual(sum(scan(Uint8Array.from([0xef, 0xbb, 0xbf, ...enc(`it('[kind:a] t', ${F});`)]))), OK(...k('a')));
  assert.deepEqual(sum(scan(`x = 1;﻿it('[kind:a] t', ${F});`)), UNSUP('ambiguous_lex'), 'a BOM after offset 0 is not whitespace');
  assert.deepEqual(sum(scan(Buffer.from(`it('[kind:a] t', ${F});`))), OK(...k('a')), 'a Buffer is a Uint8Array');
});

test('[R6] totality: random soup and hostile options never throw; steps never exceed 8 x bytes', () => {
  const R = prng(424242), alpha = ["'", '"', '`', '/', '*', '\\', '$', '{', '}', '(', ')', '[', ']', '\n', '\r', ' ', 'it', 'test', 'describe', '.skip', '.only', ',', ';', '<', '>', '!', '+', '-', '=', '#', '[kind:a]', '[plan:B]', ' ', ' ', 'é', 'x', '1', '?', '.', ':', 'of', 'return', '=>', 'import', 'from', "'node:test'"];
  const REASONS = { ok: [null], unsupported: ['unsupported_ext', 'ambiguous_lex', 'jsx_suspect', 'skip_form', 'ambiguous_callee', 'dynamic_scope'], unscannable: ['unscannable_utf8', 'unterminated', 'evidence_budget_exceeded'] };
  for (let n = 0; n < 4000; n++) {
    let s = ''; for (let len = Math.floor(R() * 60); len > 0; len--) s += alpha[Math.floor(R() * alpha.length)];
    const input = n % 5 === 0 ? Uint8Array.from({ length: Math.floor(R() * 40) }, () => Math.floor(R() * 256)) : enc(s);
    const r = scanTitles(input, { path: 'a.test.ts' });
    assert.ok(REASONS[r.status]?.includes(r.reason), JSON.stringify([s, r]));
    assert.ok(r.steps <= LIMITS.stepsPerByte * input.length + 1, `steps ${r.steps} for ${input.length} bytes`);
    for (const c of r.calls) {
      assert.match(c.title_sha256, /^[0-9a-f]{64}$/);
      for (const m of c.markers) assert.ok(m.startsWith('kind:') ? KIND_ID.test(m.slice(5)) : m.startsWith('plan:') && ITEM_ID.test(m.slice(5)), m);
    }
    if (n % 5 !== 0) { const b = scan(crlf(s), 'a.test.ts'); assert.deepEqual({ ...b, steps: 0 }, { ...r, steps: 0 }, `CRLF parity: ${JSON.stringify(s)}`); }
  }
  const bad = (x, what) => assert.deepEqual([x.status, x.reason], ['unscannable', 'input_invalid'], what);
  bad(scanTitles('it("[kind:a]", () => {})', { path: 'a.test.js' }), 'a string');
  bad(scanTitles(new Proxy(enc('x'), {}), { path: 'a.test.js' }), 'a proxied buffer');
  bad(scanTitles(enc('x'), new Proxy({ path: 'a.test.js' }, { get() { throw new Error('trap'); } })), 'proxied options');
  bad(scanTitles(enc('x'), { path: 7 }), 'a numeric path');
  bad(scanTitles(enc('x')), 'no options');
  bad(scanTitles(enc('x'), { path: 'a.test.js', limits: { maxBytes: LIMITS.maxBytes + 1 } }), 'a raised byte cap');
  bad(scanTitles(enc('x'), { path: 'a.test.js', limits: { maxSteps: -1 } }), 'a negative step cap');
  bad(scanTitles(enc('x'), { path: 'a.test.js', runnerModules: 'node:test' }), 'runnerModules not an array');
  bad(scanTitles(enc('x'), { path: 'a.test.js', runnerModules: [''] }), 'an empty module');
  bad(scanTitles(enc('x'), { path: 'a.test.js', get limits() { throw new Error('getter'); } }), 'a getter');
  bad(scanTitles(enc('x'), Object.create({ path: 'a.test.js' })), 'an inherited path');
});

test('[R7] the output carries only validated ids, enums, line numbers, digests and counts', () => {
  const r = scan(`describe('[kind:negative] g', () => { it('[kind:async-state] secret words', ${F}); });`);
  assert.deepEqual(Object.keys(r).sort(), ['calls', 'counts', 'line', 'reason', 'status', 'steps']);
  assert.deepEqual(r.calls, [{ line: 1, markers: ['kind:async-state'], title_sha256: sha('[kind:async-state] secret words') }]);
  assert.deepEqual(r.counts, { counted_calls: 1, marked_calls: 1, unknown_markers: 0, dynamic_titles: 0, rejected_signatures: 0, option_scoped: 0 });
  assert.doesNotMatch(JSON.stringify(r), /secret|words|negative/, 'no title text leaves the module');
  const u = scan('x = 1;\nconst el = <div/>;');
  assert.deepEqual([u.status, u.reason, u.line, u.calls, u.counts], ['unsupported', 'jsx_suspect', 2, [], null]);
});

test('ids: emitted markers use the test-kinds.mjs id grammar and its markers() accepts every one (L8)', async () => {
  const tk = await import('./test-kinds.mjs');
  assert.equal(KIND_ID.source, tk.NAME.source);
  assert.equal(ITEM_ID.source, tk.ITEM_ID.source);
  const all = new Set();
  for (const id of GRAMMAR) for (const side of ['pos', 'neg']) {
    const [src, , path = 'a.test.js'] = CORPUS[id][side];
    for (const c of scan(src, path).calls) for (const m of c.markers) all.add(m);
  }
  for (let seed = 1; seed <= 200; seed++) for (const c of scan(generate(seed).text).calls) for (const m of c.markers) all.add(m);
  assert.ok(all.size >= 6, `markers seen ${all.size}`);
  for (const m of all) {
    const got = tk.markers([`[${m}]`]), id = m.slice(5);
    assert.ok(m.startsWith('plan:') ? got.items.includes(id) : (got.kinds.includes(id) || got.unknown.includes(m)), m);
  }
});
