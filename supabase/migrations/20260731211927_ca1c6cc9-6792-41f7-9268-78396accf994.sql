CREATE TYPE public.fishing_mode AS ENUM ('bottom', 'squid', 'surface');
CREATE TYPE public.catch_outcome AS ENUM ('good', 'bad');

CREATE TABLE public.catch_reports (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  fished_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  mode public.fishing_mode NOT NULL,
  outcome public.catch_outcome NOT NULL,
  score_snapshot DOUBLE PRECISION,
  factors_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  note TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.catch_reports TO authenticated;
GRANT ALL ON public.catch_reports TO service_role;

ALTER TABLE public.catch_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own catch reports" ON public.catch_reports
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert their own catch reports" ON public.catch_reports
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update their own catch reports" ON public.catch_reports
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete their own catch reports" ON public.catch_reports
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE INDEX catch_reports_user_mode_idx ON public.catch_reports (user_id, mode, created_at DESC);

CREATE TRIGGER update_catch_reports_updated_at
  BEFORE UPDATE ON public.catch_reports
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.user_weights (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  mode public.fishing_mode NOT NULL,
  weights JSONB NOT NULL DEFAULT '{}'::jsonb,
  n_samples INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (user_id, mode)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_weights TO authenticated;
GRANT ALL ON public.user_weights TO service_role;

ALTER TABLE public.user_weights ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own weights" ON public.user_weights
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert their own weights" ON public.user_weights
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update their own weights" ON public.user_weights
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete their own weights" ON public.user_weights
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE TRIGGER update_user_weights_updated_at
  BEFORE UPDATE ON public.user_weights
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
