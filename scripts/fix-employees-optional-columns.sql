-- Fix missing optional employee profile columns (fixes "schema cache" create-hire errors)
-- Run in Supabase → SQL Editor → Run, then optionally:
--   NOTIFY pgrst, 'reload schema';

ALTER TABLE public.employees ADD COLUMN IF NOT EXISTS preferred_name TEXT;
ALTER TABLE public.employees ADD COLUMN IF NOT EXISTS city_center TEXT;
ALTER TABLE public.employees ADD COLUMN IF NOT EXISTS work_start_date DATE;

-- Refresh PostgREST schema cache
NOTIFY pgrst, 'reload schema';
