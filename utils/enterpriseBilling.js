export const ENTERPRISE_INCLUDED_SEATS = 25;
export const ENTERPRISE_BASE_CENTS = 350000;
export const ENTERPRISE_SEAT_CENTS = 11500;

export function seatQuantity(value) {
  const number = Number(value);
  if (value === '' || value == null || !Number.isSafeInteger(number) || number < 25 || number > 10000) {
    throw Object.assign(new Error('Enter a whole number of users between 25 and 10,000.'), { status: 400 });
  }
  return number;
}

export function enterpriseMonthlyCents(total) {
  return ENTERPRISE_BASE_CENTS + (seatQuantity(total) - 25) * ENTERPRISE_SEAT_CENTS;
}

// Find the recognized base item regardless of Stripe item order. Add-ons never determine the plan.
export function subscriptionPlanItem(subscription, plans) {
  return subscription?.items?.data?.find(item => Object.values(plans).some(plan => plan.priceId && item.price?.id === plan.priceId)) || null;
}

export function additionalSeatQuantity(subscription, seatPriceId) {
  const items = (subscription?.items?.data || []).filter(item => seatPriceId && item.price?.id === seatPriceId);
  if (items.length > 1) throw new Error('Duplicate Enterprise seat items require billing support.');
  const quantity = items[0]?.quantity ?? 0;
  if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 9975) throw new Error('Invalid Enterprise seat quantity.');
  return quantity;
}

export function validateMonthlyPrice(price, expectedCents) {
  if (!price?.active || price.currency !== 'usd' || price.unit_amount !== expectedCents ||
      price.billing_scheme !== 'per_unit' || price.recurring?.interval !== 'month' ||
      price.recurring?.interval_count !== 1 || price.recurring?.usage_type !== 'licensed') {
    throw Object.assign(new Error('Enterprise billing price is not configured correctly. Contact Atlas support.'), { status: 503 });
  }
}
