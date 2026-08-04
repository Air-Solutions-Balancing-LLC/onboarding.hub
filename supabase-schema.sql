-- ============================================================
--  ONBOARDING HUB — Supabase Schema
--  Run this in Supabase → SQL Editor
-- ============================================================

-- Shared app state (resources, tasks, orientation data, etc.)
CREATE TABLE IF NOT EXISTS hub_data (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL DEFAULT 'null',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Legacy tables (optional — used by app.js variant)
CREATE TABLE IF NOT EXISTS weekly_tasks (
  id         BIGSERIAL PRIMARY KEY,
  task       TEXT NOT NULL,
  owner      TEXT,
  due        DATE,
  status     TEXT DEFAULT 'Not started' CHECK (status IN ('Not started', 'In progress', 'Completed')),
  priority   TEXT DEFAULT 'Medium'     CHECK (priority IN ('Urgent', 'High', 'Medium', 'Low')),
  category   TEXT,
  resources  TEXT,
  notes      TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orientation_checks (
  id         TEXT PRIMARY KEY,
  checked    BOOLEAN DEFAULT FALSE,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS step_checks (
  id         TEXT PRIMARY KEY,
  checked    BOOLEAN DEFAULT FALSE,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
--  Row Level Security — authenticated users only
-- ============================================================

ALTER TABLE hub_data           ENABLE ROW LEVEL SECURITY;
ALTER TABLE weekly_tasks       ENABLE ROW LEVEL SECURITY;
ALTER TABLE orientation_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE step_checks        ENABLE ROW LEVEL SECURITY;

-- hub_data: shared team state, any signed-in user
DROP POLICY IF EXISTS "hub_data_select" ON hub_data;
DROP POLICY IF EXISTS "hub_data_insert" ON hub_data;
DROP POLICY IF EXISTS "hub_data_update" ON hub_data;

CREATE POLICY "hub_data_select" ON hub_data
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "hub_data_insert" ON hub_data
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "hub_data_update" ON hub_data
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- Legacy tables
DROP POLICY IF EXISTS "Allow all for anon" ON weekly_tasks;
DROP POLICY IF EXISTS "weekly_tasks_auth" ON weekly_tasks;
CREATE POLICY "weekly_tasks_auth" ON weekly_tasks
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow all for anon" ON orientation_checks;
DROP POLICY IF EXISTS "orientation_checks_auth" ON orientation_checks;
CREATE POLICY "orientation_checks_auth" ON orientation_checks
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow all for anon" ON step_checks;
DROP POLICY IF EXISTS "step_checks_auth" ON step_checks;
CREATE POLICY "step_checks_auth" ON step_checks
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============================================================
--  App users (Admin → User Management) — Atlas-style
--  Roles: Admin, PM, Technician, Accounting, HR, Logistics, Training
-- ============================================================

DO $$ BEGIN
  CREATE TYPE public.hub_role AS ENUM (
    'admin',
    'pm',
    'technician',
    'accounting',
    'hr',
    'logistics',
    'training'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS public.app_users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL,
  full_name   TEXT,
  role        public.hub_role NOT NULL,
  region      TEXT,
  deleted_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT app_users_email_lower_unique UNIQUE (email)
);

CREATE INDEX IF NOT EXISTS app_users_role_idx
  ON public.app_users (role)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS app_users_deleted_at_idx
  ON public.app_users (deleted_at)
  WHERE deleted_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.normalize_app_user_email()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.email := lower(trim(NEW.email));
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS app_users_normalize_email ON public.app_users;
CREATE TRIGGER app_users_normalize_email
  BEFORE INSERT OR UPDATE ON public.app_users
  FOR EACH ROW
  EXECUTE FUNCTION public.normalize_app_user_email();

-- Seed initial admins (safe to re-run)
INSERT INTO public.app_users (email, full_name, role, region)
VALUES
  ('brian.sharkey@airadigmsolutions.com', 'Brian Sharkey', 'admin', 'Southwest'),
  ('pauline.pineda@airadigmsolutions.com', 'Pauline Pineda', 'admin', 'Southwest')
ON CONFLICT (email) DO UPDATE
SET
  full_name = EXCLUDED.full_name,
  role = EXCLUDED.role,
  region = COALESCE(public.app_users.region, EXCLUDED.region),
  deleted_at = NULL,
  updated_at = NOW();

ALTER TABLE public.app_users ENABLE ROW LEVEL SECURITY;

-- Reads: any signed-in user (needed to resolve own role for Admin nav)
DROP POLICY IF EXISTS app_users_select_authenticated ON public.app_users;
CREATE POLICY app_users_select_authenticated
  ON public.app_users
  FOR SELECT
  TO authenticated
  USING (true);

-- Is the currently signed-in user an admin?
CREATE OR REPLACE FUNCTION public.is_app_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.app_users a
    WHERE lower(a.email) = lower(COALESCE(
            auth.jwt() ->> 'email',
            auth.jwt() -> 'user_metadata' ->> 'email',
            ''))
      AND a.role = 'admin'
      AND a.deleted_at IS NULL
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_app_admin() TO authenticated;

DROP POLICY IF EXISTS app_users_insert_all ON public.app_users;
DROP POLICY IF EXISTS app_users_update_all ON public.app_users;
DROP POLICY IF EXISTS app_users_delete_all ON public.app_users;
DROP POLICY IF EXISTS app_users_admin_insert ON public.app_users;
DROP POLICY IF EXISTS app_users_admin_update ON public.app_users;
DROP POLICY IF EXISTS app_users_admin_delete ON public.app_users;

CREATE POLICY app_users_admin_insert
  ON public.app_users
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_app_admin());

CREATE POLICY app_users_admin_update
  ON public.app_users
  FOR UPDATE
  TO authenticated
  USING (public.is_app_admin())
  WITH CHECK (public.is_app_admin());

CREATE POLICY app_users_admin_delete
  ON public.app_users
  FOR DELETE
  TO authenticated
  USING (public.is_app_admin());

GRANT SELECT ON public.app_users TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.app_users TO authenticated;
GRANT USAGE ON TYPE public.hub_role TO authenticated;
