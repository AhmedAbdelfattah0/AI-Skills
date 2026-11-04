#!/usr/bin/env node
/**
 * Owner-scoped, fail-closed Docker lifecycle. No global prune, no volume removal.
 * Only resources with both exact labels can be stopped/removed.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const SAFE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const LABEL = 'ai-skills.ship-ticket.owner';
const RUN = 'ai-skills.ship-ticket.run';

export function dockerArgs(action, owner, runId) {
  if (!SAFE.test(owner) || !SAFE.test(runId)) throw new Error('owner and run-id must be safe opaque IDs');
  const filters = ['--filter', 'label=' + LABEL + '=' + owner, '--filter', 'label=' + RUN + '=' + runId];
  if (action === 'list') return ['ps', '-a', ...filters, '--format', '{{.ID}}'];
  if (action === 'labels') return ['--label', LABEL + '=' + owner, '--label', RUN + '=' + runId];
  throw new Error('unsupported docker action');
}
export function runDocker(args, spawn = spawnSync) {
  const r = spawn('docker', args, { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error || r.status !== 0) throw new Error('docker operation failed: ' + (r.error?.code ?? r.status));
  return r.stdout.trim();
}
export function ownedContainers(owner, runId, spawn = spawnSync) {
  const output = runDocker(dockerArgs('list', owner, runId), spawn);
  const ids = output ? output.split(/\r?\n/) : [];
  if (!ids.every(id => /^[a-f0-9]{12,64}$/.test(id))) throw new Error('unexpected Docker container ID');
  return ids;
}
export function cleanupOwned(owner, runId, { dryRun = true, spawn = spawnSync } = {}) {
  const ids = ownedContainers(owner, runId, spawn);
  if (dryRun) return { dry_run: true, containers: ids, removed: 0 };
  // Re-verify BOTH labels for each ID immediately before removal; fail closed.
  let removed = 0;
  for (const id of ids) {
    const labels = runDocker(['inspect', '--format', '{{json .Config.Labels}}', id], spawn);
    let parsed;
    try { parsed = JSON.parse(labels); } catch { throw new Error('invalid Docker labels'); }
    if (parsed?.[LABEL] !== owner || parsed?.[RUN] !== runId) throw new Error('ownership mismatch; refusing cleanup');
    runDocker(['rm', '-f', '--', id], spawn);
    removed += 1;
  }
  return { dry_run: false, containers: ids, removed };
}
function main(argv) {
  if (argv[0] === 'labels' && argv.length === 3) return { args: dockerArgs('labels', argv[1], argv[2]) };
  if (argv[0] === 'cleanup' && (argv.length === 3 || argv.length === 4)) {
    if (argv[3] && argv[3] !== '--apply') throw new Error('only --apply is supported');
    return cleanupOwned(argv[1], argv[2], { dryRun: argv[3] === undefined });
  }
  throw new Error('Usage: docker-lifecycle.mjs labels <owner> <run-id> | cleanup <owner> <run-id> [--apply]');
}
if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  try { process.stdout.write(JSON.stringify(main(process.argv.slice(2))) + '\n'); }
  catch (e) { process.stderr.write('docker-lifecycle: ' + e.message + '\n'); process.exitCode = 1; }
}
