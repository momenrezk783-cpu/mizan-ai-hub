// Unit tests for API key issuing, parsing and verification.
// Pure functions only: no network, no D1, no Workers runtime.

import test from "node:test";
import assert from "node:assert/strict";

import {
  KEY_PATTERN,
  issueKey,
  parseKey,
  hashSecret,
  verifyKey,
  maskKey,
  sha256Hex,
  timingSafeEqual,
} from "../src/lib/keys.js";

const PEPPER = "test-pepper";

test("a key has the documented shape", async () => {
  const key = await issueKey({ mode: "live", pepper: PEPPER });

  assert.equal(key.plaintext, `mzk_live_${key.prefix}_${key.secret}`);
  // mzk_ (4) + live (4) + _ (1) + prefix (12) + _ (1) + secret (32)
  assert.equal(key.plaintext.length, 54);
  assert.match(key.plaintext, KEY_PATTERN);
  assert.equal(key.prefix.length, 12);
  assert.equal(key.secret.length, 32);
  assert.equal(key.mode, "live");
});

test("test-mode keys are distinguishable from live keys", async () => {
  const key = await issueKey({ mode: "test", pepper: PEPPER });

  assert.ok(key.plaintext.startsWith("mzk_test_"));
  assert.equal(parseKey(key.plaintext).mode, "test");
});

test("issueKey rejects an unknown mode", async () => {
  await assert.rejects(() => issueKey({ mode: "prod", pepper: PEPPER }), TypeError);
});

test("issueKey refuses to issue an unverifiable key without a pepper", async () => {
  await assert.rejects(() => issueKey({ mode: "live", pepper: "" }), TypeError);
  await assert.rejects(() => issueKey({ mode: "live" }), TypeError);
});

test("secrets avoid characters that are easy to misread", async () => {
  for (let i = 0; i < 40; i += 1) {
    const { secret, prefix } = await issueKey({ mode: "live", pepper: PEPPER });
    // Crockford-style alphabet: no i, l, o or u.
    assert.doesNotMatch(secret, /[ilou]/);
    assert.doesNotMatch(prefix, /[ilou]/);
  }
});

test("issued keys are unique", async () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const key = await issueKey({ mode: "live", pepper: PEPPER });
    assert.ok(!seen.has(key.plaintext), "duplicate key issued");
    seen.add(key.plaintext);
  }
  assert.equal(seen.size, 200);
});

test("parseKey round-trips a freshly issued key", async () => {
  const key = await issueKey({ mode: "live", pepper: PEPPER });

  assert.deepEqual(parseKey(key.plaintext), {
    mode: "live",
    prefix: key.prefix,
    secret: key.secret,
  });
});

test("parseKey tolerates surrounding whitespace from copy-paste", async () => {
  const key = await issueKey({ mode: "live", pepper: PEPPER });

  assert.deepEqual(parseKey(`  ${key.plaintext}\n`), {
    mode: "live",
    prefix: key.prefix,
    secret: key.secret,
  });
});

test("parseKey returns null for anything malformed, and never throws", async () => {
  const valid = await issueKey({ mode: "live", pepper: PEPPER });
  const secret = "b".repeat(32);

  const malformed = [
    undefined,
    null,
    0,
    42,
    {},
    [],
    "",
    "   ",
    "abc",
    "mzk_live",
    "mzk_live_",
    // unknown environment segment
    `mzk_prod_${valid.prefix}_${secret}`,
    // prefix one character short / long
    `mzk_live_${valid.prefix.slice(0, 11)}_${secret}`,
    `mzk_live_${valid.prefix}0_${secret}`,
    // secret one character short / long
    `mzk_live_${valid.prefix}_${secret.slice(0, 31)}`,
    `mzk_live_${valid.prefix}_${secret}0`,
    // wrong separator
    `mzk-live-${valid.prefix}-${secret}`,
    // uppercase is not part of the alphabet
    `mzk_live_${valid.prefix.toUpperCase()}_${secret}`,
  ];

  for (const candidate of malformed) {
    assert.equal(parseKey(candidate), null, `expected null for ${String(candidate)}`);
  }
});

test("hashing is deterministic, pepper-dependent and hex encoded", async () => {
  const secret = "c".repeat(32);

  const first = await hashSecret(PEPPER, secret);
  const second = await hashSecret(PEPPER, secret);
  const otherPepper = await hashSecret("different-pepper", secret);

  assert.equal(first, second);
  assert.notEqual(first, otherPepper);
  assert.match(first, /^[0-9a-f]{64}$/);
});

test("verification accepts the correct secret", async () => {
  const key = await issueKey({ mode: "live", pepper: PEPPER });

  assert.equal(
    await verifyKey({ pepper: PEPPER, storedHash: key.secretHash, secret: key.secret }),
    true,
  );
});

test("verification rejects a wrong secret", async () => {
  const key = await issueKey({ mode: "live", pepper: PEPPER });

  assert.equal(
    await verifyKey({ pepper: PEPPER, storedHash: key.secretHash, secret: "d".repeat(32) }),
    false,
  );
});

test("verification rejects the right secret under the wrong pepper", async () => {
  const key = await issueKey({ mode: "live", pepper: PEPPER });

  assert.equal(
    await verifyKey({ pepper: "wrong-pepper", storedHash: key.secretHash, secret: key.secret }),
    false,
  );
});

test("verification fails closed on missing inputs", async () => {
  const key = await issueKey({ mode: "live", pepper: PEPPER });

  assert.equal(await verifyKey({ pepper: PEPPER, storedHash: key.secretHash, secret: "" }), false);
  assert.equal(await verifyKey({ pepper: PEPPER, storedHash: "", secret: key.secret }), false);
});

test("sha256Hex matches the known digest of the empty string", async () => {
  assert.equal(
    await sha256Hex(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

test("timingSafeEqual compares by value, including differing lengths", () => {
  assert.equal(timingSafeEqual("abc", "abc"), true);
  assert.equal(timingSafeEqual("abc", "abd"), false);
  assert.equal(timingSafeEqual("abc", "abcd"), false);
  assert.equal(timingSafeEqual("abcd", "abc"), false);
  assert.equal(timingSafeEqual("", ""), true);
  assert.equal(timingSafeEqual("a", ""), false);
});

test("maskKey shows the prefix but never the secret", async () => {
  const key = await issueKey({ mode: "live", pepper: PEPPER });
  const masked = maskKey("live", key.prefix);

  assert.equal(masked, `mzk_live_${key.prefix}_••••`);
  assert.ok(!masked.includes(key.secret));
  assert.ok(masked.length < key.plaintext.length);
});
