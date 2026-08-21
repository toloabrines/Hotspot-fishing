CREATE TABLE public.ai_credits (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  balance integer NOT NULL DEFAULT 0,
  purchased_total integer NOT NULL DEFAULT 0,
  used_total integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.ai_credits TO authenticated;
GRANT ALL ON public.ai_credits TO service_role;

ALTER TABLE public.ai_credits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own AI credits"
  ON public.ai_credits FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Admins can view all AI credits"
  ON public.ai_credits FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER update_ai_credits_updated_at
  BEFORE UPDATE ON public.ai_credits
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.ai_credit_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_session_id text NOT NULL UNIQUE,
  price_id text NOT NULL,
  credits integer NOT NULL,
  amount_total integer,
  currency text,
  environment text NOT NULL DEFAULT 'sandbox',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ai_credit_purchases_user ON public.ai_credit_purchases(user_id);

GRANT SELECT ON public.ai_credit_purchases TO authenticated;
GRANT ALL ON public.ai_credit_purchases TO service_role;

ALTER TABLE public.ai_credit_purchases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own AI credit purchases"
  ON public.ai_credit_purchases FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Admins can view all AI credit purchases"
  ON public.ai_credit_purchases FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE OR REPLACE FUNCTION public.consume_ai_credit(_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  remaining integer;
BEGIN
  UPDATE public.ai_credits
     SET balance = balance - 1,
         used_total = used_total + 1
   WHERE user_id = _user_id AND balance > 0
  RETURNING balance INTO remaining;
  RETURN remaining;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_ai_credit(uuid) FROM public;
REVOKE ALL ON FUNCTION public.consume_ai_credit(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.consume_ai_credit(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.consume_ai_credit(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.grant_ai_credits(
  _user_id uuid,
  _session_id text,
  _price_id text,
  _credits integer,
  _amount_total integer,
  _currency text,
  _environment text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inserted integer;
BEGIN
  INSERT INTO public.ai_credit_purchases (user_id, stripe_session_id, price_id, credits, amount_total, currency, environment)
  VALUES (_user_id, _session_id, _price_id, _credits, _amount_total, _currency, _environment)
  ON CONFLICT (stripe_session_id) DO NOTHING;

  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted = 0 THEN
    RETURN false;
  END IF;

  INSERT INTO public.ai_credits (user_id, balance, purchased_total)
  VALUES (_user_id, _credits, _credits)
  ON CONFLICT (user_id) DO UPDATE
    SET balance = public.ai_credits.balance + EXCLUDED.balance,
        purchased_total = public.ai_credits.purchased_total + EXCLUDED.purchased_total,
        updated_at = now();

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.grant_ai_credits(uuid, text, text, integer, integer, text, text) FROM public;
REVOKE ALL ON FUNCTION public.grant_ai_credits(uuid, text, text, integer, integer, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.grant_ai_credits(uuid, text, text, integer, integer, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.grant_ai_credits(uuid, text, text, integer, integer, text, text) TO service_role;
