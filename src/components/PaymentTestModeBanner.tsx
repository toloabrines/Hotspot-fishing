const clientToken = import.meta.env.VITE_PAYMENTS_CLIENT_TOKEN as string | undefined;

export function PaymentTestModeBanner() {
  if (!clientToken) {
    return (
      <div className="w-full border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-center text-[11px] text-destructive">
        Los pagos reales aún no están activados. Completa la activación de Stripe para cobrar de
        verdad.
      </div>
    );
  }
  if (clientToken.startsWith("pk_test_")) {
    return (
      <div className="w-full border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-center text-[11px] text-amber-600">
        Modo de prueba: los pagos realizados aquí no son reales (tarjeta 4242 4242 4242 4242).
      </div>
    );
  }
  return null;
}

