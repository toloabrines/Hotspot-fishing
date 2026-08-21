CREATE TABLE public.ai_advisor_usage (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  day DATE NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
  request_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (user_id, day)
);

GRANT SELECT ON public.ai_advisor_usage TO authenticated;
GRANT ALL ON public.ai_advisor_usage TO service_role;

ALTER TABLE public.ai_advisor_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read their own AI usage"
  ON public.ai_advisor_usage FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
