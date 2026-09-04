-- Wipe all Hub hires so Onboarding, Roster, Archive, and My work start empty.
-- Process, hiring strategy, Atlas people, and Hub access are not touched.
-- Run in Hub Supabase → SQL Editor → Run

BEGIN;

DELETE FROM public.event_employees;
DELETE FROM public.employee_notes;
DELETE FROM public.activity_log;
DELETE FROM public.employees;

UPDATE public.hub_data
SET
  value = CASE
    WHEN jsonb_typeof(value) = 'object'
      THEN jsonb_set(value, '{progress}', '{}'::jsonb, true)
    ELSE value
  END,
  updated_at = now()
WHERE key = 'new_hire_checklist';

COMMIT;

NOTIFY pgrst, 'reload schema';
