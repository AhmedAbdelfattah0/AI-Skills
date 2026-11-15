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
 * `run-engine.mjs context --phase <p>` uses deliverPhase(): it re-reads each mandatory file, checks
 * its exact bytes against the manifest and prints those verified bytes as the delivery. What this
 * proves is VERIFIED DELIVERY: the exact bytes reached the tool result. It does not prove that the
 * model read, understood or followed them.
 *
 * CLI: context-manifest.mjs build|verify [--skill <dir>]   (default: the skill folder holding this script)
 * Exit codes: 0 ok, 1 verify failed, 2 usage error.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
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

/** Every reference file on disk (repo-relative to the skill folder), the manifest itself excluded. */
function referenceFiles(skillDir) {
  const dir = join(skillDir, 'references');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter(d => d.isFile() && `references/${d.name}` !== MANIFEST_REL)
    .map(d => `references/${d.name}`).sort();
}

/** The manifest object `build` writes for the files now on disk. */
export function buildManifest(skillDir = SKILL_DIR) {
  const files = Object.fromEntries(referenceFiles(skillDir).map(p => [p, sha256(readFileSync(join(skillDir, p)))]));
  return { schema: MANIFEST_SCHEMA, phases: structuredClone(PHASE_REFS), files };
}

/** Exact bytes `build` writes (stable: sorted keys come from the sorted file list). */
export const manifestText = (manifest) => JSON.stringify(manifest, null, 2) + '\n';

/** The manifest on disk and its digest (sha256 of the file bytes), or a refusal. */
export function loadManifest(skillDir = SKILL_DIR) {
  let raw;
  try { raw = readFileSync(join(skillDir, MANIFEST_REL)); } catch { return fail('manifest_missing', [`${MANIFEST_REL} is missing; run context-manifest.mjs build`]); }
  let m;
  try { m = JSON.parse(raw.toString('utf8')); } catch { return fail('manifest_invalid', [`${MANIFEST_REL} is not JSON`]); }
  if (m?.schema !== MANIFEST_SCHEMA || !m.files || typeof m.files !== 'object' || !m.phases || typeof m.phases !== 'object')
    return fail('manifest_invalid', [`${MANIFEST_REL} does not have the ${MANIFEST_SCHEMA} shape`]);
  return { ok: true, manifest: m, digest: sha256(raw) };
}

/**
 * Verify the whole skill against its manifest: phase lists equal PHASE_REFS, every listed file exists
 * with its recorded bytes, and no reference file exists that the manifest does not list.
 * -> { ok, code, reasons, digest, manifest }
 */
export function verifySkill(skillDir = SKILL_DIR) {
  const L = loadManifest(skillDir);
  if (!L.ok) return L;
  const { manifest: m } = L;
  const reasons = [];
  let code = null;
  const add = (c, r) => { code ??= c; reasons.push(r); };
  if (JSON.stringify(m.phases) !== JSON.stringify(PHASE_REFS)) add('manifest_phases_changed', 'manifest phase lists differ from PHASE_REFS; rebuild');
  for (const [phase, list] of Object.entries(m.phases)) for (const p of list ?? []) if (!Object.hasOwn(m.files, p)) add('manifest_invalid', `${phase} lists ${p}, which the manifest has no digest for`);
  for (const [p, digest] of Object.entries(m.files)) {
    const abs = join(skillDir, p);
    if (!existsSync(abs)) add('reference_missing', `${p} is listed but missing`);
    else if (sha256(readFileSync(abs)) !== digest) add('reference_changed', `${p} differs from its manifest digest`);
  }
  for (const p of referenceFiles(skillDir)) if (!Object.hasOwn(m.files, p)) add('reference_extra', `${p} exists but the manifest does not list it`);
  return code ? { ok: false, code, reasons, digest: L.digest } : { ok: true, code: 'verified', reasons: [], digest: L.digest, manifest: m };
}

/**
 * The delivery of one phase: the whole skill verifies (a changed non-mandatory reference also means
 * the installed skill is not the one the manifest describes), then each mandatory file is read ONCE
 * and those same bytes are both hashed and returned, so what is printed is what was checked.
 * -> { ok, code, reasons, digest, inventory: [{ path, sha256 }], text }
 */
export function deliverPhase(phase, skillDir = SKILL_DIR) {
  if (!Object.hasOwn(PHASE_REFS, phase ?? '')) return fail('phase_unknown', [`phase must be one of ${PHASES.join(', ')}`]);
  const v = verifySkill(skillDir);
  if (!v.ok) return v;
  const inventory = [], parts = [];
  for (const p of v.manifest.phases[phase]) {
    let bytes;
    try { bytes = readFileSync(join(skillDir, p)); } catch { return fail('reference_missing', [`${p} is missing`]); }
    const digest = sha256(bytes);
    if (digest !== v.manifest.files[p]) return fail('reference_changed', [`${p} changed during delivery`]);
    inventory.push({ path: p, sha256: digest });
    parts.push(`===== BEGIN ${p} ${digest} =====\n${bytes.toString('utf8')}${bytes.length && bytes[bytes.length - 1] !== 0x0a ? '\n' : ''}===== END ${p} =====\n`);
  }
  const head = `===== ship-ticket context: phase ${phase}, manifest ${v.digest}, ${inventory.length} file(s) =====\n`;
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
