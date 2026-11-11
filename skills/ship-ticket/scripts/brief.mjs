#!/usr/bin/env node
/**
 * Worker brief builder and linter (AIS-BENCH-1 Wave 2). An orchestrator tool: it reads the approved
 * DAG, the plan and optional recon answers, and writes the prompt file a builder receives, so every
 * brief carries ownership, forbidden paths, required tests and the report block. Nothing in the
 * engine calls it and it changes no engine behavior.
 *
 * Adapted from strategy/coordination/handoff-templates.md at commit 8ae6164 of
 * msitarzewski/agency-agents, MIT, Copyright (c) 2025 AgentLand Contributors.
 *
 * CLI:
 *   brief.mjs build --dag <dag.json> --node <id> --plan <plan.md> [--recon <json>] [--notes <file>] --out <file>
 *   brief.mjs lint <brief>
 * Output is deterministic: no clock, no randomness, no absolute path. The last line is
 * `brief-digest sha256:<hex>`, the digest of everything above it after CRLF became LF. Dependency-free Node >= 18; the only repository import is the read-only
 * RISK_EVIDENCE table of harness.mjs.
 *
 * Exit codes: 0 success, 1 a failed lint or any other refused input (unknown node, plan without a
 * RUN-STATE block, unreadable file, invalid JSON, a refused --out), 2 a usage error or a DAG or recon
 * field that contains a newline, control character or backtick.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, lstatSync, statSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { RISK_EVIDENCE, isEntrypoint } from './harness.mjs';

export const SECTIONS = [
  'Task', 'Approved plan and digest', 'Ownership', 'Forbidden paths', 'Dependencies and reads',
  'Exclusive resources', 'Required tests', 'Reuse inventory', 'Acceptance ids', 'Notes', 'Worker rules', 'Report block',
];
/** Sections whose absence or emptiness makes `lint` fail. */
export const REQUIRED_SECTIONS = ['Ownership', 'Forbidden paths', 'Required tests', 'Reuse inventory', 'Report block'];

const RUN_STATE_BEGIN = '<!-- RUN-STATE:BEGIN -->';
const RUN_STATE_END = '<!-- RUN-STATE:END -->';
const DIGEST_LINE = /^brief-digest sha256:([0-9a-f]{64})$/;

const fail = (message) => Object.assign(new Error(message), { briefError: true });
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
/** Line ends only: CRLF and lone CR become LF. Backslashes in text are never rewritten. */
const normalise = (text) => String(text).replace(/\r\n?/g, '\n');
const oneLine = (text) => String(text).replace(/\s+/g, ' ').trim();
const bullets = (list, none) => (list.length ? list.map((x) => `- ${x}`) : [`- ${none}`]);
const code = (x) => `\`${x}\``;
const asList = (v) => (Array.isArray(v) ? v : []);

/**
 * Exactly the engine's planNarrativeDigest (engine-dag.mjs): sha256 of the raw plan text with everything
 * strictly between the RUN-STATE markers removed, markers kept. No line-end normalisation, so a CRLF plan
 * has a different digest than its LF twin, as in the engine. A plan without the markers is refused.
 */
export function planDigest(planText) {
  const b = planText.indexOf(RUN_STATE_BEGIN);
  const e = planText.indexOf(RUN_STATE_END);
  if (b < 0 || e < b) throw fail('plan_invalid: plan has no RUN-STATE block');
  return `sha256:${sha256(planText.slice(0, b + RUN_STATE_BEGIN.length) + planText.slice(e))}`;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** A structured field: a string with no control character (newline included); with `ticks`, no backtick either. */
function checked(field, value, { ticks = false } = {}) {
  if (typeof value !== 'string') throw refuse(field, 'must be a string');
  if (CONTROL.test(value)) throw refuse(field, 'contains a newline or other control character');
  if (ticks && value.includes('`')) throw refuse(field, 'contains a backtick');
  return value;
}
const refuse = (field, why) => Object.assign(new Error(`field ${field} ${why}`), { briefError: true, usage: true });
const checkedList = (field, list, opts) => asList(list).map((v, i) => checked(`${field}[${i}]`, v, opts));

/** Free text (a plan step, a recon answer, notes) as a quotation: every line starts with "> ", so it cannot open a section. */
const quote = (text) => normalise(text).split('\n').map((l) => `> ${l}`);

/** A path field as shown: separators become `/`; an absolute or parent-escaping path shows only its base name. */
function displayPath(p) {
  const posix = String(p).replace(/\\/g, '/');
  return isAbsolute(posix) || /^[A-Za-z]:/.test(posix) || posix.split('/').includes('..') ? basename(posix) : posix;
}

/** The Step cell of the plan's execution DAG row for `id`, or null. */
export function planStep(planText, id) {
  let stepCol = 2;
  for (const raw of normalise(planText).split('\n')) {
    if (!raw.trimStart().startsWith('|')) continue;
    const cells = raw.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    const header = cells.findIndex((c) => c.toLowerCase() === 'step');
    if (header >= 0 && cells[0].toLowerCase() === 'id') {
      stepCol = header;
      continue;
    }
    if (cells[0].replace(/`/g, '') === id && cells[stepCol]) return oneLine(cells[stepCol]);
  }
  return null;
}

function reuseLines(recon) {
  if (recon == null) return ['none recorded'];
  const answers = Array.isArray(recon) ? recon : asList(recon.answers);
  if (!answers.length) return ['none recorded'];
  const out = [];
  answers.forEach((a, i) => {
    const at = `recon[${i}]`;
    if (!a || typeof a !== 'object') throw fail('recon answers must be objects with question, answer, paths, signatures');
    // Free text is quoted ("> " on every line) like notes; code-quoted fields are checked.
    const free = (v, fallback) => oneLine(v === undefined || v === null || v === '' ? fallback : v);
    out.push(`- ${free(a.question, '(no question)')}${a.answer ? `: ${free(a.answer)}` : ''}`);
    for (const p of checkedList(`${at}.paths`, a.paths, { ticks: true })) out.push(`  - path: ${code(displayPath(p))}`);
    for (const x of checkedList(`${at}.signatures`, a.signatures, { ticks: true })) out.push(`  - signature: ${code(x)}`);
    for (const q of checkedList(`${at}.quoted_lines`, a.quoted_lines ?? a.quotedLines ?? a['quoted lines'], { ticks: true })) out.push(`  - quoted: ${code(q)}`);
    if (a.confidence) out.push(`  - confidence: ${free(a.confidence)}`);
  });
  return out.flatMap((l) => quote(l));
}

const WORKER_RULES = [
  'Do not commit, switch branches, install dependencies, run a whole-repository formatter or generator, or change an approved integration contract.',
  'The orchestrator owns shared seams, barriers, reconciliation and all Git operations.',
  'Write the failing test first when a RED spec is listed, and run it to see it fail before you write the code.',
  'Run only the test files listed under Required tests, never the whole suite, unless the brief says so.',
  'Never print or store a home directory path, user name or email address in any repository file.',
];

const REPORT_EXAMPLE = [
  '```ship-ticket-report',
  '{"tests":[{"cmd":"<command you ran>","result":"pass"}],"red_seen":[],"blockers":[],"needs_outside_ownership":[]}',
  '```',
];

/** Build the brief text (digest line included) for one DAG node. Throws a `briefError` on a refused input. */
export function buildBrief({ dag, nodeId, planText, planPath = 'plan.md', recon = null, notes = null }) {
  const nodes = asList(dag && dag.nodes);
  if (!nodes.length) throw fail('the DAG has no nodes');
  const node = nodes.find((n) => n && n.id === nodeId);
  if (!node) throw fail(`unknown node id "${nodeId}" (DAG nodes: ${nodes.map((n) => n && n.id).join(', ')})`);
  if (typeof planText !== 'string' || !planText.trim()) throw fail('the plan file is empty');

  const f = {
    id: checked('node.id', node.id, { ticks: true }),
    writes: checkedList('writes', node.writes, { ticks: true }),
    reads: checkedList('reads', node.reads, { ticks: true }),
    othersOwned: checkedList('othersOwned', node.othersOwned, { ticks: true }),
    deps: checkedList('deps', node.deps, { ticks: true }),
    resources: checkedList('resources', node.resources, { ticks: true }),
    checks: checkedList('checks', node.checks, { ticks: true }),
    evidence: checkedList('evidence', node.evidence, { ticks: true }),
    acceptance: checkedList('acceptance', node.acceptance, { ticks: true }),
    redSpecs: asList(node.redSpecs).map((r, i) => (typeof r === 'string'
      ? { file: checked(`redSpecs[${i}]`, r, { ticks: true }) }
      : { file: checked(`redSpecs[${i}].file`, r && r.file, { ticks: true }), name: r && r.name !== undefined ? checked(`redSpecs[${i}].name`, r.name) : undefined })),
  };
  const risk = checkedList('risk', node.risk);
  for (const k of ['phase', 'role', 'complexity', 'modelTier', 'unit']) if (node[k] !== undefined && node[k] !== null) checked(k, String(node[k]));
  checked('plan path', String(planPath));
  const step = planStep(planText, node.id);
  const evidenceKinds = [...new Set(risk.flatMap((l) => (Object.hasOwn(RISK_EVIDENCE, l) ? RISK_EVIDENCE[l] : [])))].sort();
  const taskFacts = [
    ['phase', node.phase], ['role', node.role], ['risk', risk.length ? risk.join(', ') : null],
    ['complexity', node.complexity], ['model tier', node.modelTier], ['unit', node.unit],
  ].filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k} ${v}`);

  const lines = [];
  const section = (name, body) => lines.push(`## ${name}`, '', ...body, '');

  lines.push(`# Brief for node ${code(f.id)}`, '');
  section('Task', [
    `Node ${code(f.id)}${taskFacts.length ? ` (${taskFacts.join('; ')})` : ''}.`,
    '',
    ...(step ? quote(step) : ['No execution DAG row for this node was found in the plan; the fields below define the task.']),
  ]);
  section('Approved plan and digest', [
    `Plan file: ${code(displayPath(planPath))}`,
    '',
    `plan-digest ${planDigest(planText)}`,
    '',
    'Work only inside the approved plan. If the plan and the code disagree, stop and report; do not improvise.',
  ]);
  section('Ownership', [
    'You may write only these paths:',
    '',
    ...bullets(f.writes.map((p) => code(displayPath(p))), 'none: this node writes no files'),
  ]);
  section('Forbidden paths', [
    ...bullets(f.othersOwned.map((p) => `${code(displayPath(p))} (owned by another worker)`), 'none declared by name; every path outside Ownership is still forbidden'),
    '',
    'Other workers are active in this checkout. Do not revert their work. If you need to edit a path outside your ownership, stop and report it in `needs_outside_ownership`.',
  ]);
  section('Dependencies and reads', [
    'Finished before you start:',
    '',
    ...bullets(f.deps.map(code), 'none'),
    '',
    'Read, do not edit:',
    '',
    ...bullets(f.reads.map((p) => code(displayPath(p))), 'none'),
  ]);
  section('Exclusive resources', bullets(f.resources.map(code), 'none'));
  const tests = [];
  if (f.redSpecs.length) {
    tests.push('RED specs (write each, run it, and see it fail first):', '');
    for (const s of f.redSpecs) tests.push(`- ${code(displayPath(s.file))}${s.name ? ` "${oneLine(s.name)}"` : ''}`);
    tests.push('');
  }
  if (f.checks.length) tests.push(`Checks (named test commands): ${f.checks.map(code).join(', ')}`, '');
  if (risk.length) tests.push(`Risk labels: ${risk.join(', ')}. Evidence kinds these labels require: ${evidenceKinds.length ? evidenceKinds.map(code).join(', ') : 'none'}.`, '');
  if (f.evidence.length) tests.push(`Declared evidence: ${f.evidence.map(code).join(', ')}`, '');
  tests.push('- Run every test file you add or change and list each command with its result in the report block.');
  section('Required tests', tests);
  section('Reuse inventory', reuseLines(recon));
  section('Acceptance ids', bullets(f.acceptance.map(code), 'none'));
  section('Notes', notes && String(notes).trim() ? quote(normalise(notes).trim()) : ['none']);
  section('Worker rules', bullets(WORKER_RULES, ''));
  section('Report block', [
    'End your final message with one fenced block like this, with exactly these four keys.',
    'Each test is a command and `pass` or `fail`. List the failing specs you saw in `red_seen`.',
    '',
    ...REPORT_EXAMPLE,
  ]);

  const body = lines.join('\n').replace(/\n+$/, '\n');
  return `${body}brief-digest sha256:${sha256(body)}\n`;
}

/** Split a brief into `[{ name, lines }]` in order; headings inside fenced blocks do not count. */
function parseSections(text) {
  const out = [];
  let current = null;
  let fence = false;
  for (const line of normalise(text).split('\n')) {
    if (/^\s*```/.test(line)) fence = !fence;
    const h = !fence && /^## (.+?)\s*$/.exec(line);
    if (h) {
      current = { name: h[1], lines: [] };
      out.push(current);
    } else if (current && !DIGEST_LINE.test(line)) current.lines.push(line);
  }
  return out;
}

/** `{ ok, problems, warnings }` for a brief; a problem names the section. */
export function lintBrief(text) {
  const list = parseSections(text);
  const sections = new Map(list.map((s) => [s.name, s.lines]));
  const problems = [];
  const warnings = [];
  const seen = new Set();
  for (const { name } of list) {
    if (!SECTIONS.includes(name)) problems.push(`section "${name}" is not one of the fixed sections`);
    else if (seen.has(name)) problems.push(`section "${name}" appears more than once`);
    seen.add(name);
  }
  for (const name of REQUIRED_SECTIONS) {
    if (!sections.has(name)) problems.push(`section "${name}" is missing`);
    else if (!sections.get(name).some((l) => l.trim())) problems.push(`section "${name}" is empty`);
    else if (name === 'Report block' && !sections.get(name).some((l) => /^\s*```ship-ticket-report\s*$/.test(l))) problems.push('section "Report block" has no ship-ticket-report block');
  }
  const norm = normalise(text).replace(/\n+$/, '\n');
  const last = norm.replace(/\n$/, '').split('\n').pop();
  const m = DIGEST_LINE.exec(last);
  if (!m) warnings.push('no brief-digest line at the end');
  else if (m[1] !== sha256(norm.slice(0, norm.length - last.length - 1))) warnings.push('brief-digest does not match the brief body (edited after build?)');
  return { ok: problems.length === 0, problems, warnings };
}

function parseFlags(args, allowed) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (!allowed.includes(key)) throw Object.assign(new Error(`unknown option ${a}`), { usage: true });
      if (i + 1 >= args.length) throw Object.assign(new Error(`${a} needs a value`), { usage: true });
      i += 1;
      opts[key] = args[i];
    } else positional.push(a);
  }
  return { opts, positional };
}

function readText(path, what) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    throw fail(`cannot read ${what} ${displayPath(path)}: ${err.code ?? err.message}`);
  }
}

function readJson(path, what) {
  try {
    return JSON.parse(readText(path, what));
  } catch (err) {
    if (err.briefError) throw err;
    throw fail(`${what} ${displayPath(path)} is not valid JSON: ${err.message}`);
  }
}

/** Refuse an --out that is a symbolic link or that is one of the input files (compared by resolved and real path). */
function checkOut(out, inputs) {
  const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
  let link = false;
  try { link = lstatSync(out).isSymbolicLink(); } catch (e) { if (e.code !== 'ENOENT') throw e; } // lstat sees a dangling link; existsSync does not
  if (link) throw fail('--out is a symbolic link; refusing to write through it');
  const target = new Set([resolve(out), real(out)]);
  // A hard link has another path but the same file: compare device and inode when --out already exists.
  let outId = null;
  try { const st = statSync(out); if (st.ino) outId = `${st.dev}:${st.ino}`; } catch { /* no file yet */ }
  for (const input of inputs.filter(Boolean)) {
    if (target.has(resolve(input)) || target.has(real(input))) throw fail('--out is also an input file (dag, plan, recon or notes); refusing to overwrite it');
    if (outId) {
      let id = null;
      try { const st = statSync(input); if (st.ino) id = `${st.dev}:${st.ino}`; } catch { /* unreadable input fails later with its own message */ }
      if (id === outId) throw fail('--out is a hard link to an input file (dag, plan, recon or notes); refusing to overwrite it');
    }
  }
}

export function main(argv) {
  const [command, ...rest] = argv;
  try {
    if (command === 'build') {
      const { opts } = parseFlags(rest, ['dag', 'node', 'plan', 'recon', 'notes', 'out']);
      for (const k of ['dag', 'node', 'plan', 'out']) if (!opts[k]) throw Object.assign(new Error(`build needs --${k}`), { usage: true });
      const text = buildBrief({
        dag: readJson(opts.dag, 'DAG'),
        nodeId: opts.node,
        planText: readText(opts.plan, 'plan'),
        planPath: opts.plan,
        recon: opts.recon ? readJson(opts.recon, 'recon file') : null,
        notes: opts.notes ? readText(opts.notes, 'notes file') : null,
      });
      checkOut(opts.out, [opts.dag, opts.plan, opts.recon, opts.notes]);
      writeFileSync(opts.out, text);
      const digest = text.trimEnd().split('\n').pop();
      process.stdout.write(`brief written for node ${opts.node}: ${digest}\n`);
      return 0;
    }
    if (command === 'lint') {
      const { positional } = parseFlags(rest, []);
      if (positional.length !== 1) throw Object.assign(new Error('lint needs one brief file'), { usage: true });
      const result = lintBrief(readText(positional[0], 'brief'));
      for (const w of result.warnings) process.stderr.write(`brief: warning: ${w}\n`);
      if (!result.ok) {
        for (const p of result.problems) process.stderr.write(`brief: ${p}\n`);
        return 1;
      }
      process.stdout.write('brief lint ok\n');
      return 0;
    }
    throw Object.assign(new Error('usage: brief.mjs build --dag <dag.json> --node <id> --plan <plan.md> [--recon <json>] [--notes <file>] --out <file> | brief.mjs lint <brief>'), { usage: true });
  } catch (err) {
    if (!err.briefError && !err.usage) throw err;
    process.stderr.write(`brief: ${err.message}\n`);
    return err.usage ? 2 : 1;
  }
}

if (isEntrypoint(import.meta.url)) process.exitCode = main(process.argv.slice(2));
