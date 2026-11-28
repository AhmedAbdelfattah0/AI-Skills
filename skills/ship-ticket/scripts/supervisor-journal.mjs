/**
 * The wave journal of the ship-ticket supervisor (PR-5 / S7a; CONSOLIDATED §7 P3, §7.1, DEBATE D-g). ONE JSON document per
 * wave, written only through lib/durable-io (writeStateAtomic: temp, fsync, rename, directory fsync) under ONE lock
 * (acquireLock with `ctx.lockFile`: the engine's own pid + start-time + nonce lock, dead-holder recovery included). No new
 * lock or store code: the journal is the second user of the engine's durable I/O.
 *
 * What it records: the wave binding (manifest digest + the run-start merge strategy, fixed at the first tick), one record per
 * external operation, the ticket-local Blocked set, the ship-ready set, and the running tick's identity and bound.
 *
 * Operation protocol (intent before effect). An op's id is FIXED at intent: `<repo>:<ticket>:<op>:<generation>`, every part
 * derived from persisted state (the engine's event seq, the review execution id), never a counter, clock or uuid, so two ticks
 * after a kill -9 compute the same id and find the record. States:
 *   intent     recorded before the effect. A launch op that has no pid yet was never released (the release byte follows the
 *              pid commit), so nothing ran and it may be acted again under the SAME id.
 *   acted      the effect happened (the release byte was sent, the gate ran).
 *   recorded   its outcome is recorded (`result`); terminal.
 *   ambiguous  the effect may or may not have happened. NEVER replayed: re-probed a bounded number of times (MAX_PROBES), then
 *              the ticket alone is Blocked naming the op.
 * Allowed moves: intent -> acted | ambiguous | recorded; acted -> recorded | ambiguous; ambiguous -> recorded. Nothing ever
 * returns to intent or acted from ambiguous, and nothing leaves recorded.
 *
 * Authority: the supervisor never writes an authority event (run-state.mjs AUTHORITY_EVENTS). Every record that enters the
 * journal is checked (assertNoAuthority): a field `event` naming one, or an op kind naming one, is refused.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { acquireLock, writeStateAtomic, boundary } from './lib/durable-io.mjs';
import { AUTHORITY_EVENTS } from './run-state.mjs';

export const JOURNAL_SCHEMA = 'ship-ticket-wave-journal-v1';
export const OP_STATES = Object.freeze(['intent', 'acted', 'recorded', 'ambiguous']);
/** Inconclusive probes of an ambiguous op before its ticket is Blocked. */
export const MAX_PROBES = 3;
const MOVES = { intent: ['acted', 'ambiguous', 'recorded'], acted: ['recorded', 'ambiguous'], ambiguous: ['recorded'], recorded: [] };
const PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const coded = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });

/** `<repo>:<ticket>:<op>:<generation>`; every part a safe id. */
export function opId(repo, ticket, op, gen) {
  for (const [k, v] of [['repo', repo], ['ticket', ticket], ['op', op], ['generation', String(gen)]]) if (!PART.test(v)) throw coded('op_id_invalid', `${k} ${JSON.stringify(v)} is not a safe id`);
  return `${repo}:${ticket}:${op}:${gen}`;
}

/** A short stable repository id (from the realpath of its git common dir): the `repo` part of an op id. */
export const repoId = (commonDir) => 'r' + createHash('sha256').update(String(commonDir)).digest('hex').slice(0, 12);

/** The journal files of wave `waveId` under `stateDir`. */
export function journalPaths(stateDir, waveId) {
  if (!PART.test(waveId ?? '')) throw coded('wave_id_invalid', 'a safe wave id is required');
  const dir = join(stateDir, waveId);
  return { dir, file: join(dir, 'journal.json'), lock: join(dir, 'journal.lock'), ops: join(dir, 'ops') };
}

/** Throws `authority_refused` when `value` carries an authority event anywhere (a field `event`, an op `kind`). */
export function assertNoAuthority(value, where = 'record') {
  const walk = (v, path) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (v === null || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if ((k === 'event' || k === 'kind' || k === 'type') && typeof x === 'string' && AUTHORITY_EVENTS.includes(x))
        throw coded('authority_refused', `${where} carries the authority event ${x} at ${path}.${k}: the supervisor never writes an authority event`);
      walk(x, `${path}.${k}`);
    }
  };
  walk(value, where);
}

const fresh = (waveId) => ({ schema: JOURNAL_SCHEMA, wave_id: waveId, binding: null, tick: null, ops: {}, blocked: {}, ship_ready: {} });

/** Lock-free read (the sweep): the last committed document, or a fresh one. A partial document cannot exist (atomic rename). */
export function readJournal(paths, waveId) {
  if (!existsSync(paths.file)) return fresh(waveId);
  const doc = JSON.parse(readFileSync(paths.file, 'utf8'));
  if (doc?.schema !== JOURNAL_SCHEMA || doc.wave_id !== waveId) throw coded('journal_invalid', `${paths.file} is not the journal of wave ${waveId}`);
  return doc;
}

/**
 * Run `fn(J)` holding the journal lock (one attempt: a held lock is `journal_busy`, never waited for, so ticks never
 * overlap). `J` = { doc, commit(), intent(), move(), probe(), block(), op(id) }. The lock is released on every path.
 * `opts.hooks` are the durable-io boundary hooks (crash tests); `opts.lockCtx` adds acquireLock test seams.
 */
export async function withJournal(paths, waveId, fn, opts = {}) {
  let handle;
  try { handle = await acquireLock({ lockFile: paths.lock, runId: waveId, hooks: opts.hooks, ...(opts.lockCtx ?? {}) }); }
  catch (e) { if (e.code === 'lock_held') throw coded('journal_busy', `another supervisor command holds ${paths.lock}`); throw e; }
  try {
    const J = journalApi(paths, readJournal(paths, waveId), opts.hooks);
    return await fn(J);
  } finally { await handle.release(); }
}

function journalApi(paths, doc, hooks) {
  const J = {
    doc, paths,
    async commit(point) {
      assertNoAuthority(doc, 'journal');
      await writeStateAtomic(paths.file, doc, { hooks });
      if (point) await boundary(hooks, point, {});
    },
    op: (id) => doc.ops[id] ?? null,
    /** Record the intent of op `rec` (fixed id); an existing record is returned untouched (never re-created). */
    async intent(rec) {
      if (doc.ops[rec.op_id]) return doc.ops[rec.op_id];
      assertNoAuthority(rec, `op ${rec.op_id}`);
      doc.ops[rec.op_id] = { ...rec, state: 'intent', probes: 0, attempt: 1 };
      await J.commit('after-intent');
      return doc.ops[rec.op_id];
    },
    /** Move op `id` to `to`, merging `fields`; refuses any move outside MOVES. Commits. */
    async move(id, to, fields = {}, point) {
      const o = doc.ops[id];
      if (!o) throw coded('op_unknown', id);
      if (!MOVES[o.state].includes(to)) throw coded('op_move_refused', `${id}: ${o.state} -> ${to} is not allowed (an ambiguous op is never replayed)`);
      assertNoAuthority(fields, `op ${id}`);
      Object.assign(o, fields, { state: to });
      await J.commit(point);
      return o;
    },
    /** Update fields of op `id` without a state move (e.g. the pid of a launch op still at intent). Commits. */
    async update(id, fields, point) {
      const o = doc.ops[id];
      if (!o) throw coded('op_unknown', id);
      if (o.state === 'recorded') throw coded('op_move_refused', `${id} is recorded`);
      assertNoAuthority(fields, `op ${id}`);
      Object.assign(o, fields);
      await J.commit(point);
      return o;
    },
    /** One inconclusive probe of ambiguous op `id`: true when the probe budget is now spent (the caller Blocks the ticket). */
    async probe(id, note) {
      const o = doc.ops[id];
      o.probes = (o.probes ?? 0) + 1;
      o.last_probe = note;
      await J.commit();
      return o.probes >= MAX_PROBES;
    },
    /** Block `ticket` alone (the first cause is kept). Commits. */
    async block(ticket, code, reason, extra = {}) {
      assertNoAuthority(extra, `block ${ticket}`);
      if (!doc.blocked[ticket]) doc.blocked[ticket] = { code, reason, ...extra };
      await J.commit();
      return doc.blocked[ticket];
    },
  };
  return J;
}
