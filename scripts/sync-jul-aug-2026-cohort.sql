-- Sync Jul / Aug 2026 cohort
-- Run in Supabase → SQL Editor → Run
-- 1) Inserts missing cohort hires as Active
-- 2) Reactivates anyone on the keep list
-- 3) Archives everyone else (incl. Angel Leon Pagan)

BEGIN;

CREATE TEMP TABLE cohort_keep (
  full_name TEXT NOT NULL,
  preferred_name TEXT,
  start_date DATE,
  cohort TEXT NOT NULL
) ON COMMIT DROP;

INSERT INTO cohort_keep (full_name, preferred_name, start_date, cohort) VALUES
  ('Hakym Conejo', NULL, NULL, 'July 2026'),
  ('Jackson Price', NULL, NULL, 'July 2026'),
  ('Joshua Kropf', 'Josh', NULL, 'July 2026'),
  ('Ryan Dinger', NULL, NULL, 'July 2026'),
  ('James Bell', NULL, NULL, 'July 2026'),
  ('Clinton Duru', NULL, NULL, 'July 2026'),
  ('Javed Mohammed', NULL, DATE '2026-08-18', 'August 2026'),
  ('David Summiel IV', NULL, DATE '2026-08-18', 'August 2026'),
  ('Ryan Esparza', NULL, DATE '2026-08-18', 'August 2026'),
  ('Bilardo Artiga', NULL, DATE '2026-08-18', 'August 2026'),
  ('Evan Smith', NULL, DATE '2026-08-18', 'August 2026'),
  ('Derrick Jackson', NULL, DATE '2026-08-18', 'August 2026'),
  ('Chase Grahl', NULL, DATE '2026-08-18', 'August 2026');

-- Match helpers: strip "(Goes by …)" / parenthetical nicknames
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

-- Insert missing cohort people
INSERT INTO public.employees (
  full_name,
  preferred_name,
  region,
  employee_type,
  start_date,
  status,
  status_note
)
SELECT
  CASE
    WHEN c.preferred_name IS NOT NULL AND c.preferred_name <> ''
      THEN c.full_name || ' (Goes by ' || c.preferred_name || ')'
    ELSE c.full_name
  END,
  NULLIF(c.preferred_name, ''),
  'National',
  'technician',
  c.start_date,
  'active',
  c.cohort || ' cohort'
FROM cohort_keep c
WHERE NOT EXISTS (
  SELECT 1
  FROM public.employees e
  WHERE
    pg_temp.norm_name(e.full_name) = pg_temp.norm_name(c.full_name)
    OR pg_temp.norm_name(e.full_name) LIKE '%' || pg_temp.norm_name(c.full_name) || '%'
    OR pg_temp.norm_name(c.full_name) LIKE '%' || pg_temp.norm_name(e.full_name) || '%'
    OR (
      c.preferred_name IS NOT NULL
      AND pg_temp.norm_name(e.preferred_name) = pg_temp.norm_name(c.preferred_name)
      AND pg_temp.norm_name(e.full_name) LIKE '%' || split_part(pg_temp.norm_name(c.full_name), ' ', -1) || '%'
    )
    -- Joshua / Josh Kropf
    OR (
      pg_temp.norm_name(c.full_name) = 'joshua kropf'
      AND (
        pg_temp.norm_name(e.full_name) IN ('joshua kropf', 'josh kropf')
        OR pg_temp.norm_name(e.full_name) LIKE '%kropf%'
      )
    )
    -- David Summiel variants
    OR (
      pg_temp.norm_name(c.full_name) LIKE 'david summiel%'
      AND pg_temp.norm_name(e.full_name) LIKE 'david summiel%'
    )
);

-- Reactivate + refresh orientation date for keep list
UPDATE public.employees e
SET
  status = 'active',
  status_note = COALESCE(c.cohort || ' cohort', e.status_note),
  start_date = COALESCE(e.start_date, c.start_date),
  preferred_name = COALESCE(NULLIF(e.preferred_name, ''), NULLIF(c.preferred_name, '')),
  updated_at = NOW()
FROM cohort_keep c
WHERE
  pg_temp.norm_name(e.full_name) = pg_temp.norm_name(c.full_name)
  OR pg_temp.norm_name(e.full_name) LIKE '%' || pg_temp.norm_name(c.full_name) || '%'
  OR (
    pg_temp.norm_name(c.full_name) = 'joshua kropf'
    AND pg_temp.norm_name(e.full_name) LIKE '%kropf%'
  )
  OR (
    pg_temp.norm_name(c.full_name) LIKE 'david summiel%'
    AND pg_temp.norm_name(e.full_name) LIKE 'david summiel%'
  );

-- Archive everyone NOT on the keep list (Angel Leon Pagan included)
UPDATE public.employees e
SET
  status = 'archived',
  status_note = COALESCE(NULLIF(e.status_note, ''), 'Archived — not on Jul/Aug 2026 cohort list'),
  updated_at = NOW()
WHERE e.status = 'active'
  AND NOT EXISTS (
    SELECT 1
    FROM cohort_keep c
    WHERE
      pg_temp.norm_name(e.full_name) = pg_temp.norm_name(c.full_name)
      OR pg_temp.norm_name(e.full_name) LIKE '%' || pg_temp.norm_name(c.full_name) || '%'
      OR pg_temp.norm_name(c.full_name) LIKE '%' || pg_temp.norm_name(e.full_name) || '%'
      OR (
        pg_temp.norm_name(c.full_name) = 'joshua kropf'
        AND pg_temp.norm_name(e.full_name) LIKE '%kropf%'
      )
      OR (
        pg_temp.norm_name(c.full_name) LIKE 'david summiel%'
        AND pg_temp.norm_name(e.full_name) LIKE 'david summiel%'
      )
  );

COMMIT;

-- Verify
SELECT full_name, preferred_name, status, start_date, status_note
FROM public.employees
WHERE status = 'active'
ORDER BY start_date NULLS FIRST, full_name;
