#!/usr/bin/env node
// Cross-platform skill manager for this repo (Windows / macOS / Linux).
// Dependency-free — uses only Node built-ins. Runnable three ways:
//
//   npx github:AhmedAbdelfattah0/AI-Skills <cmd>   # no clone needed (installs by copy)
//   node scripts/cli.mjs <cmd>                     # from a clone
//   ai-skills <cmd>                                # after `npm i -g` or `npm link`
//
// Commands:
//   list                       show every skill in the repo
//   install [names...]         install all skills, or only the named ones
//     --copy / -c              copy real files instead of symlinking
//     --link / -l              force symlink even from an ephemeral source
//   update [names...]          bring already-installed skills up to date
//     --check / -n             report what would change; write nothing
//     --force / -f             overwrite copies that were edited after install
//     --prune                  also remove skills no longer in the repo
//     --no-pull                skip the `git pull --ff-only` of the source clone
//   validate                   lint every skill (the same checks CI enforces)
//   help                       this message

import {
  readdirSync, readFileSync, existsSync, lstatSync, rmSync,
  symlinkSync, cpSync, mkdirSync, writeFileSync, readlinkSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const SKILLS_DIR = join(REPO_ROOT, 'skills');

// Install targets. SKILL.md is an open standard (agentskills.io, Linux
// Foundation AAIF) — the same folder works in every tool below; only the
// directory scanned differs. `agents` (~/.agents/skills) is the interoperable
// path read by Codex, Gemini CLI, and other standard-compliant tools.
const TARGETS = {
  claude: join(homedir(), '.claude', 'skills'),   // Claude Code
  agents: join(homedir(), '.agents', 'skills'),   // cross-tool: Codex, Gemini CLI, …
  codex:  join(homedir(), '.agents', 'skills'),   // OpenAI Codex (alias of agents)
  gemini: join(homedir(), '.gemini', 'skills'),   // Gemini CLI native dir
  // Google Antigravity reads ONE global dir (its workspace dir is .agents/skills,
  // which is only reachable per-repo, not from here).
  antigravity: join(homedir(), '.gemini', 'antigravity', 'skills'),
};
const DEFAULT_TARGET = 'claude';

// ---- helpers ---------------------------------------------------------------

const isWin = platform() === 'win32';

function skillDirs() {
  if (!existsSync(SKILLS_DIR)) return [];
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(SKILLS_DIR, d.name, 'SKILL.md')))
    .map((d) => d.name)
    .sort();
}

// Extract `name:` and a flattened `description:` from a SKILL.md frontmatter.
function frontmatter(md) {
  const text = readFileSync(md, 'utf8').replace(/\r\n/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return { fm: null, name: null, description: null };
  const fm = m[1];
  const nameM = fm.match(/^name:[ \t]*(.+?)[ \t]*$/m);
  let description = null;
  const inline = fm.match(/^description:[ \t]*(.+)$/m);
  if (inline && !/^[>|]/.test(inline[1].trim())) {
    description = inline[1].trim();
  } else {
    // folded/literal block: gather the indented lines that follow.
    const lines = fm.split('\n');
    const start = lines.findIndex((l) => /^description:[ \t]*[>|]/.test(l));
    if (start !== -1) {
      const body = [];
      for (const l of lines.slice(start + 1)) {
        if (l.trim() === '' || /^[ \t]+/.test(l)) body.push(l.trim());
        else break;
      }
      description = body.join(' ').trim();
    }
  }
  return { fm, name: nameM ? nameM[1] : null, description };
}

function walk(dir, onFile) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, onFile);
    else onFile(full);
  }
}

// Remove an existing dest entry, whether it is a symlink or a real directory.
function removeExisting(p) {
  let st;
  try { st = lstatSync(p); } catch { return; }
  if (st.isSymbolicLink()) rmSync(p, { force: true });          // drop the link only
  else rmSync(p, { recursive: true, force: true });
}

// Is `p` inside `root`? Via path.relative, not a string prefix: install creates
// Windows *junctions*, whose readlink comes back with backslashes (and sometimes
// a \\?\ prefix), so a hardcoded '/' test would call every Windows install
// foreign and refuse to update it.
function isUnder(root, p) {
  const rel = relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// cpSync filter: keep the litter out of the copy, matching what hashSkill ignores.
const copyFilter = (src) => !isNoise(basename(src));

// A source living inside an npm/npx cache is ephemeral — symlinks into it would
// dangle once the cache is cleaned, so we copy from there by default.
function sourceIsEphemeral() {
  const r = REPO_ROOT.replace(/\\/g, '/');
  return /\/_npx\//.test(r) || /\/node_modules\//.test(r) || /\/\.npm\//.test(r);
}

function truncate(s, n) {
  if (!s) return '';
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
}

// ---- provenance: the manifest ----------------------------------------------
//
// `update` must be able to tell a skill that is merely STALE from one the user
// EDITED in place. Without a baseline the two are byte-identical problems with
// opposite correct answers — refresh the first, never clobber the second — so
// install records what it wrote. The manifest is a dotfile, not a directory, so
// no skill scanner (they look for `<dir>/SKILL.md`) ever sees it.
const MANIFEST = '.ai-skills-manifest.json';

function readManifest(dir) {
  try { return JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8')); } catch { return null; }
}

function writeManifest(dir, data) {
  try { writeFileSync(join(dir, MANIFEST), JSON.stringify(data, null, 2) + '\n'); return true; }
  catch (err) { console.error(`⚠️  could not write ${MANIFEST}: ${err.message}`); return false; }
}

// OS and VCS droppings are not part of a skill. Hashing them makes a source that
// merely sat in Finder look "changed" against a fresh clone, and copying them
// spreads the litter into every skills directory — which is what happened: a
// stray .DS_Store made `update` want to refresh an identical skill.
const IGNORED = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.git']);
const isNoise = (name) => IGNORED.has(name);

// Content hash of a skill folder: every file's relative path AND bytes, in a
// stable order. Path-insensitive hashing would call a renamed file unchanged.
function hashSkill(dir) {
  const files = [];
  try { walk(dir, (f) => { if (!isNoise(basename(f))) files.push(f); }); } catch { return null; }
  files.sort();
  const h = createHash('sha256');
  for (const f of files) {
    h.update(relative(dir, f).replace(/\\/g, '/'));
    h.update('\0');
    h.update(readFileSync(f));
    h.update('\0');
  }
  return h.digest('hex');
}

// ---- provenance: the source ------------------------------------------------

// Never throws and never inherits stdio — a missing git, or a repo-less source
// (an npx cache is a plain folder), returns null instead of killing the run.
function git(args, cwd = REPO_ROOT) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch { return null; }
}

// True only when REPO_ROOT is itself the top of a work tree. A vendored copy
// sitting inside someone else's repo would otherwise make `update` pull THEIR repo.
const isGitClone = () => {
  const top = git(['rev-parse', '--show-toplevel']);
  return !!top && resolve(top) === resolve(REPO_ROOT);
};
const sourceCommit = () => git(['rev-parse', 'HEAD']);

// Refresh the source itself, so `update` is one command rather than
// "git pull, then re-install". Deliberately narrow: --ff-only, and only from a
// clean tree with an upstream. Anything else reports why it stopped and lets the
// re-sync proceed against whatever the checkout already holds — an update
// command has no business rebasing, stashing, or discarding the user's work.
function refreshSource({ check }) {
  if (sourceIsEphemeral()) return { status: 'ephemeral' };
  if (!isGitClone()) return { status: 'not-a-clone' };
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (!upstream) return { status: 'no-upstream', branch };
  if (check) {
    if (git(['fetch', '--quiet']) === null) return { status: 'fetch-failed', branch, upstream };
    return { status: 'check', branch, upstream, behind: Number(git(['rev-list', '--count', `HEAD..${upstream}`]) || 0) };
  }
  if (git(['status', '--porcelain'])) return { status: 'dirty', branch };
  const before = sourceCommit();
  // `git pull --quiet` prints nothing on success, so '' is success and only
  // null (a thrown non-zero exit) is failure.
  if (git(['pull', '--ff-only', '--quiet']) === null) return { status: 'pull-failed', branch, upstream };
  const after = sourceCommit();
  return { status: before === after ? 'already' : 'pulled', before, after, branch, upstream };
}

// ---- shared flag parsing ----------------------------------------------------

// Resolve --target/--dest to destination dirs. Shared by install and update so
// the two cannot disagree about where a target lives.
function resolveDests({ targetSpec, destOverride, fallback }) {
  if (destOverride) return [{ label: 'custom', dir: resolve(destOverride) }];
  const keys = !targetSpec ? fallback
    : targetSpec === 'all' ? ['claude', 'agents', 'gemini', 'antigravity']
    : targetSpec.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = keys.filter((k) => !TARGETS[k]);
  if (unknown.length) {
    console.error(`❌ unknown target(s): ${unknown.join(', ')}`);
    console.error(`   valid: ${Object.keys(TARGETS).join(', ')}, all — or use --dest <path>`);
    process.exit(1);
  }
  const seen = new Map();
  for (const k of keys) if (!seen.has(TARGETS[k])) seen.set(TARGETS[k], k);
  return [...seen].map(([dir, label]) => ({ label, dir }));
}

function parseFlags(args) {
  const names = [];
  const flags = new Set();
  let targetSpec = null, destOverride = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--target' || a === '-t') targetSpec = args[++i];
    else if (a.startsWith('--target=')) targetSpec = a.slice('--target='.length);
    else if (a === '--dest') destOverride = args[++i];
    else if (a.startsWith('--dest=')) destOverride = a.slice('--dest='.length);
    else if (a.startsWith('-')) flags.add(a);
    else names.push(a);
  }
  return { names, flags, targetSpec, destOverride };
}

// ---- commands --------------------------------------------------------------

function cmdList() {
  const names = skillDirs();
  console.log(`${names.length} skill(s) in ${SKILLS_DIR}\n`);
  for (const name of names) {
    const { description } = frontmatter(join(SKILLS_DIR, name, 'SKILL.md'));
    console.log(`  ${name.padEnd(24)} ${truncate(description, 72)}`);
  }
}

function cmdInstall(args) {
  const wantCopy = args.includes('--copy') || args.includes('-c');
  const wantLink = args.includes('--link') || args.includes('-l');

  // Parse --target <t1,t2|all> and --dest <path>; remaining bare words = skill names.
  const { names, targetSpec, destOverride } = parseFlags(args);

  // Resolve destination directories (deduped — codex and agents share a dir).
  const destDirs = resolveDests({ targetSpec, destOverride, fallback: [DEFAULT_TARGET] });

  const available = skillDirs();
  if (available.length === 0) {
    console.error(`❌ no skills found in ${SKILLS_DIR}`);
    process.exit(1);
  }

  let targets = available;
  if (names.length) {
    const unknown = names.filter((n) => !available.includes(n));
    if (unknown.length) {
      console.error(`❌ unknown skill(s): ${unknown.join(', ')}`);
      console.error(`   run "list" to see the ${available.length} available skills.`);
      process.exit(1);
    }
    targets = names;
  }

  // Mode: explicit flag wins; otherwise copy from an ephemeral source, else link.
  const mode = wantCopy ? 'copy' : wantLink ? 'link' : (sourceIsEphemeral() ? 'copy' : 'link');
  // Windows dir symlinks need admin/developer-mode; junctions do not, so we use
  // those under the hood — but if even that fails we tell the user to try --copy.

  const commit = sourceCommit();

  for (const { label, dir } of destDirs) {
    mkdirSync(dir, { recursive: true });
    // Merge into any existing manifest: installing two skills today must not
    // erase the record of the twelve installed last week.
    const manifest = readManifest(dir) || { version: 1, skills: {} };
    manifest.version = 1;
    manifest.source = REPO_ROOT;
    manifest.commit = commit;
    manifest.updatedAt = new Date().toISOString();
    manifest.skills ||= {};
    // The dir's prevailing mode: what a skill adopted by a later `update` should
    // use. Without it an adopted skill is symlinked into a copy-only install.
    manifest.mode = mode;
    // A bare `install` means "I want the library"; `install a b` means "I want
    // these two". Only the former should pick up skills added upstream later.
    if (!names.length) manifest.all = true;

    let ok = 0;
    for (const name of targets) {
      const src = join(SKILLS_DIR, name);
      const dst = join(dir, name);
      removeExisting(dst);
      try {
        if (mode === 'link') {
          symlinkSync(src, dst, isWin ? 'junction' : 'dir');
          console.log(`🔗 linked  ${name}  → ${label}`);
        } else {
          cpSync(src, dst, { recursive: true, filter: copyFilter });
          console.log(`📄 copied  ${name}  → ${label}`);
        }
        // The hash is the baseline `update` compares against later; a symlink
        // needs none, because the link itself proves where the content comes from.
        manifest.skills[name] = { mode, hash: mode === 'copy' ? hashSkill(dst) : null };
        ok++;
      } catch (err) {
        console.error(`❌ ${name}: ${err.message}`);
        if (mode === 'link') console.error('   symlink failed — retry with --copy');
      }
    }
    if (ok) writeManifest(dir, manifest);
    console.log(`\n✅ [${label}] installed ${ok}/${targets.length} skill(s) into ${dir}  (mode: ${mode})\n`);
  }
  if (mode === 'link') console.log(`   edits in ${SKILLS_DIR} are live everywhere they're linked.`);
  console.log(`   run "update" later to bring them up to date.`);
}

// ---- update ----------------------------------------------------------------
//
// The equivalent of `claude update` / `codex --upgrade`, for skills: refresh the
// source, then re-sync every skill already installed from it. Three install
// shapes need three different answers, so each installed entry is classified
// from the filesystem rather than assumed:
//
//   symlink into this repo   already live — the pull WAS the update
//   symlink somewhere else   another checkout owns it; report, never touch
//   real directory (a copy)  stale → refresh; edited → refuse without --force
//
// Anything whose provenance cannot be established is left alone. Overwriting a
// skill somebody edited in place is unrecoverable — there is no other copy —
// and the manifest exists precisely so that case is detectable rather than a
// coin flip.
function cmdUpdate(args) {
  const { names, flags, targetSpec, destOverride } = parseFlags(args);
  const check = flags.has('--check') || flags.has('-n') || flags.has('--dry-run');
  const force = flags.has('--force') || flags.has('-f');
  const prune = flags.has('--prune');
  const noPull = flags.has('--no-pull');

  // 1. Refresh the source. Unlike install, update's default scope is every known
  //    target directory that exists — you install per-tool, but you update "my
  //    skills", wherever they landed.
  const before = sourceCommit();
  // --no-pull means "re-sync from the checkout as it stands" — so skip the
  // source refresh entirely rather than running it and ignoring the result.
  const pull = (noPull && !check)
    ? { status: sourceIsEphemeral() ? 'ephemeral' : 'no-pull', branch: git(['rev-parse', '--abbrev-ref', 'HEAD']) }
    : refreshSource({ check });
  reportSource(pull);

  // Read the library only AFTER the refresh: a skill that arrives with the pull
  // has to be visible to the run that pulled it, or it is adopted one run late.
  const available = skillDirs();
  if (!available.length) {
    console.error(`❌ no skills found in ${SKILLS_DIR}`);
    process.exit(1);
  }
  const unknown = names.filter((n) => !available.includes(n));
  if (unknown.length) {
    console.error(`❌ unknown skill(s): ${unknown.join(', ')}`);
    console.error(`   run "list" to see the ${available.length} available skills.`);
    process.exit(1);
  }

  // A dry run must answer "what will change", not "what differs right now". When
  // the checkout is behind, the on-disk source is NOT what a real run would
  // install, so comparing against it reports "up to date" about content that is
  // one fast-forward away from changing. Ask git which skills those commits touch.
  const incoming = new Set();
  if (pull.status === 'check' && pull.behind > 0) {
    const changed = git(['diff', '--name-only', `HEAD..${pull.upstream}`, '--', 'skills']) || '';
    for (const f of changed.split('\n')) {
      const m = f.match(/^skills\/([^/]+)\//);
      if (m) incoming.add(m[1]);
    }
  }

  const existingTargets = Object.keys(TARGETS).filter((k) => existsSync(TARGETS[k]));
  const destDirs = resolveDests({
    targetSpec, destOverride,
    fallback: existingTargets.length ? existingTargets : [DEFAULT_TARGET],
  }).filter(({ label, dir }) => {
    if (existsSync(dir)) return true;
    if (targetSpec || destOverride) console.log(`—  [${label}] ${dir} does not exist — nothing installed there`);
    return false;
  });

  if (!destDirs.length) {
    console.log('\nNothing to update — no skills directory found. Run "install" first.');
    return;
  }

  let anyChange = false;
  let anySkipped = false;
  const allHints = new Set();

  for (const { label, dir } of destDirs) {
    const manifest = readManifest(dir) || { version: 1, skills: {} };
    manifest.skills ||= {};
    const tally = { updated: 0, live: 0, current: 0, added: 0, removed: 0, skipped: 0, foreign: 0, failed: 0 };
    const hints = new Set();
    console.log(`\n[${label}] ${dir}`);

    // Entries we own or might own: everything installed here, plus anything the
    // manifest says belongs to us but has since vanished from disk.
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.'))
      .map((e) => e.name);
    const scope = new Set(entries);
    // A tracked-all install adopts skills added upstream since the last update.
    if (manifest.all) for (const n of available) scope.add(n);
    for (const n of Object.keys(manifest.skills)) if (available.includes(n)) scope.add(n);

    for (const name of [...scope].sort()) {
      if (names.length && !names.includes(name)) continue;
      const src = join(SKILLS_DIR, name);
      const dst = join(dir, name);
      const record = manifest.skills[name];

      let st = null;
      try { st = lstatSync(dst); } catch { /* not installed */ }

      // (a) Not installed yet — only adopt it if this dir tracks the whole
      //     library, or the user named it explicitly.
      if (!st) {
        if (!available.includes(name)) continue;
        if (!manifest.all && !names.includes(name)) continue;
        if (check) { console.log(`   + ${name}  (new upstream — would install)`); tally.added++; anyChange = true; continue; }
        // Ephemeral beats the recorded mode, exactly as in install: a clone-mode
        // manifest + an `npx … update` would otherwise symlink the new skill
        // into the npx cache, and dangle the moment that cache is cleaned.
        const mode = sourceIsEphemeral() ? 'copy' : (record?.mode || manifest.mode || 'link');
        if (applySkill(src, dst, mode, manifest, name)) {
          console.log(`   + ${name}  (new upstream — installed)`);
          tally.added++; anyChange = true;
        } else tally.failed++;
        continue;
      }

      // (b) A symlink. Where it points decides everything.
      if (st.isSymbolicLink()) {
        let target = null;
        try { target = resolve(dirname(dst), readlinkSync(dst)); } catch { /* unreadable */ }
        if (target && isUnder(SKILLS_DIR, target)) {
          if (!existsSync(target)) {
            // The skill was deleted upstream; the link now dangles.
            if (!prune) { console.log(`   ! ${name}  dangling link (deleted upstream) — --prune to remove`); tally.skipped++; hints.add('--prune'); }
            else if (check) { console.log(`   - ${name}  (dangling — would remove)`); tally.removed++; anyChange = true; }
            else { removeExisting(dst); delete manifest.skills[name]; console.log(`   - ${name}  (dangling — removed)`); tally.removed++; anyChange = true; }
            continue;
          }
          tally.live++;   // live via symlink: the source refresh already updated it
          continue;
        }
        // A symlink into the checkout that installed it — reached here because
        // this run's source is somewhere else, e.g. `npx … update` over a
        // clone install. Still ours, still live; --force would not help, so it
        // must not be counted as a skip.
        if (manifest.source && target && isUnder(join(manifest.source, 'skills'), target)) {
          if (existsSync(target)) { tally.live++; continue; }
          console.log(`   ! ${name}  link into ${manifest.source} is dangling — re-run update from that clone, or install here`);
          tally.skipped++; continue;
        }
        // Only worth a line if it is a name this library actually ships, or one
        // we installed. A skills dir commonly holds symlinks to a completely
        // different collection; reporting each of those is pure noise.
        if (available.includes(name) || record) {
          console.log(`   ~ ${name}  symlink to ${target || 'an unreadable path'} — not ours, left alone`);
          tally.skipped++;
        } else tally.foreign++;
        continue;
      }

      // (c) A real directory: a copy. Compare, then decide.
      if (!available.includes(name)) {
        // Only entries the manifest claims are ours. A dest can hold skills from
        // elsewhere — and plain files — and neither is our business to report on.
        if (!record) continue;
        if (!prune) {
          console.log(`   ! ${name}  no longer in the library — --prune to remove`);
          tally.skipped++; hints.add('--prune'); continue;
        }
        const stillOurs = record?.hash && record.hash === hashSkill(dst);
        if (!stillOurs && !force) {
          console.log(`   ! ${name}  removed upstream but edited locally — --force to remove anyway`);
          tally.skipped++; hints.add('--force'); continue;
        }
        if (check) { console.log(`   - ${name}  (removed upstream — would remove)`); tally.removed++; anyChange = true; continue; }
        removeExisting(dst); delete manifest.skills[name];
        console.log(`   - ${name}  (removed upstream — removed)`);
        tally.removed++; anyChange = true;
        continue;
      }

      const dstHash = hashSkill(dst);
      if (dstHash === hashSkill(src)) {
        if (incoming.has(name)) {
          console.log(`   ↑ ${name}  (would update — the fast-forward changes it)`);
          tally.updated++; anyChange = true;
        } else tally.current++;
        continue;
      }

      // It differs from the source. Stale, or edited? Only the manifest knows.
      const untouchedSinceInstall = record?.hash && record.hash === dstHash;
      if (!untouchedSinceInstall && !force) {
        console.log(`   ! ${name}  ${record?.hash ? 'edited after install' : 'installed before provenance tracking'} — left alone (--force to overwrite)`);
        tally.skipped++; hints.add('--force');
        continue;
      }
      if (check) { console.log(`   ↑ ${name}  (would update${untouchedSinceInstall ? '' : ' — FORCED over local edits'})`); tally.updated++; anyChange = true; continue; }
      if (applySkill(src, dst, 'copy', manifest, name)) {
        console.log(`   ↑ ${name}  updated${untouchedSinceInstall ? '' : ' (forced over local edits)'}`);
        tally.updated++; anyChange = true;
      } else tally.failed++;
    }

    if (!check && (tally.updated || tally.added || tally.removed)) {
      manifest.version = 1;
      manifest.source = REPO_ROOT;
      manifest.commit = sourceCommit();
      manifest.updatedAt = new Date().toISOString();
      writeManifest(dir, manifest);
    }

    const parts = [];
    if (tally.updated) parts.push(`${tally.updated} updated`);
    if (tally.added) parts.push(`${tally.added} added`);
    if (tally.removed) parts.push(`${tally.removed} removed`);
    if (tally.live) parts.push(`${tally.live} live via symlink`);
    if (tally.current) parts.push(`${tally.current} already current`);
    if (tally.skipped) parts.push(`${tally.skipped} skipped`);
    if (tally.foreign) parts.push(`${tally.foreign} from another collection, untouched`);
    if (tally.failed) parts.push(`${tally.failed} failed`);
    console.log(`   ${check ? '🔎' : '✅'} ${parts.length ? parts.join(', ') : 'nothing installed here'}`);
    if (tally.skipped) { anySkipped = true; for (const h of hints) allHints.add(h); }
    if (tally.failed) process.exitCode = 1;
  }

  if (check && anyChange) {
    console.log('\n🔎 dry run — nothing was written. Re-run without --check to apply.');
  } else if (anySkipped) {
    // Never report success over declined work: a skipped skill is the one case
    // the user has to decide about, and burying it under "up to date" is how it
    // stays stale forever.
    const how = [...allHints].join(' / ') || '--force';
    console.log(`\n⚠️  up to date except for the skipped skill(s) above — re-run with ${how} to act on them.`);
  } else if (check) {
    console.log('\n✅ everything is up to date.');
  } else if (before && before !== sourceCommit()) {
    console.log(`\n   source moved ${before.slice(0, 7)} → ${sourceCommit().slice(0, 7)}`);
  }
}

// Install or refresh one skill, keeping the manifest in step with what landed.
function applySkill(src, dst, mode, manifest, name) {
  try {
    removeExisting(dst);
    if (mode === 'link') symlinkSync(src, dst, isWin ? 'junction' : 'dir');
    else cpSync(src, dst, { recursive: true, filter: copyFilter });
    manifest.skills[name] = { mode, hash: mode === 'copy' ? hashSkill(dst) : null };
    return true;
  } catch (err) {
    console.error(`   ❌ ${name}: ${err.message}`);
    return false;
  }
}

// Say what happened to the source in one line, including the cases where the
// refresh was deliberately declined — a silent skip would read as "up to date".
function reportSource(r) {
  const at = r.branch ? ` (${r.branch})` : '';
  switch (r.status) {
    case 'no-pull':
      console.log(`📦 source: --no-pull — re-syncing from ${REPO_ROOT}${at} as it stands.`); break;
    case 'ephemeral':
      console.log('📦 source: npx cache — already fetched fresh from GitHub for this run.'); break;
    case 'not-a-clone':
      console.log(`📦 source: ${REPO_ROOT} is not a git clone — re-syncing from it as-is.`); break;
    case 'no-upstream':
      console.log(`📦 source: branch${at} has no upstream — re-syncing from the local checkout.`); break;
    case 'dirty':
      console.log(`📦 source: working tree${at} has uncommitted changes — not pulling; re-syncing from it as-is.`); break;
    case 'pull-failed':
      console.log(`📦 source: git pull --ff-only${at} failed (diverged from ${r.upstream}?) — re-syncing from the local checkout.`); break;
    case 'fetch-failed':
      console.log(`📦 source: git fetch${at} failed — comparing against the local checkout only.`); break;
    case 'already':
      console.log(`📦 source: already at ${r.after?.slice(0, 7)}${at}.`); break;
    case 'pulled':
      console.log(`📦 source: pulled ${r.before?.slice(0, 7)} → ${r.after?.slice(0, 7)}${at}.`); break;
    case 'check':
      console.log(r.behind
        ? `📦 source: ${r.behind} commit(s) behind ${r.upstream}${at} — a real run would fast-forward.`
        : `📦 source: up to date with ${r.upstream}${at}.`);
      break;
  }
}

// Port of scripts/validate.sh — same three invariants, cross-platform.
const ROOT = join(SKILLS_DIR, '..');

function cmdValidate() {
  // All subdirectories — including any missing a SKILL.md, so we can flag them.
  const names = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name).sort();

  // Index every .sh basename that exists anywhere under skills/.
  const haveScript = new Set();
  walk(SKILLS_DIR, (f) => { if (f.endsWith('.sh')) haveScript.add(basename(f)); });

  const invokeRe = /(?:^|[\s;&|(=])(?:bash|sh|source|\.)[ \t]+([^\s`"']*\.sh)/gm;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  console.log(`Validating skills in ${SKILLS_DIR}\n`);
  let fail = false;

  for (const name of names) {
    const md = join(SKILLS_DIR, name, 'SKILL.md');
    let err = false;

    if (!existsSync(md)) { console.log(`❌ ${name}: no SKILL.md`); fail = true; continue; }

    const { fm, name: fmName, description } = frontmatter(md);
    if (!fm) {
      console.log(`❌ ${name}: missing or empty frontmatter (must start with '---')`);
      fail = true; continue;
    }
    if (!fmName) { console.log(`❌ ${name}: frontmatter has no 'name:'`); err = fail = true; }
    else if (fmName !== name) {
      console.log(`❌ ${name}: folder name != frontmatter name ('${fmName}'). Must match exactly.`);
      err = fail = true;
    }
    if (!description) { console.log(`❌ ${name}: frontmatter has no 'description:'`); err = fail = true; }

    const text = readFileSync(md, 'utf8');
    let m;
    invokeRe.lastIndex = 0;
    const seen = new Set();
    while ((m = invokeRe.exec(text)) !== null) {
      const p = m[1];
      if (p.includes('...') || seen.has(p)) continue;
      seen.add(p);
      const base = basename(p);
      if (haveScript.has(base)) continue;                       // bundled somewhere
      if (new RegExp(`(?:mv|cp|tee|install|>)[^|]*${esc(base)}`).test(text)) continue; // self-generated
      console.log(`❌ ${name}: calls '${base}' but it is neither bundled nor created by the skill (exit-127 risk — inline, bundle, or generate it).`);
      err = fail = true;
    }

    // 4. Every relative markdown link in the SKILL.md or its references/ resolves.
    //    A skill split across references/ is only as good as its links: a dangling
    //    one silently drops the procedure it was pointing at.
    const docs = [md];
    const refDir = join(SKILLS_DIR, name, 'references');
    if (existsSync(refDir)) walk(refDir, (f) => { if (f.endsWith('.md')) docs.push(f); });
    for (const doc of docs) {
      const body = readFileSync(doc, 'utf8');
      for (const lm of body.matchAll(/\]\((?!https?:|mailto:)([^)#\s]+)(?:#[^)]*)?\)/g)) {
        const target = resolve(dirname(doc), lm[1]);
        if (existsSync(target)) continue;
        console.log(`❌ ${name}: ${relative(SKILLS_DIR, doc)} links to '${lm[1]}', which does not exist.`);
        err = fail = true;
      }
    }

    // 5. No orphan references — by REACHABILITY from SKILL.md, not by mention.
    //    Searching for a filename as text lets a self-mention, or a cycle of
    //    references that link only to each other, pass while being unreachable.
    if (existsSync(refDir)) {
      // Reachability, not mention: walk out from SKILL.md. A reference counts as
      // cited by a markdown link OR by a bare path — most skills in this library
      // name their references as `references/x.md` in prose or a table rather
      // than as a link, and that is a legitimate convention.
      const refFiles = [];
      walk(refDir, (f) => { if (f.endsWith('.md')) refFiles.push(resolve(f)); });
      const reachable = new Set([resolve(md)]);
      const queue = [resolve(md)];
      while (queue.length) {
        const cur = queue.shift();
        if (!existsSync(cur)) continue;
        const body = readFileSync(cur, 'utf8');
        for (const lm of body.matchAll(/\]\((?!https?:|mailto:)([^)#\s]+)(?:#[^)]*)?\)/g)) {
          const next = resolve(dirname(cur), lm[1]);
          if (reachable.has(next) || !next.endsWith('.md')) continue;
          reachable.add(next); queue.push(next);
        }
        for (const cand of refFiles) {
          if (reachable.has(cand)) continue;
          if (!body.includes(basename(cand))) continue;
          reachable.add(cand); queue.push(cand);
        }
      }
      walk(refDir, (f) => {
        if (!f.endsWith('.md') || reachable.has(resolve(f))) return;
        console.log(`❌ ${name}: references/${basename(f)} is not reachable by any link from SKILL.md — orphaned.`);
        err = fail = true;
      });
    }

    // 6. Retired vocabulary stays retired. A concept deleted from a skill but left
    //    referenced elsewhere is the failure mode that put a dozen dead references
    //    to a removed classifier into ship-ticket. Each entry: /regex/ + why.
    for (const [re, why, scope] of RETIRED_VOCABULARY) {
      if (scope && !scope.includes(name)) continue;
      for (const doc of docs) {
        const body = readFileSync(doc, 'utf8');
        re.lastIndex = 0;
        const hit = re.exec(body);
        if (!hit) continue;
        const line = body.slice(0, hit.index).split('\n').length;
        console.log(`❌ ${name}: ${relative(SKILLS_DIR, doc)}:${line} uses retired '${hit[0]}' — ${why}`);
        err = fail = true;
      }
    }

    // 7. Where a skill defines a canonical outcome vocabulary, it must be defined
    //    exactly once and must be able to express failure. A vocabulary that
    //    declares itself exhaustive and omits FAIL makes a failure unrecordable.
    const enumOwners = docs.filter((d) => /^PASS_FULL\s/m.test(readFileSync(d, 'utf8')));
    if (enumOwners.length > 1) {
      console.log(`❌ ${name}: the outcome vocabulary is defined in ${enumOwners.length} files — it must have exactly one owner.`);
      err = fail = true;
    } else if (enumOwners.length === 1) {
      const body = readFileSync(enumOwners[0], 'utf8');
      for (const v of ['PASS_FULL', 'FAIL', 'NOT_TRIGGERED', 'DEGRADED'])
        if (!new RegExp(`^${v}\\s`, 'm').test(body)) {
          console.log(`❌ ${name}: the outcome vocabulary omits ${v}.`);
          err = fail = true;
        }
    }

    if (!err) console.log(`✅ ${name}`);
  }

  // The repo's own guidance files are held to the retired-vocabulary rule too.
  // ship-ticket defers to AGENTS.md on any conflict, so guidance that still names
  // a deleted concept can resurrect it — which is exactly how the two copies of
  // this file drifted 76 lines apart while one of them described a classifier
  // that no longer existed.
  for (const guide of ['AGENTS.md', 'CLAUDE.md']) {
    const gp = join(ROOT, guide);
    if (!existsSync(gp)) continue;
    const body = readFileSync(gp, 'utf8');
    for (const [re, why] of RETIRED_VOCABULARY) {   // guidance files: all terms apply
      re.lastIndex = 0;
      let hit;
      while ((hit = re.exec(body)) !== null) {
        // A line may cite retired vocabulary while explaining that it is retired.
        const line = body.slice(0, hit.index).split('\n').length;
        const src = body.split('\n')[line - 1];
        if (/\b(retired|deleted|removed|no longer|never existed|does not exist)\b/i.test(src)) continue;
        console.log(`❌ ${guide}:${line} uses retired '${hit[0]}' — ${why}`);
        fail = true;
      }
    }
  }

  console.log('');
  if (fail) { console.log('❌ validation failed'); process.exit(1); }
  console.log('✅ all skills valid');
}

// Concepts that were deliberately removed. Listing them here is what stops a
// deletion from leaving live instructions pointing at something that no longer
// exists — the defect class this check was added for.
// `scope` limits each term to the skills that can legitimately be talking about
// it, plus the repo guidance files. A term with no scope applies everywhere.
const RETIRED_VOCABULARY = [
  [/\brun[- ]lanes?\b/gi, 'ship-ticket\'s FAST/STANDARD/HEAVY classifier was deleted; coverage is constant', ['ship-ticket', 'pr-review']],
  [/\b(?:effective|provisional)[- ]lane\b/gi, 'the run lane was deleted; nothing computes a lane', ['ship-ticket', 'pr-review']],
  [/\b(?:per-lane|lane[- ](?:effort|depth|table|decision))\b/gi, 'the run lane was deleted; reasoning effort is pinned, never scaled', ['ship-ticket', 'pr-review']],
  [/\bGATE [12]\b/g, 'there was never a GATE 1 or GATE 2', null],
  [/Claude Code\'s built-in review/g, '/code-review belongs to the CodeRabbit plugin; a fresh reviewer subagent is the independent route', null],
];

function cmdHelp() {
  console.log(`ai-skills — install & manage this repo's Claude Code skills

Usage:
  ai-skills list                      list every skill in the repo
  ai-skills install                   install ALL skills into ~/.claude/skills
  ai-skills install <name> [name...]  install only the named skill(s)
  ai-skills update                    bring already-installed skills up to date
  ai-skills update <name> [name...]   update only the named skill(s)
  ai-skills validate                  lint every skill (same checks as CI)
  ai-skills help                      show this message

Install flags:
  --copy, -c            copy real files instead of symlinking (needed on ephemeral/npx runs)
  --link, -l            force symlink even from an ephemeral source
  --target, -t <t,...>  which tool(s) to install for — SKILL.md is an open
                        standard, so the same skills work everywhere:
                          claude       ~/.claude/skills              (Claude Code — default)
                          codex        ~/.agents/skills              (OpenAI Codex)
                          gemini       ~/.gemini/skills              (Gemini CLI)
                          agents       ~/.agents/skills              (any standard-compliant tool)
                          antigravity  ~/.gemini/antigravity/skills  (Google Antigravity)
                          all          claude + agents + gemini + antigravity
  --dest <path>         install into a custom directory instead

Update flags (--target / --dest work here too):
  --check, -n           report what would change; write nothing
  --force, -f           overwrite copies that were edited after install
  --prune               also remove skills that no longer exist upstream
  --no-pull             do not fast-forward the source clone first

  update refreshes the source (git pull --ff-only, from a clean clone; the
  npx path is already fetched fresh from GitHub), then re-syncs every skill it
  installed. Symlinked skills are already live, so the pull IS their update.
  Copies are refreshed — unless you edited one in place, which is reported and
  left alone until you pass --force. By default it updates every skills
  directory that exists, not just Claude Code's.

Examples:
  npx github:AhmedAbdelfattah0/AI-Skills install security researcher
  npx github:AhmedAbdelfattah0/AI-Skills install --target codex
  node scripts/cli.mjs install --target all
  node scripts/cli.mjs install security --target claude,codex
  node scripts/cli.mjs list
  node scripts/cli.mjs update --check
  node scripts/cli.mjs update --prune
  npx github:AhmedAbdelfattah0/AI-Skills update`);
}

// ---- dispatch --------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'list': cmdList(); break;
  case 'install': case 'add': cmdInstall(rest); break;
  case 'update': case 'upgrade': cmdUpdate(rest); break;
  case 'validate': case 'lint': cmdValidate(); break;
  case undefined: case 'help': case '--help': case '-h': cmdHelp(); break;
  default:
    console.error(`Unknown command: ${cmd}\n`);
    cmdHelp();
    process.exit(1);
}
