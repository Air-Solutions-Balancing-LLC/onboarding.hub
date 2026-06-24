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
