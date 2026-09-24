import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import { withAuditPage } from './runtime.mjs';

export const FRAMEWORK_IDS = [
  'tailwind', 'bootstrap', 'angular-material', 'mui', 'chakra', 'styled-components',
  'emotion', 'css-modules', 'sass', 'less', 'plain-css', 'unknown',
];

const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'vendor', '.git', '.next', 'coverage']);
const COMMON_FONT_SCALE = [12, 14, 16, 18, 20, 24, 30, 32, 36, 48, 60, 72];
const TAILWIND_SPACING = [0, 1, 2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32, 36, 40, 44, 48, 56, 64, 80, 96];
const TAILWIND_RADIUS = [0, 2, 4, 6, 8, 12, 16, 24, 9999];
const BOOTSTRAP_SPACING = [0, 4, 8, 16, 24, 48];

function normalizePath(root, path) {
  return relative(root, path).split('\\').join('/');
}

function escapeRegex(input) {
  return input.replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&');
}

export function globToRegex(glob) {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*' && glob[index + 1] === '*') {
      if (glob[index + 2] === '/') { source += '(?:.*/)?'; index += 2; }
      else { source += '.*'; index += 1; }
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else if (char === '{') {
      const end = glob.indexOf('}', index);
      if (end < 0) source += '\\{';
      else { source += `(?:${glob.slice(index + 1, end).split(',').map(escapeRegex).join('|')})`; index = end; }
    } else source += escapeRegex(char);
  }
  return new RegExp(`^${source}$`, 'i');
}

export async function projectFiles(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || SKIP_DIRECTORIES.has(entry.name)) continue;
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  }
  await walk(root);
  return files;
}

export async function filesMatchingGlobs(root, globs, knownFiles) {
  const matchers = globs.map(globToRegex);
  const files = knownFiles ?? await projectFiles(root);
  return files.filter((path) => {
    const rel = normalizePath(root, path);
    return !/\.min\.css$/i.test(rel) && matchers.some((matcher) => matcher.test(rel));
  });
}

function balancedObject(source, start) {
  const open = source.indexOf('{', start);
  if (open < 0) return null;
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (['"', "'", '`'].includes(char)) { quote = char; continue; }
    if (char === '{') depth += 1;
    if (char === '}' && --depth === 0) return source.slice(open + 1, index);
  }
  return null;
}

function sectionLiterals(source, key) {
  const match = new RegExp(`(?:^|[,\\s])${key}\\s*:`).exec(source);
  if (!match) return {};
  const body = balancedObject(source, match.index + match[0].length);
  if (body === null) return {};
  const literals = {};
  const entry = /(?:^|,)\s*(?:['"]([^'"]+)['"]|([\w.-]+))\s*:\s*(?:['"]([^'"]+)['"]|(-?\d*\.?\d+))/gm;
  for (const found of body.matchAll(entry)) literals[found[1] ?? found[2]] = found[3] ?? found[4];
  return literals;
}

export function extractTailwindConfig(source) {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  return {
    spacing: sectionLiterals(clean, 'spacing'),
    colors: sectionLiterals(clean, 'colors'),
    fontSize: sectionLiterals(clean, 'fontSize'),
    borderRadius: sectionLiterals(clean, 'borderRadius'),
  };
}

function numericPixels(raw) {
  const value = String(raw).trim();
  if (/^-?\d*\.?\d+px$/i.test(value)) return Number.parseFloat(value);
  if (/^-?\d*\.?\d+rem$/i.test(value)) return Number.parseFloat(value) * 16;
  if (/^-?\d*\.?\d+$/.test(value)) return Number(value);
  return null;
}

function versionOf(specifier) {
  return String(specifier).match(/\d+(?:\.\d+){0,2}/)?.[0] ?? null;
}

function addFramework(frameworks, id, version, confidence, evidence) {
  const existing = frameworks.find((framework) => framework.id === id);
  if (existing) {
    existing.evidence.push(...evidence.filter((entry) => !existing.evidence.includes(entry)));
    if (!existing.version && version) existing.version = version;
    return existing;
  }
  const framework = { id, version: version ?? null, confidence, evidence: [...evidence] };
  frameworks.push(framework);
  return framework;
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { throw new Error(`${path}: invalid JSON (${error.message})`); }
}

function workspacePatterns(rootPackage, pnpmText) {
  const workspaces = Array.isArray(rootPackage.workspaces)
    ? rootPackage.workspaces
    : rootPackage.workspaces?.packages ?? [];
  const pnpm = [...pnpmText.matchAll(/^\s*-\s*['"]?([^'"#\s]+)['"]?\s*$/gm)].map((match) => match[1]);
  return [...new Set([...workspaces, ...pnpm])];
}

async function packageManifests(root, files) {
  const rootPath = resolve(root, 'package.json');
  const rootPackage = files.includes(rootPath) ? await readJson(rootPath) : {};
  const pnpmPath = files.find((path) => basename(path) === 'pnpm-workspace.yaml' && dirname(path) === root);
  const pnpmText = pnpmPath ? await readFile(pnpmPath, 'utf8') : '';
  const patterns = workspacePatterns(rootPackage, pnpmText).map((pattern) => globToRegex(pattern.replace(/\/$/, '')));
  const manifests = [{ path: rootPath, package: rootPackage }];
  for (const path of files.filter((candidate) => basename(candidate) === 'package.json' && candidate !== rootPath)) {
    const directory = normalizePath(root, dirname(path));
    if (patterns.some((pattern) => pattern.test(directory))) manifests.push({ path, package: await readJson(path) });
  }
  return manifests;
}

function dependencyEvidence(root, manifests) {
  const dependencies = new Map();
  for (const manifest of manifests) {
    const rel = normalizePath(root, manifest.path);
    for (const [name, specifier] of Object.entries({ ...manifest.package.dependencies, ...manifest.package.devDependencies })) {
      if (!dependencies.has(name)) dependencies.set(name, []);
      dependencies.get(name).push({ specifier, rel });
    }
  }
  return dependencies;
}

function detectPackages(frameworks, dependencies) {
  const definitions = [
    ['tailwind', ['tailwindcss']], ['bootstrap', ['bootstrap']], ['angular-material', ['@angular/material']],
    ['mui', ['@mui/material', '@mui/system']], ['chakra', ['@chakra-ui/react']],
    ['styled-components', ['styled-components']], ['emotion', ['@emotion/react', '@emotion/styled']],
    ['sass', ['sass', 'node-sass']], ['less', ['less']],
  ];
  for (const [id, packages] of definitions) {
    for (const name of packages) {
      for (const found of dependencies.get(name) ?? []) {
        addFramework(frameworks, id, versionOf(found.specifier), 'high', [`${found.rel} dependency ${name}@${found.specifier}`]);
      }
    }
  }
}

async function detectFiles(root, files, frameworks, tokenSources) {
  for (const path of files) {
    const rel = normalizePath(root, path);
    const name = basename(path);
    if (/^tailwind\.config\.(?:js|cjs|mjs|ts)$/.test(name)) {
      addFramework(frameworks, 'tailwind', null, 'high', [rel]);
      tokenSources.push({ framework: 'tailwind', kind: 'config', path: rel });
    }
    if (/\.module\.(?:css|scss|sass|less)$/i.test(name)) addFramework(frameworks, 'css-modules', null, 'medium', [rel]);
    if (/\.scss$|\.sass$/i.test(name)) addFramework(frameworks, 'sass', null, 'medium', [rel]);
    if (/\.less$/i.test(name)) addFramework(frameworks, 'less', null, 'medium', [rel]);
    if (!/\.(?:css|scss|sass|less|js|jsx|ts|tsx)$/i.test(name) && name !== 'angular.json') continue;
    const source = await readFile(path, 'utf8');
    if (/^postcss\.config\./.test(name) && /tailwindcss|@tailwindcss\/postcss/.test(source)) {
      addFramework(frameworks, 'tailwind', null, 'high', [`${rel} configures Tailwind`]);
    }
    if (name === 'angular.json') {
      if (/bootstrap(?:\.min)?\.css|bootstrap\/scss/i.test(source)) addFramework(frameworks, 'bootstrap', null, 'medium', [`${rel} styles entry`]);
      if (/@angular\/material|material-theme|\.mat-|--mat-|--mdc-/i.test(source)) addFramework(frameworks, 'angular-material', null, 'medium', [`${rel} styles entry`]);
    }
    if (/@import\s+["']tailwindcss["']|@tailwind\s+(?:base|components|utilities)|@theme\s*\{/i.test(source)) {
      addFramework(frameworks, 'tailwind', null, 'high', [rel]);
      if (/@theme\s*\{/i.test(source)) tokenSources.push({ framework: 'tailwind', kind: 'theme-css', path: rel });
    }
    if (/@import[^;]*bootstrap|@use[^;]*bootstrap/i.test(source)) {
      addFramework(frameworks, 'bootstrap', null, 'high', [`${rel} imports Bootstrap Sass`]);
      tokenSources.push({ framework: 'bootstrap', kind: 'sass-vars', path: rel });
    }
    if (/createTheme\s*\(|extendTheme\s*\(|defineStyleConfig\s*\(|styled\s*[.(]|css\s*`/.test(source)) {
      const id = /createTheme/.test(source) ? 'mui' : /extendTheme|defineStyleConfig/.test(source) ? 'chakra' : 'styled-components';
      addFramework(frameworks, id, null, 'medium', [`theme source ${rel}`]);
      tokenSources.push({ framework: id, kind: 'js-theme', path: rel });
    }
  }
  if (files.some((path) => /\.css$/i.test(path))) addFramework(frameworks, 'plain-css', null, 'low', ['project CSS files']);
}

function applyRuntimeEvidence(frameworks, tokenSources, vendorStylesheets, runtime = {}) {
  const fingerprints = runtime.fingerprints ?? [];
  const hrefs = runtime.stylesheets ?? [];
  const match = (pattern) => fingerprints.some((entry) => pattern.test(entry));
  if (match(/^--tw-|^tw:/)) addFramework(frameworks, 'tailwind', null, 'medium', ['live CSSOM Tailwind fingerprint']);
  if (match(/^--bs-|^bs:/)) {
    addFramework(frameworks, 'bootstrap', null, 'medium', ['live CSSOM Bootstrap fingerprint']);
    vendorStylesheets.push(...(runtime.bootstrapStylesheets ?? hrefs.filter((href) => /bootstrap/i.test(href)))
      .map((href) => `${href}#bootstrap-rules`));
  }
  if (match(/^--(?:mat|mdc)-|^mat:/)) addFramework(frameworks, 'angular-material', null, 'medium', ['live CSSOM Material fingerprint']);
  if (match(/^Mui/)) addFramework(frameworks, 'mui', null, 'medium', ['live .Mui class fingerprint']);
  if (match(/^chakra-/)) addFramework(frameworks, 'chakra', null, 'medium', ['live Chakra class fingerprint']);
  if (match(/^css-[a-z0-9]{5,}$/)) addFramework(frameworks, 'emotion', null, 'low', ['live hashed CSS-in-JS class fingerprint']);
  void tokenSources;
}

async function scalesFor(root, frameworks, tokenSources) {
  const primary = frameworks[0]?.id;
  if (primary === 'tailwind') {
    const spacing = [...TAILWIND_SPACING];
    const fontSize = [...COMMON_FONT_SCALE];
    const radius = [...TAILWIND_RADIUS];
    let source = 'tailwind default';
    for (const tokenSource of tokenSources.filter((entry) => entry.framework === 'tailwind')) {
      const text = await readFile(resolve(root, tokenSource.path), 'utf8');
      if (tokenSource.kind === 'config') {
        const extracted = extractTailwindConfig(text);
        for (const raw of Object.values(extracted.spacing)) { const value = numericPixels(raw); if (value !== null) spacing.push(value); }
        for (const raw of Object.values(extracted.fontSize)) { const value = numericPixels(raw); if (value !== null) fontSize.push(value); }
        for (const raw of Object.values(extracted.borderRadius)) { const value = numericPixels(raw); if (value !== null) radius.push(value); }
        source = 'tailwind config';
      } else {
        for (const match of text.matchAll(/--spacing-[\w-]+\s*:\s*([^;]+);/g)) { const value = numericPixels(match[1]); if (value !== null) spacing.push(value); }
        source = 'tailwind @theme';
      }
    }
    return { spacing: [...new Set(spacing)].sort((a, b) => a - b), fontSize: [...new Set(fontSize)].sort((a, b) => a - b), radius: [...new Set(radius)].sort((a, b) => a - b), source };
  }
  if (primary === 'bootstrap') {
    let spacing = [...BOOTSTRAP_SPACING];
    for (const tokenSource of tokenSources.filter((entry) => entry.framework === 'bootstrap')) {
      const text = await readFile(resolve(root, tokenSource.path), 'utf8');
      const spacer = text.match(/\$spacer\s*:\s*(-?\d*\.?\d+(?:px|rem))/)?.[1];
      const base = spacer ? numericPixels(spacer) : null;
      if (base !== null) spacing = [0, base * 0.25, base * 0.5, base, base * 1.5, base * 3];
      const map = text.match(/\$spacers\s*:\s*\(([\s\S]*?)\)\s*;/)?.[1] ?? '';
      const literals = [...map.matchAll(/:\s*(-?\d*\.?\d+(?:px|rem))/g)]
        .map((match) => numericPixels(match[1])).filter((value) => value !== null);
      if (literals.length) spacing.push(...literals);
    }
    return { spacing: [...new Set(spacing)].sort((a, b) => a - b), fontSize: COMMON_FONT_SCALE, radius: [0, 3.2, 4, 6, 8], source: 'bootstrap $spacers' };
  }
  return { spacing: null, fontSize: null, radius: null, source: 'inferred' };
}

function primaryFramework(frameworks, override) {
  if (!override) {
    const rank = { high: 0, medium: 1, low: 2 };
    return frameworks.map((framework, index) => ({ framework, index }))
      .sort((left, right) => rank[left.framework.confidence] - rank[right.framework.confidence] || left.index - right.index)
      .map(({ framework }) => framework);
  }
  const existing = frameworks.find((entry) => entry.id === override);
  const evidence = ['config.framework override'];
  const chosen = existing ? { ...existing, confidence: 'high', evidence: [...new Set([...evidence, ...existing.evidence])], override: true }
    : { id: override, version: null, confidence: 'high', evidence, override: true };
  return [chosen, ...frameworks.filter((entry) => entry.id !== override)];
}

export async function detectStack({ projectRoot, framework, templateGlobs, runtime } = {}) {
  const root = resolve(projectRoot);
  const files = await projectFiles(root);
  const manifests = await packageManifests(root, files);
  const dependencies = dependencyEvidence(root, manifests);
  const frameworks = [];
  const tokenSources = [];
  const vendorStylesheets = [];
  detectPackages(frameworks, dependencies);
  await detectFiles(root, files, frameworks, tokenSources);
  applyRuntimeEvidence(frameworks, tokenSources, vendorStylesheets, runtime);
  if (dependencies.has('bootstrap')) vendorStylesheets.push('node_modules/bootstrap');
  if (!frameworks.length) frameworks.push({ id: 'unknown', version: null, confidence: 'low', evidence: ['no recognized framework evidence'] });
  const ordered = primaryFramework(frameworks, framework);
  const scales = await scalesFor(root, ordered, tokenSources);
  return {
    frameworks: ordered,
    tokenSources,
    vendorStylesheets: [...new Set(vendorStylesheets)],
    templateGlobs: templateGlobs?.length ? templateGlobs : ['src/**/*.{html,tsx,jsx,vue,svelte,astro}'],
    scales,
  };
}

async function runtimeEvidence(page) {
  return page.evaluate(() => {
    const fingerprints = new Set();
    const root = getComputedStyle(document.documentElement);
    for (const property of root) if (/^--(?:tw|bs|mat|mdc)-/.test(property)) fingerprints.add(property);
    for (const element of [...document.querySelectorAll('[class]')].slice(0, 500)) {
      for (const name of element.classList) {
        if (/^Mui/.test(name)) fingerprints.add(name);
        else if (/^chakra-/.test(name)) fingerprints.add(name);
        else if (/^mat-/.test(name)) fingerprints.add(`mat:${name}`);
        else if (/^css-[a-z0-9]{5,}$/i.test(name)) fingerprints.add(name);
      }
    }
    const stylesheets = [];
    const bootstrapStylesheets = [];
    for (const sheet of document.styleSheets) {
      if (sheet.href) stylesheets.push(sheet.href);
      try {
        const css = [...sheet.cssRules].slice(0, 500).map((rule) => rule.cssText).join('\n');
        if (/--bs-[\w-]+/.test(css) && /\.btn(?:[,{.:\s])/.test(css) && sheet.href) bootstrapStylesheets.push(sheet.href);
      } catch { /* Cross-origin CSSOM is unavailable. */ }
    }
    return { fingerprints: [...fingerprints], stylesheets, bootstrapStylesheets };
  });
}

export async function runStack({ browser, config }) {
  let runtime = {};
  if (browser && config.routes?.length) {
    runtime = await withAuditPage(browser, config, config.routes[0], { width: 1440, scheme: 'light' }, runtimeEvidence);
  }
  return detectStack({ projectRoot: config.projectRoot, framework: config.framework, templateGlobs: config.templateGlobs, runtime });
}
