/**
 * Test-title marker scanner (S-01b2 P1; design S-01b2-design.md rev 3 §2b, which is normative). PURE: bytes in, a typed result
 * out, never an exception. INV-E: evidence UNDER-recognises, so an ambiguous construct ANYWHERE voids the WHOLE file.
 *
 *   scanTitles(bytes: Uint8Array, { path, runnerModules?, limits? }) ->
 *     { status: 'ok'|'unsupported'|'unscannable', reason: null|REASON, line: null|n, calls: [{line, markers, title_sha256}], counts, steps }
 *
 * SUPPORTED GRAMMAR: design rev 3 §2b as overridden by the Codex rev-3 challenge (findings 2-4, 10; to be adopted by rev 4).
 * Each row is a GRAMMAR id; test-titles.test.mjs holds a positive and a negative fixture per row.
 *   X1 extension  .js .mjs .cjs .ts .mts .cts (exact, case-sensitive); anything else, .jsx/.tsx included -> unsupported_ext
 *   X2 utf8       strict UTF-8 (fatal decoder) -> unscannable_utf8
 *   X3 prologue   a BOM only at offset 0, a `#!` line only at offset 0
 *   X4 caps       file <= 1 MiB; charged steps <= 8 x bytes (one per char, per token, per title char) -> evidence_budget_exceeded
 *   L1 line terminators LF, CR, CRLF, U+2028, U+2029 (one line each; CRLF and LF copies scan identically)
 *   L2 whitespace ASCII space, tab, VT, FF, U+00A0; any other non-ASCII code point outside a comment/string/template -> ambiguous_lex
 *   L3 comments   `//` to the line terminator, `/* *\/`
 *   L4 strings    '...' "..." with backslash escapes (an escaped terminator continues the line); a raw LF/CR -> unterminated
 *   L5 templates  backtick; `${` pushes an expression frame lexed as code; its `}` returns to text; > 16 nested frames -> ambiguous_lex
 *   L6 identifiers ASCII [A-Za-z_$][A-Za-z0-9_$]*; a backslash escape or a `#` outside the BOF `#!` -> ambiguous_lex
 *   L7 numbers    decimal/exponent/hex/octal/binary/separator/bigint literals; a malformed one -> ambiguous_lex
 *   L8 regex|div  by the previous significant token P. Regex ONLY when P is none, a template head/middle, a punctuator other than
 *                 `) ] } ++ --`, a prefix `!`, or a `)` whose `(` follows if/while/for/with. Division when P is a non-keyword
 *                 identifier (any word after `.`/`?.` is one), number, string, template end, regex, `]` or another `)`.
 *   L9 regex body `[...]` classes and escapes; flags [a-z]*
 *   L10 ambiguous a `/` after break continue return debugger yield await throw case typeof void delete in of instanceof new else do
 *                 default extends, after `break|continue <label>`, `}`, `++`, `--`, or a postfix `!`; any `for await (` header
 *                 -> ambiguous_lex (fail closed on every position not provably division or provably regex)
 *   L11 angle     `<` where an operand is expected or after `}` (JSX in any extension, TS `<T>x`) -> jsx_suspect
 *   L12 unterminated comment, string, template, regex, or a bracket left open at EOF -> unterminated
 *   L13 html-like `<!--` or `-->` anywhere in code (Annex B comments) -> ambiguous_lex
 *   L14 brackets  a closer that does not match the innermost opener -> ambiguous_lex
 *   R1 callee     the bare identifier `test` or `it` whose previous significant token is BOF, `;`, `{` or `}`
 *   R2 open       the next token is `(`
 *   R3 literal    the first argument is ONE string token or ONE template token without `${` (else counts.dynamic_titles)
 *   R4 arguments  EXACTLY two arguments (a trailing comma is allowed); a callback-less call, an options object or identifier, a
 *                 call result, a parenthesised object, a timeout: the call counts for nothing (counts.rejected_signatures)
 *   R5 frames     every open `(` frame belongs to a `describe`/`suite` call at statement position; `{` `[` frames are allowed;
 *                 a template-expression frame is not
 *   R6 callback   the second argument is entirely ONE function literal: `[async] function[*] [name](...) {...}` or an arrow whose
 *                 block body ends the argument (a concise body is the rest of the argument)
 *   R7 group      an enclosing describe/suite call whose arguments are not exactly (string/template title, R6 callback) makes every
 *                 call inside it count for nothing (counts.option_scoped): `describe('d', {skip: true}, fn)` is a skip scope
 *   F1a skip_form any identifier xit, xtest, xdescribe, fit, fdescribe
 *   F1b skip_form test/it/describe/suite followed by `.` or `?.` and one of only skip todo skipIf runIf fixme fails failing each
 *                 concurrent sequential extend
 *   F2  ambiguous_callee  test/it/describe/suite anywhere except: an R1/R2/R5 callee (describe/suite: same position rule), a property
 *                 after `.`/`?.`, or an exact import specifier `{ test }`/`{ it }`/`{ describe }`/`{ suite }` or default `test` in
 *                 `import ... from '<m>'` with <m> raw-equal to a RUNNER_MODULES entry or a caller-supplied (base-declared) module
 *   F3  dynamic_scope  the identifiers `with`, `eval` (direct or indirect) and `Function` (not as a property), or an assignment
 *                 to a `.test`/`.it`/`.describe`/`.suite` property: dynamic or global rebinding the token scan cannot see
 *   M1 markers    read from the RAW literal text: \[(kind|plan):([A-Za-z0-9][A-Za-z0-9_-]{0,63})\], ASCII, exact, case-sensitive;
 *                 emitted only when the id passes test-kinds.mjs NAME (kind) / ITEM_ID (plan), else counted in unknown_markers
 *   M2 digest     every counted call carries sha256(raw title, CRLF/CR -> LF) for the base multiset of design §2c; no title text leaves
 * Any lexer outcome or F-rule anywhere voids the WHOLE file. Reasons: unsupported = unsupported_ext, ambiguous_lex, jsx_suspect,
 * skip_form, ambiguous_callee, dynamic_scope; unscannable = unscannable_utf8, unterminated, evidence_budget_exceeded, input_invalid,
 * scanner_error. NOT claimed (design §0 L-exists): a counted marker is not a test that ran or proves anything; runtime skips
 * (`t.skip()`), conditional registration (`if (env) { it(...) }`), uncollected files and runner globals rebound by other modules
 * (setup files) defeat it.
 * REUSE: custom lexer, justified: acorn/espree have no TypeScript, typescript cannot be vendored without npm, node:module
 * stripTypeScriptTypes needs Node >= 22.13 and CI runs Node 18; nothing here needs a full parse.
 */
import { createHash } from 'node:crypto';
import { types } from 'node:util';

export const KIND_ID = /^[a-z0-9][a-z0-9-]{0,63}$/; // = test-kinds.mjs NAME (asserted by the test)
export const ITEM_ID = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/; // = test-kinds.mjs ITEM_ID (asserted by the test)
export const EXTENSIONS = Object.freeze(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts']);
export const RUNNER_MODULES = Object.freeze(['node:test', 'vitest', '@jest/globals', 'bun:test', '@playwright/test']);
export const LIMITS = Object.freeze({ maxBytes: 1048576, stepsPerByte: 8, maxTemplateDepth: 16 });
export const GRAMMAR = Object.freeze(['X1', 'X2', 'X3', 'X4', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10', 'L11', 'L12', 'L13', 'L14',
  'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'F1a', 'F1b', 'F2', 'F3', 'M1', 'M2']);

const ROOTS = new Set(['test', 'it', 'describe', 'suite']);
const GROUPS = new Set(['describe', 'suite']);
const X_IDS = new Set(['xit', 'xtest', 'xdescribe', 'fit', 'fdescribe']);
const F1_MEMBERS = new Set(['only', 'skip', 'todo', 'skipIf', 'runIf', 'fixme', 'fails', 'failing', 'each', 'concurrent', 'sequential', 'extend']);
// a `/` after one of these (not after `.`/`?.`) cannot be proven to be division (restricted productions, ASI): the file is void
const AMBIG_KW = new Set(['break', 'continue', 'return', 'debugger', 'yield', 'await', 'throw', 'case', 'typeof', 'void', 'delete', 'in', 'of', 'instanceof', 'new', 'else', 'do', 'default', 'extends']);
const SCOPE_IDS = new Set(['with', 'eval', 'Function']);
const CONTROL_KW = new Set(['if', 'while', 'for', 'with']);
const PUNCT = new Set([';', ',', '>', '+', '-', '*', '%', '&', '|', '^', '~', ':', '@', '<', '=', '!', '?', '.']);
const NUMBER = /(?:0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*|0[oO][0-7](?:_?[0-7])*|0[bB][01](?:_?[01])*)n?|(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?n?/y;
const MARKER = /\[(kind|plan):([A-Za-z0-9][A-Za-z0-9_-]{0,63})\]/g;
const UNSUPPORTED = new Set(['unsupported_ext', 'ambiguous_lex', 'jsx_suspect', 'skip_form', 'ambiguous_callee', 'dynamic_scope']);

class Stop { constructor(reason, line) { this.reason = reason; this.line = line; } }
const isLT = (c) => c === 10 || c === 13 || c === 0x2028 || c === 0x2029;
const isWS = (c) => c === 32 || c === 9 || c === 11 || c === 12 || c === 0xa0;
const isIdStart = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 36 || c === 95;
const isIdPart = (c) => isIdStart(c) || (c >= 48 && c <= 57);
const isDigit = (c) => c >= 48 && c <= 57;

/** One pass over the decoded text. Tokens: {t: id|num|str|tpl|tplh|tplm|tplt|re|p, v, s, e, line, m (matching closer), bad}. */
function lex(src, charge) {
  const T = [], S = []; // S: open frames {ch, at, bad: is a non-describe `(` or a template frame}
  const n = src.length;
  let i = 0, line = 1, bad = 0, tplDepth = 0;
  const stop = (reason) => { throw new Stop(reason, line); };
  const push = (t, v, s, e, l = line) => { charge(1); T.push({ t, v, s, e, line: l, m: -1, bad }); return T.length - 1; };
  const lt = (j) => { line++; return src.charCodeAt(j) === 13 && src.charCodeAt(j + 1) === 10 ? j + 2 : j + 1; };
  const sig = (k, v) => k >= 0 && T[k].t === 'p' && T[k].v === v;
  const afterDot = (k) => sig(k - 1, '.') || sig(k - 1, '?.');
  const operandEnd = (k) => { // does token k end an operand (so a following `/` would be division)?
    const a = T[k];
    if (a.t === 'num' || a.t === 'str' || a.t === 'tpl' || a.t === 'tplt' || a.t === 're') return true;
    if (a.t === 'id') return afterDot(k) || !AMBIG_KW.has(a.v);
    return a.v === ')' || a.v === ']';
  };
  const mode = () => { // 'regex' | 'div' | 'amb' for a `/` or `<` at this point
    const k = T.length - 1;
    if (k < 0) return 'regex';
    const a = T[k];
    if (a.t === 'tplh' || a.t === 'tplm') return 'regex';
    if (a.t === 'id') {
      if (afterDot(k)) return 'div';
      if (AMBIG_KW.has(a.v) || (k > 0 && T[k - 1].t === 'id' && (T[k - 1].v === 'break' || T[k - 1].v === 'continue'))) return 'amb';
      return 'div';
    }
    if (a.t !== 'p') return 'div';
    if (a.v === ')') return T[a.open].control ? 'regex' : 'div';
    if (a.v === ']') return 'div';
    if (a.v === '}' || a.v === '++' || a.v === '--') return 'amb';
    if (a.v === '!') { let j = k; while (j > 0 && sig(j - 1, '!')) { charge(1); j--; } return j > 0 && operandEnd(j - 1) ? 'amb' : 'regex'; }
    return 'regex';
  };
  const open = (ch, k, isBad) => { S.push({ ch, at: k, bad: isBad }); if (isBad) bad++; };
  const close = () => { const o = S.pop(); if (o.bad) bad--; return o; };
  const template = (j) => { // j is just past '`' or the closing '}'; returns {e, sub}
    for (;;) {
      charge(1);
      if (j >= n) stop('unterminated');
      const c = src.charCodeAt(j);
      if (c === 92) { j++; if (j < n && isLT(src.charCodeAt(j))) j = lt(j); else j++; } else if (c === 96) return { e: j + 1, sub: false };
      else if (c === 36 && src.charCodeAt(j + 1) === 123) return { e: j + 2, sub: true };
      else if (isLT(c)) j = lt(j); else j++;
    }
  };
  if (src.startsWith('#!')) while (i < n && !isLT(src.charCodeAt(i))) { charge(1); i++; }
  while (i < n) {
    charge(1);
    const c = src.charCodeAt(i);
    if (isLT(c)) { i = lt(i); continue; }
    if (isWS(c)) { i++; continue; }
    if (c > 127) stop('ambiguous_lex');
    if (c === 47) { // '/'
      const d = src.charCodeAt(i + 1);
      if (d === 47) { i += 2; while (i < n && !isLT(src.charCodeAt(i))) { charge(1); i++; } continue; }
      if (d === 42) {
        const l0 = line; i += 2;
        for (;;) { charge(1); if (i >= n) throw new Stop('unterminated', l0); const e = src.charCodeAt(i); if (e === 42 && src.charCodeAt(i + 1) === 47) { i += 2; break; } i = isLT(e) ? lt(i) : i + 1; }
        continue;
      }
      const md = mode();
      if (md === 'amb') stop('ambiguous_lex');
      if (md === 'div') { const v = d === 61 ? '/=' : '/'; push('p', v, i, i + v.length); i += v.length; continue; }
      let j = i + 1, cls = false;
      for (;;) {
        charge(1);
        if (j >= n || isLT(src.charCodeAt(j))) stop('unterminated');
        const e = src.charCodeAt(j);
        if (e === 92) { if (j + 1 >= n || isLT(src.charCodeAt(j + 1))) stop('unterminated'); j += 2; continue; }
        if (e === 91) cls = true; else if (e === 93) cls = false; else if (e === 47 && !cls) { j++; break; }
        j++;
      }
      while (j < n && src.charCodeAt(j) >= 97 && src.charCodeAt(j) <= 122) { charge(1); j++; }
      push('re', '', i, j); i = j; continue;
    }
    if (c === 39 || c === 34) {
      let j = i + 1; const l0 = line;
      for (;;) {
        charge(1);
        if (j >= n) stop('unterminated');
        const e = src.charCodeAt(j);
        if (e === c) { j++; break; }
        if (e === 92) { j++; if (j < n && isLT(src.charCodeAt(j))) j = lt(j); else j++; continue; }
        if (e === 10 || e === 13) stop('unterminated');
        j++;
      }
      push('str', '', i, j, l0); i = j; continue;
    }
    if (c === 96 || (c === 125 && S.length && S[S.length - 1].ch === 'tpl')) {
      const l0 = line, head = c === 96, r = template(i + 1);
      const k = push(head ? (r.sub ? 'tplh' : 'tpl') : (r.sub ? 'tplm' : 'tplt'), '', i, r.e, l0);
      if (head && r.sub) { if (++tplDepth > LIMITS.maxTemplateDepth) stop('ambiguous_lex'); open('tpl', k, true); }
      if (!head && !r.sub) { const o = close(); tplDepth--; T[o.at].m = k; }
      i = r.e; continue;
    }
    if (c === 40 || c === 91 || c === 123) {
      const ch = src[i], k0 = T.length;
      // a `(` frame is allowed by R5 only when it opens a describe/suite call at statement position
      const prev = T[k0 - 1], before = k0 - 2;
      const group = c === 40 && prev && prev.t === 'id' && GROUPS.has(prev.v) && (before < 0 || sig(before, ';') || sig(before, '{') || sig(before, '}'));
      if (c === 40 && prev && prev.t === 'id' && prev.v === 'await' && k0 > 1 && T[k0 - 2].t === 'id' && T[k0 - 2].v === 'for') stop('ambiguous_lex'); // a `for await (` header
      const control = c === 40 && prev && prev.t === 'id' && CONTROL_KW.has(prev.v) && !afterDot(k0 - 1);
      const k = push('p', ch, i, i + 1); T[k].control = control;
      open(ch, k, c === 40 && !group); i++; continue;
    }
    if (c === 41 || c === 93 || c === 125) {
      const want = c === 41 ? '(' : c === 93 ? '[' : '{';
      if (!S.length || S[S.length - 1].ch !== want) stop('ambiguous_lex');
      const o = close(), k = push('p', src[i], i, i + 1);
      T[o.at].m = k; T[k].open = o.at; i++; continue;
    }
    if (isDigit(c) || (c === 46 && isDigit(src.charCodeAt(i + 1)))) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(src), e = i + m[0].length;
      charge(m[0].length);
      if (e < n && (isIdPart(src.charCodeAt(e)) || src.charCodeAt(e) === 92)) stop('ambiguous_lex');
      push('num', '', i, e); i = e; continue;
    }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdPart(src.charCodeAt(j))) { charge(1); j++; }
      if (src.charCodeAt(j) === 92) stop('ambiguous_lex');
      push('id', src.slice(i, j), i, j); i = j; continue;
    }
    if (c === 60) { // '<'
      if (src.startsWith('<!--', i)) stop('ambiguous_lex');
      if (mode() !== 'div') stop('jsx_suspect');
      push('p', '<', i, i + 1); i++; continue;
    }
    if ((c === 43 || c === 45) && src.charCodeAt(i + 1) === c) {
      if (c === 45 && src.charCodeAt(i + 2) === 62) stop('ambiguous_lex');
      push('p', c === 43 ? '++' : '--', i, i + 2); i += 2; continue;
    }
    if (c === 63 && src.charCodeAt(i + 1) === 46 && !isDigit(src.charCodeAt(i + 2))) { push('p', '?.', i, i + 2); i += 2; continue; }
    if (c === 61 && src.charCodeAt(i + 1) === 62) { push('p', '=>', i, i + 2); i += 2; continue; }
    if (c === 46 && src.startsWith('...', i)) { push('p', '...', i, i + 3); i += 3; continue; }
    if (PUNCT.has(src[i])) { push('p', src[i], i, i + 1); i++; continue; }
    stop('ambiguous_lex'); // `\`, `#`, a control character, or any other ASCII outside the grammar
  }
  if (S.length) stop('unterminated');
  return T;
}

/** The recogniser: the first F-rule violation in token order voids the file; otherwise the counted R1-R5 calls. */
function recognise(T, src, runnerModules, charge) {
  const n = T.length;
  const isP = (k, v) => k >= 0 && k < n && T[k].t === 'p' && T[k].v === v;
  const isId = (k, v) => k >= 0 && k < n && T[k].t === 'id' && (v === undefined || T[k].v === v);
  const stmt = (k) => k < 0 || isP(k, ';') || isP(k, '{') || isP(k, '}');
  const raw = (k) => src.slice(T[k].s + 1, T[k].e - 1);
  const allowed = new Set();
  // F2 exception: `import [test][,] [{ a, b }] from '<runner module>'` with exact (un-aliased) specifiers
  for (let i = 0; i < n; i++) {
    charge(1);
    if (!isId(i, 'import') || !stmt(i - 1)) continue;
    let j = i + 1; const names = [];
    if (isId(j) && !isId(j, 'from')) { if (T[j].v !== 'test' && ROOTS.has(T[j].v)) continue; names.push(j); j++; if (isP(j, ',')) j++; else if (!isId(j, 'from')) continue; }
    if (isP(j, '{')) {
      j++;
      while (isId(j)) { charge(1); if (isId(j + 1, 'as')) { if (ROOTS.has(T[j].v) || ROOTS.has(T[j + 2]?.v)) break; j += 3; } else { names.push(j); j++; } if (isP(j, ',')) j++; else break; }
      if (!isP(j, '}')) continue;
      j++;
    }
    if (!isId(j, 'from') || T[j + 1]?.t !== 'str' || !runnerModules.includes(raw(j + 1))) continue;
    for (const k of names) allowed.add(k);
  }
  const args = (p) => { // the top-level argument ranges [s, e) of the call opened at p; a trailing comma adds no argument
    const out = [], q = T[p].m;
    let s = p + 1;
    for (let k = s; k < q;) {
      charge(1);
      if (isP(k, ',')) { out.push([s, k]); s = k + 1; k++; } else k = T[k].m > k ? T[k].m + 1 : k + 1;
    }
    if (s < q || out.length === 0) out.push([s, q]);
    return out;
  };
  const fnLiteral = ([s, e]) => { // the WHOLE argument is one function literal: `[async] function[*] [name](...) {...}` or an arrow
    let j = s;
    if (isId(j, 'async') && !isP(j + 1, '=>')) j++;
    if (isId(j, 'function')) {
      j++; if (isP(j, '*')) j++; if (isId(j)) j++;
      if (!isP(j, '(')) return false;
      j = T[j].m + 1;
      return isP(j, '{') && T[j].m === e - 1;
    }
    if (isP(j, '(')) j = T[j].m + 1; else if (isId(j) && !AMBIG_KW.has(T[j].v)) j++; else return false;
    if (!isP(j, '=>') || j + 1 >= e) return false;
    return !isP(j + 1, '{') || T[j + 1].m === e - 1; // a block body must end the argument; a concise body is the rest of it
  };
  const literal = ([s, e]) => s + 1 === e && (T[s].t === 'str' || T[s].t === 'tpl');
  const groupTitle = ([s, e]) => literal([s, e]) || (T[s].t === 'tplh' && T[s].m === e - 1);
  const calls = [], counts = { counted_calls: 0, marked_calls: 0, unknown_markers: 0, dynamic_titles: 0, rejected_signatures: 0, option_scoped: 0 };
  const scoped = []; // ends of open describe/suite calls whose arguments are not exactly (title, callback)
  for (let i = 0; i < n; i++) {
    charge(1);
    while (scoped.length && scoped[scoped.length - 1] < i) scoped.pop();
    const k = T[i];
    if (k.t !== 'id') continue;
    if (X_IDS.has(k.v)) throw new Stop('skip_form', k.line);
    const prop = isP(i - 1, '.') || isP(i - 1, '?.');
    if (SCOPE_IDS.has(k.v) && !prop) throw new Stop('dynamic_scope', k.line);
    if (!ROOTS.has(k.v)) continue;
    if ((isP(i + 1, '.') || isP(i + 1, '?.')) && isId(i + 2) && F1_MEMBERS.has(T[i + 2].v)) throw new Stop('skip_form', k.line);
    if (prop && isP(i + 1, '=')) throw new Stop('dynamic_scope', k.line); // `globalThis.test = ...` rebinds the runner global
    if (prop || allowed.has(i)) continue;
    if (!stmt(i - 1) || !isP(i + 1, '(') || k.bad !== 0) throw new Stop('ambiguous_callee', k.line);
    const p = i + 1, list = args(p);
    if (GROUPS.has(k.v)) {
      if (!(list.length === 2 && groupTitle(list[0]) && fnLiteral(list[1]))) scoped.push(T[p].m);
      continue;
    }
    if (!(list.length === 2 && fnLiteral(list[1]))) { counts.rejected_signatures++; continue; }
    if (!literal(list[0])) { counts.dynamic_titles++; continue; }
    if (scoped.length) { counts.option_scoped++; continue; }
    const a = list[0][0], title = raw(a), markers = [];
    charge(title.length);
    for (const m of title.matchAll(MARKER)) {
      const v = `${m[1]}:${m[2]}`;
      if (!(m[1] === 'kind' ? KIND_ID : ITEM_ID).test(m[2])) counts.unknown_markers++;
      else if (!markers.includes(v)) { charge(markers.length); markers.push(v); }
    }
    counts.counted_calls++;
    if (markers.length) counts.marked_calls++;
    calls.push({ line: T[a].line, markers, title_sha256: createHash('sha256').update(title.replace(/\r\n?/g, '\n'), 'utf8').digest('hex') });
  }
  return { calls, counts };
}

const own = (o, key) => { // own data property only: never a getter, a proxy trap or an inherited value (L6)
  const d = Object.getOwnPropertyDescriptor(o, key);
  if (d === undefined) return undefined;
  if (!('value' in d)) throw new Error('accessor');
  return d.value;
};
const isPlain = (o) => o !== null && typeof o === 'object' && !types.isProxy(o) && !Array.isArray(o);

function readOptions(opts) {
  if (!isPlain(opts)) throw new Error('options');
  const path = own(opts, 'path'), mods = own(opts, 'runnerModules'), lim = own(opts, 'limits');
  if (typeof path !== 'string' || path.length === 0 || path.length > 4096) throw new Error('path');
  const runnerModules = [...RUNNER_MODULES];
  if (mods !== undefined) {
    if (!Array.isArray(mods) || types.isProxy(mods) || mods.length > 64) throw new Error('runnerModules');
    for (let i = 0; i < mods.length; i++) { const m = own(mods, String(i)); if (typeof m !== 'string' || m.length === 0 || m.length > 256) throw new Error('module'); runnerModules.push(m); }
  }
  let maxBytes = LIMITS.maxBytes, maxSteps = null;
  if (lim !== undefined) {
    if (!isPlain(lim)) throw new Error('limits');
    const b = own(lim, 'maxBytes'), s = own(lim, 'maxSteps');
    if (b !== undefined) { if (!Number.isSafeInteger(b) || b < 0 || b > LIMITS.maxBytes) throw new Error('maxBytes'); maxBytes = b; }
    if (s !== undefined) { if (!Number.isSafeInteger(s) || s < 0) throw new Error('maxSteps'); maxSteps = s; }
  }
  return { path, runnerModules, maxBytes, maxSteps };
}

function extensionOf(path) {
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1), dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot) : '';
}

const result = (status, reason, line, steps, calls = [], counts = null) => ({ status, reason, line, calls, counts, steps });

/** Scan one test file. Never throws: every outcome is a typed result whose strings are enums, ids or hex digests. */
export function scanTitles(bytes, opts) {
  let o;
  try {
    if (!(bytes instanceof Uint8Array) || types.isProxy(bytes)) throw new Error('bytes');
    o = readOptions(opts);
  } catch { return result('unscannable', 'input_invalid', null, 0); }
  if (!EXTENSIONS.includes(extensionOf(o.path))) return result('unsupported', 'unsupported_ext', null, 0);
  if (bytes.length > o.maxBytes) return result('unscannable', 'evidence_budget_exceeded', null, 0);
  let src;
  try { src = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return result('unscannable', 'unscannable_utf8', null, 0); }
  const cap = Math.min(LIMITS.stepsPerByte * bytes.length, o.maxSteps ?? Infinity);
  let steps = 0;
  const charge = (k) => { if (steps + k > cap) { steps = cap + 1; throw new Stop('evidence_budget_exceeded', null); } steps += k; };
  try {
    const T = lex(src, charge);
    const { calls, counts } = recognise(T, src, o.runnerModules, charge);
    return result('ok', null, null, steps, calls, counts);
  } catch (e) {
    if (e instanceof Stop) return result(UNSUPPORTED.has(e.reason) ? 'unsupported' : 'unscannable', e.reason, e.line, Math.min(steps, cap + 1));
    return result('unscannable', 'scanner_error', null, Math.min(steps, cap + 1));
  }
}
