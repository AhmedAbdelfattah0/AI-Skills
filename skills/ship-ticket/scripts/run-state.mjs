/**
 * The one reader of a plan's RUN-STATE block (the event lines between the BEGIN and END markers).
 * Every engine and carrier reader of RUN-STATE goes through `parseRunState` / `splitLines`, so the
 * engine sees the same lines every other tool will: it splits on every sequence a common reader
 * treats as a line break (Python's str.splitlines set, which covers editors and universal-newline
 * I/O). Any such sequence other than \n and \r\n is a hidden line break: a block holding one is
 * malformed, because a later rewrite could turn it into a line nobody observed (ais2-review-4 B1).
 * Node built-ins only, no local imports, so carrier.mjs and the engine modules can all use it.
 */
import { createHash } from 'node:crypto';

export const BEGIN = '<!-- RUN-STATE:BEGIN -->';
export const END = '<!-- RUN-STATE:END -->';
/** RUN-STATE events that carry owner authority (approval, DAG binding, review retry, unit clear): never a worker's to append. */
export const AUTHORITY_EVENTS = ['START', 'DAG_BOUND', 'RETRY', 'UNIT_CLEAR'];

const BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;
const HIDDEN = /\r(?!\n)|[\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;
const HIDDEN_ALL = /[\v\f\x1c\x1d\x1e\x85\u2028\u2029]/g;

/** Lines of `text`, split on every line break any common reader honours. */
export const splitLines = (text) => text.split(BREAK);
/** Whether `text` holds a line break other than \n or \r\n. */
export const hasHiddenBreak = (text) => HIDDEN.test(text);
/** JSON for one RUN-STATE line: JSON.stringify leaves U+0085/U+2028/U+2029 raw, so escape them (strings only can hold them). */
export const eventLine = (event) => JSON.stringify(event).replace(HIDDEN_ALL, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const sha = (s) => 'sha256:' + createHash('sha256').update(s).digest('hex');

const count = (text, needle) => text.split(needle).length - 1;

/**
 * The block of `text`, or null without a BEGIN marker. The span runs from the first BEGIN to the
 * LAST END after it (to the end of the text without one), so a line planted beside a stray or
 * removed marker is still read and classified (BEGIN included, the last END excluded). A
 * well-formed block (exactly one BEGIN, then exactly one END) is the same bytes either way.
 * `events` are the brace lines that parse, `unparsed` those that do not, `hidden` flags a hidden
 * line break anywhere in the span, `markers` describes a marker count other than one BEGIN then one
 * END (null when well formed), `digest`/`length` fingerprint the span bytes.
 */
export function parseRunState(text) {
  const b = text.indexOf(BEGIN);
  if (b < 0) return null;
  const last = text.lastIndexOf(END);
  const block = text.slice(b, last > b ? last : text.length);
  const begins = count(text, BEGIN), ends = count(text, END);
  const markers = begins === 1 && ends === 1 && text.indexOf(END) > b ? null
    : `found ${begins} BEGIN and ${ends} END marker(s)${ends && text.indexOf(END) < b ? ', an END before BEGIN' : ''}`;
  const events = [], unparsed = [];
  for (const l of splitLines(block)) {
    if (!l.trim().startsWith('{')) continue;
    try { const v = JSON.parse(l); if (v && typeof v === 'object' && !Array.isArray(v)) events.push(v); else unparsed.push(l); }
    catch { unparsed.push(l); }
  }
  return { block, events, unparsed, markers, hidden: hasHiddenBreak(block), length: block.length, digest: sha(block) };
}

const AFTER = 'in a separate edit, and any owner event (START, DAG_BOUND, RETRY, UNIT_CLEAR) first seen in this block is untrusted: '
  + 'once status shows nothing live, re-append it as a new, distinct line (e.g. with a timestamp)';

/**
 * Why the RUN-STATE block `R` (a parseRunState result) is malformed, or null when it is well formed
 * or absent. The one verdict every reader applies (the engine and carrier verifyApproval).
 */
export function malformedReason(R) {
  if (!R) return null;
  if (R.markers) return `RUN-STATE must hold exactly one BEGIN marker followed by exactly one END marker (${R.markers}); `
    + `restore one pair (delete a stray marker line, or re-add a missing END) ${AFTER}`;
  if (R.hidden) return 'RUN-STATE holds a line break other than \\n or \\r\\n (a lone CR, U+2028, U+2029, ...); '
    + `normalize the plan file ${AFTER}`;
  if (R.unparsed.length) return `RUN-STATE holds a line starting with { that is not JSON (${JSON.stringify(R.unparsed[0].slice(0, 80))}); `
    + `delete that whole line (never edit it into JSON) ${AFTER}`;
  return null;
}

/** Parsed events of the RUN-STATE block of `text` ([] without one). */
export const runStateEvents = (text) => parseRunState(text)?.events ?? [];

/** Whether the block of `now` still begins with the exact bytes `before` ({ length, digest }) fingerprinted. */
export const blockExtends = (before, now) => now.length >= before.length && sha(now.block.slice(0, before.length)) === before.digest;

/**
 * True only when `after` equals `before` plus text inserted immediately before
 * the single RUN-STATE END marker: the orchestrator appending events. Any edit
 * outside the block, a rewrite of an existing event, a second block, a
 * deletion or a creation returns false.
 */
export function runStateAppendOnly(before, after) {
  if (typeof before !== 'string' || typeof after !== 'string') return false;
  if (count(before, BEGIN) !== 1 || count(before, END) !== 1) return false;
  if (count(after, BEGIN) !== 1 || count(after, END) !== 1) return false;
  const b = before.indexOf(END);
  const a = after.indexOf(END);
  return a >= b && after.slice(0, b) === before.slice(0, b) && after.slice(a) === before.slice(b);
}

/**
 * True only for a {@link runStateAppendOnly} change whose inserted lines carry no authority: the one
 * test of whether a dispatched worker's plan-file change is exempt from ownership. The inserted text
 * is read from the start of the line it lands on (so it cannot complete an existing line). A hidden
 * line break, or a brace line that does not parse, is possible authority: never exempt.
 */
export function workerRunStateAppend(before, after) {
  if (!runStateAppendOnly(before, after)) return false;
  const at = before.indexOf(END);
  const head = splitLines(before.slice(0, at)).at(-1);
  const inserted = after.slice(at - head.length, after.indexOf(END));
  if (hasHiddenBreak(inserted)) return false;
  return !splitLines(inserted).filter(l => l.trim().startsWith('{')).some(l => {
    try { return AUTHORITY_EVENTS.includes(JSON.parse(l)?.event); } catch { return true; }
  });
}
