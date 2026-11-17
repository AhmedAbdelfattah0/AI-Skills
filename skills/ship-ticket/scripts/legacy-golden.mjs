#!/usr/bin/env node
// MAINTAINER ONLY. Regenerates legacy-figures.golden.json from the ORIGIN/MAIN scripts, never from the working tree:
// it extracts the pinned base commit with `git archive` into a temp dir and runs the capture against that copy,
// so the golden cannot be re-baselined on candidate code. Needs the base commit in the local clone (git fetch origin).
// Usage: node legacy-golden.mjs   (from inside the repository)
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

export const BASE_SHA = '752371eb91a2df5568bf7a455d1ccb3d635dd687';
const here = dirname(fileURLToPath(import.meta.url));
export const GOLDEN = join(here, 'legacy-figures.golden.json');

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'legacy-base-')));
  try {
    const top = spawnSync('git', ['-C', here, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim();
    const archive = spawnSync('git', ['-C', top, 'archive', BASE_SHA, 'skills/ship-ticket/scripts'], { maxBuffer: 1 << 28 });
    if (archive.status !== 0) throw new Error(`git archive ${BASE_SHA} failed: ${archive.stderr}`);
    const untar = spawnSync('tar', ['-x', '-C', tmp], { input: archive.stdout });
    if (untar.status !== 0) throw new Error('tar failed');
    const { capture } = await import('./legacy-golden.capture.test-helper.mjs');
    const data = await capture(join(tmp, 'skills', 'ship-ticket', 'scripts'));
    writeFileSync(GOLDEN, `${JSON.stringify({ base_sha: BASE_SHA, captured_by: 'legacy-golden.mjs (git archive of base_sha, not the working tree)', data }, null, 1)}\n`);
    process.stdout.write(`wrote ${GOLDEN} from ${BASE_SHA}\n`);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
