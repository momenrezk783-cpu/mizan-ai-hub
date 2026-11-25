// Money arithmetic. Integer cents and integer micro-USD only. No floats cross a boundary.
//
//   1 USD   = 1_000_000 micro-USD
//   1 cent  = 10_000 micro-USD
//
// Overage is priced per unit in micro-USD because a single tool call or a single token costs
// a fraction of a cent. Rounding to cents happens once, at the end, and rounds half up.

export const MICROS_PER_CENT = 10_000;
export const CENTS_PER_USD = 100;

function assertNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
}

/** Units consumed beyond the plan allowance. Never negative. */
export function overageUnits(units, includedUnits) {
  assertNonNegativeInteger(units, "units");
  assertNonNegativeInteger(includedUnits, "includedUnits");
  return Math.max(0, units - includedUnits);
}

/** Overage charge in micro-USD. Exact integer arithmetic. */
export function overageMicros(units, includedUnits, overageMicrosPerUnit) {
  assertNonNegativeInteger(overageMicrosPerUnit, "overageMicrosPerUnit");
  return overageUnits(units, includedUnits) * overageMicrosPerUnit;
}

/** Converts micro-USD to cents, rounding half up. The single rounding point in the system. */
export function microsToCents(micros) {
  assertNonNegativeInteger(micros, "micros");
  return Math.round(micros / MICROS_PER_CENT);
}

/**
 * The month's charge for one subscription, in cents.
 * plan: { priceMonthlyCents, includedUnits, overageMicrosPerUnit }
 */
export function monthlyChargeCents(plan, units) {
  const base = plan.priceMonthlyCents ?? 0;
  const included = plan.includedUnits ?? 0;
  const rate = plan.overageMicrosPerUnit ?? 0;
  return base + microsToCents(overageMicros(units, included, rate));
}

/** "29.00" style, for display. */
export function formatUsd(cents) {
  assertNonNegativeInteger(cents, "cents");
  const whole = Math.floor(cents / CENTS_PER_USD);
  const fraction = cents % CENTS_PER_USD;
  return `$${whole}.${String(fraction).padStart(2, "0")}`;
}

/**
 * Rough token estimate for pre-flight quota checks only: never used for billing.
 * Billing always uses the provider's reported usage.
 */
export function estimateTokens(text) {
  const length = String(text ?? "").length;
  return Math.ceil(length / 4);
}
