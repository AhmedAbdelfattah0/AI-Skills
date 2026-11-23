/**
 * S-02a0c: every lib/git-hardened.mjs guard has a named mutant on the ONE shared harness (lib/mutation.test-helper.mjs: CRLF-safe
 * anchors, a kill only when every failure is an assertion). Each mutant copies skills/ship-ticket (the T1 scan needs the vendored
 * parser) with exact-once replacements and runs only the git-hardened.test.mjs tests tagged with its own tag; the unpatched copy
 * (the control) must pass every tagged test, and each run must execute exactly the tagged count, or the verdicts say nothing.
 * Runs with GIT_HARDENED_MUTATION=1 (POSIX; heavy: one test file at a time).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, loadMutationSource, runMutantAsync } from './mutation.test-helper.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const TEST = 'scripts/lib/git-hardened.test.mjs';
const LIB = 'scripts/lib/git-hardened.mjs';
const SKIP = process.platform === 'win32' ? 'POSIX only (win32 refuses)' : process.env.GIT_HARDENED_MUTATION !== '1' ? 'slow: runs with GIT_HARDENED_MUTATION=1' : false;

/** Protected-core mutants (git-exec.mjs R3 gate), killed by the tagged tests of lib/git-exec.test.mjs. */
export const EXEC_MUTANTS = [
  ['S2', 'send a second read of the caller array, not the validated reads', "  return Buffer.from(read.map((v) => `${v}\\n`).join(''));", "  return Buffer.from(Array.from({ length: n }, (_, i) => `${list[i]}\\n`).join(''));"],
  ['S2', 're-read the length on every iteration', '  for (let i = 0; i < n; i++) {\n    const v = list[i];', '  for (let i = 0; i < list.length; i++) {\n    const v = list[i];'],
  ['S3', 'the 99-oid (4 KiB) bound dropped', '  if (!Number.isSafeInteger(n) || n < 1 || n > STDIN_MAX_OIDS) return null;', '  if (!Number.isSafeInteger(n) || n < 1) return null;'],
  ['S3', 'elements not required to be strings', "    if (typeof v !== 'string' || !STDIN_OID.test(v)) return null;", '    if (!STDIN_OID.test(v)) return null;'],
  ['S4', 'any stdin kind accepted (input on any call)', "Object.keys(s).length !== 2 || ownValue(s, 'kind') !== 'oid-lines') return null;", 'Object.keys(s).length !== 2) return null;'],
];
/**
 * [tag, what the mutant removes, from, to, also?, platform?]: each `from` must occur exactly once in lib/git-hardened.mjs. A
 * platform-bound mutant runs only there: M29 (name normalisation) is equivalent on a normalisation-sensitive filesystem
 * (Linux: the NFC path then simply does not exist, so the walk still reports `missing`); its kill needs APFS (darwin).
 */
export const MUTANTS = [
  ['M01', 'skip the win32 refusal', "  if (process.platform === 'win32') throw fail('platform_unsupported', 'context.create');\n", ''],
  ['M02', 'cells ignore the git version string', 'const sameCell = (a, b) => a.git === b.git && a.os', 'const sameCell = (a, b) => a.os'],
  ['M02', 'cells compare major.minor only', 'const sameCell = (a, b) => a.git === b.git && a.os', 'const sameCell = (a, b) => a.git.slice(0, 16) === b.git.slice(0, 16) && a.os'],
  ['M03', 'skip the context tamper check', "  if (!sameNode(now, st.rootStat) || hooks === null || hooks.length !== 0) throw fail('context_tampered', op);\n", ''],
  ['M03', 'skip the disposed check', "  if (DISPOSED.has(ctx)) throw fail('context_disposed', op);\n", ''],
  ['M03', 'dispose removes a replaced R', "  if (!sameNode(lstatOrNull(st.root), st.rootStat)) throw fail('context_tampered', 'context.dispose');\n", ''],
  ['M04', 'skip the shallow refusal', "  if (lstatOrNull(join(common, B('shallow')))) throw fail('shallow_unsupported', op);\n", ''],
  ['M05', 'skip the grafts refusal', "  if (lstatOrNull(join(common, B('info/grafts')))) throw fail('grafts_present', op);\n", ''],
  ['M06', 'skip the alternates refusal at open', "  if (alternatesPresent(objects)) throw fail('alternates_present', op);\n", ''],
  ['M07', 'bounded reads without the cap', "    if (n > cap) throw fail('worktree_entry_unsupported', op);\n", ''],
  ['M07', 'R allowed inside the clone (TMPDIR)', "  if ([top, common].some((d) => inside(st.root, d))) throw fail('owned_dir_invalid', op);\n", ''],
  ['M09', 'skip connectivity', "  corruptOnFail(() => git(st, 'store.connect', dir, [head, base], { deadline }), 'store.connect');\n", ''],
  ['M09', 'keep the producer .idx instead of re-hashing', "  for (const ext of ['idx', 'rev']) { const f = join(V, B(`tmp/p-${out[0]}.${ext}`)); if (lstatOrNull(f)) unlinkSync(f); }\n",
    "  copyFileSync(join(V, B(`tmp/p-${out[0]}.idx`)), B(`${dir}/objects/pack/pack-${out[0]}.idx`));\n",
    [["  corruptOnFail(() => git(st, 'store.index', dir, [st.maxTotalObjectBytes, packPath], { deadline }), 'store.index');\n", '']]],
  ['M10', 'index-pack --strict', "['index-pack', '--max-input-size=<n>', '<path>']", "['index-pack', '--strict', '--max-input-size=<n>', '<path>']"],
  ['M11', 'skip the per-object size cap', "      if (+m[1] > st.maxObjectBytes) throw fail('object_too_large', 'store.sizes');\n", ''],
  ['M12', 'skip the total size cap', '      total(+m[1]);\n', ''],
  ['M13', 'skip the post-ingest source re-check', "  recheckSource(s, 'store.init');\n", ''],
  ['M15', 'remove in place instead of quarantining', '    renameSync(D, moved);\n    removeTree(slot,', '    removeTree(D, lstatSync(D).dev, () => 0, deadline);\n    removeTree(slot,'],
  ['M15', 'ignore the removal budget', "    removeTree(slot, lstatSync(slot).dev, meter(st.removeEntries, 'lane_remove_failed', 'store.init'), deadline + st.timeoutMs);",
    "    removeTree(slot, lstatSync(slot).dev, () => 0, deadline + st.timeoutMs);"],
  ['M16', 'drop the u+w restore', '    if ((ds.mode & 0o700) !== 0o700) chmodSync(d, (ds.mode & 0o7777) | 0o700);\n', ''],
  ['M16', 'treat a symlink as a directory to descend', '      if (s.isDirectory() && !s.isSymbolicLink()) queue.push(p);', '      if (s.isDirectory() || s.isSymbolicLink()) queue.push(p);'],
  ['M17', 'skip the blob hash check', "  if (!blobHash(bytes).equals(Buffer.from(oid, 'hex'))) throw fail('object_corrupt', id);\n", ''],
  ['M18', 'last-wins path map (duplicates pass)', "    if (seen.has(hexKey(e.path))) throw fail('tree_path_unsafe', id);\n", ''],
  ['M19', 'skip the unsafe-component checks (listing and raw names)', "    if (unsafePath(path)) throw fail('tree_path_unsafe', id);\n    out.push(Object.freeze({ mode", '    out.push(Object.freeze({ mode',
    [['    if (name.indexOf(0x2f) >= 0 || unsafePath(name)) throw', '    if (name.indexOf(0x2f) >= 0) throw']]],
  ['M49', 'raw tree names may hold a slash', '    if (name.indexOf(0x2f) >= 0 || unsafePath(name)) throw', '    if (unsafePath(name)) throw'],
  ['M20', 'merge-base without --all', "['merge-base', '--all', '--end-of-options', '<oid>', '<oid>']", "['merge-base', '--end-of-options', '<oid>', '<oid>']"],
  ['M21', 'skip the store integrity check in op()', '  checkStore(h.storeDir, id);\n  const deadline = Date.now() + st.timeoutMs;', '  const deadline = Date.now() + st.timeoutMs;'],
  ['M22', 'skip hashing (trust the stat)', '  const sum = hashFile(abs, lst, spendBytes, deadline, op);', "  const sum = lst.mtimeMs < Date.now() + 1 ? Buffer.from(e.oid, 'hex') : hashFile(abs, lst, spendBytes, deadline, op);"],
  ['M23', 'accept on eol_hint', "  if (!sum.equals(Buffer.from(e.oid, 'hex'))) diff(e.path, 'content', { eol_hint: eolHint(st, h, e, abs, lst, deadline, op) });",
    "  if (!sum.equals(Buffer.from(e.oid, 'hex')) && !eolHint(st, h, e, abs, lst, deadline, op)) diff(e.path, 'content', { eol_hint: false });"],
  ['M25', 'treat a populated gitlink as clean', "if (hasEntry(abs, spendFiles)) diff(e.path, 'gitlink_populated');", 'hasEntry(abs, spendFiles);'],
  ['M46', 'no scan of untracked directories for a nested .git', '      if (us && us.isDirectory() && !us.isSymbolicLink()) untrackedDirs.push(childRel(n));\n', ''],
  ['M47', 'a populated gitlink is enumerated completely', 'if (hasEntry(abs, spendFiles)) diff', 'if (listDir(abs, spendFiles).length !== 0) diff'],
  ['M48', 'rollback without the creation-identity check', "  if (!sameNode(now, created) || !now.isDirectory() || now.uid !== uid()) throw fail('context_tampered', 'store.init');\n", ''],
  ['M50', 'raw fs error from an unreadable dir', "  try { d = opendirSync(p, { encoding: 'buffer' }); } catch { throw fail('worktree_entry_unsupported', 'listdir'); }\n  const names", "  d = opendirSync(p, { encoding: 'buffer' });\n  const names"],
  ['M51', 'verifyWorktree skips the store identity check', "function op_(st, h, id, operands, deadline) {\n  if (!sameNode(lstatOrNull(h.storeDir), h.stat)) throw fail('context_tampered', id);\n", 'function op_(st, h, id, operands, deadline) {\n'],
  ['M52', 'batch-check line count not checked', "    if (sizes.length !== chunk.oids.length) throw fail('object_corrupt', 'store.sizes');\n", ''],
  ['M55', 'meters check the budget but not the deadline', 'if (n > cap || Date.now() > deadline) throw fail(code, op);', 'if (n > cap) throw fail(code, op);'],
  ['M56', 'raw fs errors escape removal', "  try { removeTreeRaw(root, dev, spend, deadline); } catch (e) { if (e instanceof GitError) throw e; throw fail('lane_remove_failed', 'remove'); }", '  removeTreeRaw(root, dev, spend, deadline);'],
  ['M47', 'a populated gitlink is enumerated completely without any charge', 'if (hasEntry(abs, spendFiles)) diff', 'if (listDir(abs, () => 0).length !== 0) diff'],
  ['M53', 'no object-count bound', "  if (all.length > st.maxObjects) throw fail('object_too_large', 'store.walk');\n", ''],
  ['M11', 'stdin passed to a row that declares none (the row binding must refuse it)', "git(st, 'store.walk', Vs, [head, base], { deadline })", "git(st, 'store.walk', Vs, [head, base], { stdin: { kind: 'oid-lines', oids: [head] }, deadline })"],
  ['M26', 'descend into a symlinked tracked dir', '      if (cs.isSymbolicLink() || !cs.isDirectory()) {', '      if (!cs.isDirectory() && !cs.isSymbolicLink()) {'],
  ['M27', 'skip the nested .git refusal', "    for (const n of names) if (isDotGit(n) && (rel.length > 0 || !n.equals(B('.git')))) throw fail('worktree_entry_unsupported', op);\n", ''],
  ['M28', 'no FIFO/socket/device refusal at a tracked path', "  if (!lst) return diff(e.path, 'missing');\n  if (special(lst)) throw fail('worktree_entry_unsupported', op);\n", "  if (!lst) return diff(e.path, 'missing');\n"],
  ['M29', 'normalise listed names (NFC)', '    const present = new Set(names.map(hexKey));', "    const present = new Set(names.map((n) => Buffer.from(n.toString().normalize('NFC')).toString('hex')));", [], 'darwin'],
  ['M30', 'an exclusion matches as a string prefix', '(p.length > e.length && p.subarray(0, e.length + 1).equals(Buffer.concat([e, SLASH])))', '(p.length > e.length && p.subarray(0, e.length).equals(e))'],
  ['M31', 'drop the info/exclude copy', '  const exBytes = lstatOrNull(ex) ? readBounded(ex, MIB, op) : EMPTY;', '  const exBytes = EMPTY;'],
  ['M32', 'ignore self-ignoring .gitignore files', "  const gitignoreUntracked = others.ignored.filter((p) => !excluded(p) && p.subarray(p.lastIndexOf(0x2f) + 1).equals(B('.gitignore')));", '  const gitignoreUntracked = [];'],
  ['M34', 'drop the file budget', "  const spendFiles = meter(st.maxFiles, 'worktree_budget_exceeded', op, deadline);", "  const spendFiles = meter(Number.MAX_SAFE_INTEGER, 'worktree_budget_exceeded', op, deadline);"],
  ['M35', 'drop the byte budget', "  const spendBytes = meter(st.maxBytes, 'worktree_budget_exceeded', op, deadline);", "  const spendBytes = meter(Number.MAX_SAFE_INTEGER, 'worktree_budget_exceeded', op, deadline);"],
  ['M36', 'enumeration not charged per entry', '    for (let e = d.readSync(); e !== null; e = d.readSync()) { spend(1); names.push(e.name); }', '    for (let e = d.readSync(); e !== null; e = d.readSync()) names.push(e.name);'],
  ['M37', 'no mid-read change detection', "    if (!s.isFile() || !sameNode(s, lst) || s.size !== lst.size) throw fail('worktree_unstable', op);", "    if (!s.isFile() || !sameNode(s, lst)) throw fail('worktree_unstable', op);",
    [["      if (n > s.size) throw fail('worktree_unstable', op);\n", ''], ["    if (n !== s.size || after.size !== s.size || !sameNode(after, s)) throw fail('worktree_unstable', op);\n", '']]],
  ['M38', 'the index dir is the builder git dir', '  const Is = str(I);', '  const Is = s ? str(s.common) : str(I);'],
  ['M41', 'openStore without the marker/config check', "  try { checkStore(D, op); } catch { throw fail('owned_dir_invalid', op); }\n", ''],
  ['M45', 'operands not validated', "      if (!ok(v) || (mark === '<n>' && v <= 0)) throw invalid();\n", ''],
];

const CHILD_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
const TEST_SRC = readFileSync(join(ROOT, TEST), 'utf8');
const taggedCount = (tag) => TEST_SRC.split('\n').filter((l) => /^test\('/.test(l) && l.includes(`[${tag}]`)).length;
const ran = (r) => +(/^# tests (\d+)/m.exec(r.stdout)?.[1] ?? -1);
const SRC = loadMutationSource(join(ROOT, LIB));
const EXEC = 'scripts/lib/git-exec.mjs';
const EXEC_TEST = 'scripts/lib/git-exec.test.mjs';
const EXEC_SRC = loadMutationSource(join(ROOT, EXEC));
const EXEC_TEST_SRC = readFileSync(join(ROOT, EXEC_TEST), 'utf8');
function apply(src, pairs) {
  let s = src;
  for (const [from, to] of pairs) {
    assert.equal(s.split(from).length, 2, `anchor occurs exactly once: ${JSON.stringify(from.slice(0, 80))}`);
    s = s.replace(from, () => to);
  }
  return s;
}

test('mutation: every guard mutant is killed by an assertion in its tagged tests; the control passes them all', { skip: SKIP, timeout: 60 * 60 * 1000 }, async (t) => {
  for (const [tag] of MUTANTS) assert.ok(taggedCount(tag) > 0, `${tag} has tagged tests`);
  const tags = [...new Set(MUTANTS.map(([tag]) => tag))];
  const pattern = (list) => ['--test-name-pattern', `\\[(?:${list.join('|')})\\]`];
  const control = await runMutantAsync({ root: ROOT, testRel: TEST, env: CHILD_ENV, args: pattern(tags), timeout: 30 * 60 * 1000 });
  const want = TEST_SRC.split('\n').filter((l) => /^test\('/.test(l) && tags.some((tag) => l.includes(`[${tag}]`))).length;
  assert.equal(classify(control).verdict, 'survived', `control passes: ${control.stdout.slice(-2000)}`);
  assert.equal(ran(control), want, 'the control ran every tagged test');
  const verdicts = [];
  for (const [tag, what, from, to, also = [], platform] of MUTANTS) {
    if (platform && platform !== process.platform) { t.diagnostic(`${tag} ${what}: not run (${platform}-only kill)`); continue; }
    const mutated = apply(SRC, [[from, to], ...also]);
    const r = await runMutantAsync({ root: ROOT, testRel: TEST, overrides: { [LIB]: mutated }, env: CHILD_ENV, args: pattern([tag]), timeout: 10 * 60 * 1000 });
    const v = classify(r);
    verdicts.push({ tag, what, verdict: v.verdict, ran: ran(r), expected: taggedCount(tag), failing: v.failing, why: v.why });
    t.diagnostic(`${tag} ${what}: ${v.verdict} (${ran(r)} tests) ${v.failing.join(' | ')}`);
  }
  for (const [tag, what, from, to] of EXEC_MUTANTS) {
    const r = await runMutantAsync({ root: ROOT, testRel: EXEC_TEST, overrides: { [EXEC]: apply(EXEC_SRC, [[from, to]]) }, env: CHILD_ENV, args: pattern([tag]), timeout: 10 * 60 * 1000 });
    const v = classify(r);
    const expected = EXEC_TEST_SRC.split('\n').filter((l) => /^test\('/.test(l) && l.includes(`[${tag}]`)).length;
    verdicts.push({ tag, what, verdict: v.verdict, ran: ran(r), expected, failing: v.failing, why: v.why });
    t.diagnostic(`${tag} ${what} (git-exec): ${v.verdict} (${ran(r)} tests) ${v.failing.join(' | ')}`);
  }
  const bad = verdicts.filter((v) => v.verdict !== 'killed' || v.expected === 0 || v.ran !== v.expected);
  assert.deepEqual(bad, [], 'every mutant killed by an assertion, with exactly its tagged tests run');
});
