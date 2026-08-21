-- 1) Base de conocimiento de pesca ampliable sin reconstruir la app
CREATE TABLE public.ai_knowledge_docs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  category text NOT NULL DEFAULT 'general',
  species text[] NOT NULL DEFAULT '{}',
  modes text[] NOT NULL DEFAULT '{}',
  tags text[] NOT NULL DEFAULT '{}',
  content text NOT NULL,
  source text,
  reviewed_on date,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.ai_knowledge_docs TO authenticated;
GRANT ALL ON public.ai_knowledge_docs TO service_role;
ALTER TABLE public.ai_knowledge_docs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read active knowledge docs"
  ON public.ai_knowledge_docs FOR SELECT TO authenticated
  USING (is_active = true);

CREATE POLICY "Admins can read all knowledge docs"
  ON public.ai_knowledge_docs FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER update_ai_knowledge_docs_updated_at
  BEFORE UPDATE ON public.ai_knowledge_docs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX ai_knowledge_docs_active_idx ON public.ai_knowledge_docs (is_active);

-- 2) Memoria de resultados reales: datos estructurados de cada jornada
ALTER TABLE public.catch_reports
  ADD COLUMN IF NOT EXISTS species text,
  ADD COLUMN IF NOT EXISTS quantity integer,
  ADD COLUMN IF NOT EXISTS depth_m double precision,
  ADD COLUMN IF NOT EXISTS technique text,
  ADD COLUMN IF NOT EXISTS bait text,
  ADD COLUMN IF NOT EXISTS quality text,
  ADD COLUMN IF NOT EXISTS env_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS validated boolean NOT NULL DEFAULT false;

ALTER TABLE public.catch_reports
  ADD CONSTRAINT catch_reports_quality_chk
  CHECK (quality IS NULL OR quality IN ('bueno','regular','malo'));

ALTER TABLE public.catch_reports
  ADD CONSTRAINT catch_reports_quantity_chk
  CHECK (quantity IS NULL OR (quantity >= 0 AND quantity <= 10000));

CREATE INDEX IF NOT EXISTS catch_reports_user_mode_idx
  ON public.catch_reports (user_id, mode, fished_at DESC);
