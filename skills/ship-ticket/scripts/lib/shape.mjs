/**
 * Shared closed-schema shape validator (S-30b). Promoted from the S-05a CI snapshot verifier; no dependencies.
 *
 * A schema is DATA. Specs:
 *   'string' | 'string|null' | '?ts'   scalar tokens joined by `|`; a leading `?` makes the key optional.
 *                                      Tokens: string null boolean number (finite) int (safe) posint uint id (canonical id
 *                                      digits or safe integer) ts (strict ISO-8601 UTC, a REAL instant).
 *   { enum: [...], nullable?, optional? }
 *   { arrayOf: spec, nullable?, optional? }
 *   { object: { key: spec }, open?, nullable?, optional? }   CLOSED unless `open` (an unknown own key is a problem).
 *
 *   validate(value, schema, opts?) -> { ok, problems: [{ code, path }], truncated }
 *     code: one of CODES (stable, machine-readable). path: JSON pointer ('' = root, '/a/0/b'; keys escaped ~0 ~1,
 *     an unknown key is cut at 40 chars and a symbol key shows as '<symbol>'). Problems come in schema order, unknown keys first.
 *     opts: maxDepth (32), maxItems per array (100000), maxNodes of work (1000000: every value visited and every key examined),
 *     maxProblems (50); each also accepts Infinity. Past maxItems or maxNodes: `too_large`. `truncated` = the list stopped at
 *     maxProblems or the node budget ran out, so more problems may exist.
 *   shapeProblem(value, spec, path = '$', opts = {}) -> null | '<path>:<code>' (the FIRST problem; legacy `$.a[0]` path form).
 *     LEGACY LIMITS: unlike validate, shapeProblem has NO item or node cap by default (maxItems/maxNodes Infinity; only maxDepth 32),
 *     because the CI snapshot verifier needs its old verdicts for arbitrarily long label/step arrays. Pass opts to bound it.
 *   depthOf(value, limit = MAX_DEPTH, maxNodes = LIMITS.maxNodes) -> nesting depth, stopping once above `limit`; Infinity when the
 *     work budget (every object visited, REPEATS included, and every key examined) runs out, so a shared-reference DAG or a
 *     cycle cannot take exponential time. Pass Infinity only for trees that cannot share references (JSON.parse output).
 *
 * Hostile data is a problem, never a throw and never a side effect: only OWN properties are read, through their
 * descriptors, including an array's `length` (a getter is reported as `accessor` and never invoked; an inherited `constructor` is not a value);
 * `__proto__`, symbol and non-enumerable keys are unknown keys of a closed object; holes in an array are `sparse`;
 * a non-plain object (array where an object is expected, class instance, Map, Date; also a cross-realm one) is `not_object`; NaN and Infinity are
 * not numbers; work is bounded by the limits above (listing the own keys of a very wide object is materialised once by the engine, an
 * unavoidable cost that is counted but not interruptible). The input and the schema are never mutated.
 * PROXIES: a Proxy is read only through its ownKeys, getOwnPropertyDescriptor, getPrototypeOf and isArray traps (never `get`/`has`);
 * a throwing trap is `unreadable`. A Proxy whose descriptor traps LIE can make validation lie: this validates data (JSON.parse
 * output and plain objects), it is not a sandbox for arbitrary exotic objects.
 * `id` = a non-negative safe integer or a canonical digit string.
 */
export const MAX_DEPTH = 32;
export const LIMITS = Object.freeze({ maxDepth: MAX_DEPTH, maxItems: 100000, maxNodes: 1000000, maxProblems: 50 });
export const CODES = Object.freeze(['bad_type', 'not_in_set', 'not_array', 'not_object', 'unknown_key', 'missing', 'too_deep', 'too_large', 'sparse', 'accessor', 'unreadable', 'bad_schema']);

const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
/** Strict ISO-8601 UTC, and a REAL instant: the native Date round trip must reproduce the supplied second (Feb 30, hour 24, second 60 do not survive it). */
export const isTimestamp = (v) => {
  if (typeof v !== 'string' || !TS.test(v)) return false;
  const whole = v.replace(/\.\d+Z$/, 'Z'), d = new Date(whole);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 19) === whole.slice(0, 19);
};
/** An id as a canonical digit string (no leading zero), or null (numbers must be safe integers). */
export const idStr = (v) => (typeof v === 'number' ? (Number.isSafeInteger(v) && v >= 0 ? String(v) : null) : typeof v === 'string' && /^(0|[1-9]\d*)$/.test(v) ? v : null);
const SCALARS = {
  string: (v) => typeof v === 'string', null: (v) => v === null, boolean: (v) => typeof v === 'boolean', number: (v) => typeof v === 'number' && Number.isFinite(v),
  int: (v) => Number.isSafeInteger(v), posint: (v) => Number.isSafeInteger(v) && v >= 1, uint: (v) => Number.isSafeInteger(v) && v >= 0, id: (v) => idStr(v) !== null, ts: isTimestamp,
};
const scalarOk = (v, tok) => Object.hasOwn(SCALARS, tok) && SCALARS[tok](v);
const mod = (s, k) => (Object.hasOwn(s, k) ? s[k] : undefined); // schema modifiers are own properties only: a polluted Object.prototype must not loosen a schema
const isOptional = (s) => (typeof s === 'string' ? s.startsWith('?') : s !== null && typeof s === 'object' && mod(s, 'optional') === true);
const plain = (v) => { const p = Reflect.getPrototypeOf(v); return p === Object.prototype || p === null; };

function add(ctx, code, extra) {
  ctx.problems.push({ code, path: extra === undefined ? [...ctx.stack] : [...ctx.stack, extra] });
  if (ctx.problems.length >= ctx.maxProblems) ctx.done = true;
}

// Named so that every stack frame inside a validation matches /at shapeProblem\b/: ci-snapshot.test.mjs attributes reads by that frame.
function shapeProblem$walk(v, spec, ctx) {
  if (ctx.done) return;
  if (++ctx.nodes > ctx.maxNodes) { add(ctx, 'too_large'); ctx.done = true; return; }
  if (ctx.stack.length > ctx.maxDepth) { add(ctx, 'too_deep'); return; }
  const depth = ctx.stack.length;
  try { check(v, spec, ctx); } catch { ctx.stack.length = depth; add(ctx, 'unreadable'); }
}

function check(v, spec, ctx) {
  if (typeof spec === 'string') { if (!spec.replace(/^\?/, '').split('|').some((tok) => scalarOk(v, tok))) add(ctx, 'bad_type'); return; }
  if (spec === null || typeof spec !== 'object') return add(ctx, 'bad_schema');
  if (v === null && mod(spec, 'nullable') === true) return;
  if (mod(spec, 'enum')) { if (!(typeof v === 'string' && spec.enum.includes(v))) add(ctx, 'not_in_set'); return; }
  if (mod(spec, 'arrayOf')) {
    if (!Array.isArray(v)) return add(ctx, 'not_array');
    const ld = Reflect.getOwnPropertyDescriptor(v, 'length'); // never `v.length`: that would run a Proxy `get` trap, which may lie
    if (!ld || !('value' in ld) || !Number.isSafeInteger(ld.value) || ld.value < 0) return add(ctx, 'unreadable');
    const n = ld.value;
    if (!(n <= ctx.maxItems)) return add(ctx, 'too_large');
    for (let i = 0; i < n && !ctx.done; i++) {
      const d = Reflect.getOwnPropertyDescriptor(v, i);
      ctx.stack.push(i);
      if (!d) add(ctx, 'sparse'); else if (!('value' in d)) add(ctx, 'accessor'); else shapeProblem$walk(d.value, spec.arrayOf, ctx);
      ctx.stack.pop();
    }
    return;
  }
  if (!mod(spec, 'object') || typeof spec.object !== 'object') return add(ctx, 'bad_schema');
  if (!v || typeof v !== 'object' || !plain(v)) return add(ctx, 'not_object');
  if (mod(spec, 'open') !== true) for (const k of Reflect.ownKeys(v)) {
    if (ctx.done) break;
    if (++ctx.nodes > ctx.maxNodes) { add(ctx, 'too_large'); ctx.done = true; break; }
    if (!Object.hasOwn(spec.object, k)) add(ctx, 'unknown_key', typeof k === 'symbol' ? '<symbol>' : k.slice(0, 40));
  }
  for (const [k, s] of Object.entries(spec.object)) {
    if (ctx.done) return;
    const d = Reflect.getOwnPropertyDescriptor(v, k);
    if (!d) { if (!isOptional(s)) add(ctx, 'missing', k); continue; }
    ctx.stack.push(k);
    if (!('value' in d)) add(ctx, 'accessor'); else shapeProblem$walk(d.value, s, ctx);
    ctx.stack.pop();
  }
}

const lim = (x, d) => (x === Infinity || (Number.isSafeInteger(x) && x >= 1) ? x : d);
function run(value, spec, o, maxProblems) {
  const ctx = { problems: [], stack: [], nodes: 0, done: false, maxDepth: lim(o.maxDepth, LIMITS.maxDepth), maxItems: lim(o.maxItems, LIMITS.maxItems), maxNodes: lim(o.maxNodes, LIMITS.maxNodes), maxProblems };
  shapeProblem$walk(value, spec, ctx);
  return ctx;
}
const pointer = (segs) => segs.map((s) => `/${String(s).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');

/** Never throws. See the header. */
export function validate(value, schema, opts) {
  const o = opts !== null && typeof opts === 'object' ? opts : {};
  try {
    const ctx = run(value, schema, o, lim(o.maxProblems, LIMITS.maxProblems));
    return { ok: ctx.problems.length === 0, problems: ctx.problems.map((p) => ({ code: p.code, path: pointer(p.path) })), truncated: ctx.done };
  } catch { return { ok: false, problems: [{ code: 'unreadable', path: '' }], truncated: false }; }
}

/** null when `v` matches `spec`, else the first problem as `<path>:<code>` (built from the path only; never throws, never stringifies a value). */
export function shapeProblem(v, spec, path = '$', opts) {
  let ctx;
  try { const o = opts !== null && typeof opts === 'object' ? opts : {}; ctx = run(v, spec, { maxItems: Infinity, maxNodes: Infinity, ...o }, 1); } catch { return `${path}:unreadable`; }
  const p = ctx.problems[0];
  return p ? `${path}${p.path.map((s) => (typeof s === 'number' ? `[${s}]` : `.${s}`)).join('')}:${p.code}` : null;
}

/** Nesting depth of the own enumerable data of `x` (getters are not invoked), stopping once above `limit`; Infinity when unreadable or the work budget runs out (see the header). */
export function depthOf(v, limit = MAX_DEPTH, maxNodes = LIMITS.maxNodes) {
  let max = 0, work = 0; const stack = [[v, 0]];
  while (stack.length) {
    const [x, d] = stack.pop();
    if (x && typeof x === 'object') {
      max = Math.max(max, d + 1); if (max > limit) return max;
      try {
        for (const k of Reflect.ownKeys(x)) {
          if (++work > maxNodes) return Infinity;
          const p = Reflect.getOwnPropertyDescriptor(x, k);
          if (p && 'value' in p && p.value && typeof p.value === 'object') stack.push([p.value, d + 1]);
        }
      } catch { return Infinity; }
    }
  }
  return max;
}
