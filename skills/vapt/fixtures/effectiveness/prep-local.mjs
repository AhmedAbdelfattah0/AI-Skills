// Local-only helper: turns an audit's findings, report and git history into per-finding input folders.
// Generic by design: it names no product and carries no data. Nothing here is committed with its output.
//   node prep-local.mjs --findings <findings.json> --report <REPORT.md> --repo <git dir> --sha <commit> --out <dir>
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize, isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_COMMITS = 8;
/** SHA-256 of a buffer or string as lowercase hex. */
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
/** Run git in the given repo and return its stdout as a buffer. */
const git = (repo, args, opts = {}) => execFileSync('git', ['-C', repo, ...args], { maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...opts });

/** Findings with verdict 'confirmed' from an array or a {findings} object. */
export function confirmedFindings(json) {
  const list = Array.isArray(json) ? json : json?.findings;
  if (!Array.isArray(list)) throw new Error('findings file is neither an array nor {findings: []}');
  return list.filter((f) => f.verdict === 'confirmed');
}

// Each confirmed finding gets the id of the report table row whose cell equals its title exactly.
export function mapFindingIds(findings, reportText) {
  const rows = [];
  for (const line of reportText.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (/^[A-Z]{1,3}-?\d+$/.test(cells[0] ?? '')) rows.push({ id: cells[0], cells: cells.slice(1) });
  }
  const out = []; const used = new Map();
  for (const f of findings) {
    const hits = rows.filter((r) => r.cells.includes(f.title));
    if (hits.length === 0) throw new Error(`no report row has the exact title ${JSON.stringify(f.title)}`);
    const ids = [...new Set(hits.map((h) => h.id))];
    if (ids.length > 1) throw new Error(`title ${JSON.stringify(f.title)} matches more than one report id: ${ids.join(', ')}`);
    if (used.has(ids[0])) throw new Error(`two confirmed findings map to the same id ${ids[0]}`);
    used.set(ids[0], true);
    out.push({ id: ids[0], finding: f });
  }
  return out;
}

// Cited (file, line) pairs from trace and evidence. line may be a number, "n" or "a-b"; ranges expand.
export function citedLines(finding) {
  const seen = new Set(); const out = [];
  for (const c of [...(finding.trace ?? []), ...(finding.evidence ?? [])]) {
    if (!c || typeof c.file !== 'string') continue;
    let lines = [];
    const raw = c.line ?? c.line_start;
    const m = /^(\d+)(?:\s*[-:]\s*(\d+))?$/.exec(String(raw ?? ''));
    if (m) { const a = Number(m[1]); const b = m[2] ? Number(m[2]) : (c.line_end ? Number(c.line_end) : a); for (let n = a; n <= Math.max(a, Math.min(b, a + 500)); n++) lines.push(n); }
    else lines = [null];
    for (const n of lines) { const k = `${c.file}\0${n}`; if (!seen.has(k)) { seen.add(k); out.push({ file: c.file, line: n }); } }
  }
  return out;
}

/** True only when the path is a regular file (blob) at sha; a directory or submodule counts as missing. */
const existsAt = (repo, sha, file) => { try { return String(git(repo, ['cat-file', '-t', `${sha}:${file}`])).trim() === 'blob'; } catch { return false; } };

// Commits that last wrote the cited lines at sha: [{hash, count}] by count desc then hash asc.
// `missing` lists cited files that do not exist at sha; `unblamable` cited lines git could not blame.
export function blameCommits(repo, sha, cites) {
  const counts = new Map(); const missing = []; const unblamable = [];
  for (const c of cites) {
    if (!existsAt(repo, sha, c.file)) { if (!missing.includes(c.file)) missing.push(c.file); continue; }
    if (c.line == null) { unblamable.push(`${c.file}`); continue; }
    try {
      const o = git(repo, ['blame', '--porcelain', '-L', `${c.line},${c.line}`, sha, '--', c.file], { encoding: 'utf8' });
      const h = /^([0-9a-f]{40}) /.exec(o)?.[1];
      if (h) counts.set(h, (counts.get(h) ?? 0) + 1);
    } catch { unblamable.push(`${c.file}:${c.line}`); }
  }
  const commits = [...counts].map(([hash, count]) => ({ hash, count })).sort((a, b) => b.count - a.count || (a.hash < b.hash ? -1 : 1));
  return { commits, missing, unblamable };
}

/** Return the relative path unchanged, or throw if it is absolute, has '..' or a NUL. */
const safeRel = (p) => {
  if (isAbsolute(p) || normalize(p).split(/[\\/]/).includes('..') || p.includes('\0')) throw new Error(`unsafe path ${p}`);
  return p;
};
/** Write a file, creating its parent directories first. */
const put = (file, data) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, data); };
/** List every file under a directory, recursively. */
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });

/** Write the ticket, code and judge record for each confirmed finding under out, plus the bundle hash. */
export function build({ findings, report, repo, sha, out }) {
  const mapped = mapFindingIds(confirmedFindings(findings), report); // throws before anything is written
  for (const { id, finding } of mapped) {
    const cites = citedLines(finding);
    const files = [...new Set(cites.map((c) => c.file))].sort();
    for (const f of files) safeRel(f);
    const b = blameCommits(repo, sha, cites);
    const lines = ['Files:', ...files.map((f) => `- ${f}`)];
    for (const f of b.missing) lines.push(`Note: ${f} is not present at this commit and was not included.`);
    if (b.unblamable.length) lines.push(`Note: ${b.unblamable.length} cited line(s) could not be attributed to a commit.`);
    lines.push('');
    for (const c of b.commits.slice(0, MAX_COMMITS)) {
      lines.push('---', git(repo, ['log', '-1', '--format=%B', c.hash], { encoding: 'utf8' }).trim());
    }
    lines.push('');
    const w = join(out, id, 'writer');
    put(join(w, 'ticket.txt'), lines.join('\n'));
    for (const f of files) if (!b.missing.includes(f)) put(join(w, 'code', f), git(repo, ['show', `${sha}:${f}`]));
    put(join(out, id, 'judge', 'finding.json'), JSON.stringify({
      title: finding.title, description: finding.description ?? null, root_cause: finding.root_cause ?? null,
      intended_behavior: finding.intended_behavior ?? null, conditions: finding.conditions ?? null,
      attacker_perspective: finding.execution?.attacker_perspective ?? null, remediation_strategy: finding.remediation?.strategy ?? null,
    }, null, 2) + '\n');
  }
  const rels = walk(out).map((p) => relative(out, p).split('\\').join('/')).filter((r) => r !== 'bundle.sha256').sort();
  const bundle = sha256(rels.map((r) => `${r} ${sha256(readFileSync(join(out, r)))}`).join('\n') + '\n');
  put(join(out, 'bundle.sha256'), bundle + '\n');
  return { ids: mapped.map((m) => m.id), bundle };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const o = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) o[a[i].slice(2)] = a[++i];
  if (!o.findings || !o.report || !o.repo || !o.sha || !o.out) {
    console.error('usage: prep-local.mjs --findings <findings.json> --report <REPORT.md> --repo <git dir> --sha <commit> --out <dir>');
    process.exit(2);
  }
  const r = build({ findings: JSON.parse(readFileSync(o.findings, 'utf8')), report: readFileSync(o.report, 'utf8'), repo: o.repo, sha: o.sha, out: o.out });
  console.log(`wrote ${r.ids.length} findings; bundle ${r.bundle}`);
}
