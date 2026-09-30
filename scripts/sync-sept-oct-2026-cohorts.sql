-- Sync Sept / Oct 2026 orientation cohorts from New Hire Checklist spreadsheet
-- Source: New hire checklist - Updated File Sept. 2025 (7).xlsx
--   02-Orient. Cohorts rows for 09/15/2026 and 10/27/2026
-- Run in Supabase → SQL Editor → Run
-- Additive: inserts missing hires, updates orientation/bootcamp/PM/region when matched.
-- Does NOT invent bootcamp dates — uses spreadsheet values only (TBD stays null).
-- Amadou John (offer rescinded) is archived, not activated.

BEGIN;

CREATE TEMP TABLE cohort_sync (
  full_name TEXT NOT NULL,
  preferred_name TEXT,
  region TEXT,
  city_center TEXT,
  assigned_pm TEXT,
  start_date DATE,
  bootcamp_start_date DATE,
  status TEXT NOT NULL DEFAULT 'active',
  status_note TEXT,
  onboarding_status TEXT DEFAULT 'in_progress'
) ON COMMIT DROP;

INSERT INTO cohort_sync (
  full_name, preferred_name, region, city_center, assigned_pm,
  start_date, bootcamp_start_date, status, status_note, onboarding_status
) VALUES
  -- 09/15/2026 orientation
  ('Nathan Cline', NULL, 'TAB NE Tech-Boston', 'Tiverton, RI', 'Thomas Edmonds',
    DATE '2026-09-15', DATE '2026-10-19', 'active', 'September 2026 cohort', 'in_progress'),
  ('Jason Chinchilla', NULL, 'TAB NE Tech-Boston', 'Lynn, MA', 'Thomas Edmonds',
    DATE '2026-09-15', DATE '2026-10-19', 'active', 'September 2026 cohort', 'in_progress'),
  ('Mitchell Peterson', NULL, 'TAB NE Tech-Boston', 'Plymouth, MA', 'Thomas Edmonds',
    DATE '2026-09-15', DATE '2026-10-19', 'active', 'September 2026 cohort', 'in_progress'),
  ('Austin Annunziata', NULL, 'TAB NE Tech-Boston', 'Revere, MA', 'Thomas Edmonds',
    DATE '2026-09-15', DATE '2026-10-19', 'active', 'September 2026 cohort', 'in_progress'),
  ('Manuel Estrada', NULL, 'TAB NE Tech-Portland', 'Cape Elizabeth, ME', 'Thomas Edmonds',
    DATE '2026-09-15', DATE '2026-10-19', 'active', 'September 2026 cohort', 'in_progress'),
  ('Zachary Shealy', NULL, 'TAB Nat''l Tech-Dallas', 'Little Elm, TX', 'Deanna White',
    DATE '2026-09-15', NULL, 'active', 'September 2026 cohort', 'in_progress'),
  ('Mason Gasaway', NULL, 'TAB Nat''l Tech-Nashville', 'Clarksville, TN', 'Deanna White',
    DATE '2026-09-15', NULL, 'active', 'September 2026 cohort', 'in_progress'),
  ('Sebastian Rosado', NULL, 'TAB Nat''l Tech-Orlando', 'Kissimmee, FL', 'Deanna White',
    DATE '2026-09-15', NULL, 'active', 'September 2026 cohort', 'in_progress'),
  -- 10/27/2026 orientation
  ('Rafael Torres', NULL, 'TAB Nat''l Tech-Orlando', NULL, 'Steve Buelterman',
    DATE '2026-10-27', DATE '2026-11-16', 'active', 'October 2026 cohort', 'in_progress'),
  ('Nicholas Robinson', NULL, 'TAB NE-Boston', 'Waltham, MA', 'Thomas Edmonds',
    DATE '2026-10-27', DATE '2026-11-16', 'active', 'October 2026 cohort', 'in_progress'),
  ('Damon Moss', NULL, 'TAB Nat''l Tech-Dallas', 'Terrell, TX', 'Deanna White',
    DATE '2026-10-27', NULL, 'active', 'October 2026 cohort', 'in_progress'),
  ('Kevin Mosley', NULL, 'TAB Nat''l Tech-Dallas', NULL, 'Deanna White',
    DATE '2026-10-27', NULL, 'active', 'October 2026 cohort', 'in_progress'),
  -- Offer rescinded (keep archived)
  ('Amadou John', NULL, 'TAB Nat''l Tech-Atlanta', NULL, 'Steve Buelterman',
    NULL, NULL, 'rescinded', 'Offer rescinded 2026-09-14 (spreadsheet)', 'not_started');

CREATE OR REPLACE FUNCTION pg_temp.norm_name(t TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT trim(regexp_replace(
    regexp_replace(
      regexp_replace(lower(coalesce(t, '')), '\(goes\s+by[^)]*\)', ' ', 'gi'),
      '\([^)]*\)', ' ', 'g'
    ),
    '\s+', ' ', 'g'
  ));
$$;

-- Insert missing people
INSERT INTO public.employees (
  full_name,
  preferred_name,
  region,
  city_center,
  assigned_pm,
  employee_type,
  start_date,
  bootcamp_start_date,
  status,
  status_note,
  onboarding_status
)
SELECT
  c.full_name,
  NULLIF(c.preferred_name, ''),
  c.region,
  NULLIF(c.city_center, ''),
  NULLIF(c.assigned_pm, ''),
  'technician',
  c.start_date,
  c.bootcamp_start_date,
  c.status,
  c.status_note,
  c.onboarding_status
FROM cohort_sync c
WHERE NOT EXISTS (
  SELECT 1
  FROM public.employees e
  WHERE pg_temp.norm_name(e.full_name) = pg_temp.norm_name(c.full_name)
     OR pg_temp.norm_name(e.full_name) LIKE '%' || pg_temp.norm_name(c.full_name) || '%'
     OR pg_temp.norm_name(c.full_name) LIKE '%' || pg_temp.norm_name(e.full_name) || '%'
);

-- Update matched active cohort rows (do not invent bootcamp: only set when spreadsheet has a date)
UPDATE public.employees e
SET
  region = COALESCE(NULLIF(c.region, ''), e.region),
  city_center = COALESCE(NULLIF(c.city_center, ''), e.city_center),
  assigned_pm = COALESCE(NULLIF(c.assigned_pm, ''), e.assigned_pm),
  start_date = COALESCE(c.start_date, e.start_date),
  bootcamp_start_date = CASE
    WHEN c.bootcamp_start_date IS NOT NULL THEN c.bootcamp_start_date
    ELSE e.bootcamp_start_date
  END,
  status = CASE WHEN c.status = 'rescinded' THEN 'rescinded' ELSE 'active' END,
  status_note = COALESCE(c.status_note, e.status_note),
  onboarding_status = COALESCE(e.onboarding_status, c.onboarding_status),
  updated_at = now()
FROM cohort_sync c
WHERE pg_temp.norm_name(e.full_name) = pg_temp.norm_name(c.full_name)
   OR pg_temp.norm_name(e.full_name) LIKE '%' || pg_temp.norm_name(c.full_name) || '%'
   OR pg_temp.norm_name(c.full_name) LIKE '%' || pg_temp.norm_name(e.full_name) || '%';

COMMIT;
