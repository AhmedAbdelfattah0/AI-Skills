// Shared mutation harness (L1), extracted from S-30b lib/shape.test.mjs so every slice uses ONE harness. Verdicts are unchanged except one case: a missing
// test file now throws ENOENT while the tree is copied (the earlier harness ran a child and classified it 'invalid'); see copyMutantTree and the test 'harness fails closed' in mutation-harness.test.mjs.
// A mutant is 'killed' ONLY when at least one test failed and EVERY failure is an assertion error. A load/syntax/runtime error,
// a crash, a signal or a timeout is 'invalid' (proves nothing); a clean pass is 'survived'.
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Anchors are LF text: a Windows checkout (autocrlf) has CRLF, so the source is normalised to LF before matching, and every
// mutant is written back as LF. ONE loader, used by every mutation harness and by the CRLF tests alike.
export const loadMutationSource = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

/**
 * The child's own reason, so an INVALID verdict says WHY on any OS (a Windows-only load failure included): the first line naming
 * an error (SyntaxError, ERR_MODULE_NOT_FOUND, "Could not find ...", ...) from stderr then stdout, then the last output bytes.
 */
const REASON = /\b(?:[A-Z]\w*Error|ERR_(?!TEST_FAILURE)[A-Z0-9_]+)\b|Could not find/;
function tail(r) {
  const out = `${r.stderr ?? ''}\n${r.stdout ?? ''}`, first = out.split(/\r?\n/).find((l) => REASON.test(l));
  const last = String((r.stderr ?? '').trim() || (r.stdout ?? '').trim()).slice(-300);
  return first ? `${first.trim().slice(0, 300)} | ${last}` : last;
}
/** `r` is a spawnSync result of `node --test` (TAP on stdout). */
export function classify(r) {
  if (r.error || r.signal || r.status === null) return { verdict: 'invalid', failing: [], why: `${String(r.error?.code ?? r.signal ?? 'no status')}: ${tail(r)}` };
  const blocks = r.stdout.split(/^not ok /m).slice(1);
  if (r.status === 0 && blocks.length === 0) return { verdict: 'survived', failing: [] };
  const failing = blocks.map((b) => b.split('\n')[0].replace(/^\d+ - /, '')), nonAssert = blocks.filter((b) => !/code: 'ERR_ASSERTION'/.test(b));
  if (blocks.length === 0 || nonAssert.length || /ERR_MODULE_NOT_FOUND|SyntaxError/.test(r.stdout + r.stderr)) return { verdict: 'invalid', failing, why: `non-assertion failure (exit ${r.status}): ${tail(r)}` };
  return { verdict: 'killed', failing };
}

/**
 * Copy the whole tree at `root` (every module a test may import, at any depth, plus data files; every OTHER *.test.mjs is left
 * out) to a temp dir, then the test under run itself, then `overrides` ({ relPath: source }).
 * The filter decides on the file NAME only, never on the absolute path `cp` hands it: Node 18's fs.cpSync passes
 * toNamespacedPath() spellings (`\\?\D:\...`) on Windows, so comparing against join(root, testRel) never matched there and the
 * test file was silently left out (every mutant then reported 'invalid'). The test file is copied explicitly by its relative
 * path, so a missing one throws (ENOENT) instead of becoming an INVALID verdict. `cp` is a seam for that regression test only.
 */
export function copyMutantTree(root, testRel, overrides = {}, { cp = cpSync } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mutant-'));
  try {
    cp(root, dir, { recursive: true, filter: (src) => !src.endsWith('.test.mjs') });
    mkdirSync(dirname(join(dir, testRel)), { recursive: true });
    copyFileSync(join(root, testRel), join(dir, testRel));
    for (const [rel, src] of Object.entries(overrides)) writeFileSync(join(dir, rel), src);
  } catch (error) { rmSync(dir, { recursive: true, force: true }); throw error; }
  return dir;
}
export function runMutant({ root, testRel, overrides = {}, env, args = [], timeout = 120000, cp }) {
  const dir = copyMutantTree(root, testRel, overrides, { cp });
  try { return spawnSync(process.execPath, ['--test', ...args, join(dir, testRel)], { env, encoding: 'utf8', timeout }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

/** runMutant without blocking, so independent mutants can run side by side: resolves the same shape as spawnSync (SIGKILL at `timeout`). */
export function runMutantAsync({ root, testRel, overrides = {}, env, args = [], timeout = 120000, cp }) {
  const dir = copyMutantTree(root, testRel, overrides, { cp });
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', ...args, join(dir, testRel)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', error;
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { error = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); child.kill('SIGKILL'); }, timeout);
    child.on('error', (e) => { error = e; });
    child.on('close', (status, signal) => { clearTimeout(timer); rmSync(dir, { recursive: true, force: true }); resolve({ status, signal, stdout, stderr, error }); });
  });
}
