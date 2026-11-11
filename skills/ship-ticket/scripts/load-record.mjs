#!/usr/bin/env node
/**
 * Load record for the ship-ticket spine (AIS-BENCH-1 Wave 1). Measurement only: it reads
 * SKILL.md and references/ and writes nothing. It reports which reference each phase loads, how
 * many bytes that is, and how many bytes of opt-in unit text sit inside the files a run loads, so
 * a later wave can be compared with today.
 *
 * Source of truth: the "Entering | Load" table in SKILL.md. A table row this script does not
 * declare in ENTERING makes it throw (CLI exit 1 with the row), so an edit of the table cannot be
 * silently mis-measured. Loads stated in prose, not in the table, are declared in PROSE_LOADS.
 *
 * Unit text counting rule: the bytes of whole Markdown sections that belong to the opt-in units
 * feature, listed per file in UNIT_SECTIONS. A section that starts at a heading runs to the next
 * heading of the same or a higher level. A section that starts at a column-0 bold lead paragraph
 * (`**Units (opt-in; ...).**`, which this repository uses as a sub-heading) runs to the next
 * heading or the next column-0 bold lead paragraph. Single sentences about units elsewhere
 * (command tables, event lists) are not counted, so the figure is a lower bound.
 *
 * CLI: load-record.mjs [--skill-dir <dir>] [--json]     on success one JSON object on stdout and exit 0; on failure nothing
 *      on stdout, `load-record: <reason>` on stderr and exit 1
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntrypoint } from './harness.mjs';

const DEFAULT_SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every phase of a full run, in order. 'START' is the "Workflow start" row. */
export const PHASES = ['START', 'UNDERSTAND', 'PLAN', 'BUILD', 'PROVE', 'REVIEW', 'SHIP'];
export const FLAGS = ['ui', 'security', 'elevated', 'codex'];

/** The declared meaning of each "Entering" cell: the phases it applies to and the flag that gates it. */
const ENTERING = {
  'Workflow start': { phases: ['START'], flag: null },
  UNDERSTAND: { phases: ['UNDERSTAND'], flag: null },
  PLAN: { phases: ['PLAN'], flag: null },
  BUILD: { phases: ['BUILD'], flag: null },
  PROVE: { phases: ['PROVE'], flag: null },
  'PROVE with UI': { phases: ['PROVE'], flag: 'ui' },
  REVIEW: { phases: ['REVIEW'], flag: null },
  'PLAN, PROVE or REVIEW of security-relevant work': { phases: ['PLAN', 'PROVE', 'REVIEW'], flag: 'security' },
  'REVIEW with elevated counterpart': { phases: ['REVIEW'], flag: 'elevated' },
  SHIP: { phases: ['SHIP'], flag: null },
};

/**
 * Loads stated in prose rather than in the table: execution-harness.md is named by the spine (SKILL.md, section
 * "Execution harness": "Read ... before BUILD"); codex-cli.md is named by references/cross-model.md (lines 4 and 44),
 * not by SKILL.md, and applies when Codex is the counterpart (PLAN debate and REVIEW second opinion).
 */
const PROSE_LOADS = [
  { phase: 'BUILD', file: 'references/execution-harness.md', flag: null, condition: null },
  { phase: 'PLAN', file: 'references/codex-cli.md', flag: 'codex', condition: 'Codex is the counterpart' },
  { phase: 'REVIEW', file: 'references/codex-cli.md', flag: 'codex', condition: 'Codex is the counterpart' },
];

/** Opt-in unit text, per file: the start line of each section counted whole. */
const UNIT_SECTIONS = {
  'references/execution-harness.md': [/^\*\*Units \(opt-in;/],
  'references/review.md': [/^## Unit review \(opt-in/, /^## Repair routing \(units\)/, /^## Final review on unit evidence/],
};

const LINK = /\[(references\/[\w.-]+\.md)\]\([^)]*\)/g;

function tableRows(skillText) {
  const lines = skillText.split('\n');
  const at = lines.findIndex(l => /^\|\s*Entering\s*\|\s*Load\s*\|/.test(l));
  if (at < 0) throw new Error('load table not found: expected a row "| Entering | Load |" in SKILL.md');
  const rows = [];
  for (const line of lines.slice(at + 2)) {
    if (!line.startsWith('|')) break;
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    rows.push({ text: line, entering: cells[0], load: cells[1] ?? '' });
  }
  return rows;
}

/** `{ phase -> [{file, flag, condition}] }` from the table plus the prose loads. */
function declaredLoads(skillText, skillDir) {
  const byPhase = Object.fromEntries(PHASES.map(p => [p, []]));
  for (const row of tableRows(skillText)) {
    const meaning = Object.hasOwn(ENTERING, row.entering) ? ENTERING[row.entering] : null;
    if (!meaning) throw new Error(`unrecognised row in the SKILL.md load table: ${row.text}`);
    const files = [...row.load.matchAll(LINK)].map(m => m[1]);
    if (!files.length && row.load !== 'this spine') throw new Error(`unrecognised load cell in the SKILL.md load table: ${row.text}`);
    for (const file of files) {
      if (!existsSync(join(skillDir, file))) throw new Error(`the SKILL.md load table names a missing file ${file}: ${row.text}`);
      for (const phase of meaning.phases) byPhase[phase].push({ file, flag: meaning.flag, condition: meaning.flag ? row.entering : null });
    }
  }
  for (const p of PROSE_LOADS) {
    if (!existsSync(join(skillDir, p.file))) throw new Error(`a prose load names a missing file ${p.file}`);
    byPhase[p.phase].push({ file: p.file, flag: p.flag, condition: p.condition });
  }
  return byPhase;
}

/** The whole sections of `text` that start at a line matched by one of `starts` (see the counting rule above). */
export function sections(text, starts) {
  const lines = text.split('\n');
  const level = (l) => /^(#{1,6}) /.exec(l)?.[1].length ?? 0;
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    if (!starts.some(re => re.test(lines[i]))) continue;
    const head = level(lines[i]);
    let end = i + 1;
    while (end < lines.length && !(head ? level(lines[end]) && level(lines[end]) <= head : level(lines[end]) || lines[end].startsWith('**'))) end++;
    found.push({ heading: /^\*\*(.+?)\*\*/.exec(lines[i])?.[1] ?? lines[i].trim(), bytes: Buffer.byteLength(lines.slice(i, end).join('\n') + '\n') });
    i = end - 1;
  }
  return found;
}

/** Distinct files and their bytes for a full run under `flags`; a load with a flag counts only when that flag is true. */
function runOf(record, flags) {
  const bytesOf = Object.fromEntries([record.spine, ...record.references].map(r => [r.file, r.bytes]));
  const files = new Set([record.spine.file]);
  for (const phase of record.phases) for (const l of phase.loads) if (!l.flag || flags[l.flag]) files.add(l.file);
  const list = [...files].sort();
  return { files: list, bytes: list.reduce((n, f) => n + bytesOf[f], 0) };
}

export function loadRecord({ skillDir = DEFAULT_SKILL_DIR } = {}) {
  const byPhase = declaredLoads(readFileSync(join(skillDir, 'SKILL.md'), 'utf8'), skillDir);
  const refDir = join(skillDir, 'references');
  const references = readdirSync(refDir).filter(f => statSync(join(refDir, f)).isFile()).sort()
    .map(f => ({ file: `references/${f}`, bytes: statSync(join(refDir, f)).size }));
  const bytesOf = Object.fromEntries(references.map(r => [r.file, r.bytes]));
  const spine = { file: 'SKILL.md', bytes: statSync(join(skillDir, 'SKILL.md')).size };
  const phases = PHASES.map(phase => ({ phase, loads: byPhase[phase].map(l => ({ file: l.file, bytes: bytesOf[l.file], condition: l.condition, flag: l.flag })) }));

  const unit_text = Object.entries(UNIT_SECTIONS).map(([file, starts]) => {
    const found = sections(readFileSync(join(skillDir, file), 'utf8'), starts);
    if (found.length !== starts.length) throw new Error(`unit sections of ${file}: expected ${starts.length}, found ${found.length}`);
    return { file, bytes: found.reduce((n, s) => n + s.bytes, 0), headings: found.map(s => s.heading) };
  });

  const record = { spine, references, total_bytes: spine.bytes + references.reduce((n, r) => n + r.bytes, 0), file_count: 1 + references.length, phases, unit_text };
  // Opt-in unit text lives inside files every run loads, so a run with units and one without load the same files.
  const plain = { ui: false, security: false, elevated: false, codex: false };
  const run = (units, flags) => ({ flags: { ...flags, units }, ...runOf(record, flags) });
  record.runs = { without_units: run(false, plain), with_units: run(true, plain), all_conditions: run(true, Object.fromEntries(FLAGS.map(f => [f, true]))) };
  return record;
}

/** Bytes of the distinct files a full run START to SHIP loads under `flags` ({ui, security, elevated, codex}; missing means false). */
export function referenceBytes(flags = {}, record = loadRecord()) {
  return runOf(record, flags).bytes;
}

if (isEntrypoint(import.meta.url)) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--skill-dir');
  try {
    process.stdout.write(JSON.stringify(loadRecord(at >= 0 ? { skillDir: argv[at + 1] } : {}), null, 2) + '\n');
  } catch (e) {
    process.stderr.write(`load-record: ${e.message}\n`);
    process.exitCode = 1;
  }
}
