-- Onboarding Status on each hire (separate from employment status)
-- Run in Hub Supabase → SQL Editor → Run

ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS onboarding_status TEXT NOT NULL DEFAULT 'not_started';

UPDATE public.employees
SET onboarding_status = 'not_started'
WHERE onboarding_status IS NULL
   OR onboarding_status NOT IN ('not_started', 'in_progress', 'complete');

ALTER TABLE public.employees
  DROP CONSTRAINT IF EXISTS employees_onboarding_status_check;

ALTER TABLE public.employees
  ADD CONSTRAINT employees_onboarding_status_check
  CHECK (onboarding_status IN ('not_started', 'in_progress', 'complete'));

CREATE INDEX IF NOT EXISTS employees_onboarding_status_idx
  ON public.employees (onboarding_status);

COMMENT ON COLUMN public.employees.onboarding_status IS
  'Overarching onboarding progress: not_started, in_progress, complete. Employment status stays on employees.status.';

NOTIFY pgrst, 'reload schema';
