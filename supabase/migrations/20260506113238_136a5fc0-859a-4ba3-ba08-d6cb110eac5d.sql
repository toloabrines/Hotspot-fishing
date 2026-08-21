-- Bucket público para cachear tiles de Copernicus / ArcGIS
-- Los tiles son datos públicos del mar; los cacheamos para no rebombardear los servidores upstream.
INSERT INTO storage.buckets (id, name, public)
VALUES ('tile-cache', 'tile-cache', true)
ON CONFLICT (id) DO NOTHING;

-- Lectura pública (cualquiera puede pedir tiles cacheados)
CREATE POLICY "tile_cache_public_read"
ON storage.objects FOR SELECT
USING (bucket_id = 'tile-cache');

-- Escritura sólo por el service_role (el server route usa supabaseAdmin)
-- No creamos política para anon/authenticated → bloqueado por defecto.

