import type Stripe from "stripe";

/**
 * Ensures the price identified by `lookupKey` charges VAT-inclusive amounts
 * (the displayed 5 € already contains tax). `tax_behavior` is immutable in
 * Stripe, so when it differs we recreate the price with the same lookup key
 * (Stripe transfers the key automatically) and archive the old one.
 */
export async function ensureInclusivePrice(
  stripe: Stripe,
  lookupKey: string,
): Promise<Stripe.Price> {
  const prices = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 });
  if (!prices.data.length) throw new Error("Price not found");
  const price = prices.data[0];

  if (price.tax_behavior === "inclusive") return price;

  const productId =
    typeof price.product === "string" ? price.product : price.product.id;
  const product = await stripe.products.retrieve(productId);

  const created = await stripe.prices.create({
    product: productId,
    currency: price.currency,
    unit_amount: price.unit_amount ?? undefined,
    ...(price.recurring && {
      recurring: { interval: price.recurring.interval, interval_count: price.recurring.interval_count },
    }),
    tax_behavior: "inclusive",
    nickname: product.name,
    lookup_key: lookupKey,
    transfer_lookup_key: true,
    metadata: { ...price.metadata },
  });

  try {
    await stripe.prices.update(price.id, { active: false });
  } catch {
    // Non-fatal: the lookup key already points to the new price.
  }

  return created;
}

