/**
 * Real-SIGKILL crash driver for engine-crash.test.mjs. Not a test file. Runs ONE engine command
 * in this process through the exported command functions, with a `boundary` hook that, at the
 * `nth` hit of boundary `name`, writes `marker` (the acknowledged barrier: the test reads it) and
 * SIGKILLs this very process: no `finally` runs, the ticket lock stays behind, pipes close as on a
 * real crash. Deterministic: the kill point is a code boundary, not a timer.
 *
 * argv[2]: JSON { cmd: 'drive' | 'gate', ctx: { repoRoot, ticket, runId, dagFile }, gate?, input?,
 *   at: { name, nth }, marker }
 */
import { writeFileSync } from 'node:fs';
import { drive, gate } from './run-engine.mjs';

const job = JSON.parse(process.argv[2]);
let hits = 0;
const hooks = {
  boundary: async (name) => {
    if (name !== job.at.name || ++hits !== job.at.nth) return;
    writeFileSync(job.marker, name);
    process.kill(process.pid, 'SIGKILL');
    await new Promise(() => {}); // never resumes
  },
};
const ctx = { ...job.ctx, env: process.env, handleSignals: false, hooks };
const out = job.cmd === 'drive' ? await drive(ctx) : await gate({ ...ctx, gate: job.gate, input: job.input });
process.stdout.write(JSON.stringify(out));
