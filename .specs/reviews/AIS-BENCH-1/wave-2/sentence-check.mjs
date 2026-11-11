#!/usr/bin/env node
// AIS-BENCH-1 Wave 2: sentence-preservation check for the ship-ticket skill text.
//
// Compares the rule text of SKILL.md and references/*.md at a pinned base commit
// (read with `git show <base>:<path>`, never a moving branch) with the working tree.
// A sentence may move between files; it may not vanish, appear from nowhere or be
// copied without a reason. Dependency-free, Node >= 18, ESM.
//
// Usage:
//   node sentence-check.mjs --base 2c5dbd7 [--allowlist allowlist.json] [--json out.json]
//        [--new-root <dir>] [--skill-dir skills/ship-ticket]
//   node sentence-check.mjs --selftest [--base 2c5dbd7]
//
// Units of comparison: fenced code block (whole), table row, heading, list item,
// paragraph sentence. Whitespace and line wraps are normalised, list markers are
// stripped, backticks and case are kept. The two sets are compared as multisets:
//   MISSING     in old, fewer copies in new
//   ADDED       not in old, present in new
//   DUPLICATED  more copies in new than in old (old has at least one)
// Allowlist entries {old, new, reason} (old or new may be absent) cover an item
// exactly by normalised text: `old` covers a MISSING item, `new` covers an ADDED or
// DUPLICATED item. Exit 1 when any item is uncovered.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SKILL_DIR = 'skills/ship-ticket';
const UNIT_TERMS = ['unitReview', 'unitRecheckCeiling', 'unit-review', 'parent_ceiling'];
const SENTENCE_SPLIT = /(?<=[.!?])\s+(?=[A-Z`*(\[])/;

export function norm(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

function normRow(line) {
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(norm);
  return `| ${cells.join(' | ')} |`;
}

const FENCE = /^\s*(`{3,}|~{3,})/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+/;
const HEADING = /^\s{0,3}#{1,6}\s+/;
const TABLE_ROW = /^\s*\|/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

// Split one markdown text into comparison units: [{kind, text}].
export function extractUnits(markdown) {
  const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n');
  const units = [];
  let i = 0;

  // Front matter is one unit.
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) {
      units.push({ kind: 'frontmatter', text: lines.slice(0, end + 1).map((l) => l.trimEnd()).join('\n') });
      i = end + 1;
    }
  }

  const flushParagraph = (buf) => {
    if (!buf.length) return;
    const joined = norm(buf.join(' '));
    for (const s of joined.split(SENTENCE_SPLIT)) {
      const t = norm(s);
      if (t) units.push({ kind: 'sentence', text: t });
    }
    buf.length = 0;
  };

  let para = [];
  let item = null; // { indent, lines }
  const flushItem = () => {
    if (!item) return;
    const text = norm(item.lines.join(' '));
    if (text) units.push({ kind: 'item', text });
    item = null;
  };

  for (; i < lines.length; i += 1) {
    const raw = lines[i];
    const fence = raw.match(FENCE);
    if (fence) {
      flushParagraph(para);
      flushItem();
      const marker = fence[1];
      const body = [raw.trimEnd().replace(/^\s+/, '')];
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const m = lines[j].match(FENCE);
        body.push(lines[j].trimEnd());
        if (m && m[1][0] === marker[0] && m[1].length >= marker.length && lines[j].trim() === m[1]) break;
      }
      units.push({ kind: 'fence', text: body.join('\n') });
      i = j;
      continue;
    }
    if (raw.trim() === '') {
      flushParagraph(para);
      flushItem();
      continue;
    }
    if (HEADING.test(raw)) {
      flushParagraph(para);
      flushItem();
      units.push({ kind: 'heading', text: norm(raw) });
      continue;
    }
    if (TABLE_ROW.test(raw)) {
      flushParagraph(para);
      flushItem();
      if (!TABLE_SEP.test(raw)) units.push({ kind: 'row', text: normRow(raw) });
      continue;
    }
    const li = raw.match(LIST_ITEM);
    if (li) {
      flushParagraph(para);
      flushItem();
      item = { indent: li[1].length, lines: [raw.slice(li[0].length)] };
      continue;
    }
    if (item) {
      item.lines.push(raw.replace(/^\s*>\s?/, ''));
      continue;
    }
    para.push(raw.replace(/^\s*>\s?/, ''));
  }
  flushParagraph(para);
  flushItem();
  return units;
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function isSkillText(rel, skillDir) {
  return rel === `${skillDir}/SKILL.md` || (rel.startsWith(`${skillDir}/references/`) && rel.endsWith('.md') && rel.split('/').length === skillDir.split('/').length + 2);
}

export function readOldSet(root, base, skillDir = DEFAULT_SKILL_DIR) {
  const names = git(root, ['ls-tree', '-r', '--name-only', base, skillDir]).split('\n').filter(Boolean).filter((n) => isSkillText(n, skillDir));
  return names.sort().map((rel) => ({ rel, text: git(root, ['show', `${base}:${rel}`]) }));
}

export function readNewSet(newRoot, skillDir = DEFAULT_SKILL_DIR) {
  const out = [];
  const skill = join(newRoot, skillDir, 'SKILL.md');
  if (existsSync(skill)) out.push({ rel: `${skillDir}/SKILL.md`, text: readFileSync(skill, 'utf8') });
  const refDir = join(newRoot, skillDir, 'references');
  if (existsSync(refDir)) {
    for (const f of readdirSync(refDir).filter((n) => n.endsWith('.md')).sort()) {
      out.push({ rel: `${skillDir}/references/${f}`, text: readFileSync(join(refDir, f), 'utf8') });
    }
  }
  return out;
}

function countUnits(files) {
  const map = new Map(); // text -> { count, where: Map(file -> n), kind }
  for (const f of files) {
    for (const u of extractUnits(f.text)) {
      let e = map.get(u.text);
      if (!e) {
        e = { count: 0, kind: u.kind, where: new Map() };
        map.set(u.text, e);
      }
      e.count += 1;
      e.where.set(f.rel, (e.where.get(f.rel) || 0) + 1);
    }
  }
  return map;
}

const whereList = (e) => [...e.where.entries()].map(([file, n]) => (n > 1 ? `${file} x${n}` : file));

export function compare(oldFiles, newFiles, allowlist = [], wholeNewFiles = []) {
  const oldMap = countUnits(oldFiles);
  const newMap = countUnits(newFiles);
  const missing = [];
  const added = [];
  const duplicated = [];
  for (const [text, o] of oldMap) {
    const n = newMap.get(text);
    const nc = n ? n.count : 0;
    if (nc < o.count) {
      missing.push({ text, kind: o.kind, old_count: o.count, new_count: nc, partial: nc > 0, old_in: whereList(o), new_in: n ? whereList(n) : [] });
    } else if (nc > o.count) {
      duplicated.push({ text, kind: o.kind, old_count: o.count, new_count: nc, old_in: whereList(o), new_in: whereList(n) });
    }
  }
  for (const [text, n] of newMap) {
    if (!oldMap.has(text)) added.push({ text, kind: n.kind, new_count: n.count, new_in: whereList(n) });
  }
  const flat = (t) => t.replace(/\s+/g, ' ').trim(); // fence units keep their line breaks
  const entries = allowlist.map((e) => ({ old: e.old == null ? null : flat(norm(e.old)), new: e.new == null ? null : flat(norm(e.new)), reason: e.reason || '' }));
  const used = new Set();
  const cover = (item, field) => {
    const idx = entries.findIndex((e) => e[field] === flat(item.text));
    if (idx >= 0) {
      used.add(idx);
      item.covered_by = entries[idx].reason || '(no reason)';
      return true;
    }
    return false;
  };
  missing.forEach((m) => cover(m, 'old'));
  added.forEach((a) => {
    if (cover(a, 'new')) return;
    // A file written from scratch in this wave (named with --new-file) has no old text to preserve.
    if (a.new_in.length && a.new_in.every((w) => wholeNewFiles.includes(w.replace(/ x\d+$/, '')))) a.covered_by = 'wholly new file';
  });
  duplicated.forEach((d) => cover(d, 'new'));
  const uncovered = {
    missing: missing.filter((m) => !m.covered_by).length,
    added: added.filter((a) => !a.covered_by).length,
    duplicated: duplicated.filter((d) => !d.covered_by).length,
  };
  const unusedAllowlist = entries.map((e, idx) => ({ e, idx })).filter(({ idx }) => !used.has(idx)).map(({ e }) => e);
  const noReason = entries.filter((e) => !e.reason).length;
  return {
    counts: {
      old_units: [...oldMap.values()].reduce((s, x) => s + x.count, 0),
      new_units: [...newMap.values()].reduce((s, x) => s + x.count, 0),
      missing: missing.length,
      added: added.length,
      duplicated: duplicated.length,
      uncovered_missing: uncovered.missing,
      uncovered_added: uncovered.added,
      uncovered_duplicated: uncovered.duplicated,
    },
    missing,
    added,
    duplicated,
    allowlist_unused: unusedAllowlist,
    allowlist_without_reason: noReason,
    // An entry that matches nothing means a covered sentence changed or vanished: fail, do not warn.
    ok: uncovered.missing + uncovered.added + uncovered.duplicated === 0 && noReason === 0 && unusedAllowlist.length === 0,
  };
}

// Mentions of unit-only identifiers, per file, for the "no unit text" record.
export function unitIdentifierHits(files) {
  const out = {};
  const re = new RegExp(UNIT_TERMS.map((t) => t.replace(/[-_]/g, '[-_]')).join('|'), 'g');
  for (const f of files) {
    const hits = [];
    f.text.replace(/\r\n?/g, '\n').split('\n').forEach((line, idx) => {
      const found = [...new Set(line.match(re) || [])];
      if (found.length) hits.push({ line: idx + 1, terms: found, text: norm(line).slice(0, 160) });
    });
    out[f.rel] = { count: hits.length, hits };
  }
  return out;
}

function parseArgs(argv) {
  const opts = { base: '2c5dbd7', skillDir: DEFAULT_SKILL_DIR };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const need = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      i += 1;
      return argv[i];
    };
    if (a === '--base') opts.base = need();
    else if (a === '--allowlist') opts.allowlist = need();
    else if (a === '--new-file') (opts.newFiles ||= []).push(need());
    else if (a === '--json') opts.json = need();
    else if (a === '--new-root') opts.newRoot = need();
    else if (a === '--skill-dir') opts.skillDir = need();
    else if (a === '--selftest') opts.selftest = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

function repoRoot() {
  return execFileSync('git', ['-C', HERE, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
}

function loadAllowlist(path) {
  if (!path) return [];
  const full = resolve(path);
  const data = JSON.parse(readFileSync(full, 'utf8'));
  const list = Array.isArray(data) ? data : data.entries;
  if (!Array.isArray(list)) throw new Error('allowlist must be an array or {entries: [...]}');
  list.forEach((e, i) => {
    if (e.old == null && e.new == null) throw new Error(`allowlist entry ${i} has neither old nor new`);
  });
  return list;
}

function printReport(result, base) {
  const c = result.counts;
  console.log(`sentence-check base=${base}: old=${c.old_units} new=${c.new_units} units`);
  console.log(`MISSING ${c.missing} (uncovered ${c.uncovered_missing}), ADDED ${c.added} (uncovered ${c.uncovered_added}), DUPLICATED ${c.duplicated} (uncovered ${c.uncovered_duplicated})`);
  const show = (label, list) => {
    for (const it of list.filter((x) => !x.covered_by)) {
      const where = it.old_in ? `old ${it.old_in.join(', ')}` : '';
      const nw = it.new_in && it.new_in.length ? ` new ${it.new_in.join(', ')}` : '';
      console.log(`  ${label} [${it.kind}] ${it.text.slice(0, 200)}${it.text.length > 200 ? '...' : ''}  (${where}${nw})`);
    }
  };
  show('MISSING', result.missing);
  show('ADDED', result.added);
  show('DUPLICATED', result.duplicated);
  if (result.allowlist_unused.length) console.log(`error: ${result.allowlist_unused.length} allowlist entr(ies) matched nothing`);
  if (result.allowlist_without_reason) console.log(`error: ${result.allowlist_without_reason} allowlist entr(ies) have no reason`);
  console.log(result.ok ? 'RESULT ok' : 'RESULT FAIL');
}

function runSelftest(base) {
  const root = repoRoot();
  const skillDir = DEFAULT_SKILL_DIR;
  const oldFiles = readOldSet(root, base, skillDir);
  const tmp = mkdtempSync(join(tmpdir(), 'sentence-check-'));
  const failures = [];
  try {
    const write = (files) => {
      for (const f of files) {
        const dest = join(tmp, f.rel);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, f.text);
      }
    };
    write(oldFiles);
    const clean = compare(oldFiles, readNewSet(tmp, skillDir));
    console.log(`selftest clean copy: missing=${clean.counts.missing} added=${clean.counts.added} duplicated=${clean.counts.duplicated} ok=${clean.ok}`);
    if (!clean.ok) failures.push('clean copy of the base must pass');

    // Plant a deletion: drop the first sentence of the first multi-sentence paragraph of ship.md.
    const target = join(tmp, skillDir, 'references', 'ship.md');
    const lines = readFileSync(target, 'utf8').split('\n');
    const idx = lines.findIndex((l) => /^[A-Z].*[.!?] [A-Z`]/.test(l));
    if (idx < 0) throw new Error('selftest could not find a multi-sentence line to delete');
    const planted = lines[idx];
    const cut = planted.search(/(?<=[.!?])\s+(?=[A-Z`*(\[])/);
    lines[idx] = planted.slice(cut).trimStart();
    writeFileSync(target, lines.join('\n'));
    const del = compare(oldFiles, readNewSet(tmp, skillDir));
    console.log(`selftest planted deletion: missing=${del.counts.missing} (uncovered ${del.counts.uncovered_missing}) ok=${del.ok}`);
    if (del.ok || del.counts.uncovered_missing < 1) failures.push('a planted deletion must fail the check');

    // Plant a duplicate: append a copy of an existing sentence to references/plan.md.
    write(oldFiles);
    const planPath = join(tmp, skillDir, 'references', 'plan.md');
    writeFileSync(planPath, `${readFileSync(planPath, 'utf8')}\n${planted.slice(0, cut).trim()}\n`);
    const dup = compare(oldFiles, readNewSet(tmp, skillDir));
    console.log(`selftest planted duplicate: duplicated=${dup.counts.duplicated} (uncovered ${dup.counts.uncovered_duplicated}) ok=${dup.ok}`);
    if (dup.ok || dup.counts.uncovered_duplicated < 1) failures.push('a planted duplicate must fail the check');

    // An allowlist entry covers it exactly.
    const covered = compare(oldFiles, readNewSet(tmp, skillDir), [{ new: planted.slice(0, cut), reason: 'selftest' }]);
    console.log(`selftest allowlisted duplicate: ok=${covered.ok}`);
    if (!covered.ok) failures.push('an allowlist entry must cover the duplicate');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  if (failures.length) {
    for (const f of failures) console.log(`SELFTEST FAIL: ${f}`);
    return 1;
  }
  console.log('SELFTEST ok');
  return 0;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    return 2;
  }
  if (opts.help) {
    console.log('usage: node sentence-check.mjs --base <commit> [--allowlist file] [--json out] [--new-root dir] | --selftest');
    return 0;
  }
  if (opts.selftest) return runSelftest(opts.base);
  const root = repoRoot();
  const newRoot = opts.newRoot ? resolve(opts.newRoot) : root;
  const oldFiles = readOldSet(root, opts.base, opts.skillDir);
  const newFiles = readNewSet(newRoot, opts.skillDir);
  const result = compare(oldFiles, newFiles, loadAllowlist(opts.allowlist), opts.newFiles || []);
  const report = {
    base: opts.base,
    old_files: oldFiles.map((f) => f.rel),
    new_files: newFiles.map((f) => f.rel),
    ...result,
    unit_identifier_hits: unitIdentifierHits(newFiles),
  };
  if (opts.json) writeFileSync(opts.json, `${JSON.stringify(report, null, 2)}\n`);
  printReport(result, opts.base);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
