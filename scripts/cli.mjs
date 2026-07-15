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
//   validate                   lint every skill (the same checks CI enforces)
//   help                       this message

import {
  readdirSync, readFileSync, existsSync, lstatSync, rmSync,
  symlinkSync, cpSync, mkdirSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const names = [];
  let targetSpec = null;
  let destOverride = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--target' || a === '-t') targetSpec = args[++i];
    else if (a.startsWith('--target=')) targetSpec = a.slice('--target='.length);
    else if (a === '--dest') destOverride = args[++i];
    else if (a.startsWith('--dest=')) destOverride = a.slice('--dest='.length);
    else if (!a.startsWith('-')) names.push(a);
  }

  // Resolve destination directories (deduped — codex and agents share a dir).
  let destDirs;
  if (destOverride) {
    destDirs = [{ label: 'custom', dir: resolve(destOverride) }];
  } else {
    const keys = !targetSpec ? [DEFAULT_TARGET]
      : targetSpec === 'all' ? ['claude', 'agents', 'gemini']
      : targetSpec.split(',').map((s) => s.trim()).filter(Boolean);
    const unknown = keys.filter((k) => !TARGETS[k]);
    if (unknown.length) {
      console.error(`❌ unknown target(s): ${unknown.join(', ')}`);
      console.error(`   valid: ${Object.keys(TARGETS).join(', ')}, all — or use --dest <path>`);
      process.exit(1);
    }
    const seen = new Map();
    for (const k of keys) if (!seen.has(TARGETS[k])) seen.set(TARGETS[k], k);
    destDirs = [...seen].map(([dir, label]) => ({ label, dir }));
  }

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

  for (const { label, dir } of destDirs) {
    mkdirSync(dir, { recursive: true });
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
          cpSync(src, dst, { recursive: true });
          console.log(`📄 copied  ${name}  → ${label}`);
        }
        ok++;
      } catch (err) {
        console.error(`❌ ${name}: ${err.message}`);
        if (mode === 'link') console.error('   symlink failed — retry with --copy');
      }
    }
    console.log(`\n✅ [${label}] installed ${ok}/${targets.length} skill(s) into ${dir}  (mode: ${mode})\n`);
  }
  if (mode === 'link') console.log(`   edits in ${SKILLS_DIR} are live everywhere they're linked.`);
}

// Port of scripts/validate.sh — same three invariants, cross-platform.
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

    if (!err) console.log(`✅ ${name}`);
  }

  console.log('');
  if (fail) { console.log('❌ validation failed'); process.exit(1); }
  console.log('✅ all skills valid');
}

function cmdHelp() {
  console.log(`ai-skills — install & manage this repo's Claude Code skills

Usage:
  ai-skills list                      list every skill in the repo
  ai-skills install                   install ALL skills into ~/.claude/skills
  ai-skills install <name> [name...]  install only the named skill(s)
  ai-skills validate                  lint every skill (same checks as CI)
  ai-skills help                      show this message

Install flags:
  --copy, -c            copy real files instead of symlinking (needed on ephemeral/npx runs)
  --link, -l            force symlink even from an ephemeral source
  --target, -t <t,...>  which tool(s) to install for — SKILL.md is an open
                        standard, so the same skills work everywhere:
                          claude  ~/.claude/skills   (Claude Code — default)
                          codex   ~/.agents/skills   (OpenAI Codex)
                          gemini  ~/.gemini/skills   (Gemini CLI)
                          agents  ~/.agents/skills   (any standard-compliant tool)
                          all     claude + agents + gemini
  --dest <path>         install into a custom directory instead

Examples:
  npx github:AhmedAbdelfattah0/AI-Skills install security researcher
  npx github:AhmedAbdelfattah0/AI-Skills install --target codex
  node scripts/cli.mjs install --target all
  node scripts/cli.mjs install security --target claude,codex
  node scripts/cli.mjs list`);
}

// ---- dispatch --------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'list': cmdList(); break;
  case 'install': case 'add': cmdInstall(rest); break;
  case 'validate': case 'lint': cmdValidate(); break;
  case undefined: case 'help': case '--help': case '-h': cmdHelp(); break;
  default:
    console.error(`Unknown command: ${cmd}\n`);
    cmdHelp();
    process.exit(1);
}
