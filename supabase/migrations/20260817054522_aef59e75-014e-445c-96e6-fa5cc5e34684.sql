DELETE FROM public.user_roles WHERE user_id = '5294e6a3-a990-4a9e-9685-ef7933f0bb4e';
INSERT INTO public.ai_advisor_usage (user_id, day, request_count)
VALUES ('5294e6a3-a990-4a9e-9685-ef7933f0bb4e', (now() AT TIME ZONE 'utc')::date, 10)
ON CONFLICT (user_id, day) DO UPDATE SET request_count = 10;
