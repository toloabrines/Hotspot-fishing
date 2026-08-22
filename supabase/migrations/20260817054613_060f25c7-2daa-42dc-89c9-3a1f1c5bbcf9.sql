INSERT INTO public.user_roles (user_id, role)
SELECT id, 'admin'::public.app_role FROM auth.users
WHERE lower(email) IN ('tolototy@gmail.com', 'totymar@totymar.com')
ON CONFLICT (user_id, role) DO NOTHING;
DELETE FROM public.ai_advisor_usage
WHERE user_id = '5294e6a3-a990-4a9e-9685-ef7933f0bb4e'
  AND day = (now() AT TIME ZONE 'utc')::date;
