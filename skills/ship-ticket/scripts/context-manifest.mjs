#!/usr/bin/env node
/**
 * Trusted context delivery for ship-ticket (P0 slice E4). Node built-ins only.
 *
 * `references/context-manifest.json` lists every reference file of the skill with its sha256 and,
 * per phase, the references that phase must load. `build` regenerates it from the files on disk;
 * `verify` fails when any reference changed, was removed or was added without a rebuild, or when the
 * phase lists differ from PHASE_REFS below (the one source of truth for what is mandatory).
 * context-manifest.test.mjs runs `verify` in CI, so a reference edit without a rebuild fails there.
 *
 * Bytes are read through a READER: `fsReader` (the files on disk) or `gitReader` (the blobs of one
 * commit of the skill's own git repository, which no later work-tree write can change). The engine
 * pins the reader at enrollment (engine-enroll.mjs) and delivers through it. What delivery proves is
 * VERIFIED DELIVERY: the exact bytes reached the tool result. Not that the model read, understood or
 * followed them.
 *
 * CLI: context-manifest.mjs build|verify [--skill <dir>]   (default: the skill folder holding this script)
 * Exit codes: 0 ok, 1 verify failed, 2 usage error.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isEntrypoint } from './harness.mjs';

export const MANIFEST_SCHEMA = 'ship-ticket-context-manifest-v1';
export const MANIFEST_REL = 'references/context-manifest.json';
export const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Mandatory references per phase (the conditional ones, e.g. units.md or design-parity.md, are not listed). */
export const PHASE_REFS = Object.freeze({
  understand: ['references/observability.md', 'references/understand.md', 'references/cross-model.md'],
  plan: ['references/plan.md', 'references/cross-model.md'],
  build: ['references/execution-harness.md', 'references/brief.md'],
  review: ['references/review.md'],
  ship: ['references/ship.md'],
});
export const PHASES = Object.freeze(Object.keys(PHASE_REFS));

export const sha256 = (bytes) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const fail = (code, reasons) => ({ ok: false, code, reasons });

/** Files on disk. `list()` is every reference file except the manifest. */
export function fsReader(skillDir = SKILL_DIR) {
  return { mode: 'copy', revision: null,
    read: (rel) => { try { return readFileSync(join(skillDir, rel)); } catch { return null; } },
    list: () => {
      const dir = join(skillDir, 'references');
      if (!existsSync(dir)) return [];
      return readdirSync(dir, { withFileTypes: true }).filter(d => d.isFile() && `references/${d.name}` !== MANIFEST_REL).map(d => `references/${d.name}`).sort();
    } };
}

const gitAt = (dir, args) => spawnSync('git', ['-C', dir, ...args], { maxBuffer: 64 * 1024 * 1024, timeout: 30000 });

/**
 * The blobs of commit `revision` (default: HEAD) of the git repository holding `skillDir`, or null
 * when the skill folder is not inside a git work tree (a copy install).
 */
export function gitReader(skillDir = SKILL_DIR, revision = null) {
  const prefixR = gitAt(skillDir, ['rev-parse', '--show-prefix']);
  if (prefixR.status !== 0) return null;
  const prefix = prefixR.stdout.toString('utf8').trim();
  const rev = revision ?? gitAt(skillDir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).stdout?.toString('utf8').trim();
  if (!rev || gitAt(skillDir, ['cat-file', '-e', `${rev}^{commit}`]).status !== 0) return { mode: 'git', revision: rev || null, missing: true, read: () => null, list: () => [] };
  return { mode: 'git', revision: rev,
    read: (rel) => { const r = gitAt(skillDir, ['cat-file', 'blob', `${rev}:${prefix}${rel}`]); return r.status === 0 ? r.stdout : null; },
    list: () => {
      const r = gitAt(skillDir, ['ls-tree', rev, '--', `${prefix}references/`]);
      if (r.status !== 0) return [];
      return r.stdout.toString('utf8').split('\n').filter(l => / blob /.test(l)).map(l => l.split('\t')[1].slice(prefix.length))
        .filter(p => p !== MANIFEST_REL).sort();
    } };
}

/** The manifest object `build` writes for the files now on disk. */
export function buildManifest(skillDir = SKILL_DIR) {
  const R = fsReader(skillDir);
  const files = Object.fromEntries(R.list().map(p => [p, sha256(R.read(p))]));
  return { schema: MANIFEST_SCHEMA, phases: structuredClone(PHASE_REFS), files };
}

/** Exact bytes `build` writes (stable: sorted keys come from the sorted file list). */
export const manifestText = (manifest) => JSON.stringify(manifest, null, 2) + '\n';

/**
 * Verify the skill as `reader` sees it against the manifest it holds: the manifest parses, phase
 * lists equal PHASE_REFS, every listed file has its recorded bytes, and no reference exists that the
 * manifest does not list. -> { ok, code, reasons, digest, manifest }
 */
export function verifySkill(skillDir = SKILL_DIR, reader = fsReader(skillDir)) {
  if (reader.missing) return fail('skill_revision_unavailable', [`the pinned skill revision ${reader.revision} is not in the skill's git repository`]);
  const raw = reader.read(MANIFEST_REL);
  if (!raw) return fail('manifest_missing', [`${MANIFEST_REL} is missing; run context-manifest.mjs build`]);
  let m;
  try { m = JSON.parse(raw.toString('utf8')); } catch { return fail('manifest_invalid', [`${MANIFEST_REL} is not JSON`]); }
  if (m?.schema !== MANIFEST_SCHEMA || !m.files || typeof m.files !== 'object' || !m.phases || typeof m.phases !== 'object')
    return fail('manifest_invalid', [`${MANIFEST_REL} does not have the ${MANIFEST_SCHEMA} shape`]);
  const digest = sha256(raw), reasons = [];
  let code = null;
  const add = (c, r) => { code ??= c; reasons.push(r); };
  if (JSON.stringify(m.phases) !== JSON.stringify(PHASE_REFS)) add('manifest_phases_changed', 'manifest phase lists differ from PHASE_REFS; rebuild');
  for (const [phase, list] of Object.entries(m.phases)) for (const p of list ?? []) if (!Object.hasOwn(m.files, p)) add('manifest_invalid', `${phase} lists ${p}, which the manifest has no digest for`);
  for (const [p, d] of Object.entries(m.files)) {
    const b = reader.read(p);
    if (!b) add('reference_missing', `${p} is listed but missing`);
    else if (sha256(b) !== d) add('reference_changed', `${p} differs from its manifest digest`);
  }
  for (const p of reader.list()) if (!Object.hasOwn(m.files, p)) add('reference_extra', `${p} exists but the manifest does not list it`);
  return code ? { ok: false, code, reasons, digest } : { ok: true, code: 'verified', reasons: [], digest, manifest: m };
}

/** Legacy name kept for the CLI: the on-disk manifest and its digest. */
export function loadManifest(skillDir = SKILL_DIR) {
  const raw = fsReader(skillDir).read(MANIFEST_REL);
  return raw ? { ok: true, digest: sha256(raw) } : fail('manifest_missing', [`${MANIFEST_REL} is missing`]);
}

/**
 * The delivery of one phase through `reader`: the whole skill verifies, then each mandatory file is
 * read ONCE and those same bytes are hashed and returned, so what is printed is what was checked.
 * -> { ok, code, reasons, digest, inventory: [{ path, sha256 }], text }
 */
export function deliverPhase(phase, skillDir = SKILL_DIR, reader = fsReader(skillDir)) {
  if (!Object.hasOwn(PHASE_REFS, phase ?? '')) return fail('phase_unknown', [`phase must be one of ${PHASES.join(', ')}`]);
  const v = verifySkill(skillDir, reader);
  if (!v.ok) return v;
  const inventory = [], parts = [];
  for (const p of v.manifest.phases[phase]) {
    const bytes = reader.read(p);
    if (!bytes) return fail('reference_missing', [`${p} is missing`]);
    const digest = sha256(bytes);
    if (digest !== v.manifest.files[p]) return fail('reference_changed', [`${p} changed during delivery`]);
    inventory.push({ path: p, sha256: digest });
    parts.push(`===== BEGIN ${p} ${digest} =====\n${bytes.toString('utf8')}${bytes.length && bytes[bytes.length - 1] !== 0x0a ? '\n' : ''}===== END ${p} =====\n`);
  }
  const src = reader.mode === 'git' ? `skill commit ${reader.revision}` : 'skill files';
  const head = `===== ship-ticket context: phase ${phase}, manifest ${v.digest} (${src}), ${inventory.length} file(s) =====\n`;
  return { ok: true, code: 'delivered', reasons: [], digest: v.digest, inventory, text: head + parts.join('') };
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const skillDir = rest.length === 2 && rest[0] === '--skill' ? rest[1] : SKILL_DIR;
  if (!['build', 'verify'].includes(cmd) || !(rest.length === 0 || (rest.length === 2 && rest[0] === '--skill'))) {
    process.stderr.write('Usage: context-manifest.mjs build|verify [--skill <dir>]\n');
    return 2;
  }
  if (cmd === 'build') {
    writeFileSync(join(skillDir, MANIFEST_REL), manifestText(buildManifest(skillDir)));
    process.stdout.write(`context-manifest: wrote ${MANIFEST_REL} (${loadManifest(skillDir).digest})\n`);
    return 0;
  }
  const v = verifySkill(skillDir);
  if (!v.ok) { process.stderr.write(`context-manifest: FAIL ${v.code}: ${v.reasons.join('; ')}; run context-manifest.mjs build after reviewing the change\n`); return 1; }
  process.stdout.write(`context-manifest: ok ${v.digest}\n`);
  return 0;
}

if (isEntrypoint(import.meta.url)) process.exitCode = main(process.argv.slice(2));
