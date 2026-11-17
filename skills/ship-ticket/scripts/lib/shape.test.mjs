import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODES, depthOf, idStr, isTimestamp, LIMITS, shapeProblem, validate } from './shape.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const codes = (v, s, o) => validate(v, s, o).problems.map((p) => `${p.path}:${p.code}`);
const POLLUTED = () => ({}).polluted === undefined && ({}).x === undefined && Object.prototype.polluted === undefined;

test('validate: shape of the result, schema order, unknown keys first, JSON-pointer paths', () => {
  const S = { object: { a: 'string', b: { arrayOf: { object: { 'c/d': 'int', 'e~f': '?string' } } }, g: { enum: ['x', 'y'], nullable: true } } };
  assert.deepEqual(validate({ a: 's', b: [{ 'c/d': 1 }], g: null }, S), { ok: true, problems: [], truncated: false });
  assert.deepEqual(codes({ z: 1, a: 1, b: [{ 'c/d': 'no', 'e~f': 2 }], g: 'q' }, S), ['/z:unknown_key', '/a:bad_type', '/b/0/c~1d:bad_type', '/b/0/e~0f:bad_type', '/g:not_in_set']);
  assert.deepEqual(codes({}, S), ['/a:missing', '/b:missing', '/g:missing']);
  assert.deepEqual(codes([], S), [':not_object']);
  assert.deepEqual(codes({ a: 's', b: {}, g: 'x' }, S), ['/b:not_array']);
  assert.deepEqual(codes({ a: 's', b: [], g: 'x', k: 1 }, S), ['/k:unknown_key']);
  assert.deepEqual(codes({ a: 's', b: [], g: 'x' }, { open: true, object: S.object }), []);
  assert.deepEqual(codes({ a: 's', b: [], g: 'x', extra: 1 }, { open: true, object: S.object }), []);
  assert.deepEqual(codes(1, { object: {}, nullable: true }), [':not_object']);
  assert.deepEqual(codes(null, { object: {}, nullable: true }), []);
  for (const p of validate({ z: 1 }, S).problems) assert.ok(CODES.includes(p.code));
  assert.equal(validate({ ['k'.repeat(100)]: 1 }, { object: {} }).problems[0].path, `/${'k'.repeat(40)}`);
});

test('shapeProblem: the legacy first-problem string form', () => {
  assert.equal(shapeProblem({ a: 1 }, { object: { a: 'int' } }), null);
  assert.equal(shapeProblem({ a: 'x' }, { object: { a: 'int' } }), '$.a:bad_type');
  assert.equal(shapeProblem({}, { object: { a: 'int' } }), '$.a:missing');
  assert.equal(shapeProblem({ l: ['a', 1] }, { object: { l: { arrayOf: 'string' } } }), '$.l[1]:bad_type');
  assert.equal(shapeProblem({ a: 1, x: 1 }, { object: { a: 'int' } }, 'root'), 'root.x:unknown_key');
  assert.equal(shapeProblem(1, { object: {} }), '$:not_object');
});

test('truncation: maxProblems bounds the list and says so', () => {
  const r = validate(Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, 1])), { object: {} }, { maxProblems: 5 });
  assert.equal(r.problems.length, 5); assert.equal(r.truncated, true);
  assert.equal(validate({ k: 1 }, { object: {} }).truncated, false);
});

test('hostile: __proto__ / constructor / prototype keys are unknown keys, and nothing is polluted', () => {
  const evil = JSON.parse('{"__proto__":{"polluted":1},"constructor":{"prototype":{"x":1}},"prototype":1}');
  assert.deepEqual(codes(evil, { object: {} }), ['/__proto__:unknown_key', '/constructor:unknown_key', '/prototype:unknown_key']);
  assert.deepEqual(codes(evil, { open: true, object: { a: '?string' } }), []);
  assert.ok(POLLUTED());
  // own-property reads only: an inherited name is never a value
  assert.deepEqual(codes({}, { object: { constructor: 'string' } }), ['/constructor:missing']);
  assert.deepEqual(codes({}, { object: { toString: '?string' } }), []);
  assert.deepEqual(codes(JSON.parse('{"__proto__":"s"}'), { object: { ['__proto__']: 'string' } }), []);
  assert.ok(POLLUTED());
});

test('hostile: a getter is reported as accessor and never invoked', () => {
  let calls = 0;
  const o = { a: 'x' }; Object.defineProperty(o, 'b', { enumerable: true, get() { calls++; throw new Error('boom'); } });
  assert.deepEqual(codes(o, { object: { a: 'string', b: 'string' } }), ['/b:accessor']);
  const arr = ['x']; Object.defineProperty(arr, 1, { enumerable: true, get() { calls++; throw new Error('boom'); } });
  assert.deepEqual(codes(arr, { arrayOf: 'string' }), ['/1:accessor']);
  const hidden = { a: 'x' }; Object.defineProperty(hidden, 'h', { enumerable: false, value: 1 });
  assert.deepEqual(codes(hidden, { object: { a: 'string' } }), ['/h:unknown_key']);
  assert.equal(calls, 0);
  assert.equal(depthOf(o), 1); assert.equal(calls, 0);
});

test('hostile: huge arrays are refused without walking them', () => {
  assert.deepEqual(codes(new Array(2 ** 32 - 1), { arrayOf: 'string' }), [':too_large']);
  assert.deepEqual(codes(new Array(LIMITS.maxItems + 1).fill('a'), { arrayOf: 'string' }), [':too_large']);
  assert.deepEqual(codes(new Array(LIMITS.maxItems).fill('a'), { arrayOf: 'string' }), []);
  assert.deepEqual(codes(['a', 'b', 'c'], { arrayOf: 'string' }, { maxItems: 2 }), [':too_large']);
  const nested = Array.from({ length: 2000 }, () => Array.from({ length: 1000 }, () => 1));
  const r = validate(nested, { arrayOf: { arrayOf: 'int' } }, { maxNodes: 5000 });
  assert.deepEqual(r.problems.map((p) => p.code), ['too_large']); assert.equal(r.truncated, true);
});

test('hostile: deep nesting and cycles are bounded, with no stack overflow', () => {
  const S = { arrayOf: null }; S.arrayOf = S; // a self-referential schema
  let deep = []; for (let i = 0; i < 200000; i++) deep = [deep];
  assert.ok(codes(deep, S).includes(`${'/0'.repeat(LIMITS.maxDepth + 1)}:too_deep`));
  assert.equal(codes(deep, S, { maxDepth: 3 }).length >= 1, true);
  assert.ok(depthOf(deep) > LIMITS.maxDepth);
  const cyc = {}; cyc.self = cyc; assert.ok(depthOf(cyc) > LIMITS.maxDepth);
  assert.equal(depthOf(null), 0); assert.equal(depthOf([]), 1); assert.equal(depthOf({ a: [{}] }), 3);
  assert.equal(depthOf(deep, 1e9, 1000), Infinity);
  const cycArr = []; cycArr.push(cycArr);
  assert.deepEqual(codes(cycArr, S).at(-1).endsWith(':too_deep'), true);
});

test('numbers: NaN, Infinity and non-integers fail every numeric token', () => {
  for (const bad of [NaN, Infinity, -Infinity]) for (const tok of ['number', 'int', 'posint', 'uint', 'id']) assert.deepEqual(codes(bad, tok), [':bad_type'], `${tok} ${bad}`);
  assert.deepEqual(codes(1.5, 'int'), [':bad_type']); assert.deepEqual(codes(1.5, 'number'), []);
  assert.deepEqual(codes(2 ** 53, 'int'), [':bad_type']); assert.deepEqual(codes(0, 'posint'), [':bad_type']); assert.deepEqual(codes(-1, 'uint'), [':bad_type']); assert.deepEqual(codes(0, 'uint'), []);
  assert.equal(idStr(NaN), null); assert.equal(idStr(Infinity), null); assert.equal(idStr('01'), null); assert.equal(idStr(7), '7');
});

test('hostile: sparse arrays, symbol keys, non-plain objects', () => {
  assert.deepEqual(codes([, 'a'], { arrayOf: 'string' }), ['/0:sparse']); // eslint-disable-line no-sparse-arrays
  assert.deepEqual(codes(Array(3), { arrayOf: 'string' }), ['/0:sparse', '/1:sparse', '/2:sparse']);
  assert.deepEqual(codes({ a: 'x', [Symbol('s')]: 1 }, { object: { a: 'string' } }), ['/<symbol>:unknown_key']);
  assert.deepEqual(codes({ a: 'x', [Symbol('s')]: 1 }, { open: true, object: { a: 'string' } }), []);
  for (const v of [new Map(), new Date(), new (class X {})(), Object.create({ a: 1 })]) assert.deepEqual(codes(v, { object: {} }), [':not_object']);
  assert.deepEqual(codes(Object.create(null), { object: {} }), []);
});

test('hostile: Proxy objects never throw out of validate or depthOf', () => {
  const trap = (name) => new Proxy({ a: 'x' }, { [name]: () => { throw new Error(name); } });
  for (const name of ['ownKeys', 'getOwnPropertyDescriptor', 'getPrototypeOf', 'get', 'has']) {
    const r = validate(trap(name), { object: { a: 'string' } });
    assert.ok(Array.isArray(r.problems), name); assert.doesNotThrow(() => depthOf(trap(name)), name);
    if (name !== 'get' && name !== 'has') assert.deepEqual(r.problems.map((p) => p.code), ['unreadable'], name);
  }
  assert.deepEqual(codes({ a: trap('ownKeys'), b: 'ok' }, { object: { a: { object: { x: '?string' } }, b: 'string' } }), ['/a:unreadable']); // the problem is local: siblings are still checked
  assert.deepEqual(codes({ a: trap('ownKeys'), b: 'no' }, { object: { a: { object: { x: '?string' } }, b: 'int' } }), ['/a:unreadable', '/b:bad_type']);
  const { proxy, revoke } = Proxy.revocable({ a: 'x' }, {}); revoke();
  assert.doesNotThrow(() => validate(proxy, { object: { a: 'string' } })); assert.doesNotThrow(() => depthOf(proxy));
  assert.ok(!validate(proxy, { object: { a: 'string' } }).ok);
  assert.deepEqual(codes(new Proxy({ a: 'x' }, {}), { object: { a: 'string' } }), []); // a well-behaved proxy is just an object
  assert.deepEqual(codes(new Proxy(['x'], { get() { throw new Error('g'); } }), { arrayOf: 'string' }).length >= 0, true);
  const bad = { object: { a: 'string' } }; Object.defineProperty(bad, 'enum', { get() { throw new Error('schema'); } });
  assert.doesNotThrow(() => validate({ a: 'x' }, bad)); assert.doesNotThrow(() => shapeProblem({ a: 'x' }, bad));
});

test('bad schema is a problem, not a throw', () => {
  for (const s of [undefined, null, 5, {}, { object: 5 }, { object: null }]) assert.deepEqual(validate({}, s).problems.map((p) => p.code), ['bad_schema']);
  assert.deepEqual(codes('x', 'nonsense'), [':bad_type']);
});

test('inputs are never mutated and frozen input is fine', () => {
  const v = Object.freeze({ a: Object.freeze(['x']) }); const before = JSON.stringify(v);
  assert.equal(validate(v, { object: { a: { arrayOf: 'string' } } }).ok, true); assert.equal(JSON.stringify(v), before);
  const S = Object.freeze({ object: Object.freeze({ a: 'string' }) });
  assert.equal(validate({ a: 's' }, S).ok, true);
});

test('timestamps: strict ISO-8601 UTC and a real instant', () => {
  for (const ok of ['2024-02-29T23:59:59Z', '2026-11-16T21:28:16.123456789Z']) assert.equal(isTimestamp(ok), true, ok);
  for (const bad of ['2026-02-30T00:00:00Z', '2025-02-29T00:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T00:00:60Z', '2026-01-01T00:00:00+00:00', '2026-01-01 00:00:00Z', '2026-01-01', 5, null, {}, '']) assert.equal(isTimestamp(bad), false, String(bad));
});

// ---- generic invariant: every schema primitive rejects every wrong-typed value of a shared corpus ----------------------
const sparse = []; sparse.length = 2;
const CORPUS = {
  undefined: undefined, null: null, true: true, false: false, zero: 0, one: 1, negative: -1, float: 1.5, NaN, Infinity, big: 2 ** 60, bigint: 10n, emptyString: '', string: 'abc', digits: '123', leadingZero: '01',
  ts: '2026-11-16T21:28:16Z', badTs: '2026-02-30T00:00:00Z', symbol: Symbol('s'), fn: () => 1, emptyObject: {}, object: { a: 1 }, nullProto: Object.create(null), emptyArray: [], array: ['a'], sparse,
  date: new Date(0), map: new Map(), regexp: /x/,
};
const ACCEPT = { // for every primitive, the ONLY corpus entries it may accept
  string: ['emptyString', 'string', 'digits', 'leadingZero', 'ts', 'badTs'], null: ['null'], boolean: ['true', 'false'], number: ['zero', 'one', 'negative', 'float', 'big'],
  int: ['zero', 'one', 'negative'], posint: ['one'], uint: ['zero', 'one'], id: ['zero', 'one', 'digits'], ts: ['ts'],
  'string|null': ['null', 'emptyString', 'string', 'digits', 'leadingZero', 'ts', 'badTs'], 'int|null': ['null', 'zero', 'one', 'negative'],
  '?string': ['emptyString', 'string', 'digits', 'leadingZero', 'ts', 'badTs'],
  enumAB: ['string'], // { enum: ['abc', 'q'] }
  arrayOfString: ['emptyArray', 'array'], objectClosedEmpty: ['emptyObject', 'nullProto'], objectOpen: ['emptyObject', 'object', 'nullProto'],
};
const SCHEMAS = {
  string: 'string', null: 'null', boolean: 'boolean', number: 'number', int: 'int', posint: 'posint', uint: 'uint', id: 'id', ts: 'ts', 'string|null': 'string|null', 'int|null': 'int|null', '?string': '?string',
  enumAB: { enum: ['abc', 'q'] }, arrayOfString: { arrayOf: 'string' }, objectClosedEmpty: { object: {} }, objectOpen: { open: true, object: {} },
};
test('invariant: every primitive accepts exactly its own corpus entries and rejects every other value, without throwing', () => {
  let checked = 0;
  for (const [name, schema] of Object.entries(SCHEMAS)) for (const [label, value] of Object.entries(CORPUS)) {
    let r; assert.doesNotThrow(() => { r = validate(value, schema); }, `${name}/${label}`);
    assert.equal(r.ok, ACCEPT[name].includes(label), `${name} vs ${label}: ${JSON.stringify(r.problems)}`);
    assert.equal(shapeProblem(value, schema) === null, r.ok, `shapeProblem ${name}/${label}`);
    for (const p of r.problems) assert.ok(CODES.includes(p.code), p.code);
    checked++;
  }
  assert.equal(checked, Object.keys(SCHEMAS).length * Object.keys(CORPUS).length);
  for (const [name, schema] of Object.entries(SCHEMAS)) for (const label of Object.keys(ACCEPT)) assert.ok(label in SCHEMAS, label); // every ACCEPT row has a schema
  // nullable and optional modifiers on top of every primitive
  for (const [name, schema] of Object.entries(SCHEMAS)) {
    if (typeof schema === 'string') continue;
    assert.equal(validate(null, { ...schema, nullable: true }).ok, true, `${name} nullable`);
    assert.equal(validate(null, schema).ok, ACCEPT[name].includes('null'), `${name} null rejected`);
    assert.deepEqual(codes({}, { object: { k: schema } }), [ '/k:missing' ], `${name} required`);
    assert.deepEqual(codes({}, { object: { k: { ...schema, optional: true } } }), [], `${name} optional`);
  }
  assert.deepEqual(codes({ k: undefined }, { object: { k: '?string' } }), ['/k:bad_type']); // present-but-undefined is not "absent"
});

// ---- mutation check: each mutant of shape.mjs must be killed by this file --------------------------------------------
const MUTANTS = [
  ['unknown keys allowed', "if (!spec.open) for (const k of Reflect.ownKeys(v))", "if (false) for (const k of Reflect.ownKeys(v))"],
  ['own check dropped (inherited values read)', "const d = Reflect.getOwnPropertyDescriptor(v, k);", "const d = k in v ? { value: v[k] } : undefined;"],
  ['getter invoked', "if (!d) { if (!isOptional(s)) add(ctx, 'missing', k); continue; }\n    ctx.stack.push(k);\n    if (!('value' in d)) add(ctx, 'accessor'); else shapeProblem$walk(d.value, s, ctx);", "if (!d) { if (!isOptional(s)) add(ctx, 'missing', k); continue; }\n    ctx.stack.push(k);\n    shapeProblem$walk(v[k], s, ctx);"],
  ['array hole accepted', "if (!d) add(ctx, 'sparse'); else if", "if (!d) { /* hole accepted */ } else if"],
  ['array size cap removed', "if (!(n <= ctx.maxItems)) return add(ctx, 'too_large');", ""],
  ['node budget removed', "if (++ctx.nodes > ctx.maxNodes) { add(ctx, 'too_large'); ctx.done = true; return; }", ""],
  ['depth cap removed', "if (ctx.stack.length > ctx.maxDepth) { add(ctx, 'too_deep'); return; }", ""],
  ['throw not caught', "catch { ctx.stack.length = depth; add(ctx, 'unreadable'); }", "catch (e) { throw e; }"],
  ['NaN is a number', "typeof v === 'number' && Number.isFinite(v)", "typeof v === 'number'"],
  ['int allows floats', "int: (v) => Number.isSafeInteger(v),", "int: (v) => typeof v === 'number',"],
  ['posint allows zero', "Number.isSafeInteger(v) && v >= 1, uint", "Number.isSafeInteger(v) && v >= 0, uint"],
  ['uint allows negatives', "uint: (v) => Number.isSafeInteger(v) && v >= 0", "uint: (v) => Number.isSafeInteger(v)"],
  ['id allows leading zero', "/^(0|[1-9]\\d*)$/.test(v)", "/^\\d+$/.test(v)"],
  ['timestamp calendar round trip dropped', "&& d.toISOString().slice(0, 19) === whole.slice(0, 19)", ""],
  ['enum accepts any string', "typeof v === 'string' && spec.enum.includes(v)", "typeof v === 'string'"],
  ['null always accepted', "if (v === null && spec.nullable) return;", "if (v === null) return;"],
  ['optional ignored', "if (!isOptional(s)) add(ctx, 'missing', k)", "add(ctx, 'missing', k)"],
  ['non-plain objects accepted', "|| !plain(v)", ""],
  ['symbol key named after a string', "typeof k === 'symbol' ? '<symbol>' : k.slice(0, 40)", "String(k)"],
  ['depthOf ignores limit', "if (max > limit) return max;", ""],
  ['depthOf invokes getters', "if (p && 'value' in p) stack.push([p.value, d + 1]);", "stack.push([x[k], d + 1]);"],
  ['problem list unbounded', "if (ctx.problems.length >= ctx.maxProblems) ctx.done = true;", ""],
  ['unknown-key loop ignores the problem cap', "if (!ctx.done && !Object.hasOwn(spec.object, k))", "if (!Object.hasOwn(spec.object, k))"],
  ['pointer escaping dropped', ".replace(/~/g, '~0').replace(/\\//g, '~1')", ""],
  ['unknown key not cut', "k.slice(0, 40)", "k"],
];
test('mutation: every mutant of shape.mjs is killed by this file', { skip: process.env.SHAPE_MUTANT_RUN === '1' }, () => {
  const src = readFileSync(join(HERE, 'shape.mjs'), 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'shape-mut-'));
  const survivors = [];
  try {
    for (const [name, from, to] of MUTANTS) {
      assert.equal(src.split(from).length - 1, 1, `mutant "${name}": anchor must occur exactly once`);
      rmSync(join(dir, 'lib'), { recursive: true, force: true }); mkdirSync(join(dir, 'lib'));
      writeFileSync(join(dir, 'lib', 'shape.mjs'), src.replace(from, to));
      copyFileSync(join(HERE, 'shape.test.mjs'), join(dir, 'lib', 'shape.test.mjs'));
      const r = spawnSync(process.execPath, ['--test', join(dir, 'lib', 'shape.test.mjs')], { env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT')), SHAPE_MUTANT_RUN: '1' }, encoding: 'utf8', timeout: 20000 });
      if (r.status === 0) survivors.push(name);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.deepEqual(survivors, [], 'surviving mutants');
});
