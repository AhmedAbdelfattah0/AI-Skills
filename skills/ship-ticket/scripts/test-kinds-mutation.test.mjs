/**
 * S-01b fail-closed recognition: every guard of the one marker recogniser in test-kinds.mjs has a named mutant. Each mutant
 * is a COPY of the layout the tests import (skills/ship-ticket/scripts and references, skills/vapt) in a temp dir, with ONE
 * guard patched (in test-kinds.mjs, or security-plan.mjs where named) by an exact string replacement (hand-named guards, plus two generated per MARKERS row) that must match
 * exactly once after CRLF became LF (a Windows checkout anchors the same). The repo is never edited.
 *
 * A mutant counts as KILLED only when (1) the patched module still imports (else INVALID: a load or syntax failure proves
 * nothing), and (2) an [R#] test fails with an assertion failure (`ERR_ASSERTION`), not a thrown
 * TypeError or a timeout. The unpatched copy (the control) must pass every [R#] test, or the results mean nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS = join(HERE, '..', '..');
const TEST_FILE = 'test-kinds.test.mjs';
const CONCURRENCY = 4;
const RUN_TIMEOUT_MS = 5 * 60 * 1000;

/** The hand-named guards: the exact text replaced in test-kinds.mjs. */
const GUARDS = [
  { name: 'detection skips NFKC (fullwidth letters read as absent)', from: ".normalize('NFKC').replace(INVISIBLE, '')", to: ".replace(INVISIBLE, '')" },
  { name: 'detection keeps invisible characters (a zero-width space hides a token)', from: ".replace(INVISIBLE, '').replace(INLINE_TAG", to: '.replace(INLINE_TAG' },
  { name: 'only \\p{Cf} is invisible (a variation selector hides a token)', from: '/[\\p{Cf}\\p{Default_Ignorable_Code_Point}]/gu', to: '/[\\p{Cf}]/gu' },
  { name: 'a Markdown backslash escape hides a token', from: ".replace(MD_ESCAPE, '')", to: '' },
  { name: 'detection is case-sensitive', from: '.toLowerCase().replace(FOLD_DASH', to: '.replace(FOLD_DASH' },
  { name: 'detection does not fold dashes and underscores', from: ".replace(FOLD_DASH, '-');", to: ';' },
  { name: 'only the U+2010-2015 dashes fold (U+2212, U+2E3A read as absent)', from: '/[_\\p{Pd}\\u2212]/gu', to: '/[_\\u2010-\\u2015]/gu' },
  { name: 'a token needs exactly one dash between its words', from: "const JOIN = '\\\\\s*-+\\\\\s*';", to: "const JOIN = '-';" },
  { name: 'token-bearing lines are never checked against the strict parse', from: 'for (const m of MARKERS) if (carriers(text, m).some((l) => !m.valid(l))) errors.push(m.code);', to: '' },
  { name: 'a doubled colon after a plan key reads as the key', from: '${key}:(?!:)(.*)$', to: '${key}:(.*)$' },
  { name: 'a security-pairs line alone does not demand the verified block', from: " || carriers(text, MARKER['security-pairs']).length", to: '' },
  { name: 'a malformed RUN-STATE is scanned as empty for opt-in', from: 'carriers(text ?? planText, m)', to: "carriers(text ?? '', m)" },
  { name: 'a malformed RUN-STATE in an opted-in plan reads as not declared', from: "if (text === null) return (errors.push('run_state_invalid'), out('refused'));", to: "if (text === null) return out('not_declared');" },
  { name: 'the region is cut at the first BEGIN substring, not at the marker line', from: "return [...ls.slice(0, at[0]), ...ls.slice(at[1] + 1)].join('\\n');", to: 'return t.slice(0, t.indexOf(RS_BEGIN)) + t.slice(t.indexOf(RS_END) + RS_END.length);' },
  { name: 'an event record naming a marker counts as a marker line', from: "if (m.event && l.trimStart().startsWith('{')) return false;", to: '' },
  { name: 'security-plan token: the comment-opener form is dropped', from: '`<!-+\\\\s*security${JOIN}plan|', to: '`' },
  { name: 'security-plan token: the key-and-colon form is dropped', from: '|security${JOIN}plan\\\\s*[:=]|', to: '|' },
  { name: 'security-plan token: the "selection_digest" backstop is dropped', from: '|"selection-digest"\\\\s*:`', to: '`' },
  { name: 'security-pairs token: only `sha` may follow', from: 'pairs\\\\s*(?:sha|[:=])', to: 'pairs\\\\s*(?:sha)' },
  { name: 'security-pairs token: only a colon may follow', from: 'pairs\\\\s*(?:sha|[:=])', to: 'pairs\\\\s*(?:[:=])' },
  { name: 'run-state token: only a colon between the words and BEGIN/END', from: 'state[\\\\s:=]*(?:begin|end)', to: 'state:(?:begin|end)' },
  { name: 'plan-key token: the whitespace-before-colon form is dropped', from: '|${a}\\\\s+${b}[^a-z0-9]{0,8}:', to: '' },
  { name: 'plan-key token: no decoration between the words and the colon', from: '${b}[^a-z0-9]{0,8}:', to: '${b}\\\\s*:' },
  { name: 'FR-1a: a plan key is not anchored to the start of its line (a prose mention opts in)', from: "const KEY_LEAD = '^(?:[^\\\\p{L}\\\\p{N}]|\\\\d{1,3}[.)])*';", to: 'const KEY_LEAD = EDGE;' },
  { name: 'a token may start inside a word (no boundary)', from: "const EDGE = '(?<![a-z0-9])';", to: "const EDGE = '';" },
  { name: 'HTML character references are not decoded', from: 'decodeEntities(l).normalize', to: 'l.normalize' },
  { name: 'inline HTML tags are not removed', from: ".replace(INLINE_TAG, '')", to: '' },
  { name: 'the block is parsed with a second RUN-STATE cut (no alreadyCut option)', from: 'parsePlanSecurityBlock(text, { alreadyCut: true })', to: 'parsePlanSecurityBlock(text)' },
  { name: 'the block reading is not compared with the engine reading of the raw plan', from: 'if ((blockToken && !block) || JSON.stringify(engineBlock) !== JSON.stringify(block))', to: 'if (blockToken && !block)' },
  { name: 'the two readings are compared only when the narrative carries a security token (Opus M-1)', from: 'if ((blockToken && !block) || JSON.stringify(engineBlock) !== JSON.stringify(block))', to: 'if (blockToken && (!block || JSON.stringify(engineBlock) !== JSON.stringify(block)))' },
  { name: 'a security token in the narrative does not demand a verified block', from: 'if ((blockToken && !block) || JSON.stringify(engineBlock) !== JSON.stringify(block))', to: 'if (JSON.stringify(engineBlock) !== JSON.stringify(block))' },
  { name: 'security-plan.mjs ignores the alreadyCut option (always re-cuts)', file: 'security-plan.mjs', from: 'if (opts?.alreadyCut === true) {', to: 'if (false) {' },
  { name: 'security-plan.mjs alreadyCut reads uncut text (no marker-line guard)', file: 'security-plan.mjs', from: "if (planText.split('\\n').some((l) => l.trim() === RS_BEGIN || l.trim() === RS_END)) return null;", to: '' },
  { name: 'benign script names are not removed before detection', from: "m.benign ? n.replace(m.benign, ' ') : n", to: 'n' },
  { name: 'the reassess record line is not recognised', from: 'const reassessLine = (l) => /^risk_reassess:', to: 'const reassessLine = (l) => false && /^risk_reassess:' },
];
/** Two generated mutants per MARKERS row: its strict test accepts every line, and its token never matches. */
function rowMutants(src) {
  return src.split('\n').filter((l) => /^ {2}f\(\{ id: '[a-z-]+', token: /.test(l)).flatMap((row) => {
    const id = /id: '([a-z-]+)'/.exec(row)[1];
    return [{ name: `row ${id}: valid accepts every line`, from: row, to: row.replace(/valid: .*$/, 'valid: () => true }),') },
      { name: `row ${id}: token never matches`, from: row, to: row.replace(/token: .*?, code: /, 'token: /(?!)/, code: ') }];
  });
}
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

/** Copy the layout, apply `mutant` (null: the control), run the tagged tests. */
async function runMutant(t, mutant) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'test-kinds-mutant-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'skills', 'ship-ticket', 'scripts');
  mkdirSync(dir, { recursive: true });
  cpSync(HERE, dir, { recursive: true });
  cpSync(join(SKILLS, 'ship-ticket', 'references'), join(root, 'skills', 'ship-ticket', 'references'), { recursive: true });
  cpSync(join(SKILLS, 'vapt'), join(root, 'skills', 'vapt'), { recursive: true });
  if (mutant) {
    const file = join(dir, mutant.file ?? 'test-kinds.mjs'), text = lf(readFileSync(file, 'utf8'));
    assert.equal(text.split(mutant.from).length, 2, `mutant "${mutant.name}": its target text occurs exactly once`);
    writeFileSync(file, text.replace(mutant.from, () => mutant.to));
    const load = await run(['--input-type=module', '-e', `await import('./${mutant.file ?? 'test-kinds.mjs'}')`], dir);
    if (load.code !== 0) return { invalid: true, tail: load.out.slice(-800) };
  }
  const r = await run(['--test', '--test-reporter=tap', '--test-name-pattern=\\[R\\d+\\]', TEST_FILE], dir);
  // the failure blocks of the TAP output: each `not ok` line up to the next test line
  const blocks = r.out.split(/^(?=\s*(?:not )?ok \d+ - )/m).filter((b) => /^\s*not ok \d+ - /.test(b));
  const killers = blocks.filter((b) => /^\s*not ok \d+ - \[R\d+\]/.test(b) && /code: 'ERR_ASSERTION'/.test(b)).map((b) => /\[R\d+\]/.exec(b)[0]);
  const passed = Number(/^# pass (\d+)$/m.exec(r.out)?.[1] ?? 0);
  return { invalid: false, ...r, killers, passed, tail: r.out.slice(-1500) };
}

test('fail-closed recognition mutation: the control passes, every guard and table-row mutant loads and is killed by an assertion in an [R#] test', { timeout: 20 * 60 * 1000 }, async (t) => {
  const src = lf(readFileSync(join(HERE, 'test-kinds.mjs'), 'utf8'));
  const rows = rowMutants(src);
  const { MARKERS } = await import('./test-kinds.mjs');
  assert.equal(rows.length, 2 * MARKERS.length, 'two generated mutants for every MARKERS row');
  const MUTANTS = [...GUARDS, ...rows];
  assert.equal(new Set(MUTANTS.map((m) => `${m.from}\u0000${m.to}`)).size, MUTANTS.length, 'mutants are distinct');
  for (const m of MUTANTS) assert.notEqual(m.from, m.to, m.name);
  const jobs = [null, ...MUTANTS], results = [];
  for (let i = 0; i < jobs.length; i += CONCURRENCY) results.push(...await Promise.all(jobs.slice(i, i + CONCURRENCY).map(async (m) => ({ m, ...await runMutant(t, m) }))));
  const [control, ...mutants] = results;
  assert.equal(control.code, 0, `the control passes every tagged test:\n${control.tail}`);
  assert.ok(control.passed >= 6, `the control ran the tagged tests (${control.passed})`);
  for (const r of mutants) t.diagnostic(JSON.stringify({ name: r.m.name, invalid: r.invalid, exit: r.code, killed_by: [...new Set(r.killers ?? [])] }));
  assert.deepEqual(mutants.filter((r) => r.invalid).map((r) => r.m.name), [], 'no mutant is INVALID (every patched module loads)');
  const survivors = mutants.filter((r) => r.timedOut || r.code === 0 || !r.killers.length).map((r) => `${r.m.name} (exit ${r.code})`);
  assert.deepEqual(survivors, [], 'every mutant is killed by an assertion failure');
  t.diagnostic(`mutants ${mutants.length} (guards ${GUARDS.length}, table rows ${rows.length}), all killed by assertions`);
});
