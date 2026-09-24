import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));

function degraded(reason, remediation) {
  return { lane: 'all', status: 'degraded', reason, remediation };
}

function cacheBase() {
  if (process.platform === 'win32') return process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches');
  return process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
}

function compatible(version) {
  const [major, minor] = String(version).split('.').map(Number);
  return Number.isFinite(major) && Number.isFinite(minor) && (major > 1 || (major === 1 && minor >= 40));
}

async function loadDependencies(depsDir) {
  const requireFromDeps = createRequire(join(depsDir, 'package.json'));
  const playwrightPackage = JSON.parse(await readFile(requireFromDeps.resolve('playwright/package.json'), 'utf8'));
  const axeEntry = requireFromDeps.resolve('@axe-core/playwright');
  if (!compatible(playwrightPackage.version)) throw new Error(`playwright ${playwrightPackage.version} is older than 1.40`);
  const playwrightModule = await import(pathToFileURL(requireFromDeps.resolve('playwright')).href);
  const axeModule = await import(pathToFileURL(axeEntry).href);
  const playwright = playwrightModule.default ?? playwrightModule;
  const axeBuilder = axeModule.default ?? axeModule.AxeBuilder;
  if (!playwright?.chromium || typeof axeBuilder !== 'function') throw new Error('dependencies did not expose the expected Playwright and Axe APIs');
  return { playwright, axeBuilder };
}

function installCommand(depsDir, args) {
  const executable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return spawnSync(executable, args, {
    cwd: depsDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function installChromium(depsDir) {
  const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  return spawnSync(executable, ['playwright', 'install', 'chromium'], {
    cwd: depsDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function remediationCommand(configPath) {
  const runScript = join(scriptDirectory, 'run.mjs');
  const quote = (part) => JSON.stringify(String(part));
  return `node ${quote(runScript)} --config ${quote(configPath ?? '<run-dir>/config.json')} --install-browsers`;
}

async function cacheDirectory() {
  const lockBytes = await readFile(join(scriptDirectory, 'package-lock.json'));
  const key = createHash('sha256').update(lockBytes).digest('hex').slice(0, 12);
  return join(cacheBase(), 'ux-audit', key);
}

async function ensureCache(depsDir) {
  try {
    return await loadDependencies(depsDir);
  } catch {
    await mkdir(depsDir, { recursive: true });
    await copyFile(join(scriptDirectory, 'package.json'), join(depsDir, 'package.json'));
    await copyFile(join(scriptDirectory, 'package-lock.json'), join(depsDir, 'package-lock.json'));
    const installed = installCommand(depsDir, ['ci', '--omit=dev', '--no-audit', '--no-fund']);
    if (installed.status !== 0) throw new Error(installed.stderr.trim() || installed.stdout.trim() || 'npm ci failed');
    return loadDependencies(depsDir);
  }
}

function browserPresent(playwright) {
  try { return existsSync(playwright.chromium.executablePath()); } catch { return false; }
}

async function maybeInstallBrowser(depsDir, dependencies, installBrowsers, allowInstall) {
  if (browserPresent(dependencies.playwright)) return null;
  if (installBrowsers && allowInstall) {
    const installed = installChromium(depsDir);
    if (installed.status !== 0) return installed.stderr.trim() || installed.stdout.trim() || 'Chromium installation failed';
    if (browserPresent(dependencies.playwright)) return null;
  }
  return 'Playwright Chromium is not installed';
}

export async function resolveDeps({ projectRoot, installBrowsers = false, configPath } = {}) {
  const explicit = process.env.UX_AUDIT_DEPS_DIR;
  const target = projectRoot ? resolve(projectRoot) : null;
  let depsDir;
  let dependencies;
  let allowInstall = true;
  try {
    if (explicit) {
      depsDir = resolve(explicit);
      dependencies = await loadDependencies(depsDir);
      allowInstall = false;
    } else if (target) {
      try {
        dependencies = await loadDependencies(target);
        depsDir = target;
      } catch {
        depsDir = await cacheDirectory();
        dependencies = await ensureCache(depsDir);
      }
    } else {
      depsDir = await cacheDirectory();
      dependencies = await ensureCache(depsDir);
    }
    const browserError = await maybeInstallBrowser(depsDir, dependencies, installBrowsers, allowInstall);
    if (browserError) {
      const remediation = explicit
        ? `npm --prefix ${JSON.stringify(depsDir)} exec -- playwright install chromium`
        : remediationCommand(configPath);
      return degraded(browserError, remediation);
    }
    return { depsDir, ...dependencies };
  } catch (error) {
    return degraded(`Unable to resolve audit dependencies: ${error.message}`, `Set UX_AUDIT_DEPS_DIR to a directory containing compatible node_modules, or run ${remediationCommand(configPath)}`);
  }
}
