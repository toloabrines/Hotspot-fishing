CREATE TABLE public.fsle_exports (
  token text PRIMARY KEY,
  filename text NOT NULL,
  content text NOT NULL,
  line_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, DELETE ON public.fsle_exports TO anon;
GRANT SELECT, INSERT, DELETE ON public.fsle_exports TO authenticated;
GRANT ALL ON public.fsle_exports TO service_role;

ALTER TABLE public.fsle_exports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can create fsle exports"
ON public.fsle_exports
FOR INSERT
TO anon, authenticated
WITH CHECK (
  length(token) >= 24
  AND length(filename) <= 120
  AND octet_length(content) <= 52428800
);

CREATE POLICY "Anyone with token can read fsle exports"
ON public.fsle_exports
FOR SELECT
TO anon, authenticated
USING (true);

CREATE POLICY "Anyone can delete old fsle exports"
ON public.fsle_exports
FOR DELETE
TO anon, authenticated
USING (created_at < now() - interval '1 day');

CREATE INDEX fsle_exports_created_at_idx ON public.fsle_exports (created_at);
