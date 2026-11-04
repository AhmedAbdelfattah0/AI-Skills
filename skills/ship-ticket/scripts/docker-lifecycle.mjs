#!/usr/bin/env node
/**
 * Owner-scoped, fail-closed Docker lifecycle. No global prune, no volume removal.
 * Only resources with both exact labels can be stopped/removed.
 */
import { spawnSync } from 'node:child_process';
import { isEntrypoint } from './harness.mjs';
const SAFE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const LABEL = 'ai-skills.ship-ticket.owner';
const RUN = 'ai-skills.ship-ticket.run';

export function dockerArgs(action, owner, runId) {
  if (!SAFE.test(owner) || !SAFE.test(runId)) throw new Error('owner and run-id must be safe opaque IDs');
  const filters = ['--filter', 'label=' + LABEL + '=' + owner, '--filter', 'label=' + RUN + '=' + runId];
  if (action === 'list') return ['ps', '-a', ...filters, '--format', '{{.ID}}'];
  if (action === 'labels') return ['--label', LABEL + '=' + owner, '--label', RUN + '=' + runId];
  if (action === 'reuse') return ['ps', ...filters, '--filter', 'status=running', '--format', '{{.ID}}'];
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
/** Running containers of this exact owner+run, for safe reuse instead of a duplicate start. */
export function reusableContainers(owner, runId, spawn = spawnSync) {
  const output = runDocker(dockerArgs('reuse', owner, runId), spawn);
  const ids = output ? output.split(/\r?\n/) : [];
  if (!ids.every(id => /^[a-f0-9]{12,64}$/.test(id))) throw new Error('unexpected Docker container ID');
  return ids;
}

/**
 * Crash recovery, read-only: every container carrying this owner label, grouped
 * by run label, so runs whose orchestrator died can be found. Removal still goes
 * through cleanupOwned(owner, run) with its per-container label re-check.
 */
export function orphanRuns(owner, spawn = spawnSync) {
  if (!SAFE.test(owner)) throw new Error('owner must be a safe opaque ID');
  const output = runDocker(['ps', '-a', '--filter', 'label=' + LABEL + '=' + owner,
    '--format', '{{.ID}}\t{{.Label "' + RUN + '"}}\t{{.State}}\t{{.CreatedAt}}'], spawn);
  const runs = {};
  for (const line of output ? output.split(/\r?\n/) : []) {
    const [id, run, state, created] = line.split('\t');
    if (!/^[a-f0-9]{12,64}$/.test(id ?? '')) throw new Error('unexpected Docker container ID');
    const key = SAFE.test(run ?? '') ? run : '(missing-run-label)';
    (runs[key] ??= []).push({ id, state: /^[a-z]{1,16}$/.test(state ?? '') ? state : 'unknown', created_at: created ?? null });
  }
  return { owner, dry_run: true, runs };
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
  if (argv[0] === 'reuse' && argv.length === 3) return { containers: reusableContainers(argv[1], argv[2]) };
  if (argv[0] === 'orphans' && argv.length === 2) return orphanRuns(argv[1]);
  if (argv[0] === 'cleanup' && (argv.length === 3 || argv.length === 4)) {
    if (argv[3] && argv[3] !== '--apply') throw new Error('only --apply is supported');
    return cleanupOwned(argv[1], argv[2], { dryRun: argv[3] === undefined });
  }
  throw new Error('Usage: docker-lifecycle.mjs labels <owner> <run-id> | reuse <owner> <run-id> | orphans <owner> | cleanup <owner> <run-id> [--apply]');
}
if (isEntrypoint(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(main(process.argv.slice(2))) + '\n'); }
  catch (e) { process.stderr.write('docker-lifecycle: ' + e.message + '\n'); process.exitCode = 1; }
}
