/**
 * Test helper (not a test file): take an initialized run through the supported admission steps, the
 * way an orchestrator does after `init`: `enroll`, then `context` for build, review and ship. Used by
 * engine-test-fixture.mjs (after every successful `init`) and engine-oracle.test-helper.mjs, so the
 * pre-enrollment engine tests keep exercising what they did before through the real commands.
 * CLI: node engine-admit.test-helper.mjs <repo> <ticket> <run-id>   (exit 0 admitted, 1 otherwise)
 */
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { enroll, context } from './run-engine.mjs';

export const ADMIT_CLI = fileURLToPath(import.meta.url);
export const ADMIT_PHASES = ['build', 'review', 'ship'];

/** Enroll the run of `ctx` and record the build, review and ship contexts. Throws on any refusal. */
export async function admitRun(ctx) {
  await enroll(ctx);
  for (const phase of ADMIT_PHASES) {
    const r = await context({ ...ctx, phase });
    if (!r.recorded) throw new Error(`admit: context ${phase} not recorded (${r.code}: ${(r.reasons ?? []).join('; ')})`);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(ADMIT_CLI)) {
  const [repoRoot, ticket, runId] = process.argv.slice(2);
  admitRun({ repoRoot, ticket, runId, handleSignals: false }).then(() => { process.exitCode = 0; },
    (e) => { process.stderr.write(`admit: ${e.message}\n`); process.exitCode = 1; });
}
