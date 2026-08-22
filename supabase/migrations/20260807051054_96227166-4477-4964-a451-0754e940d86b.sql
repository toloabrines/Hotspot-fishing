-- Actualiza has_module_access para tener en cuenta tanto suscripciones de pago
-- como invitaciones, cortesías y el trial automático de 7 días.
create or replace function public.has_module_access(
  user_uuid uuid,
  module_price_id text,
  check_env text default 'live'
)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.subscriptions
    where user_id = user_uuid
      and price_id = module_price_id
      and environment = check_env
      and (
        (status in ('active', 'trialing', 'past_due') and (current_period_end is null or current_period_end > now()))
        or (status = 'canceled' and current_period_end > now())
      )
  )
  or exists (
    select 1 from public.invite_grants
    where user_id = user_uuid
      and modules @> array[module_price_id]
      and expires_at > now()
  );
$$;

-- Índice útil para consultar rápidamente las invitaciones/trials activas de un usuario.
create index if not exists invite_grants_user_expires_idx
  on public.invite_grants (user_id, expires_at desc);

