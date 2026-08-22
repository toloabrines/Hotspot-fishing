CREATE TABLE public.waypoints (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  depth DOUBLE PRECISION,
  score DOUBLE PRECISION NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT 'Waypoint manual',
  saved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.waypoints TO authenticated;
GRANT ALL ON public.waypoints TO service_role;

ALTER TABLE public.waypoints ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own waypoints"
  ON public.waypoints FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own waypoints"
  ON public.waypoints FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own waypoints"
  ON public.waypoints FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own waypoints"
  ON public.waypoints FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE INDEX waypoints_user_id_idx ON public.waypoints(user_id);

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_waypoints_updated_at
  BEFORE UPDATE ON public.waypoints
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
