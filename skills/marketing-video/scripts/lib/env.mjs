// Runtime environment: the pinned dependency cache, the Remotion-bundled
// ffmpeg/ffprobe, and the headless browser. Nothing here installs into the
// user's project; dependencies live in a lockfile-keyed user cache, the same
// pattern as ux-audit's bootstrap.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function cacheBase() {
  if (process.platform === 'win32') return process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches');
  return process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
}

export function lockDigest() {
  return createHash('sha256').update(readFileSync(join(SCRIPTS_DIR, 'package-lock.json'))).digest('hex').slice(0, 12);
}

export function depsDir() {
  if (process.env.MARKETING_VIDEO_DEPS_DIR) return resolve(process.env.MARKETING_VIDEO_DEPS_DIR);
  return join(cacheBase(), 'marketing-video', lockDigest());
}

function depsPresent(dir) {
  try {
    const req = createRequire(join(dir, 'package.json'));
    req.resolve('@remotion/renderer');
    req.resolve('@remotion/bundler');
    return true;
  } catch { return false; }
}

// mkdir is atomic: the directory itself is the lock. A lock older than ten
// minutes belongs to a dead install and is taken over.
function withLock(dir, fn) {
  const lock = `${dir}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  try { mkdirSync(lock); } catch {
    if (Date.now() - statSync(lock).mtimeMs < 10 * 60 * 1000) throw new Error(`another install holds ${lock}; retry when it finishes`);
    rmSync(lock, { recursive: true, force: true });
    mkdirSync(lock);
  }
  try { return fn(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

export function ensureDeps({ install = false } = {}) {
  const dir = depsDir();
  if (depsPresent(dir)) return { dir, installed: false };
  if (!install) throw new Error(`dependencies missing in ${dir}; run: node mv.mjs preflight --install`);
  if (process.env.MARKETING_VIDEO_DEPS_DIR) throw new Error('MARKETING_VIDEO_DEPS_DIR is set but incomplete; it is never installed into');
  return withLock(dir, () => {
    if (depsPresent(dir)) return { dir, installed: false };
    mkdirSync(dir, { recursive: true });
    copyFileSync(join(SCRIPTS_DIR, 'package.json'), join(dir, 'package.json'));
    copyFileSync(join(SCRIPTS_DIR, 'package-lock.json'), join(dir, 'package-lock.json'));
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const r = spawnSync(npm, ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`npm ci failed: ${(r.stderr || r.stdout).trim().slice(-800)}`);
    return { dir, installed: true };
  });
}

export function requireDeps(dir = depsDir()) {
  return createRequire(join(dir, 'package.json'));
}

// The compositor package for this platform ships ffmpeg/ffprobe and their
// dylibs side by side; they only load with that directory as cwd.
export function compositorDir(dir = depsDir()) {
  const req = requireDeps(dir);
  const arch = process.platform === 'linux' ? `${process.arch}-gnu` : process.arch;
  const pkg = `@remotion/compositor-${process.platform === 'win32' ? 'win32-x64-msvc' : `${process.platform}-${arch}`}`;
  return dirname(req.resolve(`${pkg}/package.json`));
}

export function tool(name, args, { encoding = 'utf8', maxBuffer = 512 * 1024 * 1024 } = {}) {
  const cwd = compositorDir();
  const exe = join(cwd, process.platform === 'win32' ? `${name}.exe` : name);
  if (!existsSync(exe)) throw new Error(`${name} not found in ${cwd}`);
  const r = spawnSync(exe, args, { cwd, encoding, maxBuffer });
  return { status: r.status, stdout: r.stdout, stderr: encoding ? r.stderr : r.stderr?.toString('utf8') };
}

export function ffprobeJson(file) {
  const r = tool('ffprobe', ['-v', 'error', '-show_entries',
    'stream=index,codec_type,codec_name,width,height,r_frame_rate,nb_frames,sample_rate,channels:format=duration',
    '-of', 'json', file]);
  if (r.status !== 0) throw new Error(`ffprobe failed for ${file}: ${r.stderr.trim()}`);
  return JSON.parse(r.stdout);
}

// Remotion keeps its headless browser under <cwd>/.remotion, so every call
// that may download or launch it runs with the cache as cwd.
export function inDepsCwd(fn) {
  const previous = process.cwd();
  process.chdir(depsDir());
  return Promise.resolve().then(fn).finally(() => process.chdir(previous));
}
