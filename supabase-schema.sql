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

-- ============================================================
--  New Hire Checklist — employees (+ related tables)
--  Migrated from project wsijpjjbaggclnlnfklw into this hub DB
-- ============================================================

CREATE TABLE IF NOT EXISTS public.employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_number INTEGER,
  employee_type TEXT DEFAULT 'technician',
  status TEXT DEFAULT 'active',
  status_note TEXT,
  full_name TEXT NOT NULL,
  preferred_name TEXT,
  region TEXT,
  referred_by TEXT,
  home_address_line1 TEXT,
  home_address_line2 TEXT,
  home_address_line3 TEXT,
  address_confirmed BOOLEAN,
  cell_phone TEXT,
  personal_email TEXT,
  full_name_on_license TEXT,
  license_state TEXT,
  gender TEXT,
  ssn_last4 TEXT,
  birth_month_day TEXT,
  preferred_airport TEXT,
  airplane_preference TEXT,
  start_date DATE,
  bootcamp_start_date DATE,
  assigned_pm TEXT,
  assigned_lead_tech TEXT,
  contract_type TEXT DEFAULT 'full_time',
  resume_link TEXT,
  date_application_received DATE,
  mechanical_test_score TEXT,
  communication_questionnaire TEXT,
  date_verbal_offer DATE,
  date_written_offer DATE,
  date_written_offer_accepted DATE,
  date_background_requested DATE,
  date_background_clean DATE,
  background_notes TEXT,
  shirt_size TEXT,
  work_glove_size TEXT,
  boot_size TEXT,
  osha10_prior BOOLEAN,
  date_osha10_sent DATE,
  hs_diploma_received TEXT,
  tool_kit_purchase TEXT,
  date_handbook_signed DATE,
  date_w4_received DATE,
  date_i9_received DATE,
  date_cgi_login TEXT,
  date_direct_deposit DATE,
  date_noncompete_signed DATE,
  date_lunch_waiver_signed DATE,
  hr_onboarding_complete DATE,
  date_headshot_requested DATE,
  date_osha10_uploaded DATE,
  date_harassment_training DATE,
  ringcentral_created BOOLEAN,
  date_email_setup DATE,
  company_email TEXT,
  microsoft_password TEXT,
  alias_email_confirmed BOOLEAN,
  date_laptop_ordered DATE,
  ipad_needed BOOLEAN,
  date_ipad_ordered TEXT,
  national_rental_profile TEXT,
  usabalancer_username TEXT,
  usabalancer_password TEXT,
  adobe_status TEXT,
  bluebeam_status TEXT,
  hotel_engine_status TEXT,
  grainger_status TEXT,
  ipromo_status TEXT,
  geotab_status TEXT,
  ata_setup BOOLEAN,
  date_it_prep_complete DATE,
  date_sage_setup DATE,
  date_bill_card_ordered DATE,
  date_bill_card_received TEXT,
  date_vehicle_assigned DATE,
  vehicle_number TEXT,
  license_plate_state TEXT,
  license_plate_number TEXT,
  date_geotab_updated TEXT,
  date_aaa_added TEXT,
  aaa_membership_number TEXT,
  date_wex_card_ordered TEXT,
  wex_driver_number TEXT,
  date_vehicle_docs_complete TEXT,
  tool_inventory_complete TEXT,
  final_van_inventory TEXT,
  van_ready TEXT,
  date_backpack_ready DATE,
  backpack_ship_date DATE,
  date_hardhat_shipped DATE,
  date_vehicle_fully_equipped DATE,
  date_ipad_onsite TEXT,
  zagg_case_needed BOOLEAN,
  date_zagg_ordered TEXT,
  date_zagg_received TEXT,
  date_ipad_chargers_ready TEXT,
  date_mosyle_setup DATE,
  date_ipad_credentials_form DATE,
  date_ipad_setup_complete DATE,
  date_pm_informed_orient DATE,
  date_orientation_email DATE,
  date_payroll_deduction DATE,
  date_safety_manual_signed DATE,
  tool_list_usabalancer BOOLEAN,
  enrolled_ata_safety BOOLEAN,
  added_company_news_rc BOOLEAN,
  added_company_social_rc BOOLEAN,
  added_field_tech_rc BOOLEAN,
  added_training_touchbase_rc BOOLEAN,
  added_division_rc BOOLEAN,
  date_photos_sharepoint DATE,
  date_id_badge_ordered DATE,
  date_id_badge_received DATE,
  date_schedule_announced DATE,
  date_pm_informed_bootcamp DATE,
  date_bootcamp_email_sent DATE,
  date_usabalancer_bootcamp TEXT,
  date_hotel_requested DATE,
  date_hotel_confirmed DATE,
  date_hotel_forwarded DATE,
  date_flights_purchased DATE,
  date_health_insurance DATE,
  date_401k_reminder DATE,
  date_work_anniversary_added DATE,
  ipromo_250_added BOOLEAN,
  auburn_office_code BOOLEAN,
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.employee_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID,
  user_id UUID,
  author_name TEXT,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.activity_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID,
  user_id UUID,
  user_name TEXT,
  action TEXT,
  field_changed TEXT,
  old_value TEXT,
  new_value TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.upcoming_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  event_name TEXT,
  start_date DATE NOT NULL,
  end_date DATE,
  location TEXT,
  region TEXT,
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.event_employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID,
  employee_id UUID,
  confirmed BOOLEAN DEFAULT FALSE,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  role TEXT NOT NULL,
  full_name TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);


CREATE OR REPLACE VIEW public.employee_progress AS
SELECT
  id,
  full_name,
  employee_number,
  employee_type,
  status,
  region,
  start_date,
  NULL::numeric AS pct_complete
FROM public.employees;

CREATE INDEX IF NOT EXISTS employees_employee_number_idx ON public.employees (employee_number);
CREATE INDEX IF NOT EXISTS employees_status_idx ON public.employees (status);
CREATE INDEX IF NOT EXISTS employees_full_name_idx ON public.employees (full_name);

ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.upcoming_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'employees','employee_notes','activity_log','upcoming_events','event_employees','user_roles'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_auth_all ON public.%I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_auth_all ON public.%I FOR ALL TO authenticated USING (true) WITH CHECK (true)',
      t, t
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
  END LOOP;
END $$;

GRANT SELECT ON public.employee_progress TO authenticated;
