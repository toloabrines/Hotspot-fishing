ALTER TABLE public.ai_advisor_usage
  ADD COLUMN IF NOT EXISTS prompt_tokens bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS completion_tokens bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_tokens bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cost_usd numeric(12,6) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.ai_advisor_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL DEFAULT 'chat',
  model text NOT NULL DEFAULT '',
  prompt_tokens bigint NOT NULL DEFAULT 0,
  completion_tokens bigint NOT NULL DEFAULT 0,
  total_tokens bigint NOT NULL DEFAULT 0,
  cost_usd numeric(12,6) NOT NULL DEFAULT 0,
  ok boolean NOT NULL DEFAULT true,
  error text
);

GRANT SELECT ON public.ai_advisor_events TO authenticated;
GRANT ALL ON public.ai_advisor_events TO service_role;
ALTER TABLE public.ai_advisor_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read their own AI events" ON public.ai_advisor_events;
CREATE POLICY "Users can read their own AI events"
  ON public.ai_advisor_events FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Admins can read all AI events" ON public.ai_advisor_events;
CREATE POLICY "Admins can read all AI events"
  ON public.ai_advisor_events FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE INDEX IF NOT EXISTS ai_advisor_events_user_created_idx
  ON public.ai_advisor_events (user_id, created_at DESC);
