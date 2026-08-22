-- Restringir lectura: permitir GET de un objeto concreto pero no listing del bucket.
-- storage.foldername(name) devuelve los segmentos; exigir al menos un nombre evita listing raíz.
DROP POLICY IF EXISTS "tile_cache_public_read" ON storage.objects;

CREATE POLICY "tile_cache_public_read_objects"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'tile-cache'
  AND name IS NOT NULL
  AND length(name) > 0
);

