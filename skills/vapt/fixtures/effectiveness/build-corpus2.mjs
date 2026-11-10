// Builds corpus 2 from the GitHub Advisory Database exactly as prereg.json corpus2_rule says, with no judgment.
// The rule lives in pure functions (isSourceFile, firstCommitRef, npmOrPip, decide, orderedAdvisories, pickFrom,
// patchFor); only the `gh api` plumbing at the bottom touches the network.
//   node build-corpus2.mjs pick  --freeze <iso> --out <file> [--max-examined <n>]
//   node build-corpus2.mjs fetch --index <file> --out <dir>
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, normalize, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const MAX_BYTES = 200000;
const MAX_FILES = 5;
const PER_GROUP = 2;
const LIMIT = 24;
const SOURCE_EXT = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py'];
const BAD_DIRS = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'e2e', 'testing', 'fixtures', 'doc', 'docs', 'example', 'examples', 'sample', 'samples', 'vendor', 'node_modules', 'dist', 'build']);

/** True for a path that is a source file outside excluded directories. */
export function isSourceFile(path) {
  const parts = path.split('/');
  const base = parts[parts.length - 1];
  if (parts.slice(0, -1).some((d) => BAD_DIRS.has(d))) return false;
  if (!SOURCE_EXT.some((e) => base.endsWith(e))) return false;
  if (/\.(test|spec)\./.test(base)) return false;
  if (/^test_.*\.py$/.test(base) || /_test\.py$/.test(base) || base === 'conftest.py') return false;
  if (base.endsWith('.d.ts') || base.endsWith('.min.js')) return false;
  return true;
}

const COMMIT = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/commit\/([0-9a-f]{7,40})(?:[/?#].*)?$/i;
// The first reference in list order that points at a commit.
export function firstCommitRef(advisory) {
  for (const r of advisory.references ?? []) {
    const url = typeof r === 'string' ? r : r?.url;
    const m = typeof url === 'string' ? COMMIT.exec(url) : null;
    if (m) return { owner: m[1], repo: m[2], sha: m[3] };
  }
  return null;
}

/** The first npm or pip package of an advisory as {ecosystem, package}, or null. */
export function npmOrPip(advisory) {
  for (const v of advisory.vulnerabilities ?? []) {
    const eco = v?.package?.ecosystem;
    if (eco === 'npm' || eco === 'pip') return { ecosystem: eco, package: v.package.name };
  }
  return null;
}

/** The CWE ids of an advisory as plain strings. */
const cweIds = (a) => (a.cwes ?? []).map((c) => (typeof c === 'string' ? c : c.cwe_id)).filter(Boolean);
/** The CWE cap group of a case: its first CWE, or 'none'. */
const group = (cwes) => cwes[0] ?? 'none';

// Apply the keep rules in order. `commit` is the fix commit as the API returns it (null when unreadable);
// `sizeOf(repo, parentSha, path)` returns a file's pre-fix byte size and is only called when earlier rules pass.
export function decide(advisory, commit, keptSoFar, sizeOf) {
  const skip = (rule) => ({ keep: false, rule });
  if (advisory.withdrawn_at) return skip('withdrawn');
  const ref = firstCommitRef(advisory);
  if (!ref) return skip('no_fix_commit');
  if (!commit) return skip('commit_unavailable');
  if (!Array.isArray(commit.parents) || commit.parents.length !== 1) return skip('merge_commit');
  const files = (commit.files ?? []).filter((f) => f.status === 'modified' && isSourceFile(f.filename)).map((f) => f.filename).sort();
  if (files.length === 0) return skip('no_source_files');
  if (files.length > MAX_FILES) return skip('too_many_files');
  const repo = `${ref.owner}/${ref.repo}`;
  const parent = commit.parents[0].sha;
  let total = 0;
  try { for (const f of files) total += sizeOf(repo, parent, f); } catch { return skip('commit_unavailable'); }
  if (total > MAX_BYTES) return skip('too_large');
  const cwes = cweIds(advisory);
  if (keptSoFar.filter((k) => group(k.cwes ?? []) === group(cwes)).length >= PER_GROUP) return skip('cwe_cap');
  if (keptSoFar.filter((k) => k.repo === repo).length >= PER_GROUP) return skip('repo_cap');
  const pkg = npmOrPip(advisory);
  if (!pkg) throw new Error(`${advisory.ghsa_id}: no npm or pip vulnerability (should have been filtered before decide)`);
  return { keep: true, case: { ghsa_id: advisory.ghsa_id, cwes, ecosystem: pkg.ecosystem, package: pkg.package, repo, fix_sha: commit.sha ?? ref.sha, parent_sha: parent, files, published_at: advisory.published_at } };
}

// Advisories in published_at descending, ghsa_id ascending order, within [from, to]. fetchPage(cursor) returns
// {items, next}; pages are pulled only when the consumer asks for more. Equal timestamps are held back until the
// next timestamp is seen so a tie group split across pages is still sorted as one.
export function* orderedAdvisories(fetchPage, { from, to }) {
  const lo = Date.parse(from); const hi = Date.parse(to);
  const flush = (g) => g.sort((a, b) => (a.ghsa_id < b.ghsa_id ? -1 : a.ghsa_id > b.ghsa_id ? 1 : 0));
  let group = []; let cursor; let done = false;
  while (!done) {
    const page = fetchPage(cursor);
    for (const a of page.items) {
      const t = Date.parse(a.published_at);
      if (t < lo) { done = true; break; }
      if (t > hi) continue;
      if (group.length && group[0].published_at !== a.published_at) { yield* flush(group); group = []; }
      group.push(a);
    }
    if (!page.next) done = true; else cursor = page.next;
  }
  yield* flush(group);
}

// Walk the ordered advisories until `limit` are kept (or maxExamined are examined). Advisories with no npm or pip
// vulnerability are not examined. Returns {cases, skipped, examined}.
export function pickFrom(advisories, { getCommit, getSize, limit = LIMIT, maxExamined = Infinity }) {
  const cases = []; const skipped = []; let examined = 0;
  const it = advisories[Symbol.iterator]();
  while (cases.length < limit && examined < maxExamined) {
    const n = it.next();
    if (n.done) break;
    const a = n.value;
    if (!npmOrPip(a)) continue;
    examined++;
    const ref = a.withdrawn_at ? null : firstCommitRef(a);
    let commit = null;
    if (ref) { try { commit = getCommit(ref); } catch { commit = null; } }
    const d = decide(a, commit, cases, getSize);
    if (d.keep) cases.push({ id: `C2-${String(cases.length + 1).padStart(2, '0')}`, ...d.case });
    else skipped.push({ ghsa_id: a.ghsa_id, rule: d.rule });
  }
  return { cases, skipped, examined };
}

// A unified diff for the kept files only, from the per-file patches the commit API returns.
export function patchFor(commit, files) {
  const out = [];
  for (const f of commit.files ?? []) {
    if (!files.includes(f.filename)) continue;
    out.push(`diff --git a/${f.filename} b/${f.filename}\n--- a/${f.filename}\n+++ b/${f.filename}\n${f.patch ?? ''}`);
  }
  return out.join('\n') + '\n';
}

// ------------------------------------------------------------ gh plumbing
/** Run `gh api` with the given arguments and return its output. */
function gh(args, { raw = false } = {}) {
  return execFileSync('gh', ['api', ...args], { encoding: raw ? 'buffer' : 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}
/** Fetch a GitHub API path and parse the JSON body. */
const ghJson = (path) => JSON.parse(gh([path]));
/** URL-encode each segment of a slash-separated path. */
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

/** Split a `gh api -i` response into its header text and trimmed body; throws when there is no blank-line separator. */
export function splitHttpResponse(text) {
  const m = /\r?\n\r?\n/.exec(text);
  if (!m) throw new Error('GitHub API response had no header/body separator (blank line); cannot split headers from the body');
  return { head: text.slice(0, m.index), body: text.slice(m.index).trim() };
}

/** Return a cursor-based page fetcher over the reviewed advisories in the freeze window. */
function advisoryPager(freeze, from) {
  const day = freeze.slice(0, 10);
  const first = `/advisories?type=reviewed&sort=published&direction=desc&per_page=100&published=${from.slice(0, 10)}..${day}`;
  return (cursor) => {
    const text = gh(['-i', cursor ?? first]);
    const { head, body } = splitHttpResponse(text);
    const link = /^link:\s*(.*)$/im.exec(head)?.[1] ?? '';
    const next = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1];
    let n = null;
    if (next) { const u = new URL(next); n = u.pathname + u.search; }
    return { items: JSON.parse(body), next: n };
  };
}

/** Parse --name value pairs from argv into an object. */
function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[++i];
  return o;
}
/** Return the relative path unchanged, or throw if it is absolute, has '..' or a NUL. */
const safeRel = (p) => {
  if (isAbsolute(p) || normalize(p).split('/').includes('..') || p.includes('\0')) throw new Error(`unsafe path ${p}`);
  return p;
};
/** Write a file, creating its parent directories first. */
const put = (file, data) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, data); };

/** Run the preregistered pick over the live advisory feed and write the index. */
export function pick({ freeze, out, maxExamined }) {
  if (Number.isNaN(Date.parse(freeze))) throw new Error('--freeze must be an ISO time');
  const prereg = JSON.parse(readFileSync(join(here, 'prereg.json'), 'utf8'));
  const from = /from (\d{4}-\d\d-\d\dT[\d:]+Z)/.exec(prereg.corpus2_rule.window)?.[1];
  if (!from) throw new Error('prereg window has no start time');
  const stream = orderedAdvisories(advisoryPager(freeze, from), { from, to: freeze });
  const getCommit = (r) => { try { return ghJson(`/repos/${r.owner}/${r.repo}/commits/${r.sha}`); } catch { return null; } };
  const getSize = (repo, parent, path) => Number(gh([`/repos/${repo}/contents/${encPath(path)}?ref=${parent}`, '--jq', '.size']).trim());
  const r = pickFrom(stream, { getCommit, getSize, limit: LIMIT, maxExamined: maxExamined ?? Infinity });
  put(out, JSON.stringify({ schema: 'vapt-effectiveness-corpus2-v1', frozen_at: freeze, examined: r.examined, cases: r.cases, skipped: r.skipped }, null, 2) + '\n');
  return r;
}

/** Download the patch and parent-commit files of each indexed case into the output folder. */
export function fetchCases({ index, out }) {
  const idx = JSON.parse(readFileSync(index, 'utf8'));
  for (const c of idx.cases) {
    const [owner, name] = c.repo.split('/');
    const repoInfo = ghJson(`/repos/${owner}/${name}`);
    const w = join(out, c.id, 'writer'); const j = join(out, c.id, 'judge');
    put(join(w, 'context.txt'), [`ecosystem: ${c.ecosystem}`, `package: ${c.package}`, `repository: ${c.repo}`, `description: ${repoInfo.description ?? ''}`, 'files:', ...c.files.map((f) => `- ${f}`), ''].join('\n'));
    for (const f of c.files) put(join(w, 'code', safeRel(f)), gh([`/repos/${c.repo}/contents/${encPath(f)}?ref=${c.parent_sha}`, '-H', 'Accept: application/vnd.github.raw'], { raw: true }));
    const a = ghJson(`/advisories/${c.ghsa_id}`);
    put(join(j, 'advisory.json'), JSON.stringify({ ghsa_id: a.ghsa_id, summary: a.summary, description: a.description, cwes: c.cwes, severity: a.severity }, null, 2) + '\n');
    put(join(j, 'fix.patch'), patchFor(ghJson(`/repos/${c.repo}/commits/${c.fix_sha}`), c.files));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, ...rest] = process.argv.slice(2);
  const o = parseArgs(rest);
  if (cmd === 'pick' && o.freeze && o.out) {
    const r = pick({ freeze: o.freeze, out: o.out, maxExamined: o['max-examined'] ? Number(o['max-examined']) : undefined });
    console.log(`examined ${r.examined}, kept ${r.cases.length}, skipped ${r.skipped.length}`);
  } else if (cmd === 'fetch' && o.index && o.out) fetchCases({ index: o.index, out: o.out });
  else { console.error('usage: build-corpus2.mjs pick --freeze <iso> --out <file> [--max-examined <n>] | fetch --index <file> --out <dir>'); process.exit(2); }
}
