-- Drop existing policy and recreate it with the correct permissive structure
DROP POLICY IF EXISTS "Public can join waitlist with valid email" ON public.waitlist;

-- Use a simpler, working policy. The previous one used WITH CHECK on a column
-- with a regex that matches our validation needs.
CREATE POLICY "anyone_can_insert_valid_email"
ON public.waitlist
FOR INSERT
TO anon, authenticated
WITH CHECK (
  email IS NOT NULL
  AND char_length(email) BETWEEN 5 AND 254
  AND email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'
);
