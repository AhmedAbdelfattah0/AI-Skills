import { randomBytes } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

export function runId(now = new Date(), entropy = randomBytes(2).toString('hex')) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${stamp}-${entropy.toLowerCase().slice(0, 4).padEnd(4, '0')}`;
}

export function sanitizeId(input) {
  const sanitized = String(input ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return sanitized || 'unnamed';
}

export function screenshotName(route, width, scheme, scenario = 'default') {
  const parts = [sanitizeId(route), String(width), sanitizeId(scheme)];
  if (scenario && scenario !== 'default') parts.push(sanitizeId(scenario));
  return `${parts.join('__')}.png`;
}

export function assertInside(runDir, candidate) {
  const root = resolve(runDir);
  const target = resolve(candidate);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(root, rel) !== target) {
    throw new Error(`Path escapes the run directory: ${candidate}`);
  }
  return target;
}

export async function writeJsonAtomic(path, payload) {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, absolute);
  } finally {
    await file?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export function redactUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, 'REDACTED');
    return url.toString();
  } catch {
    return String(rawUrl).replace(/([?&][^=&#]+)=([^&#]*)/g, '$1=REDACTED');
  }
}
