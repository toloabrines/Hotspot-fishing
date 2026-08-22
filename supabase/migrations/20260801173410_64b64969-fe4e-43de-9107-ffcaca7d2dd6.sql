CREATE TABLE public.invite_codes (
  code text PRIMARY KEY,
  modules text[] NOT NULL DEFAULT ARRAY['superficie','fondo','calamar']::text[],
  days integer NOT NULL DEFAULT 30,
  max_uses integer NOT NULL DEFAULT 1,
  uses integer NOT NULL DEFAULT 0,
  expires_at timestamp with time zone,
  note text,
  created_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT ALL ON public.invite_codes TO service_role;
ALTER TABLE public.invite_codes ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.invite_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code text NOT NULL,
  modules text[] NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (user_id, code)
);

GRANT SELECT ON public.invite_grants TO authenticated;
GRANT ALL ON public.invite_grants TO service_role;
ALTER TABLE public.invite_grants ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own invite grants"
ON public.invite_grants FOR SELECT TO authenticated
USING (auth.uid() = user_id);

CREATE INDEX invite_grants_user_idx ON public.invite_grants (user_id);
