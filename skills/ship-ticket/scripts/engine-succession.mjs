/**
 * PR-4b (STAB S3-min, P4): in-run base and candidate succession, opt-in (`config.succession: { version: 1 }`; it needs
 * config.pinnedBase and the durable placement, and records the succession policy twin, engine-policy.mjs SUCCESSION_OFFSET).
 * Node built-ins only. UNQUALIFIED: behind the flag, not activated for any real run by this change (activation is an owner item).
 *
 * Old path replaced, for opted-in runs only (every other run is unchanged, byte for byte):
 * - "archive the run and start a new one" when the base moves (engine-base-read.mjs pinnedBaseRefusal, engine-identity.mjs
 *   verifyFrozenBase, both through movedRoute): a SUCCESSOR GENERATION recorded in-run by `run-engine.mjs succeed`;
 * - the HEAD fallback of baseRef (engine-dag.mjs): a succession run is always pinned (the DAG refuses it otherwise);
 * - RED re-proved on a hand-reverted tree: RED runs in a detached worktree of the APPROVED BASE plus the approved test-input
 *   overlay, after the DAG-declared environment setup (D-RED, below);
 * - post-freeze drift routed to an owner RETRY: an in-scope correction (F) or a mode-only change is a recorded generation.
 *
 * C2 SAFE DEFAULT (a), owner-approved: EVERY generation that follows a review invalidates the review evidence and authorizes
 * ONE fresh full original review (primary plus independent second opinion, the review gate's normal contract) naming the
 * generation, with no RETRY written or synthesized. There is no assessment, no review retention and no classification of
 * free text (the lexical classifier work is permanently stopped). RED and the local proof are renewed on the new approved base.
 * The fresh review counts in the two-round rule: after two unsuccessful review rounds any review-opening generation needs an
 * RCA record { differs, evidence } naming the different path (§7.1). Rounds and the review chain are never reset.
 *
 * ONE lifecycle owner for the transition (succeed): the predecessor stays authoritative until the successor's ONE atomic state
 * commit. Before it, the transition is recorded `prepared` in the state (old head, run-private retained ref) and the
 * predecessor commits are retained with an expected-old `git update-ref` (create-only), so a later destructive rebase or ref
 * move never makes them unreachable. A crash leaves exactly one of: nothing (old authoritative), a prepared transition (still
 * old authoritative; the next succeed resumes it, idempotently) or the committed generation (the transition record is removed
 * in that same commit). `succeed --prepare true` records the transition and retains the current HEAD BEFORE a rebase.
 *
 * Preserved across a generation: completed node outputs and their (re-recorded) fingerprints, attempts, the review chain, RCA
 * history, rounds, stage obligations (S.stage), operation ids and the event log. Unit evidence is rebound through its own
 * binding (base commit, fingerprints): units the generation invalidates get one generation-authorized re-check and unit
 * re-review that spend no run-wide ceiling and count no invalidation storm (engine-units.mjs, engine-unit-review.mjs).
 */
import { lstatSync, readFileSync, readlinkSync, mkdirSync, rmSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir, devNull } from 'node:os';
import { join, posix } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { coded, note, overlap, isObj, successionOn, clampTimeout, judgment } from './engine-dag.mjs';
import { underHardenedGit, pinBaseRecord, baseCandidate } from './engine-base-read.mjs';
import { authGit } from './engine-base.mjs';
import { invalidateRed } from './engine-attempts.mjs';
import { unitStates, hasUnits } from './engine-units.mjs';
import { retire, leaderStart } from './engine-quiesce.mjs';
import { armAttempt } from './lib/deadline.mjs';
import * as io from './engine-io.mjs';

export { successionOn };
export const SUCCESSION_VERSION = 1;
/** The runner-output parser version a run reads RED with (gate.mjs PARSER_VERSIONS): 2 on a succession run, else the frozen 1. */
export const parserOf = (S) => (successionOn(S) ? 2 : 1);

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const digest = (data) => 'sha256:' + createHash('sha256').update(data).digest('hex');
const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
const no = (code, reasons, extra = {}) => ({ ok: false, code, judgment_point: true, reasons, ...extra });
const git = (root, args, opts) => underHardenedGit(() => authGit(root, args, opts));

// ---------------------------------------------------------------------------
// Delta manifests

/**
 * The complete base delta `from`..`to` (commits), read hardened: every changed path with its status, modes and blobs (renames
 * off, so a rename is a delete plus an add), sorted by path, plus the digest of the full patch. Throws base_delta_unavailable.
 */
export function baseDelta(root, from, to) {
  if (!SHA.test(from) || !SHA.test(to)) throw coded('base_delta_unavailable', `base delta needs two commits, got ${from} .. ${to}`);
  const raw = git(root, ['diff', '--raw', '-z', '--no-renames', '--no-abbrev', '--no-ext-diff', from, to], { maxBuffer: 64 * 1024 * 1024 });
  if (raw.status !== 0) throw coded('base_delta_unavailable', `git diff --raw ${from} ${to}: ${raw.stderr.trim()}`);
  const tok = raw.stdout.split('\0');
  const entries = [];
  for (let i = 0; i + 1 < tok.length; i += 2) {
    const m = tok[i].match(/^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/);
    if (!m) { if (tok[i] === '') break; throw coded('base_delta_unavailable', `unparseable raw diff header ${JSON.stringify(tok[i])}`); }
    entries.push({ path: tok[i + 1], status: m[5], old_mode: m[1], new_mode: m[2], old_blob: m[3], new_blob: m[4] });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const patch = git(root, ['diff', '--no-renames', '--no-ext-diff', '--no-color', '--full-index', from, to], { maxBuffer: 256 * 1024 * 1024 });
  if (patch.status !== 0) throw coded('base_delta_unavailable', `git diff ${from} ${to}: ${patch.stderr.trim()}`);
  return { entries, patch_digest: digest(patch.stdout) };
}

/** Per-path identity of a candidate (the candidate-id.mjs fields: kind, mode, content digest) for `paths` under `root`. */
export function candidateManifest(root, paths) {
  const files = {};
  for (const p of [...new Set(paths)].sort()) {
    const abs = join(root, p);
    let entry = { kind: 'deleted', mode: '0', digest: digest('tombstone') };
    try {
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) entry = { kind: 'symlink', mode: '120000', digest: digest(readlinkSync(abs)) };
      else if (st.isFile()) entry = { kind: 'file', mode: (st.mode & 0o111) === 0 ? '100644' : '100755', digest: digest(readFileSync(abs)) };
      else entry = { kind: 'other', mode: '0', digest: digest('other') };
    } catch { /* deleted */ }
    files[p] = entry;
  }
  return files;
}

/** The candidate delta between two manifests: [{ path, change: content|mode|added|removed|kind, old, new }], sorted. */
export function candidateDelta(from, to) {
  const out = [];
  for (const p of [...new Set([...Object.keys(from ?? {}), ...Object.keys(to ?? {})])].sort()) {
    const a = from?.[p] ?? null, b = to?.[p] ?? null;
    if (a && b && a.kind === b.kind && a.mode === b.mode && a.digest === b.digest) continue;
    const change = !a ? 'added' : !b ? 'removed' : a.kind !== b.kind ? 'kind' : a.digest !== b.digest ? 'content' : 'mode';
    out.push({ path: p, change, old: a, new: b });
  }
  return out;
}

/** The last accepted review that authorizes ship (original or confirmation PASS), or null. */
const authorizingReview = (S) => {
  const last = (S.review_chain ?? []).at(-1);
  return last && ['original', 'confirmation'].includes(last.kind) && last.outcome === 'PASS' ? last : null;
};

/** Unsuccessful review rounds on this run, across every generation: FAIL originals and confirmations (append-only chain). */
export const unsuccessfulRounds = (S) => (S.review_chain ?? []).filter(r => ['original', 'confirmation'].includes(r.kind) && r.outcome === 'FAIL').length;

// ---------------------------------------------------------------------------
// D-RED: RED on the approved base, in a declared environment, plus the approved test-input overlay

const IMPORT_RE = /(?:\bimport\s*(?:[^'"`;]*?\bfrom\s*)?|\bexport\s+[^'"`;]*?\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"\n]+)['"]/g;
const SCANNED = /\.(?:[cm]?[jt]sx?)$/;
const EXTENSIONS = ['', '.mjs', '.js', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts', '/index.mjs', '/index.js', '/index.ts'];
const transitiveDependents = (S, id) => {
  const out = new Set(), stack = [id];
  while (stack.length) { const x = stack.pop(); for (const [k, n] of Object.entries(S.nodes)) if ((n.deps ?? []).includes(x) && !out.has(k)) { out.add(k); stack.push(k); } }
  return [...out];
};
const inBase = (root, commit, p) => git(root, ['cat-file', '-e', `${commit}:${p}`]).status === 0;

/**
 * The overlay for RED of `node` on base `commit` (the changed-helper falsification, kept from S3): the node's spec files plus
 * every file they import (transitively, relative JS/TS imports) that the candidate changed and the RED node itself writes (its
 * own test inputs). -> { ok: true, overlay: [{ path, from }] } | refusal: red_overlay_implementation (an overlaid input is also a
 * dependent's write: candidate implementation), red_helper_dependency (an imported candidate-changed file outside the RED
 * node's and its dependents' writes), red_baseline_missing (an imported file the implementation adds that does not exist on
 * the base and has no designed baseline harness: Blocked). Files the candidate changed inside the dependents' writes are the
 * implementation under test: the base version is used. Package imports are resolved by the declared environment only.
 */
export function redOverlay(root, S, node, specs, commit, changedPaths) {
  const n = S.nodes[node], changed = new Set(changedPaths);
  const own = n.writes ?? [], impl = transitiveDependents(S, node).flatMap(d => S.nodes[d].writes ?? []);
  const harness = new Map((n.redBaseline ?? []).map(b => [b.path, b.harness]));
  const overlay = new Map(), queue = [];
  const add = (path, from) => { if (overlay.has(path)) return; overlay.set(path, from); queue.push(from); };
  for (const s of specs) add(s.file, s.file);
  while (queue.length) {
    const file = queue.shift();
    if (!SCANNED.test(file)) continue;
    let text;
    try { text = readFileSync(join(root, file), 'utf8'); } catch { continue; } // a missing spec fails RED on its own (spec_missing / load)
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1];
      if (!spec.startsWith('./') && !spec.startsWith('../')) continue; // packages: the declared environment only (never the checkout's)
      const target = posix.normalize(posix.join(posix.dirname([...overlay.entries()].find(([, f]) => f === file)?.[0] ?? file), spec));
      if (target.startsWith('../')) return no('red_helper_dependency', [`${file} imports ${spec}, outside the repository`]);
      const resolved = EXTENSIONS.map(x => target + x);
      const hitBase = resolved.find(p => inBase(root, commit, p));
      const hitCand = resolved.find(p => changed.has(p) || existsSync(join(root, p)));
      const isImpl = (p) => impl.some(w => overlap(p, w)), isOwn = (p) => own.some(w => overlap(p, w));
      if (!hitBase) { // the base has no such file: a file the candidate adds (or will add), or a broken import (load fails on its own)
        const h = resolved.find(p => harness.has(p));
        if (h) { add(h, harness.get(h)); continue; }
        const implPath = resolved.find(isImpl);
        if (implPath) return no('red_baseline_missing', [`${file} imports ${hitCand ?? target}, a file the implementation adds that does not exist on the base ${commit}: `
          + 'a new client file needs a designed baseline harness (node redBaseline [{ path, harness }]) in the approved plan; RED is Blocked']);
        if (!hitCand || overlay.has(hitCand)) continue;
        if (isOwn(hitCand)) { add(hitCand, hitCand); continue; }
        return no('red_helper_dependency', [`${file} imports ${hitCand}, a file the candidate adds outside the RED node's and its dependents' writes: `
          + 'RED on the approved base cannot load a helper it never approved; declare it in the RED node or Block']);
      }
      if (overlay.has(hitBase) || !changed.has(hitBase) || isImpl(hitBase)) continue; // base version: approved, or the implementation under test
      if (isOwn(hitBase)) { add(hitBase, hitBase); continue; }
      return no('red_helper_dependency', [`${file} imports ${hitBase}, which the candidate changed outside the RED node's and its dependents' writes: `
        + 'RED on the approved base would run against a helper it never approved; declare it in the RED node or Block']);
    }
  }
  for (const [path, from] of overlay) if (impl.some(w => overlap(path, w)) && !harness.has(path))
    return no('red_overlay_implementation', [`${path} is overlaid (${from}) but a dependent of ${node} writes it: the overlay may not carry candidate implementation`]);
  return { ok: true, overlay: [...overlay.entries()].map(([path, from]) => ({ path, from })).sort((a, b) => (a.path < b.path ? -1 : 1)) };
}

/**
 * The run's RED base-worktree directory: deterministic per (repository, ticket, run), in the OS temp dir (realpath). NOT under
 * the git common dir: a checkout under <repo>/.git resolves bare imports from <repo>/node_modules (Node walks every ancestor),
 * so the candidate's dependencies would leak into RED on the base (S3 defect 4, Codex D-c). The worktree REGISTRATION lives in
 * the common dir (git worktree add); it is removed on every exit path and a leftover of a crash is removed at the next entry.
 */
export function redTreeDir(E) {
  const key = digest(`${realpathSync(io.commonGitDir(E.ctx.repoRoot))}\0${E.S.ticket}\0${E.S.run_id}`).slice(7, 23);
  return join(realpathSync(tmpdir()), `ship-ticket-red-base-${key}`);
}

/** Remove the base worktree `dir` (its registration, then its files) and prune stale registrations. Never throws. */
export function removeRedTree(root, dir) {
  try { git(root, ['worktree', 'remove', '--force', '--force', dir]); } catch { /* not registered */ }
  rmSync(dir, { recursive: true, force: true });
  try { git(root, ['worktree', 'prune']); } catch { /* best effort: a stale registration whose dir is gone is pruned later */ }
}

/** The declared environment's identity (what RED evidence binds): the digest of config.redEnvironment. */
export const environmentDigest = (S) => digest(JSON.stringify(S.config.redEnvironment ?? null));

/**
 * Prepare RED of `node` on the approved base `commit`: the overlay, the declared environment, a fresh detached worktree of the
 * base (hooks off), the overlay bytes, then each declared setup step under the runner protocol (attempt kind gate-red with
 * `setup`, the node's resources locked, a persisted deadline, retire() before it counts; it runs inside `gate red`, a heavy
 * engine command claimed at the process boundary, engine-host-claim.mjs HEAVY_GATES); `depsFor(dir)` gives the runner deps
 * rooted at the worktree. -> { ok: true, tree } | a refusal (the
 * worktree is already removed). Never falls back to the work tree.
 */
export async function prepareRedTree(E, node, specs, commit, depsFor) {
  const root = E.ctx.repoRoot, S = E.S;
  const c = baseCandidate(root, S, S.pinned_exclusions);
  if (!c.candidate_id) return no('candidate_unavailable', [c.reason]);
  const o = redOverlay(root, S, node.id, specs, commit, c.paths ?? []);
  if (!o.ok) return o;
  const env = S.config.redEnvironment;
  if (env === undefined) return no('red_baseline_missing', ['no declared RED environment (config.redEnvironment { setup }): RED on the approved base cannot be prepared, '
    + 'and the checkout\'s dependencies are never linked (an unchanged lockfile is no permission); RED is Blocked until the approved DAG declares it']);
  const dir = redTreeDir(E);
  removeRedTree(root, dir); // a leftover of an interrupted gate red
  const add = git(root, ['-c', `core.hooksPath=${devNull}`, 'worktree', 'add', '--detach', '--force', dir, commit]);
  if (add.status !== 0) { removeRedTree(root, dir); return no('red_base_unavailable', [`git worktree add --detach ${commit}: ${add.stderr.trim()}`]); }
  try {
    const placed = [];
    for (const { path, from } of o.overlay) {
      const bytes = readFileSync(join(root, from));
      mkdirSync(join(dir, posix.dirname(path)), { recursive: true });
      writeFileSync(join(dir, path), bytes);
      placed.push({ path, from, digest: digest(bytes) });
    }
    const steps = [];
    for (const [i, s] of env.setup.entries()) {
      const r = await setupStep(E, node, s, i, depsFor(dir));
      if (r.refusal) { removeRedTree(root, dir); return r.refusal; }
      steps.push(r.step);
    }
    return { ok: true, tree: { dir, commit, overlay: placed, environment: { digest: environmentDigest(S), steps } } };
  } catch (e) { removeRedTree(root, dir); return no(e.code ?? 'red_base_unavailable', [e.message]); }
}

async function setupStep(E, node, s, i, deps) {
  const S = E.S, timeoutMs = clampTimeout(S.config.timeoutMs);
  const a = { attempt_id: 'att-' + randomUUID(), kind: 'gate-red', node: node.id, setup: i, status: 'intent', resources: [...node.resources], started_at: new Date().toISOString() };
  S.attempts.push(a);
  for (const r of node.resources) S.locks[r] = a.attempt_id;
  await E.commit();
  let result;
  try {
    const launch = await deps.spawnRunner({ attempt_id: a.attempt_id, command: { cmd: s.cmd, args: s.args ?? [] }, timeoutMs });
    Object.assign(a, { pid: launch.pid, pgid: launch.pgid, leader_start: leaderStart(launch.pgid), status: 'running' });
    armAttempt(S, a, timeoutMs, E.ctx.deadlineClock);
    await E.commit();
    launch.release();
    result = await launch.done;
  } catch (e) { result = { exitCode: null, timedOut: false, error: e.message, quiescent: true }; }
  if (result.quiescent !== true || !(await retire(S, a, E.alive, 'exited', { owned: true }))) {
    a.status = 'unknown';
    const reason = `cannot prove RED setup group ${a.pgid ?? a.pid} (${node.id} step ${i}) has exited; no RED recorded`;
    if (!S.judgments.some(j => j.code === 'quiescence_unknown' && j.node === node.id)) S.judgments.push(judgment('quiescence_unknown', node.id, reason));
    await E.commit();
    return { refusal: no('quiescence_unknown', [reason]) };
  }
  a.envelope = { exitCode: result.exitCode, timedOut: result.timedOut === true };
  await E.commit();
  const step = { step: i, cmd: s.cmd, args: [...(s.args ?? [])], attempt_id: a.attempt_id, exit_code: result.exitCode };
  if (result.exitCode !== 0 || result.timedOut) return { refusal: no('red_environment_failed', [`RED environment setup step ${i} (${s.cmd}) `
    + `${result.timedOut ? 'timed out' : `exited ${result.exitCode}`}${result.error ? `: ${result.error}` : ''}: RED on the approved base is not established`]) };
  return { step };
}

// ---------------------------------------------------------------------------
// Git preservation (expected-old update-ref) and the transition record

/** The HEAD commit of the checkout now (hardened), or null. */
export const headOid = (root) => { const r = git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']); return r.status === 0 && SHA.test(r.stdout.trim()) ? r.stdout.trim() : null; };
/** The run-private ref that retains the predecessor of generation `g` (ticket and run digested: always a valid ref name). */
export const retainedRef = (S, g) => `refs/ship-ticket/succession/${digest(`${S.ticket}\0${S.run_id}`).slice(7, 23)}/pre-g${g}`;

/**
 * Retain `T.old_head` under `T.retained_ref` with an expected-old (create-only) update-ref. Idempotent: an existing ref that
 * already names the old head is the earlier attempt's. -> { preserved: true } | { preserved: false, reason } (nothing to retain:
 * no recorded head, or its objects are gone) | a refusal (retained_ref_conflict: the ref names another commit).
 */
function retain(root, T) {
  if (!T.old_head) return { preserved: false, reason: 'no predecessor head was recorded' };
  if (git(root, ['cat-file', '-e', `${T.old_head}^{commit}`]).status !== 0) return { preserved: false, reason: `the predecessor head ${T.old_head} is no longer in the object store` };
  const r = git(root, ['update-ref', '-m', `ship-ticket succession: retain the predecessor of generation ${T.g}`, T.retained_ref, T.old_head, '']);
  if (r.status === 0) return { preserved: true };
  const now = git(root, ['rev-parse', '--verify', '--quiet', T.retained_ref]);
  if (now.status === 0 && now.stdout.trim() === T.old_head) return { preserved: true };
  return no('retained_ref_conflict', [`${T.retained_ref} exists and names ${now.stdout.trim() || '(unreadable)'}, not the predecessor ${T.old_head}: nothing is overwritten`]);
}

/** Where the transition stands: 'committed' (no pending transition), or 'prepared' (old authoritative; succeed resumes it). */
export const transitionPhase = (S) => (S.succession?.transition ? S.succession.transition.phase : 'committed');

// ---------------------------------------------------------------------------
// The successor generation

const KINDS = ['base', 'correction', 'mode'];
const INPUT_KEYS = { base: ['kind', 'reason', 'rca'], correction: ['kind', 'reason', 'paths', 'rca'], mode: ['kind', 'reason', 'paths', 'rca'] };

/** The live base the run would pin now (re-read from the remote, hardened) or a refusal. */
function nextPin(E) {
  try { return { ok: true, pin: pinBaseRecord(E.ctx.repoRoot, E.S.config).base }; }
  catch (e) { return no(e.code ?? 'base_unverified', [e.message]); }
}

/**
 * The transition the work tree asks for now, without writing: a moved merge base (kind base), else the change against the
 * recorded candidate manifest (correction, or mode when every change is a mode change). -> { ok, g, kind, ... } | refusal.
 */
function plan(E, kind) {
  const S = E.S, root = E.ctx.repoRoot, g = (S.succession?.g ?? 0) + 1, old_base = S.base.merge_base;
  const M = S.succession?.manifest ?? null;
  const p = nextPin(E);
  if (!p.ok) return p;
  if (p.pin.merge_base !== old_base) {
    if (kind && kind !== 'base') return no('succession_record_mismatch', [`the merge base moved (${old_base} -> ${p.pin.merge_base}): record kind base`]);
    const c = baseCandidate(root, { ...S, base: { ...S.base, merge_base: p.pin.merge_base } }, S.pinned_exclusions);
    if (!c.candidate_id) return no('candidate_unavailable', [c.reason]);
    const d = baseDelta(root, old_base, p.pin.merge_base);
    return { ok: true, g, kind: 'base', pin: p.pin, old_base, new_base: p.pin.merge_base, old_candidate: M?.candidate_id ?? authorizingReview(S)?.candidate_id ?? null,
      new_candidate: c.candidate_id, paths: c.paths ?? [], entries: d.entries, patch_digest: d.patch_digest, candidate_delta: [] };
  }
  if (kind === 'base') return no('succession_nothing_changed', [`merge-base(HEAD, ${S.base.remote}/${S.base.ref}) is still the pinned ${old_base}: `
    + 'rebase the ticket branch onto the new base first (an advanced remote alone never changes the run)']);
  if (!M) return no('succession_pre_review', ['a correction or mode generation follows a review freeze; before it, changed work is re-run (stale), as before']);
  const c = baseCandidate(root, S, S.pinned_exclusions);
  if (!c.candidate_id) return no('candidate_unavailable', [c.reason]);
  const now = candidateManifest(root, [...new Set([...(c.paths ?? []), ...Object.keys(M.files)])]);
  const delta = candidateDelta(M.files, now);
  if (!delta.length) return no('succession_nothing_changed', [`the work tree is the recorded candidate ${M.candidate_id}`]);
  const modeOnly = delta.every(d => d.change === 'mode');
  return { ok: true, g, kind: kind ?? (modeOnly ? 'mode' : 'correction'), modeOnly, old_base, new_base: old_base, old_candidate: M.candidate_id, new_candidate: c.candidate_id,
    paths: c.paths ?? [], entries: [], patch_digest: null, candidate_delta: delta, manifest: now };
}

/** Input validation that needs no state. */
function inputRefusal(input) {
  if (!isObj(input) || !KINDS.includes(input.kind)) return no('succession_record_missing', ['succeed needs a record { kind: base|correction|mode, reason, ... }: no record, no generation']);
  const extra = Object.keys(input).filter(k => !INPUT_KEYS[input.kind].includes(k));
  if (extra.length) return no('bad_input', [`unknown succession field(s) for kind ${input.kind}: ${extra.join(', ')}`]);
  if (!nonEmpty(input.reason)) return no('succession_record_missing', ['the record needs a non-empty reason']);
  if (input.kind !== 'base' && !(Array.isArray(input.paths) && input.paths.length && input.paths.every(nonEmpty)))
    return no('succession_record_missing', [`a ${input.kind} record declares the paths it changes (paths: [..])`]);
  const evidence = input.rca?.evidence;
  if (input.rca !== undefined && !(isObj(input.rca) && Object.keys(input.rca).every(k => ['differs', 'evidence'].includes(k)) && nonEmpty(input.rca.differs)
    && (nonEmpty(evidence) || (Array.isArray(evidence) && evidence.length > 0 && evidence.every(nonEmpty)))))
    return no('bad_input', ['rca is { differs, evidence } (what this path does differently, and the evidence for it: a string or non-empty strings)']);
  return null;
}

/** Guards every succeed (plan, prepare and commit) shares. */
function entryRefusal(E) {
  const S = E.S;
  if (!successionOn(S)) return no('succession_off', ['this run does not set config.succession: a moved base or a post-freeze change follows the frozen route']);
  const unbound = E.verifyBinding();
  if (unbound.length) return no(unbound[0].code, unbound.map(j => j.reason));
  const live = S.attempts.filter(a => ['intent', 'launched', 'running', 'unknown'].includes(a.status)).map(a => a.attempt_id);
  if (live.length) return no('succession_busy', [`attempts still live: ${live.join(', ')}`]);
  const open = S.repairs.filter(r => ['pending', 'running'].includes(r.state)).map(r => r.id);
  if (open.length) return no('succession_busy', [`repairs still open: ${open.join(', ')}: finish the repair route first`]);
  return null;
}

/** Record the transition as prepared (old head, retained ref) and retain the old head. -> { T, kept } | refusal. */
async function prepare(E, oldHead) {
  const S = E.S, root = E.ctx.repoRoot;
  let T = S.succession.transition;
  if (!T) {
    const g = S.succession.g + 1;
    T = { g, phase: 'prepared', old_head: oldHead, retained_ref: retainedRef(S, g), prepared_at_seq: S.seq };
    S.succession.transition = T;
    note(S, 'GENERATION_PREPARED', { g, old_head: T.old_head, retained_ref: T.retained_ref });
    await E.commit();
  }
  await io.boundary(E.ctx.hooks, 'succession-prepared', { g: T.g });
  const kept = retain(root, T);
  if (kept.ok === false) return kept;
  await io.boundary(E.ctx.hooks, 'succession-retained', { g: T.g });
  return { T, kept };
}

/**
 * Units whose evidence the successor `N` no longer binds (its base commit or fingerprints moved): each gets one
 * generation-authorized re-check and unit re-review (no ceiling spend, no storm count). Returns their names.
 */
function rebindUnits(E, N, g) {
  if (!hasUnits(N)) return [];
  const after = unitStates(N, E.ctx.repoRoot, {});
  const out = [];
  for (const [u, s] of Object.entries(after)) {
    if (s.state !== 'stale' || !N.unit_checks[u].evidence) continue;
    N.unit_checks[u].generation = { g, recheck: true, rereview: true, storm: true };
    out.push(u);
  }
  return out;
}

/**
 * `run-engine.mjs succeed` (under the run lock), the ONE lifecycle owner of a transition.
 * - `mode: 'plan'`: the transition the work tree asks for now (kind, changed paths); nothing is written.
 * - `mode: 'prepare'`: record the transition and retain the CURRENT HEAD (call it before a rebase); no generation.
 * - otherwise: validate the record, prepare (or resume) the transition, build the successor on a clone and install it with ONE
 *   commit that also removes the transition record. `beforeCommit` (in-process tests only) runs on the clone just before it.
 */
export async function succeed(E, input, { mode = 'commit', beforeCommit } = {}) {
  const S = E.S;
  const bad = entryRefusal(E);
  if (bad) return bad;
  S.succession ??= { g: 0, generations: [], head: null };
  if (mode === 'prepare') {
    const p = await prepare(E, S.succession.transition?.old_head ?? headOid(E.ctx.repoRoot));
    if (p.ok === false) return p;
    return { ok: true, code: 'transition_prepared', judgment_point: false, transition: p.T, preserved: p.kept.preserved, ...(p.kept.reason ? { reason: p.kept.reason } : {}) };
  }
  if (mode === 'plan') {
    const t = plan(E, null);
    if (!t.ok) return t;
    return { ok: true, code: 'succession_plan', judgment_point: false, transition: { g: t.g, kind: t.kind, base_moved: t.kind === 'base', old_base: t.old_base, new_base: t.new_base,
      old_candidate: t.old_candidate, new_candidate: t.new_candidate, paths: t.candidate_delta.map(d => d.path), changes: t.candidate_delta.map(d => ({ path: d.path, change: d.change })),
      base_delta: t.entries.map(e => ({ path: e.path, status: e.status })), review_required: S.review_chain.some(r => r.kind === 'original'), phase: transitionPhase(S) } };
  }
  const refused = inputRefusal(input);
  if (refused) return refused;
  const t = plan(E, input.kind);
  if (!t.ok) return t;
  // (F) and mode: the declared paths are exactly the changed paths, all inside the approved scope (some node's writes)
  if (t.kind !== 'base') {
    const changed = t.candidate_delta.map(d => d.path), declared = [...new Set(input.paths)].sort();
    if (declared.join('\0') !== changed.join('\0')) return no('succession_record_mismatch', [`the record declares ${declared.join(', ')}; the candidate changed ${changed.join(', ')}`]);
    if (input.kind === 'mode' && !t.modeOnly) return no('succession_record_mismatch', ['a mode record covers mode-only changes; content changed: use kind correction']);
    if (input.kind === 'correction' && t.modeOnly) return no('succession_record_mismatch', ['a mode-only change is recorded as kind mode']);
    const writes = Object.values(S.nodes).flatMap(n => [...(n.writes ?? []), ...(n.redSpecs ?? []).filter(isObj).map(s => s.file)]);
    const outside = changed.filter(p => !writes.some(w => overlap(p, w)));
    if (outside.length) return no('succession_out_of_scope', [`changed path(s) outside every node's approved writes: ${outside.join(', ')}: out-of-scope drift is the owner's (unchanged route)`]);
  }
  // C2 (a): any original on the chain (a PASS, a FAIL, a repair or a pending confirmation included) means review evidence to renew
  const review_required = S.review_chain.some(r => r.kind === 'original');
  const rounds = unsuccessfulRounds(S);
  if (review_required && rounds >= 2 && input.rca === undefined)
    return no('rca_required', [`${rounds} unsuccessful review rounds on this run: the same loop stops; a generation that opens a new review needs an RCA record { differs, evidence } naming the different path (§7.1)`]);

  // Prepared (or resumed) before anything is installed: the predecessor stays authoritative through every point below
  const prepared = await prepare(E, S.succession.transition?.old_head ?? S.succession.head ?? headOid(E.ctx.repoRoot));
  if (prepared.ok === false) return prepared;
  const { T, kept } = prepared;
  if (T.g !== t.g) return no('transition_corrupt', [`the prepared transition names generation ${T.g}; the next generation is ${t.g}`]);

  // Build the successor on a clone; E.S (and the state on disk) is untouched until the one commit below
  const X = { ...E, S: structuredClone(E.S) }, N = X.S;
  const redNodes = Object.keys(N.gates.red ?? {}).filter(d => N.gates.red[d]);
  const invalidRed = t.kind === 'base' ? redNodes
    : redNodes.filter(d => Object.keys(N.gates.red[d].spec_digests ?? {}).some(f => t.candidate_delta.some(x => x.path === f)));
  X.baseCommit = t.new_base;
  for (const d of invalidRed) invalidateRed(X, d, { changed: t.kind === 'base' ? [] : Object.keys(N.gates.red[d].spec_digests).filter(f => t.candidate_delta.some(x => x.path === f)), moved: t.kind === 'base' });
  const addenda = t.kind === 'base' ? Object.keys(N.gates.red_addendum ?? {}) : [];
  for (const k of addenda) delete N.gates.red_addendum[k];
  const new_head = headOid(E.ctx.repoRoot);
  const gen = { g: t.g, kind: t.kind, reason: input.reason, at_seq: null,
    old: { candidate: t.old_candidate, base: t.old_base }, new: { candidate: t.new_candidate, base: t.new_base },
    delta: { base: t.entries, base_patch_digest: t.patch_digest, candidate: t.candidate_delta },
    invalidated: { red: invalidRed, red_addendum: addenda, local_proof: N.local_proof ? N.local_proof.seq ?? true : null, ship_ready: N.ship_ready ?? null,
      freeze: review_required ? N.freeze ?? null : null, units: [] },
    renewal_required: { red: invalidRed, red_addendum: addenda, local_proof: true, review: review_required, units: [] },
    renewed: { red: {}, red_addendum: {}, local_proof: null, review: null },
    review_required, rounds_before: rounds, ...(input.rca ? { rca: input.rca } : {}),
    git: { old_head: T.old_head, new_head, retained_ref: kept.preserved ? T.retained_ref : null, preserved: kept.preserved, ...(kept.reason ? { reason: kept.reason } : {}) } };
  N.local_proof = null;
  delete N.ship_ready;
  if (t.kind === 'base') N.base = { ...N.base, sha: t.pin.sha, merge_base: t.new_base, pinned_at_seq: (N.seq ?? 0) + 1 };
  if (review_required) N.freeze = null;
  if (t.kind !== 'base') for (const r of N.repairs) if (r.state === 'failed') { r.state = 'cancelled'; r.reason = `superseded by generation ${t.g}`; }
  // the done nodes' fingerprints are re-recorded: the change is recorded here, not reported again as post-freeze drift
  for (const n of Object.values(N.nodes)) if (n.state === 'done' && n.fps) n.fps = io.fingerprints(E.ctx.repoRoot, Object.keys(n.fps));
  const units = rebindUnits(E, N, t.g);
  gen.invalidated.units = units;
  gen.renewal_required.units = units;
  N.succession.manifest = { candidate_id: t.new_candidate, files: t.manifest ?? candidateManifest(E.ctx.repoRoot, t.paths) };
  N.succession.head = new_head;
  delete N.succession.transition;
  note(N, 'GENERATION', { g: t.g, kind: t.kind, review_required });
  gen.at_seq = N.seq;
  N.succession.g = t.g;
  N.succession.generations.push(gen);
  N.outbox.push({ run_id: N.run_id, event: 'GENERATION', event_id: `generation-${N.run_id}-${t.g}`, g: t.g, kind: t.kind, old: gen.old, new: gen.new,
    review_required, timestamp: new Date().toISOString() });
  if (beforeCommit) await beforeCommit(N);
  await io.boundary(E.ctx.hooks, 'succession-commit', { g: t.g });
  E.S = N;
  await E.commit();
  return { ok: true, code: 'generation_recorded', judgment_point: false, generation: gen };
}

/** The current generation record, or null before the first. */
export const currentGeneration = (S) => (S.succession?.generations ?? []).at(-1) ?? null;

/**
 * Review authorization by the current generation (C2 (a)): a fresh ORIGINAL review that names `generation: g` is authorized
 * without a RETRY exactly once per generation that requires a review. -> null (no generation claim), { ok: true, g } or a
 * refusal. Never writes an authority event.
 */
export function generationReview(S, input) {
  if (input.generation === undefined) return null;
  if (!(Number.isInteger(input.generation) && input.generation > 0)) return no('bad_input', ['generation names a succession generation (a positive integer)']);
  const gen = currentGeneration(S);
  if (!gen || input.generation !== gen.g) return no('generation_mismatch', [`the review names generation ${input.generation}; the current generation is ${gen?.g ?? 'none'}`]);
  if (input.kind !== 'original') return no('generation_mismatch', ['a generation authorizes one fresh original review']);
  if (!gen.review_required) return no('generation_mismatch', [`generation ${gen.g} opened no review (there was none to renew)`]);
  if (gen.renewed.review) return no('retry_unauthorized', [`generation ${gen.g} already authorized review ${gen.renewed.review}: a further original needs a RETRY`]);
  return { ok: true, g: gen.g };
}

/**
 * Ship-ready on a succession run: SHIP_READY only for a (candidate, base) whose RED, base-bound proof and review are recorded
 * for that base. RED of every live RED-bearing node must be recorded on the current base (red_renewal_pending); after a
 * review-opening generation the authorizing PASS must belong to the review line that generation opened: its fresh original,
 * then that line's repair and confirmation (review_generation_stale). -> null | refusal.
 */
export function successionShipRefusal(E) {
  const S = E.S;
  if (!successionOn(S)) return null;
  const base = S.base.merge_base;
  const stale = Object.entries(S.nodes).filter(([, n]) => (n.redSpecs ?? []).length && n.state !== 'cancelled')
    .filter(([d]) => !S.gates.red?.[d] || S.gates.red[d].base_commit !== base).map(([d]) => d);
  if (stale.length) return no('red_renewal_pending', [`RED of ${stale.join(', ')} is not recorded on the current base ${base} (gate red renews it on the approved base)`]);
  const gen = (S.succession?.generations ?? []).findLast(x => x.review_required);
  if (!gen) return null;
  const last = authorizingReview(S);
  const opened = S.review_chain.some(r => r.kind === 'original' && r.generation === gen.g);
  if (!(last && opened && (last.generation ?? 0) >= gen.g)) return no('review_generation_stale', [`the authorizing review ${last?.review_execution ?? '(none)'} predates `
    + `generation ${gen.g} (${gen.kind}): a fresh original review naming generation ${gen.g} is needed (primary and second opinion)`]);
  return null;
}

/** The recorded candidate manifest and head at a review freeze or repair (every freeze, any outcome). */
function recordCandidate(E, candidate, paths) {
  E.S.succession ??= { g: 0, generations: [], head: null };
  E.S.succession.manifest = { candidate_id: candidate, files: candidateManifest(E.ctx.repoRoot, paths) };
  E.S.succession.head = headOid(E.ctx.repoRoot);
}

/** Stamp an accepted review record with the current generation and record the reviewed candidate (called by the review gate). */
export function recordReviewed(E, record, candidate, paths) {
  if (!successionOn(E.S)) return;
  recordCandidate(E, candidate, paths);
  record.generation = E.S.succession.g;
}

/** After a review repair on a succession run: the repaired candidate is the recorded one (engine-attempts completeRepair). */
export function recordRepaired(E, candidate, paths) {
  if (successionOn(E.S)) recordCandidate(E, candidate, paths);
}

/** Record a renewed piece of evidence in the current generation (RED by node, proof, review). */
export function recordRenewal(S, what, key, id) {
  const gen = successionOn(S) ? currentGeneration(S) : null;
  if (!gen) return;
  if (what === 'local_proof' || what === 'review') gen.renewed[what] = id;
  else gen.renewed[what][key] = id;
}
