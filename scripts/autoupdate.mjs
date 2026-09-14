// Automatic updates for this skill library.
//
// Skills are passive files: nothing of ours ever executes, so there is no moment
// at which the library could notice it is out of date the way a running binary
// can. "Automatic" therefore means installing something that runs. Two things do:
//
//   a daily scheduled job     launchd / systemd / schtasks, per platform
//   a Claude Code hook        SessionStart, so a session never opens on stale skills
//
// Both call `cli.mjs update --auto`, which takes a lock, throttles to one run an
// hour, never overwrites a skill you edited, and prints nothing unless something
// actually changed. Everything installed here is removable with --remove.

import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync,
  readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const LAUNCHD_LABEL = 'com.ai-skills.update';
const SYSTEMD_UNIT = 'ai-skills-update';
const SCHTASKS_NAME = 'AI Skills Update';

// How we recognise our own hook: install must be idempotent, and remove must
// never take somebody else's SessionStart hook with it. The identity is the
// ABSOLUTE PATH OF THIS CLI — unique to this install. Matching loose substrings
// like "cli.mjs" + "update --auto" would also claim another checkout's updater,
// or any unrelated `/opt/tool/cli.mjs update --auto`.
const isOurHook = (h, cliPath) => {
  if (h?.type !== 'command') return false;
  // Current shape: exec form, no shell — cliPath is its own argv entry.
  if (Array.isArray(h.args) && h.args.includes(cliPath)) return true;
  // Legacy shape: one shell string. Still ours only if it names THIS cli path.
  return typeof h.command === 'string' && h.command.includes(cliPath) && h.command.includes('update');
};

const isWin = platform() === 'win32';
const settingsFile = () => join(homedir(), '.claude', 'settings.json');
const plistPath = () => join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
const systemdDir = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user');

// Run a command for its output; null means it failed or is not installed.
function exec(cmd, args) {
  try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { return null; }
}

// launchd and systemd start jobs with a minimal PATH that has no nvm or Homebrew
// node on it, so a job that merely says `node` silently never runs. Bake in the
// absolute interpreter, and a PATH wide enough to still find git.
function jobEnv() {
  const nodeBin = process.execPath;
  const path = [dirname(nodeBin), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
    .filter((p, i, a) => a.indexOf(p) === i).join(':');
  return { nodeBin, path };
}

// No StandardOutPath/StandardErrorPath on purpose: launchd opens those BEFORE it
// starts the process, so a log under a state directory that has since been
// deleted makes the job fail before node can recreate it — silently, every day,
// forever. `update --auto` opens its own log, after creating the directory.
function plistXml(cliPath) {
  const { nodeBin, path } = jobEnv();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${cliPath}</string>
    <string>update</string>
    <string>--auto</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${path}</string></dict>
  <key>StartInterval</key><integer>86400</integer>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`;
}

// systemd splits ExecStart on whitespace, so an unquoted path containing a space
// — AI_SKILLS_HOME="/home/me/AI Skills" is entirely legal — installs a timer that
// can never run the CLI. Double-quote every dynamic value, and escape the `%`
// that systemd would otherwise read as a specifier. StandardOutput is omitted
// for the same reason as launchd's: it is opened before the process starts.
const sdQuote = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;

function systemdUnits(cliPath) {
  const { nodeBin, path } = jobEnv();
  return {
    service: `[Unit]
Description=Update the AI-Skills library

[Service]
Type=oneshot
Environment=${sdQuote(`PATH=${path}`)}
ExecStart=${sdQuote(nodeBin)} ${sdQuote(cliPath)} update --auto
`,
    timer: `[Unit]
Description=Daily AI-Skills update

[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
`,
  };
}

// EXEC form — `command` plus `args`, which Claude Code spawns directly with no
// shell. The previous shell string was three latent bugs: `&&` and `||` are
// syntax errors in Windows PowerShell 5.1, so SessionStart never reached node
// there at all; a repo or home path containing a quote, `$(...)` or a backtick
// broke the quoting or executed a substitution; and the `>>` redirect meant an
// absent log directory killed the hook before node could recreate it. There is
// no redirect now because `update --auto` writes its own log and prints nothing
// to stdout — which also keeps it out of the session's context.
// async:true keeps session startup instant.
function hookEntry(cliPath) {
  const { nodeBin } = jobEnv();
  return {
    type: 'command',
    command: nodeBin,
    args: [cliPath, 'update', '--auto'],
    async: true,
    timeout: 120,
  };
}

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

// Add or remove our SessionStart hook, disturbing nothing else in the file.
// A malformed settings.json silently disables EVERY setting in it, so an
// unparseable file is refused rather than overwritten.
function editHook(install, cliPath) {
  const file = settingsFile();
  let settings = {};
  if (existsSync(file)) {
    settings = readJson(file);
    if (settings === null) {
      console.error(`❌ ${file} is not valid JSON — refusing to touch it.`);
      console.error('   Fix it first: a malformed settings.json disables every setting in it.');
      return false;
    }
  }
  settings.hooks ||= {};
  const groups = Array.isArray(settings.hooks.SessionStart) ? settings.hooks.SessionStart : [];

  const kept = groups
    .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurHook(h, cliPath)) }))
    .filter((g) => (g.hooks || []).length > 0);

  if (install) kept.push({ hooks: [hookEntry(cliPath)] });

  if (kept.length) settings.hooks.SessionStart = kept;
  else delete settings.hooks.SessionStart;
  if (!Object.keys(settings.hooks).length) delete settings.hooks;

  mkdirSync(dirname(file), { recursive: true });
  // Atomically. Truncating settings.json in place means a full disk, a short
  // write or an interrupt leaves partial JSON — which disables EVERY Claude Code
  // setting in the file, the very outcome the malformed-input check above exists
  // to avoid. Write a sibling, flush it to disk, then rename over the original;
  // rename within a directory is atomic, so a reader sees old or new, never half.
  const tmp = join(dirname(file), `.settings.json.ai-skills-${process.pid}`);
  try {
    const fd = openSync(tmp, 'w');
    try {
      writeFileSync(fd, JSON.stringify(settings, null, 2) + '\n');
      fsyncSync(fd);
    } finally { closeSync(fd); }
    if (existsSync(file)) { try { chmodSync(tmp, statSync(file).mode); } catch { /* keep the default */ } }
    renameSync(tmp, file);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    console.error(`❌ could not write ${file}: ${err.message}`);
    return false;
  }
  return true;
}

function hookInstalled(cliPath) {
  const groups = readJson(settingsFile())?.hooks?.SessionStart;
  return Array.isArray(groups) && groups.some((g) => (g.hooks || []).some((h) => isOurHook(h, cliPath)));
}

function installJob(cliPath) {
  const { nodeBin } = jobEnv();
  if (platform() === 'darwin') {
    const p = plistPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, plistXml(cliPath));
    const uid = process.getuid?.() ?? 0;
    exec('launchctl', ['bootout', `gui/${uid}/${LAUNCHD_LABEL}`]);   // replace cleanly on re-install
    if (exec('launchctl', ['bootstrap', `gui/${uid}`, p]) === null) {
      console.error(`⚠️  wrote ${p} but launchctl bootstrap failed.`);
      console.error(`   Load it yourself: launchctl bootstrap gui/${uid} "${p}"`);
    } else {
      console.log(`⏰ daily launchd job installed (${LAUNCHD_LABEL})`);
    }
    return;
  }
  if (platform() === 'linux') {
    if (exec('systemctl', ['--user', '--version']) === null) {
      console.error('⚠️  systemctl --user is unavailable here, so no timer was installed.');
      console.error('   Add this crontab line instead (crontab -e):');
      console.error(`     0 9 * * * "${nodeBin}" "${cliPath}" update --auto`);
      return;
    }
    const dir = systemdDir();
    mkdirSync(dir, { recursive: true });
    const u = systemdUnits(cliPath);
    writeFileSync(join(dir, `${SYSTEMD_UNIT}.service`), u.service);
    writeFileSync(join(dir, `${SYSTEMD_UNIT}.timer`), u.timer);
    exec('systemctl', ['--user', 'daemon-reload']);
    if (exec('systemctl', ['--user', 'enable', '--now', `${SYSTEMD_UNIT}.timer`]) === null) {
      console.error(`⚠️  units written, but enabling ${SYSTEMD_UNIT}.timer failed.`);
    } else {
      console.log(`⏰ daily systemd timer installed (${SYSTEMD_UNIT}.timer)`);
    }
    return;
  }
  if (isWin) {
    const tr = `"${nodeBin}" "${cliPath}" update --auto`;
    if (exec('schtasks', ['/Create', '/F', '/SC', 'DAILY', '/TN', SCHTASKS_NAME, '/TR', tr]) === null) {
      console.error('⚠️  schtasks failed. Create it yourself:');
      console.error(`     schtasks /Create /F /SC DAILY /TN "${SCHTASKS_NAME}" /TR "${tr}"`);
    } else {
      console.log(`⏰ daily scheduled task installed (${SCHTASKS_NAME}) — untested on Windows, check it runs`);
    }
    return;
  }
  console.error(`⚠️  no scheduler known for platform "${platform()}" — the SessionStart hook still works.`);
}

function removeJob() {
  if (platform() === 'darwin') {
    const uid = process.getuid?.() ?? 0;
    exec('launchctl', ['bootout', `gui/${uid}/${LAUNCHD_LABEL}`]);
    if (existsSync(plistPath())) {
      rmSync(plistPath(), { force: true });
      console.log(`🗑  launchd job removed (${LAUNCHD_LABEL})`);
    }
    return;
  }
  if (platform() === 'linux') {
    exec('systemctl', ['--user', 'disable', '--now', `${SYSTEMD_UNIT}.timer`]);
    for (const f of [`${SYSTEMD_UNIT}.timer`, `${SYSTEMD_UNIT}.service`]) {
      const p = join(systemdDir(), f);
      if (existsSync(p)) rmSync(p, { force: true });
    }
    exec('systemctl', ['--user', 'daemon-reload']);
    console.log(`🗑  systemd timer removed (${SYSTEMD_UNIT}.timer)`);
    return;
  }
  if (isWin) {
    exec('schtasks', ['/Delete', '/F', '/TN', SCHTASKS_NAME]);
    console.log(`🗑  scheduled task removed (${SCHTASKS_NAME})`);
  }
}

function jobStatus() {
  if (platform() === 'darwin') {
    if (!existsSync(plistPath())) return 'not installed';
    const uid = process.getuid?.() ?? 0;
    const loaded = exec('launchctl', ['print', `gui/${uid}/${LAUNCHD_LABEL}`]) !== null;
    return loaded ? `installed and loaded (${LAUNCHD_LABEL}, daily)` : `plist written but NOT loaded (${LAUNCHD_LABEL})`;
  }
  if (platform() === 'linux') {
    if (!existsSync(join(systemdDir(), `${SYSTEMD_UNIT}.timer`))) return 'not installed';
    return `installed (${(exec('systemctl', ['--user', 'is-enabled', `${SYSTEMD_UNIT}.timer`]) || 'not enabled').trim()})`;
  }
  if (isWin) return exec('schtasks', ['/Query', '/TN', SCHTASKS_NAME]) !== null ? 'installed' : 'not installed';
  return 'unsupported platform';
}

/**
 * @param {string[]} args        raw argv after the command word
 * @param {object}   ctx         { repoRoot, cliPath, stateDir, ephemeral, lastRun }
 */
export function autoupdate(args, ctx) {
  const has = (...names) => names.some((n) => args.includes(n));
  const remove = has('--remove', '--uninstall');
  const install = has('--install');
  const hookOnly = has('--hook-only');
  const jobOnly = has('--job-only');
  const log = join(ctx.stateDir, 'update.log');

  if (!install && !remove) { report(ctx, log); return; }

  if (ctx.ephemeral) {
    console.error('❌ this source is an npx cache, which is deleted between runs.');
    console.error('   A scheduled job pointing at it would break. Clone the repo first — or run');
    console.error('   the curl installer, which clones into ~/.ai-skills — and set it up there.');
    process.exit(1);
  }

  mkdirSync(ctx.stateDir, { recursive: true });

  if (remove) {
    if (!hookOnly) removeJob();
    if (!jobOnly && editHook(false, ctx.cliPath)) console.log('🗑  Claude Code SessionStart hook removed');
    console.log('\n✅ automatic updates are off. `update` still works whenever you run it.');
    return;
  }

  if (!hookOnly) installJob(ctx.cliPath);
  if (!jobOnly && editHook(true, ctx.cliPath)) {
    console.log('🪝 Claude Code SessionStart hook installed (~/.claude/settings.json)');
    console.log('   It runs in the background, so it neither delays startup nor speaks');
    console.log('   into your session — output goes to the log only.');
  }
  console.log(`\n📋 log: ${log}`);
  console.log('   Runs are throttled to one an hour and never overwrite a skill you edited.');
  console.log('   `autoupdate` to check status, `autoupdate --remove` to turn it all off.');
}

function report(ctx, log) {
  console.log(`source:        ${ctx.repoRoot}`);
  console.log(`log:           ${log}`);
  const job = jobStatus();
  console.log(`daily job:     ${job}`);
  console.log(`SessionStart:  ${hookInstalled(ctx.cliPath) ? 'installed (~/.claude/settings.json)' : 'not installed'}`);
  const at = ctx.lastRun;
  if (at) {
    const mins = Math.round((Date.now() - at) / 60000);
    console.log(`last auto run: ${mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`}`);
  } else {
    console.log('last auto run: never');
  }
  if (job === 'not installed' && !hookInstalled(ctx.cliPath)) {
    console.log('\n   `autoupdate --install` turns automatic updates on.');
  }
}
