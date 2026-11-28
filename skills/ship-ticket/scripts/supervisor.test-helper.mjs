/**
 * Test world of supervisor.test.mjs (PR-5). Fake providers only: no real engine run, launchd, network or Docker.
 *
 * A world is a directory: `world.json` (tickets + behaviour), one fake engine state per ticket (`state/<key>.json`), an
 * `effects.jsonl` log every fake effect appends to, and `clock` (virtual nanoseconds of the test deadline clock). The fake
 * engine (`fake-engine.cjs`) and the fake agent CLI (`fake-agent.cjs`) run as REAL processes under the REAL durable
 * launcher (engine-io startLauncher: own process group, release byte, envelope), so session loss, kill -9 and detached
 * survival are real; only what they do is fake.
 *
 * Fake engine state machine (phase): build -> (drive) review_owed -> (gate review original) PASS: ship_owed | FAIL: repair_owed
 * -> (drive) confirmation_owed -> (gate review confirmation) PASS: ship_owed | FAIL: confirmation_fail; ship_owed ->
 * (gate ship-ready) published -> owner_publish. The fake `gate review` keeps the real gate's one-record-per-execution and
 * repair-brief (`repair_prompt_missing`) rules and its unknown-field `bad_input` refusal; behaviour `lock` makes a command
 * fail as the engine does under a held run lock (exit 1, nothing recorded). Other phases: owner_stop (budget_spent), terminal (review_terminal).
 *
 * CLI (the crash tests): node supervisor.test-helper.mjs tick|sweep <worldDir> [<boundary>:<n> kill|hang]
 *   kill: SIGKILL itself at the n-th hit of that boundary; hang: never resolve there (the journal lock stays held).
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testClock } from './lib/deadline.mjs';
import { groupAlive } from './engine-io.mjs';
import { tick, sweep } from './supervisor.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const WAVE_ID = 'W-S';
export const BOOT = '00000000-0000-4000-8000-000000000001';

// Fake engine: one engine command; logs the effect, advances the fake state, prints a drive-like JSON.
const FAKE_ENGINE = String.raw`'use strict';
const fs = require('node:fs'), path = require('node:path');
const a = process.argv.slice(2);
const W = process.env.SUP_WORLD;
const flag = (k) => a[a.indexOf('--' + k) + 1];
const sub = a[1] === 'gate' ? 'gate ' + a[2] : a[1];
const key = flag('ticket');
const world = JSON.parse(fs.readFileSync(path.join(W, 'world.json'), 'utf8'));
const beh = (world.behaviour[key] || {})[sub];
fs.appendFileSync(path.join(W, 'effects.jsonl'), JSON.stringify({ kind: sub, ticket: key, pid: process.pid, argv: a,
  ...(sub === 'gate review' ? (() => { const i = JSON.parse(fs.readFileSync(flag('input'), 'utf8')); return { review_kind: i.kind, rx: i.review_execution }; })() : {}) }) + '\n');
if (beh === 'hang') { setInterval(() => {}, 1e6); return; }
if (beh === 'held') process.exit(75);
if (beh === 'lock') { process.stderr.write('run-engine: lock_held'); process.exit(1); } // the engine refused before doing anything
if (beh === 'lock_once') { const f = path.join(W, 'lock_once-' + key); if (!fs.existsSync(f)) { fs.writeFileSync(f, '1'); process.stderr.write('run-engine: lock_held'); process.exit(1); } }
if (beh === 'linger') require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore' }).unref();
const sf = path.join(W, 'state', key + '.json');
const S = JSON.parse(fs.readFileSync(sf, 'utf8'));
const save = () => { fs.writeFileSync(sf + '.tmp', JSON.stringify(S)); fs.renameSync(sf + '.tmp', sf); };
const note = (e) => { S.seq += 1; S.events.push({ seq: S.seq, ...e }); };
if (sub === 'gate review') {
  // the real gate's rules that matter here: one record per execution; an accepted FAIL that opens a repair needs its brief
  const input = JSON.parse(fs.readFileSync(flag('input'), 'utf8'));
  const refuse = (code) => { note({ type: 'GATE', gate: 'review', ok: false, code }); save(); process.stdout.write(JSON.stringify({ gate: 'review', ok: false, code })); process.exit(2); };
  const extra = Object.keys(input).filter((k) => !['review_execution', 'kind', 'primary', 'second_opinion', 'reconciliation', 'repair_prompt_file'].includes(k));
  if (extra.length) { process.stderr.write('run-engine: bad_input: unknown input field(s) ' + extra.join(',')); process.exit(1); }
  if (S.review_chain.some((r) => r.review_execution === input.review_execution && r.kind === input.kind)) refuse('chain_broken');
  const outcome = input.primary.outcome;
  const fixes = (input.reconciliation?.dispositions || []).filter((d) => d.disposition === 'fix').map((d) => d.finding_id);
  if (input.kind === 'original' && outcome === 'FAIL' && fixes.length) {
    const b = input.repair_prompt_file;
    if (!(typeof b === 'string' && path.isAbsolute(b) && fs.existsSync(b) && fs.statSync(b).isFile())) refuse('repair_prompt_missing');
  }
  S.review_chain.push({ review_execution: input.review_execution, kind: input.kind, outcome, ...(outcome === 'FAIL' ? { fix_findings: fixes } : {}) });
  S.phase = outcome === 'PASS' ? 'ship_owed' : input.kind === 'original' ? 'repair_owed' : 'confirmation_fail';
  note({ type: 'GATE', gate: 'review', ok: true, code: 'review_accepted' });
  save();
  process.stdout.write(JSON.stringify({ gate: 'review', ok: true, code: 'review_accepted' }));
  return;
}
const next = { build: 'review_owed', repair_owed: 'confirmation_owed', ship_owed: 'published' };
if (sub === 'drive' && S.phase === 'repair_owed') S.review_chain.push({ review_execution: 'rx-1', kind: 'repair' });
if (next[S.phase]) S.phase = next[S.phase];
note({ type: sub === 'drive' ? 'DISPATCH' : 'GATE', ...(sub === 'drive' ? {} : { gate: a[2], ok: true, code: 'ok' }) });
save();
process.stdout.write(JSON.stringify(sub === 'drive' ? { schema: 'ship-ticket-engine-status-v1', ticket: key, outcome: 'done', seq: S.seq } : { gate: a[2], ok: true, code: 'ok' }));
`;

// Fake agent CLI: argv after the script is the routed provider argv (logged); the prompt on stdin names the leg.
const FAKE_AGENT = String.raw`'use strict';
const fs = require('node:fs'), path = require('node:path');
const W = process.env.SUP_WORLD;
const [provider, ...args] = process.argv.slice(2);
let prompt = '';
process.stdin.on('data', (c) => { prompt += c; });
process.stdin.on('end', () => {
  const key = /ticket (\S+?),/.exec(prompt)?.[1] || /analysis: (\S+)/.exec(prompt)?.[1];
  const leg = /leg (\w+)/.exec(prompt)?.[1] || (/root-cause/.test(prompt) ? 'rca' : 'unknown');
  const kind = /# ship-ticket (\w+) review/.exec(prompt)?.[1] || null;
  const world = JSON.parse(fs.readFileSync(path.join(W, 'world.json'), 'utf8'));
  const beh = world.behaviour[key] || {};
  fs.appendFileSync(path.join(W, 'effects.jsonl'), JSON.stringify({ kind: 'agent', leg, review_kind: kind, ticket: key, provider, args, pid: process.pid }) + '\n');
  const finish = () => {
    let out;
    const outcome = (beh.outcomes || {})[kind] || 'PASS';
    if (leg === 'primary') out = { reviewer_identity: 'primary-' + provider, candidate_id: 'cand', outcome, findings: outcome === 'FAIL' ? [{ id: 'f1', path: 'src/a.txt' }] : [] };
    else if (leg === 'second') out = { route: provider, reviewer_identity: 'second-' + provider, candidate_id: 'cand', findings: [], overflow: false, outcome: 'PASS' };
    else if (leg === 'reconcile') {
      const arts = JSON.parse(prompt.slice(prompt.indexOf('{"primary"'), prompt.lastIndexOf('}') + 1));
      const rx = /review_execution (\S+?)[,)]/.exec(prompt)[1];
      const dispositions = (arts.primary.findings || []).map((f) => ({ finding_id: f.id, source: 'primary', disposition: 'fix' }));
      out = beh.tamper ? { kind, review_execution: rx, primary: { ...arts.primary, outcome: 'PASS' }, second_opinion: arts.second_opinion, reconciliation: { dispositions } }
        : { kind, review_execution: rx, primary: arts.primary, second_opinion: arts.second_opinion, reconciliation: { dispositions }, ...(beh.extra_key ? { notes: 'x' } : {}) };
    } else if (leg === 'rca') out = beh.rca || { hypothesis: 'h', evidence: [], differs: '', path: 'blocked' };
    if (beh['fail_' + leg]) process.exit(3);
    // each provider's real final-message shape (worker-report.mjs finalMessage parses them)
    process.stdout.write(provider === 'codex' ? JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(out) } }) + '\n'
      : JSON.stringify({ type: 'result', is_error: false, result: JSON.stringify(out) }));
  };
  const slow = (beh.slow || {})[leg];
  if (slow === 'hang') setInterval(() => {}, 1e6); else setTimeout(finish, slow || 0);
});
`;

/** Create a world: tickets [{ key, deps?, phase?, behaviour? }]. Returns { dir, manifest, ticket(key) }. */
export function makeWorld(dir, tickets, { merge_strategy } = {}) {
  mkdirSync(join(dir, 'state'), { recursive: true });
  mkdirSync(join(dir, 'runs'), { recursive: true });
  writeFileSync(join(dir, 'fake-engine.cjs'), FAKE_ENGINE);
  writeFileSync(join(dir, 'fake-agent.cjs'), FAKE_AGENT);
  writeFileSync(join(dir, 'effects.jsonl'), '');
  writeFileSync(join(dir, 'clock'), '1000000000');
  const manifest = { schema: 'ship-ticket-wave-v1', wave_id: WAVE_ID, endpoint: 'SHIP_READY', heavy_slots: 1, ...(merge_strategy ? { merge_strategy } : {}),
    tickets: tickets.map((t) => ({ key: t.key, plan: `.specs/plans/${t.key}.md`, run_id: `run-${t.key}`, worktree: join(dir, 'wt', t.key), branch: `feat/${t.key}`, deps: t.deps ?? [], dep_mode: 'ship_ready', resources: [] })) };
  for (const t of manifest.tickets) mkdirSync(t.worktree, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(dir, 'world.json'), JSON.stringify({ behaviour: Object.fromEntries(tickets.map((t) => [t.key, t.behaviour ?? {}])) }));
  for (const t of tickets) writeState(dir, t.key, { seq: 1, events: [], phase: t.phase ?? 'build', review_chain: t.chain ?? [], durable: true,
    config: { provider: 'claude', modelMap: { strong: 'claude-strong-x', inherit: 'claude-inherit-x' } } });
  return { dir, manifest };
}
export const readState = (dir, key) => JSON.parse(readFileSync(join(dir, 'state', `${key}.json`), 'utf8'));
export const writeState = (dir, key, S) => writeFileSync(join(dir, 'state', `${key}.json`), JSON.stringify(S));
export const effects = (dir) => readFileSync(join(dir, 'effects.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
export const setClock = (dir, ns) => writeFileSync(join(dir, 'clock'), String(ns));
export const worldClock = (dir) => testClock({ bootId: BOOT, nowNs: () => BigInt(readFileSync(join(dir, 'clock'), 'utf8').trim()) });

/** The fake engine's `next`: a NextStep-shaped object from the fake phase. */
function fakeNext(dir, t) {
  const S = readState(dir, t.key);
  const cmd = (c, input) => ({ script: 'run-engine.mjs', cmd: c, flags: {}, ...(input ? { input } : {}) });
  const go = (action, c, input, extra = {}) => ({ action, phase: 'X', command: cmd(c, input), facts: { candidate_id: 'cand', excluded_reviewers: [] }, ...extra });
  const stop = (code, cls) => ({ action: 'stop', phase: 'X', command: null, code, stop_class: cls, reason: code, facts: {} });
  switch (S.phase) {
    case 'build': return go('run', 'drive');
    case 'review_owed': return go('dispatch', 'gate review');
    case 'repair_owed': return go('run', 'drive');
    case 'confirmation_owed': return go('dispatch', 'gate review', { kind: 'confirmation', review_execution: 'rx-1' });
    case 'ship_owed': return go('run', 'gate ship-ready', {});
    case 'published': return stop('owner_publish', 'owner');
    case 'confirmation_fail': return stop('confirmation_fail', 'owner');
    case 'owner_stop': return stop('budget_spent', 'owner');
    case 'terminal': return stop('review_terminal', 'owner');
    case 'judgment': return stop('node_failed', 'judgment');
    default: return stop('unknown_phase', 'unknown');
  }
}

/** Deps of a supervisor over world `dir`; `over` replaces any of them. */
export function worldDeps(dir, over = {}) {
  const manifestPath = join(dir, 'manifest.json');
  const text = readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(text);
  const digest = 'sha256:' + Buffer.from(text).toString('hex').slice(0, 64).padEnd(64, '0');
  return {
    verifyWave: () => ({ ok: true, digest }),
    readManifest: () => ({ ok: true, manifest, digest, problems: [] }),
    readTicket: () => ({ state: 'pending', reason: 'resumable' }),
    readState: (t) => readState(dir, t.key),
    runDir: (t) => join(dir, 'runs', t.key),
    repoOf: () => 'rtest',
    next: async (t) => fakeNext(dir, t),
    admitted: (argv) => ({ file: process.execPath, args: [join(dir, 'fake-engine.cjs'), ...argv.slice(1)], shell: false }),
    agentSpec: (plan) => ({ file: process.execPath, args: [join(dir, 'fake-agent.cjs'), plan.provider, ...plan.args], shell: false }),
    verifySubscription: () => true,
    isAlive: (pgid) => groupAlive(pgid),
    armClock: worldClock(dir),
    sweepClock: worldClock(dir),
    reconcile: (t) => { appendFileSync(join(dir, 'effects.jsonl'), JSON.stringify({ kind: 'reconcile', ticket: t.key }) + '\n'); return { status: 0 }; },
    secondOpinionRoute: () => ({ provider: 'codex', modelMap: { strong: 'codex-strong-x' } }),
    env: { ...process.env, SUP_WORLD: dir },
    ...over,
  };
}
export const opts = (dir) => ({ manifestPath: join(dir, 'manifest.json'), stateDir: join(dir, 'journal') });
export const journalFile = (dir) => join(dir, 'journal', WAVE_ID, 'journal.json');
export const journal = (dir) => (existsSync(journalFile(dir)) ? JSON.parse(readFileSync(journalFile(dir), 'utf8')) : null);

/**
 * Hooks that SIGKILL (or hang) this process at the n-th hit of `boundary`, counted ACROSS processes (the count persists in
 * the world dir), so `<boundary>:<n>` names the n-th time the whole wave reaches that point, whichever tick reaches it.
 */
export function crashHooks(spec) {
  if (!spec) return undefined;
  const [at, mode] = spec.split(' ');
  const [name, n] = at.split(':');
  const file = join(process.env.SUP_WORLD, `hits-${name}`);
  return { boundary: async (b) => {
    if (b !== name) return;
    const hits = (existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0) + 1;
    writeFileSync(file, String(hits));
    if (hits !== Number(n)) return;
    writeFileSync(join(process.env.SUP_WORLD, 'killed'), `${name}:${n}`);
    if (mode === 'hang') { writeFileSync(join(process.env.SUP_WORLD, 'hung'), String(process.pid)); setInterval(() => {}, 1e6); await new Promise(() => {}); }
    process.kill(process.pid, 'SIGKILL');
  } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, dir, spec] = process.argv.slice(2);
  process.env.SUP_WORLD = dir;
  const run = cmd === 'sweep' ? sweep : tick;
  run(opts(dir), worldDeps(dir, { hooks: crashHooks(spec) })).then((r) => { process.stdout.write(JSON.stringify(r.out)); process.exitCode = r.code; },
    (e) => { process.stderr.write(String(e.stack)); process.exitCode = 9; });
}
void HERE;
