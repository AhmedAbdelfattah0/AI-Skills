#!/usr/bin/env node
/**
 * PR scope check (S6, F07; design v3, option B): classifies every path of the candidate as planned, supporting or
 * material against the ONE fenced scope-contract block of the approved plan, and writes a `ship-ticket-scope-v1`
 * record. The orchestrator runs it before announcing REVIEW and again on the frozen candidate at SHIP (manual flow
 * included). No gate, engine step or ship-ready check reads it, and the engine never imports it: it adds no authority.
 * The Files touched table is explanation for the approver and is read by no script.
 * Dependency-free Node >= 22; git and candidate-id.mjs through spawnSync with an argument list, no shell.
 *
 * CLI: check-pr-scope.mjs check --repo <path> --ticket <T> --run-id <id> --base <ref> --plan <plan.md> [--dag <dag.json>] [--out <file>]
 *      check-pr-scope.mjs lint --plan <plan.md>            (the same rule function on the plan alone, before approval)
 *      check-pr-scope.mjs contract --mode engine|manual [--dag <dag.json>] [--planned <p>]... [--supporting <s>]...
 *      check-pr-scope.mjs contract --verify-quote <saved-quote.txt> --plan <plan.md> [--record <scope.json>]
 *      (saved-quote.txt is exactly the four-backtick quote block extracted from the request, nothing else)
 *
 * The contract is one fenced block at column 0 with a blank line before and after it, inside the plan digest bound by
 * START, plus one `contract body: sha256:<hex>` line (SHA-256 of the body bytes without the line end):
 *   ```scope-contract
 *   {"v":1,"mode":"manual","dag":null,"planned":["src/checkout","src/checkout/page.tsx"],"supporting":["tests"]}
 *   ```
 * Rules (validatePlanText, shared by lint, check and verify-quote; all refusals exit 2):
 *  R0 no C0/C1 control other than TAB, LF and CRLF, no DEL, U+2028/2029 or BOM anywhere in the file (RUN-STATE body
 *     included); lines split on \r?\n, which then equals the CommonMark line model; blank = spaces and tabs only;
 *  R1 exactly one opener line, then one body line, then the closer (`scope_contract_missing` / `_ambiguous` /
 *     `_malformed`; a legacy bare `scope-contract:` line is missing and is never converted);
 *  R2 `scope-contract` appears on no other line, in any case;
 *  R3 no run of 3+ backticks or tildes on any line before the closer (R3a), and no line anywhere else that starts,
 *     after container prefixes, with one (R3b): the plan holds exactly one fenced block, so no second block whose
 *     info string decodes to the same name can exist;
 *  R4 the block precedes RUN-STATE; R5 blank lines around it (no front-matter exception); R6 CommonMark 0.31.2 HTML
 *     blocks of types 1-5 opened before it end before the blank line (types 6 and 7 end at that blank line);
 *  R7 front matter (a first line starting with --- or +++) closes with the same token before the block, no `...`;
 *  R8 no `$$` before the block; R10 exactly one `contract body:` line, equal to the body's SHA-256.
 * Under these rules CommonMark/GFM render exactly one fenced code block, at top level, with info `scope-contract` and
 * the body as its literal content (structural, design v3 §3). NOT proven: DOM/CSS effects of raw HTML in a viewer that
 * renders it, and renderer extensions. Raw HTML is deliberately no longer refused by S6 (option B): such viewers are
 * excluded by the owner's signed qualified-surface approval policy, not by code. `contract --verify-quote` byte-compares
 * the body of the saved quote block (the orchestrator extracts only the four-backtick quote from the ExitPlanMode
 * request it sent; any other non-blank line fails: a precise input definition) with the plan block and the record. That is byte
 * verification only: it does not prove what the owner saw and does not authorize execution; native ExitPlanMode
 * approval, given on a qualified approval surface (one that shows the complete plan and does not let raw HTML hide or run
 * content), remains mandatory, and when the approval surface cannot meet that requirement the orchestrator fails closed with the NOT_VERIFIED_REPORT wording.
 * The canonical JSON body: keys v, mode, dag, planned, supporting in that order (`scope_contract_noncanonical`); body
 * <= 8 KiB (64 KiB in engine mode), planned <= 64 entries of <= 256 chars (engine mode 256 of <= 512), supporting <= 16. Field rules
 * (`scope_contract_invalid`):
 *  - every entry is a path with no trailing slash covering itself and everything below (the DAG write syntax): the
 *    engine-dag normalRel rule, printable ASCII only without < > & ` | " (engine globs * ? [ ] { } allowed), no
 *    duplicate;
 *  - planned: manual mode literal paths only (no * or ?; brackets and braces match literally, `app/[id]/page.tsx`)
 *    and at least one; engine mode may carry the DAG's globs; a single-segment entry or a wildcard-only first segment
 *    is allowed and flagged `broad_planned` (advisory: the engine DAG is the breadth authority);
 *  - supporting: literal, last segment in the closed set tests, test, __tests__, spec, e2e, fixtures, __fixtures__,
 *    docs; no segment .github, .git, .claude, .ship-ticket, .specs or node_modules; disjoint from planned
 *    (`supporting_overlaps_planned`: segment-wise unification of the planned entry, globs included, against the
 *    supporting path: no planned entry may cover it, an ancestor of it, or any descendant of it).
 * Mode binding (the approved contract is the authority; the tripwires below only refuse):
 *  - engine: --dag required (`dag_required`, also after a failed engine init); sha of the --dag file equals `dag`
 *    and, when the run has any DAG_BOUND, exactly one DAG_BOUND equal to it (`dag_unbound`); validateEngineDag passes
 *    (`dag_invalid`); planned equals the DAG write set (`contract_dag_mismatch`);
 *  - manual: no --dag (`contract_mode_mismatch`); no DAG_BOUND of the run, no <T>.state.json, no <T>.engine.jsonl
 *    (`manual_with_engine_evidence`). Falling back from engine to manual is a new plan version re-approved through
 *    ExitPlanMode (the digest changes). The script cannot prove a ticket is ELEVATED or that the owner understood the
 *    mode; that is the S3c human step. The engine archive directory is not a manual tripwire (an archived earlier
 *    run is not evidence about this one).
 * Steps (any refusal exits 2 and writes no record): approval (the narrative digest equals the last START of the run,
 * `approval_mismatch`), the contract, the mode, then the path set from candidate-id.mjs --base <ref> with exactly the
 * pinned exclusions `.specs/plans/<T>.md` and `session-log.md` (tracked diff against the merge base, no renames, plus
 * untracked non-ignored files; a git-ignored file is invisible to this check exactly as to the candidate ID; a dirty
 * submodule fails candidate-id). candidate-id excludes by prefix, so a changed path strictly below an exclusion file
 * (`session-log.md/x`) is added here as material with flag `under_exclusion_file` (engine follow-up).
 *
 * Classes, first match wins (a path holding a line terminator is always material):
 *  1. planned: equals an entry (via exact) or lies under one (via directory; engine mode matches every entry `w` as
 *     the engine does, globRe(w) or globRe(w/**), via glob when `w` has * or ?), flag unlisted_under_directory_write;
 *  2. supporting: under a supporting entry, kind `file` (never a symlink, deletion or submodule), not a manifest or
 *     lockfile (case-insensitive basename), not executable (flag executable_mode: git index mode, the diff's new mode
 *     or the file-system bit says 100755; on Windows the bit is always clear, so the index mode and the shebang rule
 *     carry it), not starting with `#!` (flag shebang), and under a `docs`
 *     entry only a documentation or asset extension (md, mdx, markdown, txt, rst, adoc, png, jpg, jpeg, gif, svg,
 *     webp, ico, pdf, csv; anything else, json/yaml/toml and extensionless files included, flag docs_not_allowlisted).
 *     Under a tests-class entry any other plain file is supporting by the owner-approved design (D1): production code
 *     placed in a tests-named directory is classified supporting and listed for the reviewer;
 *  3. material: anything else.
 * Advisory flags never change the exit code: case_alias, symlink, symlink_target_outside_contract, submodule,
 * deleted, dependency_manifest, unlisted_under_directory_write, broad_planned, line_terminator, executable_mode,
 * shebang, docs_not_allowlisted, under_exclusion_file. A planned path always matches the engine's Design Contract
 * (designContract + security-plan.mjs globRe), pinned by the property test. Supporting paths are OUTSIDE the Design
 * Contract: CLEAN alone does not establish that every candidate path is inside it. They are listed in the record and
 * the PR body for the reviewer; on an engine policy-2 run the engine's reassess flags them as out-of-plan-path
 * (REAPPROVAL), so engine-run authors put test directories that will change into the DAG writes. Supporting is most
 * useful in manual mode. The record carries the approved contract line (`contract`) for the reviewer.
 *
 * What it proves: the candidate's path set (the set the candidate ID hashes) against the approved contract. What it
 * does not prove: behaviour inside a planned file (a new route inside page.tsx is reassess's new-route signal).
 * A forged record is moot: SHIP recomputes it on the frozen candidate and never trusts a stored one. By design a
 * refusal leaves an earlier record at the default path untouched, and START/DAG_BOUND are read as the engine reads
 * them before init (the last START of the run, no quiescence rule): a stored record is never evidence.
 *
 * Output: the record as JSON on stdout, byte-identical to the file written atomically to --out (default
 * `<git dir>/ai-skills/ship-ticket/<T>.scope.json`, never committed; an --out inside the work tree but outside the
 * git dir is refused), so record_sha = sha256 of stdout.
 * Exit codes: 0 CLEAN, 1 material paths present (listed), 2 refused input, 3 git or candidate-id failure.
 * **Exit 0 is never a commit or freeze permission.**
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readlinkSync, realpathSync, existsSync, lstatSync, openSync, readSync, closeSync } from 'node:fs';
import { resolve, dirname, basename, isAbsolute, join, relative, sep, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEngineDag, planNarrativeDigest, runStateEvents, sha, normDigest, BEGIN, END } from './engine-dag.mjs';
import { parseRunState, malformedReason } from './run-state.mjs';
import { gitPath, writeStateAtomic } from './lib/durable-io.mjs';
import { enginePaths } from './lib/run-placement.mjs';
import { isEntrypoint } from './harness.mjs';

export const SCHEMA = 'ship-ticket-scope-v1';
const CANDIDATE_CLI = fileURLToPath(new URL('./candidate-id.mjs', import.meta.url));
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;
/** Printable ASCII without the characters that can change how a plan renders: < > & ` | " (and backslash, refused by normalRel). */
const ENTRY_CHARS = /^[ !#$%'()*+,\-./0-9:;=?@A-Z[\]^_a-z{}~]+$/;
const CONTROL = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;
const KEYS = 'v,mode,dag,planned,supporting';
const DIGEST = /^sha256:[0-9a-f]{64}$/;
export const SUPPORTING_SEGMENTS = Object.freeze(['tests', 'test', '__tests__', 'spec', 'e2e', 'fixtures', '__fixtures__', 'docs']);
const FORBIDDEN_SEGMENTS = ['.github', '.git', '.claude', '.ship-ticket', '.specs', 'node_modules'];
/** Files a `docs` supporting entry may hold as supporting: documentation and static assets only (closed allowlist). */
const DOCS_ALLOWED = /\.(md|mdx|markdown|txt|rst|adoc|png|jpg|jpeg|gif|svg|webp|ico|pdf|csv)$/i;
const USAGE = 'Usage: check-pr-scope.mjs check --repo <path> --ticket <T> --run-id <id> --base <ref> --plan <plan.md> [--dag <dag.json>] [--out <file>]\n'
  + '       check-pr-scope.mjs lint --plan <plan.md>\n'
  + '       check-pr-scope.mjs contract --verify-quote <saved-quote.txt> --plan <plan.md> [--record <scope.json>]\n'
  + '       check-pr-scope.mjs contract --mode engine|manual [--dag <dag.json>] [--planned <p>]... [--supporting <s>]...';

class Refusal extends Error {
  constructor(exit, code, message) { super(`${code}: ${message}`); this.exit = exit; this.code = code; }
}
const refuse = (code, message) => { throw new Refusal(2, code, message); };
const gitFail = (code, message) => { throw new Refusal(3, code, message); };

/** engine-dag.mjs normalRel (not exported there), kept local; parity with validateEngineDag is pinned by a test. */
export const normalRel = (p) => typeof p === 'string' && p.length > 0 && !isAbsolute(p) && !/^[A-Za-z]:/.test(p) && !p.includes('\\')
  && !p.split('/').some(x => x === '..' || x === '.' || !x);

/** security-plan.mjs normPath + globRe (not exported there; a protected file), kept local; a parity test extracts the real source. */
const normPath = (p) => String(p).replace(/^(\.\/)+/, '');
export function globRe(glob) {
  let g = normPath(glob);
  if (g.endsWith('/')) g += '**';
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === '*' && g[i + 1] === '*') { i++; if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; }
    else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}
/** The engine's Design Contract match of one write `w`: `w` or `w/**` (engine-gates.mjs designContract). */
function engineMatcher(entries) {
  const res = entries.map(w => [w, globRe(w), globRe(`${w}/**`)]);
  return (p) => res.find(([, a, b]) => a.test(p) || b.test(p))?.[0];
}
const literalMatcher = (entries) => (p) => entries.find(w => p === w || p.startsWith(w + '/'));
const hasGlob = (w) => /[*?]/.test(w);
/** A planned entry is broad when it has one segment or a wildcard-only first segment (advisory; the DAG is the engine's breadth authority). */
const isBroad = (w) => !w.includes('/') || /^\*+$/.test(w.split('/')[0]);

/**
 * Whether planned entry `p` (literal or engine glob) and supporting entry `s` (literal) can cover a common path:
 * segment-wise unification, `**` (or any segment containing it, an over-approximation) matching zero or more
 * segments and every other segment matched by the engine's globRe. True when p covers `s` or an ancestor of it
 * (p exhausted first: p/** covers the rest) or when p's leading segments unify with all of `s` (s exhausted first:
 * some descendant of s satisfies the remaining segments). Pinned against brute-force enumeration by a property test.
 */
export function globOverlaps(p, s) {
  const P = p.split('/'), T = s.split('/');
  const seg = P.map(x => (x.includes('**') ? null : globRe(x)));
  const memo = new Map();
  const m = (i, j) => {
    if (i === P.length || j === T.length) return true;
    const k = i * 1024 + j;
    if (memo.has(k)) return memo.get(k);
    const r = seg[i] === null ? m(i + 1, j) || m(i, j + 1) : seg[i].test(T[j]) && m(i + 1, j + 1);
    memo.set(k, r);
    return r;
  };
  return m(0, 0);
}

const MANIFESTS = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'bun.lock', 'bun.lockb', '.npmrc', '.yarnrc', '.yarnrc.yml', 'deno.json', 'deno.jsonc', 'deno.lock', 'Cargo.toml', 'Cargo.lock',
  'go.mod', 'go.sum', 'go.work', 'Gemfile', 'Gemfile.lock', 'requirements.txt', 'Pipfile', 'Pipfile.lock', 'poetry.lock', 'pyproject.toml',
  'uv.lock', 'setup.py', 'setup.cfg', 'composer.json', 'composer.lock', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle',
  'settings.gradle.kts', 'gradle.lockfile', 'packages.lock.json', 'Directory.Packages.props', 'Package.swift', 'Package.resolved',
  'Podfile', 'Podfile.lock', 'mix.exs', 'mix.lock', 'pubspec.yaml', 'pubspec.lock']);
/** A dependency manifest or lockfile, by basename. */
/** A dependency manifest or lockfile, by basename, case-insensitively (a case-insensitive file system aliases PACKAGE.JSON). */
export const isManifest = (p) => { const b = posix.basename(p).toLowerCase(); return MANIFESTS_LOWER.has(b) || /\.(csproj|fsproj|vbproj)$/.test(b) || /^requirements.*\.txt$/.test(b); };
const MANIFESTS_LOWER = new Set([...MANIFESTS].map(m => m.toLowerCase()));

/** Validate a contract object's fields; refuses scope_contract_invalid / supporting_overlaps_planned. Returns it. */
export function validateContract(c) {
  const invalid = (why) => refuse('scope_contract_invalid', why);
  if (c.v !== 1) invalid('v must be 1');
  if (c.mode !== 'engine' && c.mode !== 'manual') invalid('mode must be "engine" or "manual"');
  if (c.mode === 'engine' ? !(typeof c.dag === 'string' && DIGEST.test(c.dag)) : c.dag !== null) invalid('dag must be sha256:<64 hex> in engine mode and null in manual mode');
  const engine = c.mode === 'engine';
  const list = (name, max, len) => {
    const v = c[name];
    if (!Array.isArray(v) || v.length > max || !v.every(e => typeof e === 'string')) invalid(`${name} must be an array of at most ${max} strings`);
    if (new Set(v).size !== v.length) invalid(`${name} holds a duplicate entry`);
    for (const e of v) {
      if (e.length > len || CONTROL.test(e) || !normalRel(e)) invalid(`${name} entry ${JSON.stringify(e)} is not a normalized repository path (no trailing slash, no . or .., no backslash, no control character)`);
      if (!ENTRY_CHARS.test(e)) invalid(`${name} entry ${JSON.stringify(e)} holds a character outside printable ASCII or one of < > & \` | " (they can alter how the plan renders)`);
    }
    return v;
  };
  const planned = engine ? list('planned', 256, 512) : list('planned', 64, 256), supporting = list('supporting', 16, 256);
  if (!engine && !planned.length) invalid('a manual-mode contract plans at least one path');
  for (const p of planned) {
    if (!engine && hasGlob(p)) invalid(`manual-mode planned entry ${JSON.stringify(p)} carries * or ? (literal paths only; brackets and braces are literal)`);
  }
  for (const s of supporting) {
    const segs = s.split('/');
    if (hasGlob(s)) invalid(`supporting entry ${JSON.stringify(s)} carries * or ?`);
    if (!SUPPORTING_SEGMENTS.includes(segs.at(-1))) invalid(`supporting entry ${JSON.stringify(s)} must end in one of ${SUPPORTING_SEGMENTS.join(', ')}`);
    if (segs.some(x => FORBIDDEN_SEGMENTS.includes(x.toLowerCase()))) invalid(`supporting entry ${JSON.stringify(s)} lies under ${FORBIDDEN_SEGMENTS.join(', ')}`);
    if (isManifest(s)) invalid(`supporting entry ${JSON.stringify(s)} is a manifest`);
    for (const p of planned) {
      if (globOverlaps(p.toLowerCase(), s.toLowerCase())) refuse('supporting_overlaps_planned', `supporting entry ${JSON.stringify(s)} overlaps planned entry ${JSON.stringify(p)}`);
    }
  }
  return c;
}

// ---------------------------------------------------------------------------------------------------- the contract block

export const OPENER = '```scope-contract';
export const CLOSER = '```';
/** The ExitPlanMode quote wraps the block in a FOUR-backtick fence (three would be closed by the block's own closer). */
export const QUOTE_FENCE = '````';
/** Every C0 and C1 control except TAB and LF (CR only before LF), DEL, U+2028/2029 and BOM: refused anywhere in the file. */
const FORBIDDEN_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\ufeff]|\r(?!\n)/;
const BLANK = /^[ \t]*$/;
/** A container prefix (blockquote markers, list markers, spaces and tabs), stripped before the fence and HTML tests. */
const CONTAINER = /^(?:[ \t]*(?:>|[-+*](?=[ \t]|$)|\d{1,9}[.)](?=[ \t]|$)))*[ \t]*/;
const DIGEST_LINE = /^contract body: (sha256:[0-9a-f]{64})$/;
/** Printed in every record and by --verify-quote: the owner's qualified-surface approval condition (interface-neutral, 2026-11-24). */
export const APPROVAL_CAVEAT = 'Byte verification only: this does not prove what the owner saw and does not authorize execution. '
  + 'Native ExitPlanMode approval remains mandatory, and it is valid only when given on a qualified approval surface: one that shows '
  + 'the complete, untruncated plan and does not let raw HTML hide or run content (Claude Code terminal, Claude Desktop, Plannotator\'s Approve action). '
  + 'Browser, GitHub and editor previews are never valid approval surfaces.';
/** The exact report when the approval was not a native ExitPlanMode approval on a qualified surface (fail closed). */
export const NOT_VERIFIED_REPORT = 'scope approval NOT verified: the approval was not a native ExitPlanMode approval on a qualified approval surface; do not build';

/**
 * CommonMark 0.31.2 §4.6 HTML block start conditions 1-5 (the ones whose end is not a blank line), as a conservative
 * superset (type 1 fires on any character after the name outside [A-Za-z0-9-]), with their end conditions. Types 6 and
 * 7 end at the next blank line, which R5 guarantees before the opener. Pinned spec wording: see check-pr-scope.test.mjs.
 */
const HTML_BLOCKS = [
  { type: 1, start: /^<(?:pre|script|style|textarea)(?![A-Za-z0-9-])/i, end: /<\/(?:pre|script|style|textarea)>/i },
  { type: 2, start: /^<!--/, end: /-->/ },
  { type: 3, start: /^<\?/, end: /\?>/ },
  { type: 5, start: /^<!\[CDATA\[/, end: /\]\]>/ },
  { type: 4, start: /^<![A-Za-z]/, end: />/ },
];

/**
 * The ONE rule function shared by `lint`, `check` and `contract --verify-quote` (design v3, rules R0-R8, R3b, R10): the
 * plan's single fenced scope-contract block, its canonical validated contract and its body bytes. Refuses (exit 2).
 * A file without RUN-STATE markers is a draft (R4 is then not applicable); with markers the block must precede BEGIN
 * and the RUN-STATE body is held to R0, R2 and R3b like the rest of the file.
 */
export function validatePlanText(text) {
  const unsafe = (why) => refuse('scope_contract_unsafe', why);
  const fc = FORBIDDEN_CHARS.exec(text);
  if (fc) unsafe(`the plan holds a forbidden character U+${fc[0].charCodeAt(0).toString(16).padStart(4, '0')} (only TAB, LF and CRLF are allowed as controls)`);
  const lines = text.split(/\r?\n/);
  const openers = lines.flatMap((l, i) => (l === OPENER ? [i] : []));
  if (!openers.length) {
    const legacy = lines.some(l => l.startsWith('scope-contract: '));
    refuse('scope_contract_missing', `the plan has no \`${OPENER}\` block${legacy ? ' (a legacy bare `scope-contract:` line is never converted: write the fenced block and re-approve through ExitPlanMode)' : ''}`);
  }
  if (openers.length > 1) refuse('scope_contract_ambiguous', `the plan holds ${openers.length} scope-contract blocks; exactly one is allowed`);
  const o = openers[0], body = lines[o + 1], c3 = o + 2;
  if (body === undefined || lines[c3] !== CLOSER) refuse('scope_contract_malformed', 'the scope-contract block is one opener line, one JSON line and one closing ``` line');
  // R2: the key nowhere else (any case), body and RUN-STATE body included.
  const mention = lines.findIndex((l, i) => i !== o && /scope-contract/i.test(l));
  if (mention >= 0) refuse('scope_contract_ambiguous', `line ${mention + 1} mentions scope-contract outside the block opener`);
  // R3a: no 3+ backtick or tilde run anywhere on a line before the closer; R3b: no fence-starting line anywhere else.
  const before = lines.findIndex((l, i) => i < c3 && i !== o && /`{3,}|~{3,}/.test(l));
  if (before >= 0) unsafe(`line ${before + 1} holds a run of 3+ backticks or tildes before the scope-contract block closes`);
  const fence = lines.findIndex((l, i) => (i < o || i > c3) && /^(`{3,}|~{3,})/.test(l.replace(CONTAINER, '')));
  if (fence >= 0) unsafe(`line ${fence + 1} starts a code fence; a plan holds no fenced block other than the scope-contract block`);
  // R4: before RUN-STATE.
  const begin = lines.findIndex(l => l.includes(BEGIN));
  if (begin >= 0 && c3 > begin) unsafe('the scope-contract block must come before the RUN-STATE block');
  // R5: a blank line directly before the opener and after the closer (or end of file), with no exception.
  if (o === 0 || !BLANK.test(lines[o - 1])) unsafe('the scope-contract block needs a blank line directly before it');
  if (c3 + 1 < lines.length && !BLANK.test(lines[c3 + 1])) unsafe('the scope-contract block needs a blank line directly after it');
  // R7: front matter, triggered by any first line starting with --- or +++; closed by the same token before the block.
  const fm = /^(---|\+\+\+)/.exec(lines[0]);
  if (fm) {
    const close = lines.findIndex((l, i) => i > 0 && l.replace(/[ \t]+$/, '') === fm[1]);
    if (close < 0 || close >= o - 1) unsafe(`front matter opened by ${fm[1]} must close with ${fm[1]} before the scope-contract block, with a blank line between`);
    const dots = lines.findIndex((l, i) => i > 0 && i < close && l.replace(/[ \t]+$/, '') === '...');
    if (dots >= 0) unsafe(`line ${dots + 1}: a ... line inside front matter is an ambiguous terminator`);
  }
  // R6: HTML blocks of types 1-5 opened before the block must end before the blank line that precedes it.
  for (let i = 0; i < o - 1; i++) {
    const s = lines[i].replace(CONTAINER, '');
    const h = HTML_BLOCKS.find(t => t.start.test(s));
    if (!h) continue;
    let j = i;
    if (!h.end.test(s.slice(h.type === 2 ? 4 : 1))) { j = i + 1; while (j < o - 1 && !h.end.test(lines[j])) j++; }
    if (j >= o - 1) unsafe(`line ${i + 1} opens an HTML block (type ${h.type}) that does not end before the scope-contract block`);
    // No skip to j: a container close can end the block earlier than its end string, so every later line is checked
    // again as a possible start (a superset: it only adds refusals). Live-oracle survivor: `><script>` ... `<?x`.
  }
  // R8: no $$ before the block.
  const math = lines.findIndex((l, i) => i < o && l.includes('$$'));
  if (math >= 0) unsafe(`line ${math + 1} holds $$ (display math) before the scope-contract block`);
  // The body: canonical JSON, then the field rules.
  const engineLike = body.startsWith('{"v":1,"mode":"engine"');
  if (Buffer.byteLength(body) > (engineLike ? 65536 : 8192)) refuse('scope_contract_noncanonical', 'the contract body exceeds 8 KiB (64 KiB in engine mode)');
  let c;
  try { c = JSON.parse(body); } catch { refuse('scope_contract_noncanonical', 'the contract body is not JSON'); }
  if (c === null || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).join(',') !== KEYS || JSON.stringify(c) !== body) {
    refuse('scope_contract_noncanonical', `the contract body must be canonical JSON with keys ${KEYS} in that order (no whitespace, escapes or extra keys)`);
  }
  validateContract(c);
  // R10: exactly one `contract body:` line in the narrative before RUN-STATE, equal to SHA-256 of the body bytes.
  const digestLines = lines.flatMap((l, i) => ((begin < 0 || i < begin) && /^contract body:/i.test(l) ? [i] : []));
  if (!digestLines.length) refuse('contract_body_digest_missing', 'the plan needs one `contract body: sha256:<hex>` line (printed by `check-pr-scope.mjs contract`)');
  if (digestLines.length > 1) refuse('contract_body_digest_ambiguous', `the plan holds ${digestLines.length} contract body lines; exactly one is allowed`);
  const bodySha = sha(body);
  const m = DIGEST_LINE.exec(lines[digestLines[0]]);
  if (!m || m[1] !== bodySha) refuse('contract_body_digest_mismatch', `the contract body line must read exactly \`contract body: ${bodySha}\``);
  return { contract: c, body, bodySha };
}

/** The plan's contract (the validated block); refuses (exit 2) otherwise. */
export const parseContract = (text) => validatePlanText(text).contract;

/** The canonical body for `c` (keys in order, arrays sorted). */
const canonicalBody = (c) => JSON.stringify({ v: 1, mode: c.mode, dag: c.dag, planned: [...c.planned].sort(), supporting: [...c.supporting].sort() });

/** The block, its digest line and the ExitPlanMode quote for a canonical body. */
export function contractOutput(body) {
  const block = `${OPENER}\n${body}\n${CLOSER}`;
  return { block, digestLine: `contract body: ${sha(body)}`, quote: `${QUOTE_FENCE}\n${block}\n${QUOTE_FENCE}` };
}

/** The canonical contract output for `c`, validated through the same rule function as a plan. */
export function contractFor(c) {
  const out = contractOutput(canonicalBody(c));
  validatePlanText(`\n${out.block}\n\n${out.digestLine}\n`);
  return out;
}

/**
 * Byte-compare the quoted body (`quoteText` must be exactly the four-backtick quote block the orchestrator extracted
 * from the approval request it sent; nothing else) with the plan block and, when given, the record's `contract`; recompute SHA-256 against the plan's digest line
 * and the record's `contract_sha256`. Returns { ok, lines }. A human/orchestrator step: it cannot know the saved quote
 * is what the owner saw.
 */
export function verifyQuote(quoteText, planText, record) {
  const out = [];
  const fail = (why) => ({ ok: false, lines: [...out, `verify-quote: FAIL: ${why}`] });
  if (FORBIDDEN_CHARS.test(quoteText)) return fail('the quote holds a control character, BOM or lone CR');
  // PRECISE INPUT DEFINITION: the saved file is exactly the quote that `contract` prints (four-backtick fence, opener,
  // body, closer, four-backtick fence), optionally surrounded by whitespace-only lines; CRLF is normalized. Any other
  // non-blank line fails, so no second contract, lookalike key, zero-width character or stray fence can be present.
  const all = quoteText.split(/\r?\n/), at = all.flatMap((l, i) => (BLANK.test(l) ? [] : [i])), q = at.map(i => all[i]);
  if (!(q.length === 5 && at[4] - at[0] === 4 && q[0] === QUOTE_FENCE && q[1] === OPENER && q[3] === CLOSER && q[4] === QUOTE_FENCE)) {
    return fail('saved text must be only the quote; save the quote block extracted from the request, prose belongs elsewhere');
  }
  const quoted = q[2];
  const plan = validatePlanText(planText);
  const diff = (a, b) => { let k = 0; while (k < a.length && a[k] === b[k]) k++; return k; };
  if (quoted !== plan.body) return fail(`the quoted body differs from the plan block at character ${diff(quoted, plan.body)}`);
  out.push(`verify-quote: quoted body equals the plan block (${plan.bodySha})`);
  if (record !== undefined) {
    if (record.contract !== quoted) return fail(`the quoted body differs from record.contract at character ${diff(quoted, String(record.contract ?? ''))}`);
    if (record.contract_sha256 !== sha(quoted)) return fail('record.contract_sha256 is not the SHA-256 of the quoted body');
    out.push('verify-quote: quoted body equals record.contract and record.contract_sha256');
  }
  return { ok: true, lines: [...out, 'verify-quote: PASS'] };
}

// ---------------------------------------------------------------------------------------------------- classification

/** Where a symlink at repo path `p` with link text `target` points, repo-relative, or null when outside the repository. */
function linkTarget(p, target) {
  const t = String(target).replace(/\\/g, '/');
  if (posix.isAbsolute(t) || win32.isAbsolute(target)) return null;
  const n = posix.normalize(posix.join(posix.dirname(p), t));
  return n === '..' || n.startsWith('../') ? null : n.replace(/\/$/, '');
}

/**
 * Classify candidate entries [{ path, kind }] against a contract's mode, planned and supporting entries (see the
 * header for the rules). `readlink(path)` returns a symlink's link text. Returns [{ path, kind, class, via, flags }].
 */
export function classify(entries, { mode, planned, supporting, readlink, readHead = () => '' }) {
  const make = mode === 'engine' ? engineMatcher : literalMatcher;
  const match = make(planned), lower = make(planned.map(p => p.toLowerCase()));
  const supportMatch = literalMatcher(supporting);
  const self = mode === 'engine' ? planned.map(w => [w, globRe(w)]) : [];
  return entries.map(({ path, kind, mode: gitMode }) => {
    const flags = [];
    if (kind === 'symlink') {
      flags.push('symlink');
      let target = null;
      try { target = linkTarget(path, readlink(path)); } catch { /* unreadable: outside */ }
      if (target === null || LINE_TERMINATOR.test(target) || !(match(target) || supportMatch(target))) flags.push('symlink_target_outside_contract');
    }
    if (kind === 'submodule') flags.push('submodule');
    if (kind === 'deleted') flags.push('deleted');
    const manifest = isManifest(path);
    if (manifest) flags.push('dependency_manifest');
    let cls = 'material', via = null;
    const root = LINE_TERMINATOR.test(path) ? undefined : planned.includes(path) ? path : match(path);
    const support = root === undefined && !LINE_TERMINATOR.test(path) ? supportMatch(path) : undefined;
    if (LINE_TERMINATOR.test(path)) flags.push('line_terminator');
    else if (root === path) { cls = 'planned'; via = 'exact'; }
    else if (root !== undefined) {
      cls = 'planned'; via = mode === 'engine' && hasGlob(root) ? 'glob' : 'directory';
      // a glob entry that matches the path itself lists it; only coverage from below is unlisted
      if (!(via === 'glob' && self.some(([w, re]) => w === root && re.test(path)))) flags.push('unlisted_under_directory_write');
      if (isBroad(root)) flags.push('broad_planned');
    } else if (support !== undefined) {
      if (kind === 'file' && !manifest) {
        if (gitMode === '100755') flags.push('executable_mode');
        let head = '';
        try { head = String(readHead(path) ?? ''); } catch { head = '#!'; /* unreadable: fail closed */ }
        if (head.startsWith('#!')) flags.push('shebang');
        if (support.split('/').at(-1) === 'docs' && !DOCS_ALLOWED.test(path)) flags.push('docs_not_allowlisted');
        if (!flags.some(x => ['executable_mode', 'shebang', 'docs_not_allowlisted'].includes(x))) { cls = 'supporting'; via = 'supporting'; }
      }
    } else if (lower(path.toLowerCase())) flags.push('case_alias');
    return { path, kind, class: cls, via, flags };
  });
}

// ---------------------------------------------------------------------------------------------------- git and files

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) gitFail('git_failed', `git ${args.join(' ')}: ${(r.stderr || r.error?.message || '').trim()}`);
  return r.stdout.trim();
}
/** NUL-separated git output, split (no trim: a path may start or end with a space). */
function gitZ(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) gitFail('git_failed', `git ${args.join(' ')}: ${(r.stderr || r.error?.message || '').trim()}`);
  return r.stdout.split('\0').filter(Boolean);
}
/** candidate-id.mjs's kinds for a work-tree path: symlink, file, submodule (a directory) or deleted. */
function kindOf(abs) {
  try { const st = lstatSync(abs); return st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'submodule' : 'file'; } catch { return 'deleted'; }
}
/** realpath of `p`, or of its nearest existing ancestor joined with the rest (the file may not exist yet). */
function realish(p) {
  const abs = resolve(p);
  if (existsSync(abs)) return realpathSync.native(abs); // native: expands Windows 8.3 short names as git reports them
  const parent = dirname(abs);
  return parent === abs ? abs : join(realish(parent), basename(abs));
}
const inside = (p, dir) => { const r = relative(dir, p); return r === '' || (!r.startsWith('..' + sep) && r !== '..' && !isAbsolute(r)); };

/** The approved plan's text, digest and events; refuses unless this run's last START approves the current narrative. */
function approvedPlan(planFile, runId) {
  let text;
  try { text = readFileSync(planFile, 'utf8'); } catch (e) { refuse('plan_unreadable', `${planFile}: ${e.code ?? e.message}`); }
  const R = parseRunState(text);
  if (!R) refuse('approval_mismatch', `${planFile} has no RUN-STATE block`);
  const malformed = malformedReason(R);
  if (malformed) refuse('run_state_malformed', malformed);
  const digest = planNarrativeDigest(text);
  const events = runStateEvents(text);
  const start = events.filter(e => e.event === 'START' && e.run_id === runId).at(-1);
  if (!start || normDigest(start.approved_plan_digest) !== digest) refuse('approval_mismatch', `plan narrative does not match the last START of ${runId}`);
  return { text, digest, events };
}

/** A DAG file's digest and validated document; refuses dag_invalid. */
function readDag(dagFile, ticket) {
  let raw, doc;
  try { raw = readFileSync(dagFile); } catch (e) { refuse('dag_invalid', `${dagFile}: ${e.code ?? e.message}`); }
  try { doc = JSON.parse(raw); } catch { refuse('dag_invalid', 'the DAG is not JSON'); }
  let dag;
  try { dag = validateEngineDag(doc, ticket ? { ticket } : {}); } catch (e) { refuse('dag_invalid', e.message); }
  return { digest: sha(raw), writes: [...new Set(dag.nodes.flatMap(n => n.writes))].sort() };
}

/** The mode checks of the contract `c` (see the header); refuses dag_required, dag_unbound, contract_* or manual_with_engine_evidence. */
function bindMode(c, { repo, ticket, runId, events, dag }) {
  const bound = events.filter(e => e.event === 'DAG_BOUND' && e.run_id === runId);
  if (c.mode === 'manual') {
    if (dag !== undefined) refuse('contract_mode_mismatch', 'the approved contract is manual mode; --dag is for an engine-mode contract');
    const base = `ai-skills/ship-ticket/${ticket}`;
    // S1: a durable run's state is in its common-dir run directory (lib/run-placement.mjs); both placements count as evidence
    const placed = (() => { try { return enginePaths(repo, ticket); } catch { return { state: 'ambiguous' }; } })();
    const evidence = bound.length ? 'a DAG_BOUND of this run' : placed?.state === 'ambiguous' ? 'engine state in two placements'
      : placed ? placed.state : existsSync(gitPath(repo, `${base}.engine.jsonl`)) ? `${base}.engine.jsonl` : null;
    if (evidence) refuse('manual_with_engine_evidence', `the contract is manual mode but ${evidence} exists; an engine run needs an engine-mode contract (re-approve through ExitPlanMode)`);
    return;
  }
  if (dag === undefined) refuse('dag_required', 'the approved contract is engine mode: pass the bound DAG with --dag (a failed engine init does not make a run manual)');
  const d = readDag(dag, ticket);
  if (d.digest !== c.dag) refuse('dag_unbound', `the --dag file is ${d.digest}, the approved contract names ${c.dag}`);
  if (bound.length && !(bound.length === 1 && normDigest(bound[0].dag_digest) === d.digest)) refuse('dag_unbound', 'the run has DAG_BOUND events but not exactly one naming this DAG');
  const planned = [...new Set(c.planned)].sort();
  if (planned.join('\0') !== d.writes.join('\0')) refuse('contract_dag_mismatch', `planned ${JSON.stringify(planned)} differs from the DAG writes ${JSON.stringify(d.writes)}`);
}

// ---------------------------------------------------------------------------------------------------- the check

/** Run the check; returns { exit, record, text } or throws a Refusal (exit 2 or 3). Writes nothing itself. */
export function checkScope({ repo, ticket, runId, base, plan, dag }) {
  if (!SAFE_ID.test(ticket ?? '')) refuse('bad_input', `unsafe --ticket ${JSON.stringify(ticket)}`);
  if (!SAFE_ID.test(runId ?? '')) refuse('bad_input', `unsafe --run-id ${JSON.stringify(runId)}`);
  if (typeof base !== 'string' || !base || base.startsWith('-')) refuse('bad_input', `refused ref: ${base}`);
  const approved = approvedPlan(plan, runId);
  const block = validatePlanText(approved.text);
  const c = block.contract;
  bindMode(c, { repo, ticket, runId, events: approved.events, dag });
  const exclusions = [`.specs/plans/${ticket}.md`, 'session-log.md'];
  const r = spawnSync(process.execPath, [CANDIDATE_CLI, '--repo', repo, '--base', base, ...exclusions.flatMap(x => ['--exclude', x])],
    { encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) gitFail('candidate_id_failed', `candidate-id: ${(r.stderr || r.error?.message || 'failed').trim()}`);
  let cand;
  try { cand = JSON.parse(r.stdout); } catch { gitFail('candidate_id_failed', 'candidate-id printed no JSON'); }
  const top = git(repo, ['rev-parse', '--show-toplevel']);
  const readHead = (p) => { const fd = openSync(join(top, p), 'r'); try { const b = Buffer.alloc(2); return b.subarray(0, readSync(fd, b, 0, 2, 0)).toString('latin1'); } finally { closeSync(fd); } };
  // candidate-id reports the file-system mode; with core.filemode=false (and always on Windows) the git index or the
  // diff carries an executable bit the file system does not. A path is executable when ANY of them says 100755.
  const exec = new Set();
  for (const rec of gitZ(top, ['ls-files', '-s', '-z'])) { const m = /^(\d{6}) [0-9a-f]+ \d\t(.*)$/s.exec(rec); if (m && m[1] === '100755') exec.add(m[2]); }
  // The diff's new mode is belt and braces: for a work-tree diff git takes it from the index when core.filemode=false,
  // so no reachable state found so far sets it without the index; it is kept so a future source of the bit is not lost.
  const raw = gitZ(top, ['diff', '--raw', '-z', '--no-renames', cand.merge_base, '--']);
  for (let i = 0; i + 1 < raw.length; i += 2) { const m = /^:\d{6} (\d{6}) /.exec(raw[i]); if (m && m[1] === '100755') exec.add(raw[i + 1]); }
  const files = classify(cand.paths.map(p => ({ path: p.path, kind: p.kind, mode: exec.has(p.path) ? '100755' : p.mode })), { mode: c.mode, planned: c.planned, supporting: c.supporting, readlink: (p) => readlinkSync(join(top, p)), readHead });
  // candidate-id excludes by prefix, so a path below an exclusion FILE (session-log.md/x, the plan path used as a
  // directory) is missing from its set; enumerate the same way (tracked diff + untracked, non-ignored) and flag it.
  const changed = [...gitZ(top, ['diff', '--name-only', '-z', '--no-renames', cand.merge_base, '--']),
    ...gitZ(top, ['ls-files', '--others', '--exclude-standard', '-z', '--'])];
  for (const path of [...new Set(changed.filter(p => exclusions.some(x => p.startsWith(x + '/'))))].sort()) {
    const kind = kindOf(join(top, path));
    files.push({ path, kind, class: 'material', via: null, flags: ['under_exclusion_file', ...(kind === 'file' ? [] : [kind])] });
  }
  const count = (k) => files.filter(f => f.class === k).length;
  const counts = { planned: count('planned'), supporting: count('supporting'), material: count('material'), total: files.length };
  const record = { schema: SCHEMA, ticket, run_id: runId, base, merge_base: cand.merge_base, candidate_id: cand.candidate_id,
    approved_plan_digest: approved.digest, mode: c.mode, dag_digest: c.dag, roots: [...c.planned].sort(), supporting: [...c.supporting].sort(),
    broad_planned: c.planned.filter(isBroad).sort(), contract: block.body, contract_sha256: block.bodySha, approval_caveat: APPROVAL_CAVEAT, exclusions, files, counts, outcome: counts.material ? 'MATERIAL' : 'CLEAN' };
  return { exit: counts.material ? 1 : 0, record, text: JSON.stringify(record, null, 1) + '\n' };
}

/** Where the record goes: --out (refused inside the work tree unless inside the git dir) or the git-dir default. */
function outPath(repo, ticket, out) {
  const top = realish(git(repo, ['rev-parse', '--show-toplevel']));
  if (out === undefined) return gitPath(top, `ai-skills/ship-ticket/${ticket}.scope.json`);
  const target = realish(out);
  const gitDirs = [git(repo, ['rev-parse', '--absolute-git-dir']), resolve(top, git(repo, ['rev-parse', '--git-common-dir']))].map(realish);
  if (inside(target, top) && !gitDirs.some(d => inside(target, d))) refuse('out_in_work_tree', `--out ${out} is inside the work tree; the record is never committed (use the git dir or a path outside the repository)`);
  return target;
}

/** Parse `--flag value` pairs; `repeat` names flags that may repeat (collected into arrays). Returns null on a bad argument. */
function flags(rest, allowed, repeat = []) {
  const f = {};
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i]?.startsWith('--') ? rest[i].slice(2) : null;
    if (!allowed.includes(k) || rest[i + 1] === undefined) return null;
    if (repeat.includes(k)) (f[k] ??= []).push(rest[i + 1]);
    else if (Object.hasOwn(f, k)) return null;
    else f[k] = rest[i + 1];
  }
  return f;
}

const readText = (file, code) => { try { return readFileSync(file, 'utf8'); } catch (e) { return refuse(code, `${file}: ${e.code ?? e.message}`); } };

/** Print the block, the digest line and the four-backtick quote (the order a plan and an ExitPlanMode request use them). */
const printContract = (out) => process.stdout.write(`${out.block}\n\n${out.digestLine}\n\n${out.quote}\n`);

function contractCommand(rest) {
  if (rest[0] === '--verify-quote') {
    const f = flags(rest, ['verify-quote', 'plan', 'record']);
    if (!f || !f['verify-quote'] || !f.plan) { process.stderr.write(USAGE + '\n'); return 2; }
    let record;
    if (f.record !== undefined) { try { record = JSON.parse(readText(f.record, 'record_unreadable')); } catch (e) { if (e instanceof Refusal) throw e; refuse('record_unreadable', `${f.record} is not JSON`); } }
    const r = verifyQuote(readText(f['verify-quote'], 'quote_unreadable'), readText(f.plan, 'plan_unreadable'), record);
    process.stdout.write(`${r.lines.join('\n')}\nCAVEAT: ${APPROVAL_CAVEAT}\nIf the approval surface did not meet that requirement, report exactly: ${NOT_VERIFIED_REPORT}\n`);
    return r.ok ? 0 : 1;
  }
  const f = flags(rest, ['mode', 'dag', 'planned', 'supporting'], ['planned', 'supporting']);
  if (!f || !['engine', 'manual'].includes(f.mode) || (f.mode === 'engine') !== (f.dag !== undefined)) { process.stderr.write(USAGE + '\n'); return 2; }
  const d = f.dag === undefined ? null : readDag(resolve(f.dag));
  printContract(contractFor({ mode: f.mode, dag: d?.digest ?? null, planned: f.planned ?? d?.writes ?? [], supporting: f.supporting ?? [] }));
  return 0;
}

/** `lint --plan P`: the same rule function as `check`, on the plan file alone (no git, no START); prints the contract output. */
function lintCommand(rest) {
  const f = flags(rest, ['plan']);
  if (!f || !f.plan) { process.stderr.write(USAGE + '\n'); return 2; }
  const text = readText(f.plan, 'plan_unreadable');
  const b = validatePlanText(text);
  printContract(contractOutput(b.body));
  process.stderr.write(`check-pr-scope lint: PASS${text.includes(BEGIN) ? '' : ' (draft: no RUN-STATE)'}\n`);
  return 0;
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'contract') return contractCommand(rest);
    if (cmd === 'lint') return lintCommand(rest);
    const f = cmd === 'check' ? flags(rest, ['repo', 'ticket', 'run-id', 'base', 'plan', 'dag', 'out']) : null;
    if (!f || !f.repo || !f.ticket || !f['run-id'] || !f.base || !f.plan) { process.stderr.write(USAGE + '\n'); return 2; }
    const repo = resolve(f.repo);
    // Check the --base and identity inputs before touching git, then the output location before any work.
    if (String(f.base).startsWith('-')) refuse('bad_input', `refused ref: ${f.base}`);
    if (!SAFE_ID.test(f.ticket)) refuse('bad_input', `unsafe --ticket ${JSON.stringify(f.ticket)}`);
    const out = outPath(repo, f.ticket, f.out);
    const res = checkScope({ repo, ticket: f.ticket, runId: f['run-id'], base: f.base, plan: resolve(f.plan), dag: f.dag === undefined ? undefined : resolve(f.dag) });
    try { await writeStateAtomic(out, res.record); } catch (e) { gitFail('record_write_failed', `${out}: ${e.code ?? e.message}`); }
    process.stdout.write(res.text);
    if (res.exit === 1) process.stderr.write('check-pr-scope: MATERIAL\n' + res.record.files.filter(x => x.class === 'material').map(x => `  ${x.path}${x.flags.length ? ` (${x.flags.join(', ')})` : ''}`).join('\n') + '\n');
    return res.exit;
  } catch (e) {
    if (e instanceof Refusal) { process.stderr.write(`check-pr-scope: ${e.message}\n`); return e.exit; }
    if (e?.code === 'plan_invalid') { process.stderr.write(`check-pr-scope: ${e.message}\n`); return 2; }
    if (e?.code === 'not_a_repo') { process.stderr.write(`check-pr-scope: ${e.message}\n`); return 3; }
    process.stderr.write(`check-pr-scope: ${e?.stack ?? e}\n`);
    return 3;
  }
}

if (isEntrypoint(import.meta.url)) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
