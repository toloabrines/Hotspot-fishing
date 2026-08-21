CREATE TABLE public.sounding_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'AutoBatimetría',
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  point_count integer NOT NULL DEFAULT 0,
  min_depth_m double precision,
  max_depth_m double precision,
  south double precision,
  west double precision,
  north double precision,
  east double precision,
  spacing_m double precision,
  source text NOT NULL DEFAULT 'nmea',
  is_shared boolean NOT NULL DEFAULT false,
  points jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sounding_sessions TO authenticated;
GRANT ALL ON public.sounding_sessions TO service_role;

ALTER TABLE public.sounding_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own sounding sessions"
  ON public.sounding_sessions FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can view shared sounding sessions"
  ON public.sounding_sessions FOR SELECT TO authenticated
  USING (is_shared = true);

CREATE POLICY "Users can insert their own sounding sessions"
  ON public.sounding_sessions FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own sounding sessions"
  ON public.sounding_sessions FOR UPDATE TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own sounding sessions"
  ON public.sounding_sessions FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

CREATE INDEX sounding_sessions_user_idx ON public.sounding_sessions (user_id, started_at DESC);
CREATE INDEX sounding_sessions_shared_idx ON public.sounding_sessions (is_shared) WHERE is_shared = true;

CREATE TRIGGER update_sounding_sessions_updated_at
  BEFORE UPDATE ON public.sounding_sessions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
