-- Postgres + RLS — Reference Migration
-- A stack-specific reference implementation of Model 1 (database-enforced row isolation),
-- append-only audit, and webhook idempotency. Use only if the project is on PostgreSQL
-- with RLS. Adapt identifiers to your schema.
--
-- NOTE: auth.jwt()/auth.uid() and the authenticated/anon/service_role roles are Supabase
-- conventions. On plain PostgreSQL, replace them with your own current-setting/JWT accessor
-- (e.g. current_setting('request.jwt.claims', true)::jsonb) and your own role names.

-- ===========================================================================
-- 0. SHARED HELPERS (create once)
-- ===========================================================================

-- Bump updated_at on UPDATE (column DEFAULT only fires on INSERT).
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

-- Resolve the caller's tenant from the verified JWT (app_metadata.tenant_id).
-- Reading from the token avoids a per-row table join inside policies. STABLE so the
-- planner caches it within a statement.
CREATE OR REPLACE FUNCTION current_tenant_id()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid
$$;

-- ===========================================================================
-- 1. TENANT TABLE TEMPLATE
-- ===========================================================================

CREATE TABLE example (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE NOT NULL,
  -- domain columns
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX idx_example_tenant ON example(tenant_id);

CREATE TRIGGER trg_example_updated_at
  BEFORE UPDATE ON example
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE example ENABLE ROW LEVEL SECURITY;

-- PERFORMANCE: wrap auth/helper calls in (SELECT ...) so Postgres evaluates them ONCE
-- per statement (initplan) instead of once per row — O(1) vs O(n) on large scans.
CREATE POLICY "Tenant reads own example rows" ON example
  FOR SELECT USING ( tenant_id = (SELECT current_tenant_id()) );

CREATE POLICY "Tenant mutates own example rows" ON example
  FOR ALL
  USING      ( tenant_id = (SELECT current_tenant_id()) )
  WITH CHECK ( tenant_id = (SELECT current_tenant_id()) );

-- If tenant must come from a table instead of the token, still wrap it:
--   USING ( tenant_id = (SELECT tenant_id FROM admin_users
--                        WHERE auth_user_id = (SELECT auth.uid())) );

-- ===========================================================================
-- 2. APPEND-ONLY AUDIT LOG
-- ===========================================================================
-- An elevated/service credential bypasses RLS, so "no UPDATE/DELETE policy" enforces
-- nothing for the writer. Lock immutability at the privilege level (and optionally a trigger).

CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  actor_id uuid,
  actor_email text,
  action text NOT NULL,
  severity text NOT NULL DEFAULT 'info'
    CHECK (severity IN ('info','warning','critical')),
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_audit_tenant_created ON audit_logs(tenant_id, created_at DESC);

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Tenant reads own audit rows" ON audit_logs
  FOR SELECT USING ( tenant_id = (SELECT current_tenant_id()) );

REVOKE UPDATE, DELETE ON audit_logs FROM authenticated, anon, service_role;

CREATE OR REPLACE FUNCTION block_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_logs is append-only'; END; $$;

CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION block_audit_mutation();
CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION block_audit_mutation();

-- ===========================================================================
-- 3. WEBHOOK EVENTS — IDEMPOTENCY
-- ===========================================================================
-- The UNIQUE constraint is the real idempotency guard; check-then-insert is racy.

CREATE TABLE webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id text NOT NULL,
  provider text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz DEFAULT now(),
  CONSTRAINT uq_webhook_event UNIQUE (event_id)
);

CREATE INDEX idx_webhook_provider_received ON webhook_events(provider, received_at DESC);

ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
-- No policies: only the elevated writer (which bypasses RLS) touches this table.
-- Fail-closed for everyone else.
