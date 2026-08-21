DROP POLICY IF EXISTS "Anyone with token can read fsle exports" ON public.fsle_exports;

REVOKE SELECT ON public.fsle_exports FROM anon;
REVOKE SELECT ON public.fsle_exports FROM authenticated;
