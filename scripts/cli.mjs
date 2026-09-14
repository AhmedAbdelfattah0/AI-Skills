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
  symlinkSync, cpSync, mkdirSync, writeFileSync, readlinkSync, renameSync, rmdirSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { autoupdate } from './autoupdate.mjs';

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

// Like walk(), but yields directories and symlinks as entries in their own right
// — hashing needs to see an empty directory and must not follow a link.
function walkAll(dir, onEntry) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    onEntry(full);
    if (e.isDirectory()) walkAll(full, onEntry);               // isDirectory() is false for a symlink
  }
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
  const rel = relative(normalizeTarget(root), normalizeTarget(p));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// A Windows junction's readlink comes back in the `\\?\C:\...` namespaced form.
// Left alone, path.relative() returns an ABSOLUTE path for it, so isUnder() calls
// a perfectly good junction foreign and refuses to ever update it — the exact
// opposite of the bug the relative() rewrite was meant to fix.
function normalizeTarget(p) {
  if (!p) return p;
  let out = String(p).replace(/^\\\\\?\\(UNC\\)?/, (_, unc) => (unc ? '\\\\' : ''));
  if (isWin) out = out.replace(/\//g, '\\');
  return resolve(out);
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
  // Returns null when the tree cannot be read in full. The read is inside the
  // try for a reason: one unreadable file used to escape as an uncaught EACCES
  // and kill the entire update, rather than making this one skill undecidable —
  // which is what a null is, and callers already treat it as "do not touch".
  try {
    const entries = [];
    walkAll(dir, (p) => { if (!isNoise(basename(p))) entries.push(p); });
    entries.sort();
    const h = createHash('sha256');
    for (const p of entries) {
      const st = lstatSync(p);
      h.update(relative(dir, p).replace(/\\/g, '/'));
      h.update('\0');
      // Type and the executable bit are part of what a skill IS: swapping a file
      // for a symlink to identical bytes, or flipping +x on a bundled script,
      // left the old content-only hash unchanged — so an edited copy read as
      // untouched and was overwritten with no --force.
      if (st.isSymbolicLink()) { h.update('L\0'); h.update(readlinkSync(p)); }
      else if (st.isDirectory()) { h.update('D\0'); }          // empty dirs count too
      else { h.update(`F${st.mode & 0o111 ? 'x' : '-'}\0`); h.update(readFileSync(p)); }
      h.update('\0');
    }
    return h.digest('hex');
  } catch { return null; }
}

// ---- unattended-run state --------------------------------------------------
//
// A scheduled job and a session hook can fire at the same second. Two cpSync
// calls racing on one destination leave a half-written skill, and git's own
// index lock only covers the pull — so the whole run takes a lock. State is
// keyed by source path: two clones on one machine must not share a lock.
function stateDir() {
  // STATE, not cache. The lock, the last-run stamp and the log are none of them
  // regenerable, and ~/.cache is what `brew cleanup`, macOS storage tools and
  // every `rm -rf ~/.cache` are entitled to delete. Losing this directory does
  // not merely lose history: the hook's `>> "$log"` redirect fails before node
  // is even reached, `|| true` swallows the error, and automatic updates are
  // dead with nothing to show for it. Nothing purges ~/.local/state.
  const base = process.env.XDG_STATE_HOME
    || (isWin ? (process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')) : join(homedir(), '.local', 'state'));
  const key = createHash('sha256').update(REPO_ROOT).digest('hex').slice(0, 12);
  return join(base, 'ai-skills', key);
}

// An age alone is not evidence a runner died: a pull over a slow link can exceed
// any threshold you pick, and stealing its lock re-enables the very concurrent
// copy this exists to prevent. Liveness is the test — age only bounds the case
// where a PID has been recycled by an unrelated process.
const LOCK_MAX_MS = 6 * 60 * 60 * 1000;    // beyond this, assume PID reuse, not a 6h pull
const THROTTLE_MS = 60 * 60 * 1000;        // three sessions in a row = one fetch

const lockPath = () => join(stateDir(), 'update.lock');

function holderIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  // Signal 0 tests for existence without delivering anything. EPERM means the
  // process exists and is simply owned by somebody else — still alive.
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

// Returns a release() on success, or null if another run holds the lock.
// The token is what makes release safe: a runner whose lock was taken over must
// not delete the new owner's file on its way out.
function acquireLock() {
  const dir = stateDir();
  mkdirSync(dir, { recursive: true });
  const lock = lockPath();
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const mine = JSON.stringify({ pid: process.pid, token, at: Date.now() });

  const claim = () => { writeFileSync(lock, mine + '\n', { flag: 'wx' }); return releaser(token); };
  try { return claim(); } catch { /* held — judge the holder below */ }

  let held = null;
  let readable = true;
  try { held = JSON.parse(readFileSync(lock, 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') { try { return claim(); } catch { return null; } } readable = false; }

  // A lock we cannot parse is debris, not a running process. Leaving it in place
  // meant an empty or truncated file — a crash mid-write, a full disk — disabled
  // automatic updates permanently and silently, because claim() then failed
  // forever against a file nothing would ever remove.
  if (readable && held && holderIsAlive(held.pid) && !expired(held.at)) return null;

  // Displace it with rename-verify-restore, and NO second "breaker" lock: rename
  // is atomic per path, but the path can be recreated, so the loser of a race can
  // end up renaming the WINNER's fresh lock away (an ABA, not a compare-and-swap).
  // Verifying what we actually moved — and putting it back when it is not the
  // thing we condemned — is what closes that, and it needs no extra file whose
  // own takeover would have the same problem one level down.
  const condemned = readable ? held?.token : null;
  const aside = `${lock}.stale.${token}`;
  try { renameSync(lock, aside); } catch { return null; }        // someone else got there first
  let moved = null;
  try { moved = JSON.parse(readFileSync(aside, 'utf8')); } catch { moved = null; }
  const sameThing = (moved?.token ?? null) === condemned;
  if (!sameThing) {
    // We moved a lock that appeared after we judged the old one. Put it back.
    try { renameSync(aside, lock); } catch { /* nothing better available */ }
    return null;
  }
  try { rmSync(aside, { force: true }); } catch { /* best effort */ }
  try { return claim(); } catch { return null; }                 // a third party beat us to the fresh claim
}

// A timestamp we cannot trust is not evidence of a live run. A far-future `at`
// makes `now - at` negative for as long as the clock says so, which would starve
// every future update permanently. (There is no longer a separate breaker lock:
// its own takeover had the same ABA the lock's did, one level down.)
function expired(at) {
  if (!Number.isFinite(at)) return true;
  const age = Date.now() - at;
  return age < 0 || age >= LOCK_MAX_MS;
}

// Release only while the lock is still ours — and prove it by renaming rather
// than by reading and then deleting, which leaves a window in which a new owner's
// lock is the thing being deleted.
function releaser(token) {
  return () => {
    const lock = lockPath();
    const leaving = `${lock}.leaving.${token}`;
    try {
      if (JSON.parse(readFileSync(lock, 'utf8')).token !== token) return;
      renameSync(lock, leaving);
    } catch { return; }                       // already gone, unreadable, or no longer ours
    try {
      // Re-read after the rename: if the content is not ours, we moved somebody
      // else's lock and must put it back rather than delete it.
      if (JSON.parse(readFileSync(leaving, 'utf8')).token !== token) { renameSync(leaving, lock); return; }
    } catch { /* unreadable — fall through and drop it */ }
    try { rmSync(leaving, { force: true }); } catch { /* leave it for the liveness check */ }
  };
}

// True when the last unattended run was recent enough to skip this one.
function throttled() {
  try {
    const at = Number(readFileSync(join(stateDir(), 'last-run'), 'utf8').trim());
    return Number.isFinite(at) && Date.now() - at < THROTTLE_MS;
  } catch { return false; }
}

// An unattended run writes its own log, and writes NOTHING to stdout. Two
// reasons this belongs here rather than in a shell redirect: a SessionStart
// hook's stdout is injected into the session as context, and a redirect set up
// by launchd or systemd is opened BEFORE node starts, so it cannot recreate a
// state directory that has been deleted — the job just dies, silently, forever.
function appendLog(lines) {
  if (!lines.length) return;
  try {
    mkdirSync(stateDir(), { recursive: true });
    const stamp = new Date().toISOString();
    writeFileSync(join(stateDir(), 'update.log'), `${stamp}\n${lines.join('\n')}\n\n`, { flag: 'a' });
  } catch { /* a log we cannot write is not a reason to fail the update */ }
}

function stampRun() {
  try { mkdirSync(stateDir(), { recursive: true }); writeFileSync(join(stateDir(), 'last-run'), String(Date.now())); }
  catch { /* a missing stamp only costs an extra run */ }
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
// Which LIBRARY this is, as opposed to which checkout. The remote survives a
// clone being moved or re-cloned elsewhere, which a path does not; and it differs
// for a fork, which is exactly the case a path cannot tell apart.
function originUrl() {
  // The git remote ONLY. package.json was tried here and is not provenance: it
  // is content inside the candidate tree, and a fork keeps the upstream
  // `repository` field as a matter of course. Run such a fork through npx — no
  // .git, so the field is all there is — and it would present itself as the
  // canonical library and overwrite canonical installs with fork content, with
  // no flag. A self-asserted identity cannot answer "who installed this".
  const raw = git(['remote', 'get-url', 'origin']);
  if (!raw) return null;
  // Normalise the spellings of one remote: scp-form vs https, optional .git.
  return raw.trim()
    .replace(/^git\+/, '')
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

// Was this destination populated by THIS library? A manifest written by a fork,
// or by an unrelated repo that happens to ship a skill of the same name, must not
// have its hashes trusted — that is what lets one checkout silently overwrite
// another's content.
function sameLibrary(manifest) {
  // A recorded origin is authoritative: it came from a git remote, which is
  // configuration about where the tree CAME FROM rather than content inside it.
  // Absent one — a manifest predating the field — the source path is weaker
  // evidence but is still evidence, and refusing it outright would strand every
  // install made before the field existed.
  //
  // A source with no git remote at all (an npx cache) is INDETERMINATE, not
  // trusted: it can offer nothing about its own provenance that a fork could not
  // offer identically. Such installs need --adopt once, which is the honest
  // price of not being able to tell them apart.
  if (manifest.origin) { const mine = originUrl(); return !!mine && manifest.origin === mine; }
  if (manifest.source) return resolve(manifest.source) === resolve(REPO_ROOT);
  // No identity evidence at all. Absence of a contradiction is not proof of
  // ownership: a manifest carrying hashes but naming no library is exactly what
  // a hand-edited or truncated file looks like, and trusting it lets unchanged
  // foreign content be overwritten with no flag. --adopt exists for this.
  return false;
}

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

// A user-facing error: reported as a message, not a stack trace, and — unlike
// process.exit() — it unwinds through every `finally` on the way out.
class CliError extends Error {}

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
    // Throw, never process.exit(): exit does not unwind `finally`, so an auto
    // run dying here released its lock but never stamped the throttle, and every
    // following session repeated the network fetch.
    throw new CliError(`unknown target(s): ${unknown.join(', ')}\n`
      + `   valid: ${Object.keys(TARGETS).join(', ')}, all — or use --dest <path>`);
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
    // erase the record of the twelve installed last week. But only if it is
    // OURS — merging into a foreign manifest and then stamping our own origin on
    // it launders that library's records into ours, after which a later update
    // overwrites its untouched skills with no flag at all.
    for (const n of recoverInterrupted(dir)) {
      console.log(`   ♻️  ${n}  restored from an interrupted update`);
    }
    const found = readManifest(dir);
    const manifest = found && sameLibrary(found) ? found : { version: 1, skills: {} };
    if (found && manifest !== found) {
      console.log(`   ℹ️  ${dir} has a manifest from another library — starting our own record set`);
    }
    manifest.version = 1;
    manifest.source = REPO_ROOT;
    manifest.origin = originUrl();
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
      // Same build-then-swap as update: a re-install over a working skill must
      // not be able to leave a hole where that skill was.
      if (applySkill(src, dst, mode, manifest, name)) {
        console.log(`${mode === 'link' ? '🔗 linked ' : '📄 copied '} ${name}  → ${label}`);
        ok++;
      } else if (mode === 'link') {
        console.error('   symlink failed — retry with --copy');
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
// The unattended contract needs ONE finalizer that every exit reaches — a return,
// an early error, or a throw. process.exit() inside the body skipped stampRun(),
// which meant a failing run left the throttle unset and every following session
// pulled again.
function cmdUpdate(args) {
  try { runUpdate(args); }
  catch (err) {
    if (!(err instanceof CliError)) throw err;
    console.error(`❌ ${err.message}`);
    process.exitCode = 1;
  }
  finally { if (typeof pendingFinish === 'function') pendingFinish(); }
}

let pendingFinish = null;

function runUpdate(args) {
  const { names, flags, targetSpec, destOverride } = parseFlags(args);
  const check = flags.has('--check') || flags.has('-n') || flags.has('--dry-run');
  const auto = flags.has('--auto');
  // Unattended runs are deliberately timid: they never overwrite an edit and
  // never delete anything. A scheduler that could do either would eventually do
  // it at 3am to something the user cared about.
  // --force overrides an edit to a skill THIS library installed. It does not
  // claim content nobody recorded installing — a directory that merely shares a
  // name with one of our skills may be somebody else's entirely. Taking that over
  // is a separate, explicit act.
  const force = !auto && (flags.has('--force') || flags.has('-f'));
  const adopt = !auto && flags.has('--adopt');
  const prune = !auto && flags.has('--prune');
  const noPull = flags.has('--no-pull');

  // --auto: one runner at a time, not more than once an hour, silent unless
  // there is something a human would want to know.
  let release = () => {};
  if (auto) {
    if (throttled()) return;
    const got = acquireLock();
    if (!got) return;               // another run is already doing this
    release = got;
    // `finally` does not run when a signal kills the process, and Node's 'exit'
    // event fires only for a normal end or process.exit() — so a SIGTERM during
    // a fetch left the throttle unstamped and every later session refetched.
    // Handle the catchable signals, finalize, then exit with the conventional
    // code. SIGKILL and power loss remain uncoverable, by definition.
    process.on('exit', release);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      // pendingFinish, not finish: this runs before finish is declared, and a
      // signal landing in that window would hit the temporal dead zone. The
      // module-level binding is null until there is something to run.
      process.on(sig, () => { try { pendingFinish?.(); } finally { process.exit(sig === 'SIGINT' ? 130 : 143); } });
    }
  }
  // Buffered so a no-op run prints nothing at all — a SessionStart hook that
  // chatters every time is a hook people turn off.
  const out = [];
  const say = (line) => (auto ? out.push(line) : console.log(line));
  // Auto runs go to the log only — never to stdout, which a SessionStart hook
  // would inject into the session.
  const flush = (worth) => { if (worth) appendLog(out); out.length = 0; };
  // Declared up here because finish() closes over them and is callable from the
  // early returns below — which is the whole point of it.
  let anyChange = false;
  let anySkipped = false;
  const allHints = new Set();
  // Every exit from an unattended run stamps the throttle and drops the lock —
  // including the early ones. A path that returns before stamping means the next
  // session pulls again, and the one after that, which is how a quiet updater
  // turns into a machine hammering GitHub on every session start.
  let finished = false;
  // eslint-disable-next-line prefer-const
  const finish = () => {
    if (!auto || finished) return;
    finished = true;
    pendingFinish = null;
    // Worth waking a human for: something changed, something was declined, the
    // source refresh did not go to plan, or a run failed. "Already fine" is not news.
    const sourceTrouble = ['dirty', 'pull-failed', 'fetch-failed'].includes(pull.status);
    flush(anyChange || anySkipped || sourceTrouble || process.exitCode === 1);
    stampRun();
    release();
  };
  pendingFinish = finish;   // so the try/finally wrapper reaches it on a throw

  // 1. Refresh the source. Unlike install, update's default scope is every known
  //    target directory that exists — you install per-tool, but you update "my
  //    skills", wherever they landed.
  const before = sourceCommit();
  // --no-pull means "re-sync from the checkout as it stands" — so skip the
  // source refresh entirely rather than running it and ignoring the result.
  const pull = (noPull && !check)
    ? { status: sourceIsEphemeral() ? 'ephemeral' : 'no-pull', branch: git(['rev-parse', '--abbrev-ref', 'HEAD']) }
    : refreshSource({ check });
  reportSource(pull, say);

  // Read the library only AFTER the refresh: a skill that arrives with the pull
  // has to be visible to the run that pulled it, or it is adopted one run late.
  const available = skillDirs();
  if (!available.length) {
    console.error(`❌ no skills found in ${SKILLS_DIR}`);
    process.exitCode = 1;
    finish();
    return;
  }
  const unknown = names.filter((n) => !available.includes(n));
  if (unknown.length) {
    console.error(`❌ unknown skill(s): ${unknown.join(', ')}`);
    console.error(`   run "list" to see the ${available.length} available skills.`);
    process.exitCode = 1;
    finish();
    return;
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
    if (targetSpec || destOverride) say(`—  [${label}] ${dir} does not exist — nothing installed there`);
    return false;
  });

  if (!destDirs.length) {
    say('\nNothing to update — no skills directory found. Run "install" first.');
    finish();
    return;
  }


  for (const { label, dir } of destDirs) {
    for (const n of recoverInterrupted(dir)) {
      say(`   ♻️  ${n}  restored from an interrupted update`);
      anyChange = true;
    }
    // A manifest from a different library is evidence about somebody else's
    // install. Suppressing its per-skill lookups was not enough: the object was
    // still carried, so its `all` and `mode` stayed live, and the first write
    // stamped OUR origin onto it — after which every retained foreign hash was
    // trusted on the next run. Drop it entirely and start our own.
    const foundManifest = readManifest(dir);
    const trusted = !foundManifest || sameLibrary(foundManifest);
    if (!trusted) {
      say(`   ⚠️  installed by a different library (${foundManifest.origin || foundManifest.source || 'unknown source'}) — its records are not ours to act on`);
    }
    const manifest = trusted ? (foundManifest || { version: 1, skills: {} }) : { version: 1, skills: {} };
    manifest.skills ||= {};
    const tally = { updated: 0, live: 0, current: 0, added: 0, removed: 0, skipped: 0, foreign: 0, failed: 0 };
    const hints = new Set();
    say(`\n[${label}] ${dir}`);

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
        if (check) { say(`   + ${name}  (new upstream — would install)`); tally.added++; anyChange = true; continue; }
        // Ephemeral beats the recorded mode, exactly as in install: a clone-mode
        // manifest + an `npx … update` would otherwise symlink the new skill
        // into the npx cache, and dangle the moment that cache is cleaned.
        const mode = sourceIsEphemeral() ? 'copy' : (record?.mode || manifest.mode || 'link');
        if (applySkill(src, dst, mode, manifest, name)) {
          say(`   + ${name}  (new upstream — installed)`);
          tally.added++; anyChange = true;
        } else tally.failed++;
        continue;
      }

      // (b) A symlink. Where it points decides everything.
      if (st.isSymbolicLink()) {
        let target = null;
        try { target = resolve(dirname(dst), readlinkSync(dst)); } catch { /* unreadable */ }
        // Containment is not identity. `security -> <repo>/skills/vapt` lives under
        // SKILLS_DIR but is an alias the user made, not our install of `security`;
        // reporting it live forever, and pruning it on a dangling target, are both
        // wrong. Only the exact expected target is ours.
        if (target && isUnder(SKILLS_DIR, target) && normalizeTarget(target) !== normalizeTarget(src)) {
          say(`   ~ ${name}  aliases ${relative(SKILLS_DIR, normalizeTarget(target))} in this library — left alone`);
          tally.skipped++;
          continue;
        }
        if (target && normalizeTarget(target) === normalizeTarget(src)) {
          if (!existsSync(target)) {
            // The skill was deleted upstream; the link now dangles. Pointing at
            // our skills dir proves where a link POINTS, not who made it — a
            // hand-made link has the same target as an installed one, so without
            // a record this is not ours to delete.
            if (!record && !adopt) {
              say(`   ! ${name}  dangling link we have no record of installing — --adopt to remove it too`);
              tally.skipped++; hints.add('--adopt');
            } else if (!prune) { say(`   ! ${name}  dangling link (deleted upstream) — --prune to remove`); tally.skipped++; hints.add('--prune'); }
            else if (check) { say(`   - ${name}  (dangling — would remove)`); tally.removed++; anyChange = true; }
            else { removeExisting(dst); delete manifest.skills[name]; say(`   - ${name}  (dangling — removed)`); tally.removed++; anyChange = true; }
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
          say(`   ! ${name}  link into ${manifest.source} is dangling — re-run update from that clone, or install here`);
          tally.skipped++; continue;
        }
        // Only worth a line if it is a name this library actually ships, or one
        // we installed. A skills dir commonly holds symlinks to a completely
        // different collection; reporting each of those is pure noise.
        if (available.includes(name) || record) {
          say(`   ~ ${name}  symlink to ${target || 'an unreadable path'} — not ours, left alone`);
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
          say(`   ! ${name}  no longer in the library — --prune to remove`);
          tally.skipped++; hints.add('--prune'); continue;
        }
        // --adopt claims things we never installed. It must NOT double as
        // permission to delete a skill we DID install and you have since edited
        // — that is --force's job, and conflating them means adopting one
        // unrelated directory silently authorises losing edits in every skill
        // that happens to have been removed upstream.
        const stillOurs = record?.hash && record.hash === hashSkill(dst);
        const mayRemove = stillOurs || (record ? force : adopt);
        if (!mayRemove) {
          say(`   ! ${name}  removed upstream but edited locally — --force to remove anyway`);
          tally.skipped++; hints.add('--force'); continue;
        }
        if (check) { say(`   - ${name}  (removed upstream — would remove)`); tally.removed++; anyChange = true; continue; }
        removeExisting(dst); delete manifest.skills[name];
        say(`   - ${name}  (removed upstream — removed)`);
        tally.removed++; anyChange = true;
        continue;
      }

      const dstHash = hashSkill(dst);
      if (dstHash === hashSkill(src)) {
        if (incoming.has(name)) {
          say(`   ↑ ${name}  (would update — the fast-forward changes it)`);
          tally.updated++; anyChange = true;
        } else tally.current++;
        continue;
      }

      // It differs from the source. Three cases, and they need different flags:
      //   we installed it, unchanged since   -> stale, refresh it, no flag
      //   we installed it, changed since     -> the user edited it,     --force
      //   nobody recorded installing it      -> not ours to replace,    --adopt
      const ours = !!record?.hash;
      const untouchedSinceInstall = ours && record.hash === dstHash;
      const allowed = untouchedSinceInstall || (ours ? force : adopt);
      if (!allowed) {
        if (ours) { say(`   ! ${name}  edited after install — left alone (--force to overwrite)`); hints.add('--force'); }
        else { say(`   ! ${name}  present but not installed by us — left alone (--adopt to take it over)`); hints.add('--adopt'); }
        tally.skipped++;
        continue;
      }
      const how = untouchedSinceInstall ? '' : ours ? ' (over your edits)' : ' (adopted)';
      if (check) { say(`   ↑ ${name}  (would update${how})`); tally.updated++; anyChange = true; continue; }
      if (applySkill(src, dst, 'copy', manifest, name)) {
        say(`   ↑ ${name}  updated${how}`);
        tally.updated++; anyChange = true;
      } else tally.failed++;
    }

    if (!check && (tally.updated || tally.added || tally.removed)) {
      manifest.version = 1;
      manifest.source = REPO_ROOT;
      manifest.origin = originUrl();
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
    // A ✅ printed next to "1 failed" is a lie the eye believes.
    const glyph = tally.failed ? '❌' : check ? '🔎' : '✅';
    say(`   ${glyph} ${parts.length ? parts.join(', ') : 'nothing installed here'}`);
    if (tally.skipped) { anySkipped = true; for (const h of hints) allHints.add(h); }
    if (tally.failed) process.exitCode = 1;
  }

  if (auto) { finish(); return; }

  if (check && anyChange) {
    say('\n🔎 dry run — nothing was written. Re-run without --check to apply.');
  } else if (anySkipped) {
    // Never report success over declined work: a skipped skill is the one case
    // the user has to decide about, and burying it under "up to date" is how it
    // stays stale forever.
    const how = [...allHints].join(' / ') || '--force';
    say(`\n⚠️  up to date except for the skipped skill(s) above — re-run with ${how} to act on them.`);
  } else if (check) {
    say('\n✅ everything is up to date.');
  } else if (before && before !== sourceCommit()) {
    say(`\n   source moved ${before.slice(0, 7)} → ${sourceCommit().slice(0, 7)}`);
  }
}

// Install or refresh one skill, keeping the manifest in step with what landed.
//
// Build first, swap last. Deleting the working skill before its replacement
// exists means a full disk, an unreadable source or an interrupt leaves nothing
// there — and the catch cannot put it back, because the only copy was the one
// just deleted. So: stage a complete copy, move the old one aside, promote the
// staged one, and only then drop the backup.
//
// The guarantee this provides is RECOVERABILITY, not "the destination is never
// absent". Two renames are each atomic but the pair is not, so a kill between
// them leaves the destination missing — with the content intact in the backup,
// which recoverInterrupted() restores on the next run. If even the rollback
// fails, the backup is kept and its path printed rather than cleaned up.
//
// Staging lives in a DOT-directory. A sibling named `security.new` would hold a
// SKILL.md and be scanned as a skill in its own right for as long as it exists;
// scanners skip dotfiles, and so does this CLI's own enumeration.
function applySkill(src, dst, mode, manifest, name) {
  // Staging paths are unique PER ATTEMPT. Shared `${name}.new` / `${name}.old`
  // meant two processes touching the same skill would delete each other's
  // staging tree, or promote one while the other was still copying it — which
  // is precisely the half-written destination the staging exists to prevent.
  const tmpRoot = join(dirname(dst), '.ai-skills-tmp');
  const attempt = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const staged = join(tmpRoot, `${name}.new.${attempt}`);
  const backup = join(tmpRoot, `${name}.old.${attempt}`);
  let movedAside = false;
  let promoted = false;
  let keepTmp = false;
  try {
    mkdirSync(tmpRoot, { recursive: true });
    removeExisting(staged);
    removeExisting(backup);

    // 1. Build the replacement in full, off to one side.
    if (mode === 'link') symlinkSync(src, staged, isWin ? 'junction' : 'dir');
    else cpSync(src, staged, { recursive: true, filter: copyFilter });

    // 2. Swap. Both renames are within one directory tree, so each is atomic.
    if (existsSync(dst) || isLink(dst)) { renameSync(dst, backup); movedAside = true; }
    renameSync(staged, dst);
    promoted = true;                 // <- the commit point; everything after is cleanup

    // 3. Record what landed BEFORE touching the backup. A failure while deleting
    //    the backup used to return false with the new content already installed
    //    and no hash recorded — leaving a stale baseline that made the fresh copy
    //    look edited on the next run.
    manifest.skills[name] = { mode, hash: mode === 'copy' ? hashSkill(dst) : null };
    try { removeExisting(backup); }
    catch { console.error(`   ⚠️  ${name}: installed, but its backup could not be removed — see ${backup}`); keepTmp = true; }
    return true;
  } catch (err) {
    // Past the commit point the new content is installed; do not roll back over it.
    if (promoted) {
      console.error(`   ⚠️  ${name}: installed, but cleanup failed: ${err.message}`);
      keepTmp = true;
      return true;
    }
    // Put the original back if we got as far as moving it.
    let rolledBack = true;
    if (movedAside && !existsSync(dst) && !isLink(dst)) {
      try { renameSync(backup, dst); } catch { rolledBack = false; }
    }
    try { removeExisting(staged); } catch { /* best effort */ }
    console.error(`   ❌ ${name}: ${err.message}`);
    if (!rolledBack) {
      // The only copy of this skill is the backup. Say where it is and KEEP it —
      // the finally below would otherwise delete the thing we failed to restore.
      console.error(`   ⚠️  ${name}: could not restore it — your copy is at ${backup}`);
      keepTmp = true;
    }
    return false;
  } finally {
    // Only this attempt's artifacts — another process may be mid-copy in here.
    if (!keepTmp) {
      for (const p of [staged, backup]) { try { rmSync(p, { recursive: true, force: true }); } catch { /* leave it */ } }
      try { rmdirSync(tmpRoot); } catch { /* not empty, or gone — either is fine */ }
    }
  }
}

// Recover from a run that was killed between "move the old aside" and "promote
// the new one" — which leaves the destination missing and the only copy of that
// skill sitting in the staging directory. This has to be a sweep, not a check
// inside applySkill: a skill that is MISSING never enters the per-skill loop, so
// nothing would ever look at its backup, and the next run's cleanup would delete
// it. Runs before anything else touches the directory.
function recoverInterrupted(dir) {
  const tmpRoot = join(dir, '.ai-skills-tmp');
  if (!existsSync(tmpRoot)) return [];
  const restored = [];
  let entries = [];
  try { entries = readdirSync(tmpRoot); } catch { return restored; }
  for (const e of entries) {
    // `<name>.old.<attempt>` — the attempt suffix keeps concurrent runs apart.
    const m = e.match(/^(.+)\.old\.[^.]+$/);
    if (!m) continue;
    const name = m[1];
    const dst = join(dir, name);
    if (existsSync(dst) || isLink(dst)) continue;          // the swap completed after all
    try { renameSync(join(tmpRoot, e), dst); restored.push(name); } catch { /* leave it in place */ }
  }
  return restored;
}

// existsSync follows symlinks, so a dangling link reads as absent — which would
// make the rollback overwrite rather than restore. This asks about the link itself.
function isLink(p) {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

// Say what happened to the source in one line, including the cases where the
// refresh was deliberately declined — a silent skip would read as "up to date".
function reportSource(r, say = console.log) {
  const at = r.branch ? ` (${r.branch})` : '';
  switch (r.status) {
    case 'no-pull':
      say(`📦 source: --no-pull — re-syncing from ${REPO_ROOT}${at} as it stands.`); break;
    case 'ephemeral':
      say('📦 source: npx cache — already fetched fresh from GitHub for this run.'); break;
    case 'not-a-clone':
      say(`📦 source: ${REPO_ROOT} is not a git clone — re-syncing from it as-is.`); break;
    case 'no-upstream':
      say(`📦 source: branch${at} has no upstream — re-syncing from the local checkout.`); break;
    case 'dirty':
      say(`📦 source: working tree${at} has uncommitted changes — not pulling; re-syncing from it as-is.`); break;
    case 'pull-failed':
      say(`📦 source: git pull --ff-only${at} failed (diverged from ${r.upstream}?) — re-syncing from the local checkout.`); break;
    case 'fetch-failed':
      say(`📦 source: git fetch${at} failed — comparing against the local checkout only.`); break;
    case 'already':
      say(`📦 source: already at ${r.after?.slice(0, 7)}${at}.`); break;
    case 'pulled':
      say(`📦 source: pulled ${r.before?.slice(0, 7)} → ${r.after?.slice(0, 7)}${at}.`); break;
    case 'check':
      say(r.behind
        ? `📦 source: ${r.behind} commit(s) behind ${r.upstream}${at} — a real run would fast-forward.`
        : `📦 source: up to date with ${r.upstream}${at}.`);
      break;
  }
}

// Automatic updates live in ./autoupdate.mjs; this hands it the paths and state
// that cli.mjs already owns, so there is one definition of each, not two.
function cmdAutoupdate(args) {
  let lastRun = null;
  try { lastRun = Number(readFileSync(join(stateDir(), 'last-run'), 'utf8').trim()) || null; } catch { /* never run */ }
  autoupdate(args, {
    repoRoot: REPO_ROOT,
    cliPath: fileURLToPath(import.meta.url),
    stateDir: stateDir(),
    ephemeral: sourceIsEphemeral(),
    lastRun,
  });
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
  const outcomeVocabularyOwners = [];

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
    const enumOwners = docs.filter((d) => /^OUTCOME_VOCABULARY$/m.test(readFileSync(d, 'utf8')));
    outcomeVocabularyOwners.push(...enumOwners);
    if (enumOwners.length > 1) {
      console.log(`❌ ${name}: the outcome vocabulary is defined in ${enumOwners.length} files — it must have exactly one owner.`);
      err = fail = true;
    } else if (enumOwners.length === 1) {
      const body = readFileSync(enumOwners[0], 'utf8');
      for (const v of ['PASS', 'FAIL', 'NOT_TRIGGERED', 'NOT_APPLICABLE', 'DEGRADED'])
        if (!new RegExp(`^${v}\\s`, 'm').test(body)) {
          console.log(`❌ ${name}: the outcome vocabulary omits ${v}.`);
          err = fail = true;
        }
    }

    if (!err) console.log(`✅ ${name}`);
  }

  if (outcomeVocabularyOwners.length !== 1) {
    console.log(`❌ canonical outcome vocabulary has ${outcomeVocabularyOwners.length} owners — expected exactly one.`);
    fail = true;
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
  [/\bGATE [345]\b/g, 'ship-ticket uses named phases and checks, not numbered gates', ['ship-ticket', 'vapt', 'generate-ticket', 'code-quality']],
  [/\bfinal\s+`?mutation_round`?/gi, 'mutation_round is derived and is never a stored final field', ['ship-ticket']],
  [/\bmutation_round:\s*\d+\b/gi, 'mutation_round is derived and is never a stored scalar', ['ship-ticket']],
  [/mutation_round`?\s+is the length of `?batches\[\]`?/gi, 'mutation_round is partitioned by active run_id, not counted across ticket history', ['ship-ticket']],
  [/\bnew (?:approved plan and a )?run record\b/gi, 'a new execution appends a run partition to the existing record', ['ship-ticket']],
  [/\bOne schema, three consumers\b/g, 'the run record has a truthful precommit projection and a separate external postcommit projection', ['ship-ticket']],
  [/\bany stop (?:after it )?ends the current run\b/gi, 'REVIEW stops conclude; resumable external SHIP failures pause without reopening review', ['ship-ticket']],
  [/\bAny PR, tracker or CI check fails\b/g, 'SHIP distinguishes resumable service failures from deterministic red checks and content changes', ['ship-ticket']],
  [/\bresume SHIP only if the final candidate manifest\b/gi, 'SHIP resumes by representation-independent reviewed_content_id, not a manifest changed by commit', ['ship-ticket']],
  [/\bA retry that changes no repository bytes may rerun CI only\b/gi, 'SHIP resumes missing idempotent external operations under reviewed_content_id', ['ship-ticket']],
  [/\b(?:one CI wait|wait exactly once for CI)\b/gi, 'SHIP has one enumerated CI gate; infrastructure retries do not reopen REVIEW', ['ship-ticket']],
  [/\bwait once for CI\b/gi, 'SHIP waits for the enumerated gate and may resume an infrastructure-interrupted wait', ['ship-ticket']],
  [/\bpost-verdict session-log entry\b/gi, 'the session log stops at the precommit SHIP_READY cutoff', ['ship-ticket']],
  [/\bremaining SHIP timing\/result entries\b/gi, 'only knowable SHIP_READY facts enter the committed projection', ['ship-ticket']],
  [/\bSHIP result slots may be appended\b/gi, 'repository result writes end at the precommit SHIP_READY cutoff', ['ship-ticket']],
  [/\bso they ride the single gated commit\b/gi, 'postcommit outcomes stay external because they do not exist at the commit cutoff', ['ship-ticket']],
  [/\bAdd one merge-blocking check\b/g, 'VAPT GATE detects enforcement; only explicit setup work may install it', ['vapt']],
  [/\bInstalling (?:the|it) check is repo setup, never something (?:a|this) ticket adds after the freeze\b/gi, 'CI enforcement is caller-aware: detect in GATE, install only in explicit pre-freeze setup work', ['ship-ticket', 'vapt']],
  [/\band a merge-blocking CI check[\s\S]{0,120}is what actually stops a regression\b/gi, 'VAPT accepts declared enforcement degradation in GATE mode while committed tests still run in CI', ['vapt']],
  [/\bTwo vocabularies, at two levels\b/g, 'rule rows and whole checks share one canonical outcome vocabulary', ['ship-ticket']],
  [/\bPASS_(?:FULL|GROUPED|REUSED)\b/g, 'execution detail belongs in execution_mode; PASS is the canonical outcome', ['ship-ticket', 'vapt']],
  [/\bNOT_APPLICABLE_NO_SCREEN_REFERENCE\b/g, 'NOT_APPLICABLE is the outcome and NO_SCREEN_REFERENCE is a reason_code', ['ship-ticket']],
  [/\bPASS\s*\/\s*FAIL\s*\/\s*N-A\b/g, 'rule rows use the canonical outcome vocabulary', ['ship-ticket', 'code-quality']],
  [/\bN-A\b/g, 'the canonical applicability outcome is NOT_APPLICABLE', ['ship-ticket', 'code-quality']],
  [/\bN\/A\b/g, 'the canonical applicability outcome is NOT_APPLICABLE', ['ship-ticket', 'vapt', 'angular-code-quality', 'backend-code-quality', 'code-quality', 'pr-review']],
  [/\bFIXED\b/g, 'a fixed finding has outcome PASS and records fixed as disposition evidence', ['vapt']],
  [/\| Rule \| Status \| Evidence \|/g, 'routed rule rows use the canonical Subject ID | Outcome | Evidence shape', ['angular-code-quality', 'backend-code-quality', 'pr-review']],
  [/\| Rule \| Surface \| Verdict \| Evidence \|/g, 'VAPT rows use the canonical Subject ID | Outcome | Evidence shape', ['vapt']],
  [/\bBoth halves are load-bearing, and REVIEW compares the pair\b/g, 'test coverage matches body digests first so a name-only rename remains equivalent', ['ship-ticket']],
  [/\beach test ID being PROVE's name-plus-body-digest pair\b/g, 'coverage vectors use body-digest multisets; test names are locators and rename evidence', ['ship-ticket']],
  [/\b(?:terminal verdict when one is required|when terminal review is required)\b/gi, 'every ship-ticket run gets an unconditional terminal reviewer', ['ship-ticket']],
  [/\bno terminal verdict recorded\b/gi, 'ship-ticket resumption keys on whether REVIEW started, not whether a verdict exists', ['ship-ticket']],
  [/\bauthz (?:predicate|component)\b/gi, 'boundary identity excludes prose authorization labels; executable test IDs carry authorization coverage', ['ship-ticket']],
  [/\bship-ticket(?:'s)?\s+step\s+\d+(?:\.\d+)?\b/gi, 'ship-ticket uses named phases rather than numbered steps', ['vapt', 'generate-ticket']],
  [/\bsigns later\b/gi, 'the terminal reviewer is the only signature; the plan-critique route never signs', ['ship-ticket']],
  [/\bempty schema-defined slots?\b/gi, 'parity and VAPT evidence artifacts freeze whole; later results live in the plan run-state block', ['ship-ticket']],
  [/\b(?:barrier 2|round 3|further rounds?)\b/gi, 'ship-ticket review has one repair barrier and one terminal verdict', ['ship-ticket']],
  [/\b(?:F2|Fn|F\(n[−-]1\))\b/g, 'ship-ticket review has only F0 and an optional F1 candidate', ['ship-ticket']],
  [/\bscope[_ -]digests?\b/gi, 'terminal review binds to manifests and the frozen-record digest; the separate scope digest was deleted', ['ship-ticket']],
  [/\bpayload[_ -]digests?\b/gi, 'the separate signing payload and its digest were deleted', ['ship-ticket']],
  [/\bunsigned verdicts?\b/gi, 'review outputs now feed one terminal verdict directly', ['ship-ticket']],
  [/\bindependent signatures?\b/gi, 'independence now belongs to the terminal reviewer, with no separate signing dispatch', ['ship-ticket', 'generate-ticket', 'vapt']],
  [/\bsignature blocks?\b/gi, 'separate parity and security signature blocks were folded into the terminal verdict', ['ship-ticket']],
  [/\bsigners?\b/gi, 'ship-ticket and vapt use reviewers and outcomes, not a separate signer role', ['ship-ticket', 'vapt']],
  [/\bresumable signer route\b/gi, 'the terminal reviewer is a one-shot route', ['ship-ticket']],
  [/\bre[- ]?sign(?:ing|atures?)\b/gi, 'terminal outcomes are never reopened inside the same run', ['ship-ticket']],
  [/\bsame[- ]reviewer rule\b/gi, 'the signing resumption ceremony was deleted', ['ship-ticket']],
  [/\bstaleness rule\b/gi, 'record immutability and manifest binding replace signature staleness', ['ship-ticket']],
  [/\bevery (?:claim, count, citation and )?conclusion (?:a reader would check )?belongs in the prefix\b/gi, 'conclusions live in the append-only run-state block; the frozen prefix holds only pre-F0 claims', ['ship-ticket']],
  [/\bevery batch carries `?fix_packet_digest`?\b/gi, 'only the REVIEW barrier-1 batch carries a fix packet; PROVE and pre-F0 batches precede any packet', ['ship-ticket']],
  [/\b(?:a )?config boundary\b/gi, 'record boundaries by vapt kind code — security-config, never prose', ['ship-ticket']],
  [/\boutbound credential path\b/gi, 'record boundaries by vapt kind code — outbound-data, never prose', ['ship-ticket']],
  [/\bparity verdict (?:is )?re-derived\b/gi, 'the complete parity comparison runs once in round 1', ['ship-ticket']],
  [/\bregenerate the parity draft\b/gi, 'post-F0 UI changes receive a targeted impact check instead', ['ship-ticket']],
  [/\bstrict mode\b/gi, 'vapt no longer owns a separate review or signing mode', ['vapt']],
  [/\bsigned-off:/gi, 'vapt produces runtime evidence; ship-ticket terminal review owns review attestation', ['vapt']],
  [/\brun[- ]lanes?\b/gi, 'ship-ticket\'s FAST/STANDARD/HEAVY classifier was deleted; coverage is constant', ['ship-ticket', 'pr-review']],
  [/\bREVIEW timing degraded\b/gi, 'serial round 1 is a stop, never a declared timing degradation', ['ship-ticket']],
  [/\brun A, B and C serially\b/gi, 'serial round 1 is a stop, never a declared timing degradation', ['ship-ticket']],
  [/\bserial round 1\b/gi, 'serial round 1 is a stop, never a declared timing degradation', ['ship-ticket']],
  [/\bformatters and generators first\b/gi, 'the mutation budget is read before anything that writes, formatters included', ['ship-ticket']],
  [/\bRun formatters and generators before\b/gi, 'the mutation budget is read before anything that writes, formatters included', ['ship-ticket']],
  [/\bno record mutation\b/gi, 'the post-F0 ban names candidate files and frozen prefixes; append-only run-state writes are required', ['ship-ticket']],
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
  ai-skills autoupdate                show whether automatic updates are on
  ai-skills autoupdate --install      turn them on (daily job + Claude Code hook)
  ai-skills autoupdate --remove       turn them off again
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
  --force, -f           overwrite a copy WE installed that you edited since
  --adopt               take over a directory nobody recorded installing
  --prune               also remove skills that no longer exist upstream
  --no-pull             do not fast-forward the source clone first

  update refreshes the source (git pull --ff-only, from a clean clone; the
  npx path is already fetched fresh from GitHub), then re-syncs every skill it
  installed. Symlinked skills are already live, so the pull IS their update.
  Copies are refreshed — unless you edited one in place (--force) or nobody
  recorded installing it (--adopt). Those are separate flags on purpose: a
  directory that merely shares a name with one of our skills may be somebody
  else's, and overwriting it is not what "force an update" should mean. By
  default it updates every skills directory that exists, not just Claude Code's.

Autoupdate flags:
  --install / --remove  turn automatic updates on or off
  --job-only            only the daily scheduled job
  --hook-only           only the Claude Code SessionStart hook

  Skills are passive files — nothing of ours ever runs, so there is no moment at
  which the library could notice it is stale by itself. Automatic updates
  therefore install two things that DO run: a daily job (launchd / systemd /
  schtasks) and a SessionStart hook, both calling "update --auto". That run is
  locked against itself, throttled to once an hour, never prunes, never adopts,
  never overwrites a skill you edited, and writes only to its own log — never to
  stdout, which a SessionStart hook would inject into your session.

Examples:
  npx github:AhmedAbdelfattah0/AI-Skills install security researcher
  npx github:AhmedAbdelfattah0/AI-Skills install --target codex
  node scripts/cli.mjs install --target all
  node scripts/cli.mjs install security --target claude,codex
  node scripts/cli.mjs list
  node scripts/cli.mjs update --check
  node scripts/cli.mjs update --prune
  npx github:AhmedAbdelfattah0/AI-Skills update
  node scripts/cli.mjs autoupdate --install`);
}

// ---- dispatch --------------------------------------------------------------

// Turn a CliError into a message + exit code; let anything else surface as the
// bug it is.
function runCommand(fn) {
  try { fn(); }
  catch (err) {
    if (!(err instanceof CliError)) throw err;
    console.error(`❌ ${err.message}`);
    process.exitCode = 1;
  }
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'list': cmdList(); break;
  case 'install': case 'add': runCommand(() => cmdInstall(rest)); break;
  case 'update': case 'upgrade': cmdUpdate(rest); break;
  case 'autoupdate': case 'auto': cmdAutoupdate(rest); break;
  case 'validate': case 'lint': cmdValidate(); break;
  case undefined: case 'help': case '--help': case '-h': cmdHelp(); break;
  default:
    console.error(`Unknown command: ${cmd}\n`);
    cmdHelp();
    process.exit(1);
}
