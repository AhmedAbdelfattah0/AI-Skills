/**
 * S-01b2 P1 title scanner: every guard of test-titles.mjs has a named mutant. Each mutant is a COPY of the two files the tagged
 * tests load (test-titles.mjs and test-titles.test.mjs; the copy is proven complete by checking their static imports) in a temp
 * dir, with ONE guard patched by an exact string replacement that must match exactly once after CRLF became LF (a Windows
 * checkout anchors the same, L10). The repo is never edited.
 *
 * A mutant counts as KILLED only when (1) the patched module still imports (else INVALID: a load or syntax failure proves
 * nothing), and (2) an [R#] test fails with an assertion failure (`ERR_ASSERTION`), not a thrown TypeError or a timeout (L1).
 * The unpatched copy (the control) must pass every [R#] test, or the results mean nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILES = ['test-titles.mjs', 'test-titles.test.mjs'];
const CONCURRENCY = 4;
const RUN_TIMEOUT_MS = 5 * 60 * 1000;

/** The guards: the exact text replaced in test-titles.mjs. */
const GUARDS = [
  { name: 'a line comment ends only at LF (U+2028 does not end it)', from: "if (d === 47) { i += 2; while (i < n && !isLT(src.charCodeAt(i)))", to: 'if (d === 47) { i += 2; while (i < n && src.charCodeAt(i) !== 10)' },
  { name: 'a regex class does not hide `/`', from: 'if (e === 91) cls = true;', to: 'if (false) cls = true;' },
  { name: 'a string escape is not honoured', from: "if (e === 92) { j++; if (j < n && isLT(src.charCodeAt(j))) j = lt(j); else j++; continue; }\n        if (e === 10", to: 'if (e === 10' },
  { name: 'a raw line terminator inside a string is accepted', from: "if (e === 10 || e === 13) stop('unterminated');", to: '' },
  { name: 'a template substitution is template text', from: 'else if (c === 36 && src.charCodeAt(j + 1) === 123) return', to: 'else if (false) return' },
  { name: 'template nesting is uncapped', from: "if (++tplDepth > LIMITS.maxTemplateDepth) stop('ambiguous_lex');", to: '++tplDepth;' },
  { name: 'a `/` after a restricted keyword is guessed, not refused', from: 'if (AMBIG_KW.has(a.v) || ', to: 'if (false || ' },
  { name: 'a `/` after `break|continue <label>` is division', from: " || (k > 0 && T[k - 1].t === 'id' && (T[k - 1].v === 'break' || T[k - 1].v === 'continue'))", to: '' },
  { name: 'a keyword after `.` is not a property name', from: "if (afterDot(k)) return 'div';\n      if (AMBIG_KW", to: 'if (AMBIG_KW' },
  { name: 'a `/` after `}` is not ambiguous', from: "if (a.v === '}' || a.v === '++'", to: "if (a.v === '++'" },
  { name: 'a `/` after a postfix `!` is a regex', from: "return j > 0 && operandEnd(j - 1) ? 'amb' : 'regex';", to: "return 'regex';" },
  { name: 'a control-header `)` reads as division', from: "return T[a.open].control ? 'regex' : 'div';", to: "return 'div';" },
  { name: 'a `for await (` header is allowed', from: "if (c === 40 && prev && prev.t === 'id' && prev.v === 'await'", to: "if (false && c === 40 && prev && prev.t === 'id' && prev.v === 'await'" },
  { name: 'an operand-position `<` is allowed (JSX)', from: "if (mode() !== 'div') stop('jsx_suspect');", to: '' },
  { name: '`<!--` in code is allowed', from: "if (src.startsWith('<!--', i)) stop('ambiguous_lex');", to: '' },
  { name: '`-->` in code is allowed', from: "if (c === 45 && src.charCodeAt(i + 2) === 62) stop('ambiguous_lex');", to: '' },
  { name: 'non-ASCII outside literals is skipped', from: "if (c > 127) stop('ambiguous_lex');", to: 'if (c > 127) { i++; continue; }' },
  { name: 'a bracket open at EOF is accepted', from: "if (S.length) stop('unterminated');", to: '' },
  { name: 'every `(` frame is allowed (R5)', from: 'open(ch, k, c === 40 && !group);', to: 'open(ch, k, false);' },
  { name: 'a template-expression frame is allowed (R5)', from: "open('tpl', k, true);", to: "open('tpl', k, false);" },
  { name: 'statement position is not required (R1)', from: "if (!stmt(i - 1) || !isP(i + 1, '(') || k.bad !== 0)", to: "if (!isP(i + 1, '(') || k.bad !== 0)" },
  { name: 'enclosing frames are not checked (R5)', from: "if (!stmt(i - 1) || !isP(i + 1, '(') || k.bad !== 0)", to: "if (!stmt(i - 1) || !isP(i + 1, '('))" },
  { name: 'x/f-prefixed identifiers are not skip forms (F1a)', from: "if (X_IDS.has(k.v)) throw new Stop('skip_form', k.line);", to: '' },
  { name: 'skip members are not skip forms (F1b)', from: "if ((isP(i + 1, '.') || isP(i + 1, '?.')) && isId(i + 2) && F1_MEMBERS.has(T[i + 2].v)) throw new Stop('skip_form', k.line);", to: '' },
  { name: 'with/eval/Function are allowed (F3)', from: "if (SCOPE_IDS.has(k.v) && !prop) throw new Stop('dynamic_scope', k.line);", to: '' },
  { name: 'a runner property assignment is allowed (F3)', from: "if (prop && isP(i + 1, '=')) throw new Stop('dynamic_scope', k.line);", to: '' },
  { name: 'any import module is a runner module (F2)', from: '!runnerModules.includes(raw(j + 1))', to: 'false' },
  { name: 'any root may be a default import (F2)', from: "if (T[j].v !== 'test' && ROOTS.has(T[j].v)) continue;", to: '' },
  { name: 'extra arguments are allowed (R4)', from: 'if (!(list.length === 2 && fnLiteral(list[1])))', to: 'if (!(list.length >= 2 && fnLiteral(list[1])))' },
  { name: 'the callback need not be a function literal (R6)', from: 'if (!(list.length === 2 && fnLiteral(list[1])))', to: 'if (!(list.length === 2))' },
  { name: 'a function body need not end the argument (R6)', from: "return isP(j, '{') && T[j].m === e - 1;", to: "return isP(j, '{');" },
  { name: 'an arrow block body need not end the argument (R6)', from: "return !isP(j + 1, '{') || T[j + 1].m === e - 1;", to: 'return true;' },
  { name: 'a group signature does not scope its calls (R7)', from: 'if (!(list.length === 2 && groupTitle(list[0]) && fnLiteral(list[1]))) scoped.push(T[p].m);', to: '' },
  { name: 'a title need not be one token (R3)', from: "const literal = ([s, e]) => s + 1 === e && (T[s].t === 'str' || T[s].t === 'tpl');", to: "const literal = ([s, e]) => (T[s].t === 'str' || T[s].t === 'tpl');" },
  { name: 'a template with substitutions is a title (R3)', from: "const literal = ([s, e]) => s + 1 === e && (T[s].t === 'str' || T[s].t === 'tpl');", to: "const literal = ([s, e]) => T[e - 1].t === 'tplt' || (s + 1 === e && (T[s].t === 'str' || T[s].t === 'tpl'));" },
  { name: 'marker ids are not validated (M1)', from: "if (!(m[1] === 'kind' ? KIND_ID : ITEM_ID).test(m[2])) counts.unknown_markers++;\n      else if", to: 'if (false) counts.unknown_markers++;\n      else if' },
  { name: 'markers are case-insensitive (M1)', from: '{0,63})\\]/g;', to: '{0,63})\\]/gi;' },
  { name: 'the title digest is line-ending dependent (M2)', from: "title.replace(/\\r\\n?/g, '\\n')", to: 'title' },
  { name: 'charged steps are not capped (X4)', from: 'if (steps + k > cap)', to: 'if (false)' },
  { name: 'the per-file byte cap is not applied (X4)', from: 'if (bytes.length > o.maxBytes)', to: 'if (false)' },
  { name: 'UTF-8 decoding is lenient (X2)', from: '{ fatal: true }', to: '{ fatal: false }' },
  { name: 'every extension is scanned (X1)', from: 'if (!EXTENSIONS.includes(extensionOf(o.path)))', to: 'if (false)' },
  { name: 'an accessor option is read as absent (L6)', from: "if (!('value' in d)) throw new Error('accessor');", to: '' },
];

const lf = (s) => s.replace(/\r\n/g, '\n');
const run = (args, cwd) => new Promise((resolve) => {
  const { NODE_TEST_CONTEXT: _nested, ...env } = process.env;
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', timedOut = false;
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, RUN_TIMEOUT_MS);
  child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, timedOut }); });
});

/** Copy the two files, apply `mutant` (null: the control), run the tagged tests. */
async function runMutant(t, mutant) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'test-titles-mutant-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const f of FILES) writeFileSync(join(dir, f), lf(readFileSync(join(HERE, f), 'utf8')));
  if (mutant) {
    const file = join(dir, 'test-titles.mjs'), text = readFileSync(file, 'utf8');
    assert.equal(text.split(mutant.from).length, 2, `mutant "${mutant.name}": its target text occurs exactly once`);
    writeFileSync(file, text.replace(mutant.from, () => mutant.to));
    const load = await run(['--input-type=module', '-e', "await import('./test-titles.mjs')"], dir);
    if (load.code !== 0) return { invalid: true, tail: load.out.slice(-800) };
  }
  const r = await run(['--test', '--test-reporter=tap', '--test-name-pattern=\\[R\\d+\\]', 'test-titles.test.mjs'], dir);
  const blocks = r.out.split(/^(?=\s*(?:not )?ok \d+ - )/m).filter((b) => /^\s*not ok \d+ - /.test(b));
  const killers = blocks.filter((b) => /^\s*not ok \d+ - \[R\d+\]/.test(b) && /code: 'ERR_ASSERTION'/.test(b)).map((b) => /\[R\d+\]/.exec(b)[0]);
  const passed = Number(/^# pass (\d+)$/m.exec(r.out)?.[1] ?? 0);
  return { invalid: false, ...r, killers, passed, tail: r.out.slice(-1500) };
}

test('title scanner mutation: the control passes, every guard mutant loads and is killed by an assertion in an [R#] test', { timeout: 20 * 60 * 1000 }, async (t) => {
  // the copy is complete: the two files statically import only node: builtins and each other
  for (const f of FILES) {
    const specs = [...readFileSync(join(HERE, f), 'utf8').matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    assert.deepEqual(specs.filter((s) => !s.startsWith('node:') && !FILES.includes(s.replace(/^\.\//, ''))), [], `${f} imports only node: builtins and the copied files`);
  }
  assert.equal(new Set(GUARDS.map((m) => `${m.from}\u0000${m.to}`)).size, GUARDS.length, 'mutants are distinct');
  for (const m of GUARDS) assert.notEqual(m.from, m.to, m.name);
  const jobs = [null, ...GUARDS], results = [];
  for (let i = 0; i < jobs.length; i += CONCURRENCY) results.push(...await Promise.all(jobs.slice(i, i + CONCURRENCY).map(async (m) => ({ m, ...await runMutant(t, m) }))));
  const [control, ...mutants] = results;
  assert.equal(control.code, 0, `the control passes every tagged test:\n${control.tail}`);
  assert.ok(control.passed >= 10, `the control ran the tagged tests (${control.passed})`);
  for (const r of mutants) t.diagnostic(JSON.stringify({ name: r.m.name, invalid: r.invalid, exit: r.code, killed_by: [...new Set(r.killers ?? [])] }));
  assert.deepEqual(mutants.filter((r) => r.invalid).map((r) => r.m.name), [], 'no mutant is INVALID (every patched module loads)');
  const survivors = mutants.filter((r) => r.timedOut || r.code === 0 || !r.killers.length).map((r) => `${r.m.name} (exit ${r.code})`);
  assert.deepEqual(survivors, [], 'every mutant is killed by an assertion failure');
  t.diagnostic(`mutants ${mutants.length}, all killed by assertions`);
});
