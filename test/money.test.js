// Unit tests for billing arithmetic.
// Money is integer cents and integer micro-USD; floats are rejected, never rounded silently.

import test from "node:test";
import assert from "node:assert/strict";

import {
  MICROS_PER_CENT,
  CENTS_PER_USD,
  overageUnits,
  overageMicros,
  microsToCents,
  monthlyChargeCents,
  formatUsd,
  estimateTokens,
} from "../src/lib/money.js";

const starter = {
  priceMonthlyCents: 2900,
  includedUnits: 1_000_000,
  overageMicrosPerUnit: 2,
};

const pro = {
  priceMonthlyCents: 9900,
  includedUnits: 6_000_000,
  overageMicrosPerUnit: 2,
};

const business = {
  priceMonthlyCents: 34_900,
  includedUnits: 30_000_000,
  overageMicrosPerUnit: 1,
};

const free = {
  priceMonthlyCents: 0,
  includedUnits: 50_000,
  overageMicrosPerUnit: 0,
};

test("unit constants are internally consistent", () => {
  assert.equal(MICROS_PER_CENT, 10_000);
  assert.equal(CENTS_PER_USD, 100);
  // One dollar is one million micro-USD.
  assert.equal(MICROS_PER_CENT * CENTS_PER_USD, 1_000_000);
});

test("overageUnits never goes negative", () => {
  assert.equal(overageUnits(1_500, 1_000), 500);
  assert.equal(overageUnits(1_000, 1_000), 0);
  assert.equal(overageUnits(10, 1_000), 0);
  assert.equal(overageUnits(0, 0), 0);
  assert.equal(overageUnits(5_000_000, 1_000_000), 4_000_000);
});

test("overageMicros multiplies billable units by the unit price", () => {
  assert.equal(overageMicros(1_500, 1_000, 1_000), 500_000);
  assert.equal(overageMicros(2_000_000, 1_000_000, 2), 2_000_000);
  assert.equal(overageMicros(10, 1_000, 500), 0);
  // A plan with no overage price bills nothing beyond its allowance.
  assert.equal(overageMicros(9_999_999, 1_000, 0), 0);
});

test("microsToCents rounds half up at a single point", () => {
  assert.equal(microsToCents(0), 0);
  assert.equal(microsToCents(4_999), 0);
  assert.equal(microsToCents(5_000), 1);
  assert.equal(microsToCents(9_999), 1);
  assert.equal(microsToCents(10_000), 1);
  assert.equal(microsToCents(15_000), 2);
  assert.equal(microsToCents(500_000), 50);
  assert.equal(microsToCents(30_000_000), 3_000);
  assert.equal(microsToCents(1_000_000), 100);
});

test("worked example: starter plan, 2M tokens costs $31.00", () => {
  // $29.00 base + 1,000,000 overage tokens at 2 micro-USD = 2,000,000 micros = $2.00
  assert.equal(monthlyChargeCents(starter, 2_000_000), 3_100);
  assert.equal(formatUsd(monthlyChargeCents(starter, 2_000_000)), "$31.00");
});

test("a plan at or under its allowance charges exactly the base price", () => {
  assert.equal(monthlyChargeCents(starter, 0), 2_900);
  assert.equal(monthlyChargeCents(starter, 1), 2_900);
  assert.equal(monthlyChargeCents(starter, 1_000_000), 2_900);
  assert.equal(formatUsd(monthlyChargeCents(pro, 6_000_000)), "$99.00");
});

test("worked example: business plan, 60M tokens costs $379.00", () => {
  // $349.00 base + 30,000,000 overage tokens at 1 micro-USD = 30,000,000 micros = $30.00
  assert.equal(monthlyChargeCents(business, 60_000_000), 37_900);
  assert.equal(formatUsd(monthlyChargeCents(business, 60_000_000)), "$379.00");
});

test("a free plan never produces a charge, however much is used", () => {
  assert.equal(monthlyChargeCents(free, 0), 0);
  assert.equal(monthlyChargeCents(free, 50_000), 0);
  assert.equal(monthlyChargeCents(free, 50_001), 0);
  assert.equal(monthlyChargeCents(free, 500_000_000), 0);
});

test("the charge is monotonic in usage", () => {
  let previous = -1;
  for (const units of [0, 500_000, 1_000_000, 1_000_001, 2_000_000, 10_000_000, 99_000_000]) {
    const charge = monthlyChargeCents(starter, units);
    assert.ok(charge >= previous, `charge decreased at ${units}`);
    previous = charge;
  }
});

test("formatUsd always shows two decimal places", () => {
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatUsd(1), "$0.01");
  assert.equal(formatUsd(5), "$0.05");
  assert.equal(formatUsd(50), "$0.50");
  assert.equal(formatUsd(100), "$1.00");
  assert.equal(formatUsd(2_900), "$29.00");
  assert.equal(formatUsd(123_456), "$1234.56");
});

test("estimateTokens is a pre-flight guess, never a billing figure", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("a"), 1);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
  assert.equal(estimateTokens("a".repeat(4_000)), 1_000);
  assert.ok(estimateTokens("a".repeat(4_000_001)) > 1_000_000);
  // Missing text is empty text. This figure is a pre-flight guess and must never be the
  // reason a request fails.
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(undefined), 0);
});

test("non-integer input is rejected rather than silently truncated", () => {
  assert.throws(() => overageUnits(1.5, 10), TypeError);
  assert.throws(() => overageUnits(10, 1.5), TypeError);
  assert.throws(() => overageMicros(1.5, 10, 100), TypeError);
  assert.throws(() => microsToCents(1.5), TypeError);
  assert.throws(() => monthlyChargeCents(starter, 1_000.5), TypeError);
  assert.throws(() => formatUsd(29.5), TypeError);
});

test("negative input is rejected", () => {
  assert.throws(() => overageUnits(-1, 10), TypeError);
  assert.throws(() => overageUnits(10, -1), TypeError);
  assert.throws(() => microsToCents(-1), TypeError);
  assert.throws(() => formatUsd(-1), TypeError);
  assert.throws(
    () => monthlyChargeCents({ ...starter, priceMonthlyCents: -100 }, 0),
    TypeError,
  );
});

test("a plan missing its price fields is rejected", () => {
  assert.throws(() => monthlyChargeCents({ includedUnits: 10, overageMicrosPerUnit: 1 }, 0), TypeError);
  assert.throws(() => monthlyChargeCents({ priceMonthlyCents: 100 }, 0), TypeError);
});
