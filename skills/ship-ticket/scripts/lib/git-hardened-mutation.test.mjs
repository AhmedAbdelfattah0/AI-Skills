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
  ['S7', 'a throwing getter or a revoked Proxy escapes as a raw error', '\nconst oidLines = (s) => { try { return readOidLines(s); } catch { return null; } };', '\nconst oidLines = (s) => readOidLines(s);'],
  ['S4', 'any stdin kind accepted (input on any call)', "Object.keys(s).length !== 2 || ownValue(s, 'kind') !== 'oid-lines') return null;", 'Object.keys(s).length !== 2) return null;'],
];
/**
 * [tag, what the mutant removes, from, to, also?, platform?]: each `from` must occur exactly once in lib/git-hardened.mjs. A
 * platform-bound mutant runs only there: M29 (name normalisation) is equivalent on a normalisation-sensitive filesystem
 * (Linux: the NFC path then simply does not exist, so the walk still reports `missing`); its kill needs APFS (darwin).
 * M56 (typed removal errors) needs `chflags uchg` to make an unlink fail without root, so its test and mutant are darwin-only.
 */
export const MUTANTS = [
  ['M01', 'skip the win32 refusal', "  if (process.platform === 'win32') throw fail('platform_unsupported', 'context.create');\n", ''],
  ['M02', 'cells ignore the git version string', 'const sameCell = (a, b) => a.git === b.git && a.os', 'const sameCell = (a, b) => a.os'],
  ['M02', 'cells compare major.minor only', 'const sameCell = (a, b) => a.git === b.git && a.os', 'const sameCell = (a, b) => a.git.slice(0, 16) === b.git.slice(0, 16) && a.os'],
  ['M03', 'skip the context tamper check', "  if (!sameNode(now, st.rootStat) || hooks === null || hooks.length !== 0) throw fail('context_tampered', op);\n", ''],
  ['M03', 'skip the disposed check', "  if (DISPOSED.has(ctx)) throw fail('context_disposed', op);\n", ''],
  ['M03', 'dispose removes a replaced R', "  if (!sameNode(fx.lstatOrNull(st.root), st.rootStat)) throw fail('context_tampered', 'context.dispose');\n", ''],
  ['M04', 'skip the shallow refusal', "  if (fx.lstatOrNull(join(common, B('shallow')))) throw fail('shallow_unsupported', op);\n", ''],
  ['M05', 'skip the grafts refusal', "  if (fx.lstatOrNull(join(common, B('info/grafts')))) throw fail('grafts_present', op);\n", ''],
  ['M06', 'skip the alternates refusal at open', "  if (alternatesPresent(fx, objects)) throw fail('alternates_present', op);\n", ''],
  ['M07', 'bounded reads without the cap', "    if (n > cap) throw fail('worktree_entry_unsupported', op);\n", ''],
  ['M07', 'R allowed inside the clone (TMPDIR)', "  if ([top, common].some((d) => inside(st.root, d))) throw fail('owned_dir_invalid', op);\n", ''],
  ['M09', 'skip connectivity', "  corruptOnFail(() => git(fx, st, 'store.connect', dir, [head, base]), 'store.connect');\n", ''],
  ['M09', 'keep the producer .idx instead of re-hashing', "  for (const ext of ['idx', 'rev']) { const f = join(V, B(`tmp/p-${out[0]}.${ext}`)); if (fx.lstatOrNull(f)) fx.unlink(f); }\n",
    "  fx.copyFile(join(V, B(`tmp/p-${out[0]}.idx`)), B(`${dir}/objects/pack/pack-${out[0]}.idx`));\n",
    [["  corruptOnFail(() => git(fx, st, 'store.index', dir, [st.maxTotalObjectBytes, packPath]), 'store.index');\n", '']]],
  ['M10', 'index-pack --strict', "['index-pack', '--max-input-size=<n>', '<path>']", "['index-pack', '--strict', '--max-input-size=<n>', '<path>']"],
  ['M11', 'skip the per-object size cap', "      if (+m[1] > st.maxObjectBytes) throw fail('object_too_large', 'store.sizes');\n", ''],
  ['M12', 'skip the total size cap', '      total(+m[1]);\n', ''],
  ['M13', 'skip the post-ingest source re-check', "  recheckSource(fx, s, 'store.init');\n", ''],
  ['M15', 'remove in place instead of quarantining', "    gx.rename(D, join(slot, B('store')));\n", "    removeTree(gx, D, created.dev, Number.MAX_SAFE_INTEGER);\n"],
  ['M15', 'ignore the removal budget', "  const spend = meter(budget, 'lane_remove_failed', 'remove', gx);", "  const spend = meter(Number.MAX_SAFE_INTEGER, 'lane_remove_failed', 'remove', gx);"],
  ['M16', 'drop the u+w restore', '    if ((ds.mode & 0o700) !== 0o700) gx.chmod(d, (ds.mode & 0o7777) | 0o700);\n', ''],
  ['M16', 'treat a symlink as a directory to descend', '      if (s.isDirectory() && !s.isSymbolicLink()) queue.push(p);', '      if (s.isDirectory() || s.isSymbolicLink()) queue.push(p);'],
  ['M17', 'skip the blob hash check', "  if (!blobHash(bytes).equals(Buffer.from(oid, 'hex'))) throw fail('object_corrupt', id);\n", ''],
  ['M18', 'last-wins path map (duplicates pass)', "    if (seen.has(hexKey(e.path))) throw fail('tree_path_unsafe', id);\n", ''],
  ['M19', 'skip the unsafe-component checks (listing and raw names)', "    if (unsafePath(fx, path)) throw fail('tree_path_unsafe', id);\n    out.push(Object.freeze({ mode", '    out.push(Object.freeze({ mode',
    [['    if (name.indexOf(0x2f) >= 0 || unsafePath(fx, name)) throw', '    if (name.indexOf(0x2f) >= 0) throw']]],
  ['M49', 'raw tree names may hold a slash', '    if (name.indexOf(0x2f) >= 0 || unsafePath(fx, name)) throw', '    if (unsafePath(fx, name)) throw'],
  ['M20', 'merge-base without --all', "['merge-base', '--all', '--end-of-options', '<oid>', '<oid>']", "['merge-base', '--end-of-options', '<oid>', '<oid>']"],
  ['M21', 'skip the store integrity check in op()', '  checkStore(fx, h.storeDir, id);\n  if (id === \'tree.list\') return listTree(fx, st, h, operands);\n  const res', "  if (id === 'tree.list') return listTree(fx, st, h, operands);\n  const res"],
  ['M22', 'skip hashing (trust the stat)', '  const sum = hashFile(fx, abs, lst, spendBytes, op);', "  const sum = lst.mtimeMs < Date.now() + 1 ? Buffer.from(e.oid, 'hex') : hashFile(fx, abs, lst, spendBytes, op);"],
  ['M23', 'accept on eol_hint', "  if (!sum.equals(Buffer.from(e.oid, 'hex'))) diff(e.path, 'content', { eol_hint: eolHint(fx, st, h, e, abs, lst, op) });",
    "  if (!sum.equals(Buffer.from(e.oid, 'hex')) && !eolHint(fx, st, h, e, abs, lst, op)) diff(e.path, 'content', { eol_hint: false });"],
  ['M25', 'treat a populated gitlink as clean', "if (hasEntry(fx, abs, spendFiles)) diff(e.path, 'gitlink_populated');", 'hasEntry(fx, abs, spendFiles);'],
  ['M46', 'no scan of untracked directories for a nested .git', '      if (us && us.isDirectory() && !us.isSymbolicLink()) untrackedDirs.push(childRel(n));\n', ''],
  ['M47', 'a populated gitlink is enumerated completely', 'if (hasEntry(fx, abs, spendFiles)) diff', 'if (listDir(fx, abs, spendFiles).length !== 0) diff'],
  ['M48', 'rollback without the creation-identity check', "  if (!sameNode(now, created) || !now.isDirectory() || now.uid !== uid()) throw fail('context_tampered', 'store.init');\n", ''],
  ['M50', 'raw fs error from an unreadable dir', "  try { d = fx.openDir(p); } catch (e) { if (expired(e)) throw e; throw fail('worktree_entry_unsupported', 'listdir'); }\n  const names", '  d = fx.openDir(p);\n  const names'],
  ['M51', 'verifyWorktree skips the store identity check', "function op_(fx, st, h, id, operands) {\n  if (!sameNode(fx.lstatOrNull(h.storeDir), h.stat)) throw fail('context_tampered', id);\n", 'function op_(fx, st, h, id, operands) {\n'],
  ['M52', 'batch-check line count not checked', "    if (sizes.length !== chunk.oids.length) throw fail('object_corrupt', 'store.sizes');\n", ''],
  ['M56', 'raw fs errors escape removal', "  try { removeTreeRaw(gx, root, dev, spend); } catch (e) { if (expired(e)) throw e; if (e instanceof GitError && e.code === 'lane_remove_failed') throw e; throw fail('lane_remove_failed', 'remove'); }", '  removeTreeRaw(gx, root, dev, spend);', [], 'darwin'],
  ['M64', 'cleanup keeps a walk code instead of lane_remove_failed', "if (e instanceof GitError && e.code === 'lane_remove_failed') throw e;", 'if (e instanceof GitError) throw e;'],
  ['M59', 'op() runs internal rows', "  if (!r || r.policy !== 'raw-object' || !Array.isArray(operands)) throw invalid();", '  if (!r || !Array.isArray(operands)) throw invalid();'],
  ['M60', 'verifyWorktree does not bind the store to the context', "(source === undefined) === (dir === undefined) || h.ctx !== ctx) throw invalid();", '(source === undefined) === (dir === undefined)) throw invalid();'],
  ['M60', 'verifyWorktree does not bind the source to the context', '  if (s && s.ctx !== ctx) throw invalid();\n', ''],
  ['M61', 'the gitlink read is not charged', '  try { const e = d.read(); spend(1); return e !== null; }', '  try { const e = d.read(); return e !== null; }'],
  ['M63', 'no independent cap on the produced pack', "  if (!pst.isFile() || pst.size > st.maxTotalObjectBytes) throw fail('object_too_large', 'store.pack');", "  if (!pst.isFile()) throw fail('object_too_large', 'store.pack');"],
  ['M47', 'a populated gitlink is enumerated completely without any charge', 'if (hasEntry(fx, abs, spendFiles)) diff', 'if (listDir(fx, abs, () => 0).length !== 0) diff'],
  ['M53', 'no object-count bound', "  if (all.length > st.maxObjects) throw fail('object_too_large', 'store.walk');\n", ''],
  ['M11', 'stdin passed to a row that declares none (the row binding must refuse it)', "git(fx, st, 'store.walk', Vs, [head, base])", "git(fx, st, 'store.walk', Vs, [head, base], { stdin: { kind: 'oid-lines', oids: [head] } })"],
  ['M26', 'descend into a symlinked tracked dir', '      if (cs.isSymbolicLink() || !cs.isDirectory()) {', '      if (!cs.isDirectory() && !cs.isSymbolicLink()) {'],
  ['M27', 'skip the nested .git refusal', "    for (const n of names) { fx.tick(); if (isDotGit(n) && (rel.length > 0 || !n.equals(B('.git')))) throw fail('worktree_entry_unsupported', op); }\n", ''],
  ['M28', 'no FIFO/socket/device refusal at a tracked path', "  if (!lst) return diff(e.path, 'missing');\n  if (special(lst)) throw fail('worktree_entry_unsupported', op);\n", "  if (!lst) return diff(e.path, 'missing');\n"],
  ['M29', 'normalise listed names (NFC)', '    const present = new Set(names.map(hexKey));', "    const present = new Set(names.map((n) => Buffer.from(n.toString().normalize('NFC')).toString('hex')));", [], 'darwin'],
  ['M30', 'an exclusion matches as a string prefix', '(p.length > e.length && p.subarray(0, e.length + 1).equals(Buffer.concat([e, SLASH])))', '(p.length > e.length && p.subarray(0, e.length).equals(e))'],
  ['M31', 'drop the info/exclude copy', '  const exBytes = fx.lstatOrNull(ex) ? readBounded(fx, ex, MIB, op) : EMPTY;', '  const exBytes = EMPTY;'],
  ['M32', 'ignore self-ignoring .gitignore files', "  const gitignoreUntracked = others.ignored.filter((p) => { fx.tick(); return !excluded(p) && p.subarray(p.lastIndexOf(0x2f) + 1).equals(B('.gitignore')); });", '  const gitignoreUntracked = [];'],
  ['M34', 'drop the file budget', "  const spendFiles = meter(st.maxFiles, 'worktree_budget_exceeded', op, fx);", "  const spendFiles = meter(Number.MAX_SAFE_INTEGER, 'worktree_budget_exceeded', op, fx);"],
  ['M35', 'drop the byte budget', "  const spendBytes = meter(st.maxBytes, 'worktree_budget_exceeded', op, fx);", "  const spendBytes = meter(Number.MAX_SAFE_INTEGER, 'worktree_budget_exceeded', op, fx);"],
  ['M36', 'enumeration not charged per entry', '    for (let e = d.read(); e !== null; e = d.read()) { spend(1); names.push(e.name); }', '    for (let e = d.read(); e !== null; e = d.read()) names.push(e.name);'],
  ['M37', 'no mid-read change detection', "    if (!s.isFile() || !sameNode(s, lst) || s.size !== lst.size) throw fail('worktree_unstable', op);", "    if (!s.isFile() || !sameNode(s, lst)) throw fail('worktree_unstable', op);",
    [["      if (n > s.size) throw fail('worktree_unstable', op);\n", ''], ["    if (n !== s.size || after.size !== s.size || !sameNode(after, s)) throw fail('worktree_unstable', op);\n", '']]],
  ['M38', 'the index dir is the builder git dir', '  const Is = str(I);', '  const Is = s ? str(s.common) : str(I);'],
  ['M41', 'openStore without the marker/config check', "  try { checkStore(fx, D, op); } catch (e) { if (expired(e)) throw e; throw fail('owned_dir_invalid', op); }\n", ''],
  ['M45', 'operands not validated', "      if (!ok(v) || (mark === '<n>' && v <= 0)) throw invalid();\n", ''],
  // attempt 3 (fsx): the gateway itself, recovery, codes, CPU checks.
  ['M65', 'fsx: the deadline check removed', '  const check = () => { if (Date.now() >= deadline) { const e = fail(code, op); EXPIRED.add(e); throw e; } };', '  const check = () => undefined;'],
  ['M66', 'fsx: one call site bypasses the gateway (removal lstat)', '    const ds = gx.lstat(d);', '    const ds = lstatSync(d);'],
  ['M65', 'fsx: close is checked (a descriptor leaks on expiry)', '    close: (fd) => quietClose(() => closeSync(fd)),', '    close: (fd) => { check(); quietClose(() => closeSync(fd)); },'],
  ['M65', 'recovery runs on the expired deadline', "const recovery = (fx, st, op) => fx.derive({ deadline: fx.deadline + st.timeoutMs, code: 'lane_remove_failed', op });", "const recovery = (fx, st, op) => fx.derive({ deadline: fx.deadline, code: 'lane_remove_failed', op });"],
  ['M65', 'recovery windows reopen from now (not the approved deadline + timeoutMs)', "const recovery = (fx, st, op) => fx.derive({ deadline: fx.deadline + st.timeoutMs, code: 'lane_remove_failed', op });", "const recovery = (fx, st, op) => fx.derive({ deadline: (Date.now() > fx.deadline ? Date.now() : fx.deadline) + st.timeoutMs, code: 'lane_remove_failed', op });"],
  ['M69', 'the terminal check before op() returns is removed', '  const result = rawRow(fx, st, h, id, operands);\n  fx.done();\n', '  const result = rawRow(fx, st, h, id, operands);\n'],
  ['M65', 'openSource: no terminal check (MA)', '  fx.writeNew(excludeCopy, exBytes);\n  fx.done();\n', '  fx.writeNew(excludeCopy, exBytes);\n'],
  ['M65', 'storeHandle (openStore, initStore): no terminal check (MB)', '  const stat = fx.lstat(D);\n  fx.done();\n', '  const stat = fx.lstat(D);\n'],
  ['M65', 'verifyWorktree: no terminal check (MC)', '  live(st, fx, op);\n  fx.done();\n  return Object.freeze({', '  live(st, fx, op);\n  return Object.freeze({'],
  ['M65', 'createContext: no terminal check', "    fx.writeNew(join(R, B('empty.gitconfig')), '');\n    fx.done();\n    made = true;\n", "    fx.writeNew(join(R, B('empty.gitconfig')), '');\n    made = true;\n"],
  ['M65', 'dispose: no terminal check', '  removeTree(fx, st.root, st.rootStat.dev, st.removeEntries);\n  fx.done();\n}', '  removeTree(fx, st.root, st.rootStat.dev, st.removeEntries);\n}'],
  ['M73', 'the Dir read is unchecked (MD)', 'read: () => { check(); return d.readSync(); }', 'read: () => d.readSync()'],
  ['M75', 'reads without O_NONBLOCK (ME)', '  const RD_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;', '  const RD_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;'],
  ['M74', 'the owner check of repository dirs dropped', "  if (s.uid !== uid()) throw fail('repo_owner_mismatch', op);\n  return s;", '  return s;'],
  ['M71', 'rollback without a verified creation identity', '    if (handle === null && created !== null) discard(', '    if (handle === null) discard('],
  ['M69', 'the NUL-record splitter does not tick', '{ fx.tick(); out.push(buf.subarray(at, nul)); at = nul + 1; }', '{ out.push(buf.subarray(at, nul)); at = nul + 1; }'],
  ['M69', 'unsafePath does not tick', "  for (let at = 0; at <= p.length;) {\n    fx.tick();\n    const cut = p.indexOf(0x2f, at);", '  for (let at = 0; at <= p.length;) {\n    const cut = p.indexOf(0x2f, at);'],
  ['M76', 'exclusions are not ticked', 'ex.some((e) => { fx.tick(); return p.equals(e)', 'ex.some((e) => { return p.equals(e)'],
  ['M72', 'a failing close replaces the error in flight', '  const quietClose = (f) => { try { f(); } catch { closeFailed = true; } };', '  const quietClose = (f) => f();'],
  ['M68', 'checkStore remaps an expiry to tampering', "  const okBytes = (name, want) => { try { return readBounded(fx, join(D, B(name)), 4096, op).equals(B(want)); } catch (e) { if (expired(e)) throw e; return false; } };", "  const okBytes = (name, want) => { try { return readBounded(fx, join(D, B(name)), 4096, op).equals(B(want)); } catch (e) { return false; } };"],
  ['M68', 'live remaps an expiry to tampering', "  try { hooks = listDir(fx, join(st.root, B('hooks')), () => 0); } catch (e) { if (expired(e)) throw e; hooks = null; }", "  try { hooks = listDir(fx, join(st.root, B('hooks')), () => 0); } catch (e) { hooks = null; }"],
  ['M66', 'eolHint swallows an expiry (a catch that does not rethrow the sentinel)', "  try { work = readBounded(fx, abs, EOL_HINT_CAP, op); } catch (err) { if (expired(err)) throw err; return false; }", '  try { work = readBounded(fx, abs, EOL_HINT_CAP, op); } catch (err) { return false; }'],
  ['M69', 'the tree.list parse loops do not check the clock', "  for (const rec of zRecords(fx, stdout)) {\n    fx.tick();\n    const tab", '  for (const rec of zRecords(fx, stdout)) {\n    const tab',
    [["  for (const e of out) {\n    fx.tick();\n    if (seen.has", '  for (const e of out) {\n    if (seen.has'], ["  for (const e of out) {\n    fx.tick();\n    const cut", '  for (const e of out) {\n    const cut']]],
  ['M69', 'the quadratic prefix scan is restored', "    const cut = e.path.lastIndexOf(0x2f);\n    if (cut < 0) continue;\n    const parentKey = hexKey(e.path.subarray(0, cut));\n    if (leaves.has(parentKey) || !seen.has(parentKey)) throw fail('tree_path_unsafe', id);",
    "    for (let i = 0; i < e.path.length; i++) if (e.path.subarray(i, i + 1).equals(SLASH)) { const k = hexKey(e.path.subarray(0, i)); if (leaves.has(k) || !seen.has(k)) throw fail('tree_path_unsafe', id); }"],
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
