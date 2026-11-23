#!/usr/bin/env node
/**
 * Trusted context delivery for ship-ticket (P0 slice E4, ported to main by S-28b b0 from a890b0d). Node built-ins plus this
 * skill's own harness.mjs (isEntrypoint) and engine-base-read.mjs (underHardenedGit); no third-party package.
 *
 * `references/context-manifest.json` lists every reference file of the skill with its sha256 and,
 * per phase, the references that phase must load. `build` regenerates it from the files on disk;
 * `verify` fails when any reference changed, was removed or was added without a rebuild, or when the
 * phase lists differ from PHASE_REFS below (the one source of truth for what is mandatory).
 * context-manifest.test.mjs runs `verify` in CI, so a reference edit without a rebuild fails there.
 *
 * references/ is FLAT: every entry must be a regular file at its top level. A directory, a symlink (git mode 120000), a submodule
 * or anything else there is refused (`reference_unsupported_entry`) by `verify` and by `build`, through ONE inventory that both
 * readers compute the same way, so nothing can sit in references/ outside the manifest's view (PR #121 Round 1, MAJOR C).
 *
 * Bytes are read through a READER: `fsReader` (the files on disk) or `gitReader` (the blobs of one
 * commit of the skill's own git repository, which a work-tree edit does not change; a new commit
 * does not either, but whoever can commit to that repository can create the commit that gets pinned). Not yet in this
 * slice (S-28b b1 adds them): an engine `enroll` step that pins the reader, and a `context` command that delivers through it
 * and records the delivery. What such a record will prove is only that the verified bytes were handed to stdout and the write
 * completed; not that a model received, read, understood or followed them.
 *
 * CLI: context-manifest.mjs build|verify [--skill <dir>]   (default: the skill folder holding this script)
 * Exit codes: 0 ok, 1 verify failed or build refused (an unsupported entry in references/), 2 usage error.
 */
import { readFileSync, writeFileSync, readdirSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isEntrypoint } from './harness.mjs';
import { underHardenedGit } from './engine-base-read.mjs';

export const MANIFEST_SCHEMA = 'ship-ticket-context-manifest-v1';
export const MANIFEST_REL = 'references/context-manifest.json';
export const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Mandatory references per phase (the conditional ones, e.g. units.md or design-parity.md, are not listed). */
export const PHASE_REFS = Object.freeze({
  understand: ['references/observability.md', 'references/understand.md', 'references/cross-model.md'],
  plan: ['references/plan.md', 'references/cross-model.md'],
  build: ['references/execution-harness.md', 'references/brief.md'],
  prove: ['references/prove.md'],
  review: ['references/review.md'],
  ship: ['references/ship.md'],
});
export const PHASES = Object.freeze(Object.keys(PHASE_REFS));

export const sha256 = (bytes) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const fail = (code, reasons) => ({ ok: false, code, reasons });
const DIGEST = /^sha256:[0-9a-f]{64}$/;
/** The only path shape a manifest key may have: one name directly under references/ (no separator, no '.' or '..'). */
const REF_PATH = /^references\/(?!\.\.?$)[^/\\\0]+$/;

/**
 * The inventory of references/: { files, unsupported }. `files` = every top-level regular file except the manifest, sorted;
 * `unsupported` = '<path> (<kind>)' for every other entry, and 'references is not a directory (<kind>)' when references/ is
 * itself not a plain directory. Both readers build it from the same kinds, so they agree on any tree.
 */
const inventoryOf = (entries) => {
  const files = [], unsupported = [];
  for (const [name, kind] of entries) {
    const p = `references/${name}`;
    if (kind === 'file') { if (p !== MANIFEST_REL) files.push(p); } else unsupported.push(`${p} (${kind})`);
  }
  return { files: files.sort(), unsupported: unsupported.sort() };
};
const fsKind = (st) => st.isFile() ? 'file' : st.isDirectory() ? 'directory' : st.isSymbolicLink() ? 'symbolic link' : 'special file';

/** Files on disk (never following a symlink: lstat, and a listed path is read only when it is an inventoried regular file). */
export function fsReader(skillDir = SKILL_DIR) {
  const inventory = () => {
    const dir = join(skillDir, 'references');
    let st;
    try { st = lstatSync(dir); } catch { return { files: [], unsupported: [] }; }
    if (!st.isDirectory()) return { files: [], unsupported: [`references is not a directory (${fsKind(st)})`] };
    return inventoryOf(readdirSync(dir).map(n => { try { return [n, fsKind(lstatSync(join(dir, n)))]; } catch { return [n, 'unreadable entry']; } }));
  };
  const read = (rel) => {
    try { return lstatSync(join(skillDir, rel)).isFile() ? readFileSync(join(skillDir, rel)) : null; } catch { return null; }
  };
  return { mode: 'copy', revision: null, read, inventory };
}

// S-28b b0 (declared change from a890b0d): every git read of the skill repository runs under underHardenedGit, so no inherited
// GIT_* variable (GIT_DIR, GIT_WORK_TREE, GIT_OBJECT_DIRECTORY, ...) redirects it to another repository, and replace refs and
// grafts are off. TODO(S-02a0c): move to the shared hardened git runner when it lands.
const gitAt = (dir, args) => underHardenedGit(() => spawnSync('git', ['-C', dir, ...args], { maxBuffer: 64 * 1024 * 1024, timeout: 30000 }));

const GIT_KIND = { '100644': 'file', '100755': 'file', '040000': 'directory', '120000': 'symbolic link', '160000': 'submodule' };
/** `git ls-tree -z <sha> -- <path>` -> [[name relative to the -C directory, kind]], or null when git failed. */
const lsTree = (dir, sha, path) => {
  const r = gitAt(dir, ['ls-tree', '-z', sha, '--', path]);
  if (r.status !== 0) return null;
  return r.stdout.toString('utf8').split('\0').filter(Boolean).map(e => {
    const tab = e.indexOf('\t'), mode = e.slice(0, e.indexOf(' '));
    return [e.slice(tab + 1), GIT_KIND[mode] ?? `git mode ${mode}`];
  });
};

/**
 * The blobs of commit `revision` (default: HEAD) of the git repository holding `skillDir`, or null
 * when the skill folder is not inside a git work tree (a copy install). `revision` is resolved ONCE, here, to a full commit sha
 * (recorded as `revision`); every later read uses that sha, so a ref that moves afterwards changes nothing. Input that is not a
 * non-empty single-line string, that starts with '-', or that does not name a commit gives a reader with `missing: true`.
 */
export function gitReader(skillDir = SKILL_DIR, revision = null) {
  const prefixR = gitAt(skillDir, ['rev-parse', '--show-prefix']);
  if (prefixR.status !== 0) return null;
  const prefix = prefixR.stdout.toString('utf8').trim();
  const refused = { mode: 'git', revision: null, requested: revision, missing: true, read: () => null, inventory: () => ({ files: [], unsupported: [] }) };
  const asked = revision ?? 'HEAD';
  if (typeof asked !== 'string' || !asked || asked.startsWith('-') || /[\0\r\n]/.test(asked)) return refused;
  const r = gitAt(skillDir, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${asked}^{commit}`]);
  const rev = r.status === 0 ? r.stdout.toString('utf8').trim() : '';
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(rev)) return refused;
  // The commit is immutable, so its references/ listing is read once and memoised; read() serves only a path that listing has as
  // a top-level regular file (MAJOR C): a symlink blob, a nested path or a submodule is never read.
  let listing;
  const entries = () => {
    if (listing !== undefined) return listing;
    // S-28b b0 (declared fix of a890b0d): ls-tree paths, in and out, are relative to the -C directory, so the repository prefix
    // (which only `rev:path` in cat-file needs) is not added or sliced; P listed nothing when the skill sat below the repo root.
    const self = lsTree(skillDir, rev, 'references');
    if (!self || self.length === 0) return (listing = { kinds: new Map(), not: null });
    if (self.length !== 1 || self[0][1] !== 'directory') return (listing = { kinds: new Map(), not: `references is not a directory (${self[0][1]})` });
    const list = lsTree(skillDir, rev, 'references/');
    if (!list) return (listing = { kinds: new Map(), not: 'references (unreadable tree)' });
    return (listing = { kinds: new Map(list.map(([p, k]) => [p.slice('references/'.length), k])), not: null });
  };
  return { mode: 'git', revision: rev,
    read: (rel) => {
      if (typeof rel !== 'string' || !rel.startsWith('references/') || entries().kinds.get(rel.slice('references/'.length)) !== 'file') return null;
      const b = gitAt(skillDir, ['cat-file', 'blob', `${rev}:${prefix}${rel}`]);
      return b.status === 0 ? b.stdout : null;
    },
    inventory: () => {
      const e = entries();
      return e.not ? { files: [], unsupported: [e.not] } : inventoryOf([...e.kinds]);
    } };
}

/** The manifest object `build` writes for the files now on disk. Throws (code reference_unsupported_entry) rather than skip an entry. */
export function buildManifest(skillDir = SKILL_DIR) {
  const R = fsReader(skillDir), inv = R.inventory();
  if (inv.unsupported.length) throw Object.assign(new Error(`reference_unsupported_entry: ${inv.unsupported.join('; ')}`), { code: 'reference_unsupported_entry' });
  const files = Object.fromEntries(inv.files.map(p => [p, sha256(R.read(p))]));
  return { schema: MANIFEST_SCHEMA, phases: structuredClone(PHASE_REFS), files };
}

/** Exact bytes `build` writes (stable: sorted keys come from the sorted file list). */
export const manifestText = (manifest) => JSON.stringify(manifest, null, 2) + '\n';

const plain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);

/**
 * Verify the skill as `reader` sees it against the manifest it holds: references/ holds only top-level regular files; the
 * manifest parses, has exactly the schema/phases/files shape, and its bytes are the canonical serialization `build` writes (so
 * duplicate keys, reordering or CRLF are refused); phase lists equal PHASE_REFS; the manifest's file set EQUALS the inventory;
 * every listed file has its recorded bytes. Never throws on manifest content. -> { ok, code, reasons, digest, manifest }
 */
export function verifySkill(skillDir = SKILL_DIR, reader = fsReader(skillDir)) {
  if (reader.missing) return fail('skill_revision_unavailable', [`the requested skill revision ${JSON.stringify(reader.requested ?? reader.revision)} does not resolve to a commit of the skill's git repository`]);
  const inv = reader.inventory();
  if (inv.unsupported.length) return fail('reference_unsupported_entry', inv.unsupported.map(u => `${u}: references/ may hold only top-level regular files`));
  const raw = reader.read(MANIFEST_REL);
  if (!raw) return fail('manifest_missing', [`${MANIFEST_REL} is missing; run context-manifest.mjs build`]);
  let m;
  try { m = JSON.parse(raw.toString('utf8')); } catch { return fail('manifest_invalid', [`${MANIFEST_REL} is not JSON`]); }
  if (!plain(m) || m.schema !== MANIFEST_SCHEMA || !plain(m.files) || !plain(m.phases) || Object.keys(m).sort().join() !== 'files,phases,schema')
    return fail('manifest_invalid', [`${MANIFEST_REL} does not have the ${MANIFEST_SCHEMA} shape`]);
  const badKeys = Object.entries(m.files).filter(([p, d]) => !REF_PATH.test(p) || p === MANIFEST_REL || typeof d !== 'string' || !DIGEST.test(d)).map(([p]) => p);
  if (badKeys.length) return fail('manifest_invalid', badKeys.map(p => `${JSON.stringify(p)} is not a top-level reference path with a sha256 digest`));
  const digest = sha256(raw), reasons = [];
  let code = null;
  const add = (c, r) => { code ??= c; reasons.push(r); };
  // phase lists are compared, never iterated, unless they equal PHASE_REFS (a malformed list such as `ship: 7` cannot throw)
  if (JSON.stringify(m.phases) !== JSON.stringify(PHASE_REFS)) add('manifest_phases_changed', 'manifest phase lists differ from PHASE_REFS; rebuild');
  else for (const [phase, list] of Object.entries(m.phases)) for (const p of list) if (!Object.hasOwn(m.files, p)) add('manifest_invalid', `${phase} lists ${p}, which the manifest has no digest for`);
  const have = new Set(inv.files);
  for (const [p, d] of Object.entries(m.files)) {
    const b = have.has(p) ? reader.read(p) : null;
    if (!b) add('reference_missing', `${p} is listed but missing`);
    else if (sha256(b) !== d) add('reference_changed', `${p} differs from its manifest digest`);
  }
  for (const p of inv.files) if (!Object.hasOwn(m.files, p)) add('reference_extra', `${p} exists but the manifest does not list it`);
  const canonical = manifestText({ schema: m.schema, phases: m.phases, files: Object.fromEntries(Object.keys(m.files).sort().map(p => [p, m.files[p]])) });
  if (raw.toString('utf8') !== canonical) add('manifest_noncanonical', `${MANIFEST_REL} is not byte-identical to its canonical form (duplicate or reordered keys, whitespace or line endings): run context-manifest.mjs build`);
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
    let m;
    try { m = buildManifest(skillDir); } catch (e) { if (e.code !== 'reference_unsupported_entry') throw e; process.stderr.write(`context-manifest: FAIL ${e.message}: references/ may hold only top-level regular files\n`); return 1; }
    writeFileSync(join(skillDir, MANIFEST_REL), manifestText(m));
    process.stdout.write(`context-manifest: wrote ${MANIFEST_REL} (${loadManifest(skillDir).digest})\n`);
    return 0;
  }
  const v = verifySkill(skillDir);
  if (!v.ok) { process.stderr.write(`context-manifest: FAIL ${v.code}: ${v.reasons.join('; ')}; run context-manifest.mjs build after reviewing the change\n`); return 1; }
  process.stdout.write(`context-manifest: ok ${v.digest}\n`);
  return 0;
}

if (isEntrypoint(import.meta.url)) process.exitCode = main(process.argv.slice(2));
