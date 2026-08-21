-- Drop the permissive policy and replace with one that validates email format
DROP POLICY IF EXISTS "Anyone can join waitlist" ON public.waitlist;

-- Add validation constraints
ALTER TABLE public.waitlist
  ADD CONSTRAINT email_format_check CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'),
  ADD CONSTRAINT email_length_check CHECK (char_length(email) <= 254),
  ADD CONSTRAINT source_length_check CHECK (source IS NULL OR char_length(source) <= 50);

-- Recreate insert policy with explicit validation in WITH CHECK
CREATE POLICY "Public can join waitlist with valid email"
ON public.waitlist
FOR INSERT
TO anon, authenticated
WITH CHECK (
  email IS NOT NULL
  AND char_length(email) BETWEEN 5 AND 254
  AND email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'
);

