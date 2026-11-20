// Legacy (block format 2) parity capture for security-plan.mjs. The golden security-plan-legacy.golden.json was captured
// by running captureLegacy() against origin/main be63aea's security-plan.mjs (a `git archive` copy, never the working tree);
// security-obligations.test.mjs replays it on the candidate. Generic inputs only (no ticket data): every boundary kind alone
// under all-false / all-true / all-unknown facts, multi-surface mixes, an empty selection, and a format-2 reassess of
// changed files that F12a's C5 narrowing must NOT change for legacy runs (test-named files in router roots, workspace
// api/ modules, migrations, auth specs). `config_fragment` is excluded (F12a removes its stray securityControls key).
// The golden depends on the catalog bytes (every selection digest embeds catalog_digest, recorded in the file). It was
// captured from the FROZEN base be63aea (never "origin/main" after this merges). If S59 fails because controls.json
// changed, regenerate from a tree whose security-plan.mjs is be63aea's and whose catalog is the NEW controls.json
// (that pins legacy behaviour under the new catalog); never from candidate code. Recipe (owner-approved baseline change only):
//   git archive be63aea skills/ship-ticket/scripts | tar -x -C <dir>; git archive HEAD skills/vapt | tar -x -C <dir>
//   node -e "import('./security-plan-legacy.capture.test-helper.mjs').then(async m => console.log(JSON.stringify(await m.captureLegacy('<dir>/skills/ship-ticket/scripts/security-plan.mjs'), null, 1)))"
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const h = (v) => 'sha256:' + createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');

export const REASSESS_FILES = [
  { path: 'apps/web/app/routes/admin.test.tsx', added: ['export async function action() {}'] },
  { path: 'apps/api/src/plugins/users.ts', added: ["fastify.get('/users', async () => db.all())"] },
  { path: 'apps/api/src/trpc/router.ts', added: ['deleteUser: protectedProcedure.mutation(() => 1),'] },
  { path: 'app/routes/api.users.spec.ts', added: [] },
  { path: 'src/routes/__mocks__/handler.ts', added: [] },
  { path: 'apps/api/src/middleware/auth.spec.ts', added: [] },
  { path: 'db/migrations/0001_rls.test.sql', added: ['create policy p on t using (true);'] },
  { path: 'supabase/migrations/20261119120000_orders_rls.spec.sql', added: ['alter table orders disable row level security;'] },
  { path: 'src/routes/__tests__/+server.ts', added: ['export async function GET() {}'] },
  { path: 'apps/api/src/services/shipment.service.ts', added: [] },
  { path: 'apps/api/src/index.ts', added: [] },
  { path: 'apps/api/src/routes/orders.spec.ts', added: [] },
  // files a FORMAT-3 run exempts (test-named, outside every router/middleware root): a format-2 run must still signal them
  { path: 'src/lib/util.test.ts', added: ["app.get('/x', h)"] },
  { path: 'src/lib/auth.spec.ts', added: [] },
  { path: 'tests/test_routes.py', added: ["router.post('/x', h)"] },
  { path: 'src/__tests__/session.ts', added: ["export async function GET() {}"] },
];

export async function captureLegacy(securityPlanPath) {
  const SP = await import(pathToFileURL(securityPlanPath).href);
  const cat = SP.loadCatalog();
  const V = cat.catalog.fact_vocabulary;
  const bools = Object.keys(V).filter((k) => V[k].type === 'bool');
  const kinds = V.boundaries.values;
  const ev = (facts) => Object.fromEntries(bools.map((k) => [k, facts[k] === 'unknown' ? 'unknown: not determined' : 'src/x.ts:fn']));
  const mk = (surfaces, facts) => ({ security_policy: 2, surfaces, facts, evidence: ev(facts) });
  const all = (v) => Object.fromEntries(bools.map((b) => [b, v]));
  const inputs = [];
  for (const k of [...kinds, 'unknown']) for (const v of [false, true, 'unknown']) inputs.push(mk([{ boundary_id: `s-${k}`, kind: k, path: `src/${k}.ts`, principals: ['staff'] }], all(v)));
  inputs.push(mk(kinds.map((k, i) => ({ boundary_id: `b${i}:x`, kind: k, path: `apps/api/src/${k}/index.ts`, principals: ['anonymous', 'service'] })), Object.fromEntries(bools.map((b, i) => [b, i % 2 === 0]))));
  inputs.push(mk(kinds.slice(0, 5).map((k, i) => ({ boundary_id: `m${i}`, kind: k, path: `pkg/m${i}.ts`, principals: ['staff'] })), { ...all(false), persistent_write: true, session_context: true, state_transitions: true, sensitive_field_write: true }));
  inputs.push(mk([], all(false)));
  const plan = (s) => `# P\n\n${s.rows_md}\n\n<!-- RUN-STATE:BEGIN -->\n<!-- RUN-STATE:END -->\n`;
  const select = inputs.map((inp) => {
    const s = SP.selectControls(cat, inp);
    if (!s.ok) return { code: s.code };
    // rows_md, controls, excluded and the parsed block are pinned by sha256 of their exact bytes (byte identity, small file)
    return { selection_digest: s.selection_digest, facts_digest: s.facts_digest, pairs: s.pairs.map((p) => p.pair_id), unknown_facts: s.unknown_facts,
      pairsLine: SP.pairsLine({ catalogDigest: s.catalog_digest, pairs: s.pairs }), rows_md: h(s.rows_md), controls: h(s.controls), excluded: h(s.excluded),
      parsed: h(SP.parsePlanSecurityBlock(plan(s))) };
  });
  const approved = SP.selectControls(cat, mk([{ boundary_id: 'H', kind: 'request-handler', path: 'apps/api/src/routes/orders.ts', principals: ['authenticated'] }], all(false)));
  const reassess = REASSESS_FILES.map((f) => {
    const r = SP.reassess({ plan: plan(approved), catalog: cat, inventory: { surfaces: [] }, changed: { contract_paths: ['**'], files: [f] }, classifications: [] });
    return { path: f.path, ok: r.ok, code: r.code, outcome: r.outcome ?? null, signals: r.signals ?? null, unclassified: r.unclassified ?? null, delta_pairs: r.delta_pairs ?? null };
  });
  return { base: 'origin/main be63aea', catalog_digest: cat.digest, select, reassess };
}
