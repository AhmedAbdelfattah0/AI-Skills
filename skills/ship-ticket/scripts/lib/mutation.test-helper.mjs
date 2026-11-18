// Shared mutation harness (L1), extracted unchanged in behaviour from S-30b lib/shape.test.mjs so every slice uses ONE harness.
// A mutant is 'killed' ONLY when at least one test failed and EVERY failure is an assertion error. A load/syntax/runtime error,
// a crash, a signal or a timeout is 'invalid' (proves nothing); a clean pass is 'survived'.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Anchors are LF text: a Windows checkout (autocrlf) has CRLF, so the source is normalised to LF before matching, and every
// mutant is written back as LF. ONE loader, used by every mutation harness and by the CRLF tests alike.
export const loadMutationSource = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

/** `r` is a spawnSync result of `node --test` (TAP on stdout). */
export function classify(r) {
  if (r.error || r.signal || r.status === null) return { verdict: 'invalid', failing: [], why: String(r.error?.code ?? r.signal ?? 'no status') };
  const blocks = r.stdout.split(/^not ok /m).slice(1);
  if (r.status === 0 && blocks.length === 0) return { verdict: 'survived', failing: [] };
  const failing = blocks.map((b) => b.split('\n')[0].replace(/^\d+ - /, '')), nonAssert = blocks.filter((b) => !/code: 'ERR_ASSERTION'/.test(b));
  if (blocks.length === 0 || nonAssert.length || /ERR_MODULE_NOT_FOUND|SyntaxError/.test(r.stdout + r.stderr)) return { verdict: 'invalid', failing, why: 'non-assertion failure' };
  return { verdict: 'killed', failing };
}

/**
 * Copy the whole tree at `root` (every module a test may import, at any depth, plus data files; every OTHER *.test.mjs is left
 * out) to a temp dir, write `overrides` ({ relPath: source }), run `node --test ...args <testRel>` there -> raw spawn result.
 */
export function runMutant({ root, testRel, overrides = {}, env, args = [], timeout = 120000 }) {
  const dir = mkdtempSync(join(tmpdir(), 'mutant-'));
  try {
    const keep = join(root, testRel);
    cpSync(root, dir, { recursive: true, filter: (src) => !src.endsWith('.test.mjs') || src === keep });
    for (const [rel, src] of Object.entries(overrides)) writeFileSync(join(dir, rel), src);
    return spawnSync(process.execPath, ['--test', ...args, join(dir, testRel)], { env, encoding: 'utf8', timeout });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
