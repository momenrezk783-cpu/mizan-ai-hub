// Authentication, tenant scoping and metering tests.
//
// D1 is replaced by a double that answers by SQL shape. This lets the real auth and billing
// code run end to end while asserting the one invariant that matters most:
// **tenant_id comes from the verified key, never from the request.**

import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { issueKey } from "../src/lib/keys.js";

const ORIGIN = "https://ai.mizanconsult.com";
const PEPPER = "test-pepper";
const ADMIN_TOKEN = "test-admin-token";

function fakeDb(rules = []) {
  const answer = (sql) => rules.find((rule) => rule.match.test(sql)) ?? {};
  const resolve = (fn, sql, args, fallback) =>
    typeof fn === "function" ? fn(sql, args) : (fn ?? fallback);

  const statement = (sql) => {
    const self = {
      sql,
      args: [],
      bind(...args) {
        self.args = args;
        return self;
      },
      async first() {
        const rule = answer(sql);
        return resolve(rule.first, sql, self.args, null);
      },
      async all() {
        const rule = answer(sql);
        return { results: resolve(rule.all, sql, self.args, []) };
      },
      async run() {
        const rule = answer(sql);
        return resolve(rule.run, sql, self.args, { meta: { changes: 1 } });
      },
    };
    return self;
  };

  return {
    prepare: statement,
    async batch(statements) {
      return statements.map(() => ({ meta: { changes: 1 } }));
    },
  };
}

function env(overrides = {}) {
  return {
    ENVIRONMENT: "test",
    DEFAULT_AI_MODEL: "@cf/meta/llama-3.1-8b-instruct",
    ALLOWED_ORIGINS: "*",
    API_KEY_PEPPER: PEPPER,
    ADMIN_TOKEN,
    DB: fakeDb(),
    ...overrides,
  };
}

const call = (path, init, envOverrides) =>
  worker.fetch(new Request(`${ORIGIN}${path}`, init), env(envOverrides), {});

const bearer = (token) => ({ headers: { authorization: `Bearer ${token}` } });

/** A live key plus a database double whose key lookup returns a matching row. */
async function fixture({ keyRow = {}, rules = [] } = {}) {
  const key = await issueKey({ mode: "live", pepper: PEPPER });
  const row = {
    id: "key_000000000000000000000001",
    tenant_id: "ten_000000000000000000000001",
    secret_hash: key.secretHash,
    mode: "live",
    revoked_at: null,
    tenant_status: "active",
    tenant_name: "Acme Ltd",
    ...keyRow,
  };
  const db = fakeDb([{ match: /FROM api_keys k/, first: row }, ...rules]);
  return { key, row, db };
}

/* ------------------------------------------------------------------------- verification */

test("a valid key authenticates and the tenant comes from the key", async () => {
  const { key, row } = await fixture();

  const response = await call("/v1/keys", bearer(key.plaintext));

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(Array.isArray(body.keys));
  // The handler scoped the query by the tenant on the key row, not by anything in the request.
  assert.equal(row.tenant_id, "ten_000000000000000000000001");
});

test("key listing masks every key and never leaks a secret", async () => {
  const { key } = await fixture({
    rules: [
      {
        match: /FROM api_keys WHERE tenant_id/,
        all: [
          {
            id: "key_1",
            prefix: "aaaaaaaaaaaa",
            mode: "live",
            label: "Default",
            created_at: "2025-01-01T00:00:00.000Z",
            last_used_at: null,
            revoked_at: null,
          },
        ],
      },
    ],
  });

  const body = await (await call("/v1/keys", bearer(key.plaintext))).json();
  const serialized = JSON.stringify(body);

  assert.equal(body.keys.length, 1);
  assert.equal(body.keys[0].masked, "mzk_live_aaaaaaaaaaaa_••••");
  assert.ok(!serialized.includes(key.secret), "the secret must never appear in a response");
  assert.ok(!serialized.includes("secret_hash"));
});

test("an unknown prefix is rejected as an invalid key", async () => {
  const key = await issueKey({ mode: "live", pepper: PEPPER });
  const response = await call("/v1/keys", bearer(key.plaintext), { DB: fakeDb() });
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.equal(body.error.code, "invalid_key");
});

test("a wrong secret is rejected with the same message as an unknown prefix", async () => {
  const stored = await issueKey({ mode: "live", pepper: PEPPER });
  const presented = await issueKey({ mode: "live", pepper: PEPPER });
  const db = fakeDb([
    {
      match: /FROM api_keys k/,
      first: {
        id: "key_1",
        tenant_id: "ten_1",
        secret_hash: stored.secretHash,
        mode: "live",
        revoked_at: null,
        tenant_status: "active",
        tenant_name: "Acme",
      },
    },
  ]);

  const response = await call("/v1/keys", bearer(presented.plaintext), { DB: db });
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.equal(body.error.code, "invalid_key");
  assert.equal(body.error.message, "That API key is not valid.");
});

test("a key presented in the wrong mode is rejected", async () => {
  const { key } = await fixture({ keyRow: { mode: "test" } });

  const response = await call("/v1/keys", bearer(key.plaintext));

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "invalid_key");
});

test("a revoked key is rejected with its own code", async () => {
  const { key } = await fixture({ keyRow: { revoked_at: "2025-02-01T00:00:00.000Z" } });

  const response = await call("/v1/keys", bearer(key.plaintext));

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "revoked_key");
});

test("a suspended tenant is refused after the secret verifies", async () => {
  const { key } = await fixture({ keyRow: { tenant_status: "suspended" } });

  const response = await call("/v1/keys", bearer(key.plaintext));

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "tenant_inactive");
});

test("a wrong secret on a suspended account is an invalid key, not a status disclosure", async () => {
  const stored = await issueKey({ mode: "live", pepper: PEPPER });
  const presented = await issueKey({ mode: "live", pepper: PEPPER });
  const db = fakeDb([
    {
      match: /FROM api_keys k/,
      first: {
        id: "key_1",
        tenant_id: "ten_1",
        secret_hash: stored.secretHash,
        mode: "live",
        revoked_at: null,
        tenant_status: "suspended",
        tenant_name: "Acme",
      },
    },
  ]);

  const response = await call("/v1/keys", bearer(presented.plaintext), { DB: db });

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "invalid_key");
});

test("authentication fails closed when the pepper is unset", async () => {
  const { key } = await fixture();

  const response = await call("/v1/keys", bearer(key.plaintext), { API_KEY_PEPPER: undefined });
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.equal(body.error.code, "misconfigured");
});

test("authentication fails closed when storage is unavailable", async () => {
  const { key } = await fixture();

  const response = await call("/v1/keys", bearer(key.plaintext), { DB: undefined });
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.equal(body.error.code, "internal_error");
});

test("an authorization header without the Bearer scheme is ignored", async () => {
  const { key } = await fixture();

  const response = await call("/v1/keys", { headers: { authorization: key.plaintext } });

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "missing_credentials");
});

/* ------------------------------------------------------------------------------- usage */

test("usage reports this period's counters against the subscribed plan", async () => {
  const { key } = await fixture({
    rules: [
      {
        match: /FROM subscriptions s/,
        // bind(tenantId, serviceId) — only the AI API is subscribed.
        first: (sql, args) =>
          args[1] === "ai-api"
            ? {
                plan_id: "starter",
                price_monthly_cents: 2_900,
                included_units: 1_000_000,
                overage_micros_per_unit: 2,
              }
            : null,
      },
      {
        match: /FROM usage_counters[\s\S]*WHERE tenant_id/,
        all: [{ service_id: "ai-api", units: 1_500_000, requests: 12 }],
      },
    ],
  });

  const body = await (await call("/v1/usage", bearer(key.plaintext))).json();

  assert.equal(body.tenant_id, "ten_000000000000000000000001");
  assert.match(body.period, /^\d{4}-\d{2}$/);

  const ai = body.services.find((service) => service.service_id === "ai-api");
  assert.equal(ai.subscribed, true);
  assert.equal(ai.plan_id, "starter");
  assert.equal(ai.units_used, 1_500_000);
  assert.equal(ai.requests, 12);
  assert.equal(ai.included_units, 1_000_000);
  assert.equal(ai.overage_units, 500_000);
  // $29.00 + 500,000 × 2 µUSD ($1.00)
  assert.equal(ai.estimated_charge_cents, 3_000);
  assert.equal(ai.estimated_charge_display, "$30.00");
});

test("an unsubscribed service reports zero rather than a guessed charge", async () => {
  const { key } = await fixture();

  const body = await (await call("/v1/usage", bearer(key.plaintext))).json();
  const mcp = body.services.find((service) => service.service_id === "mcp-gateway");

  assert.equal(mcp.subscribed, false);
  assert.equal(mcp.plan_id, null);
  assert.equal(mcp.units_used, 0);
  assert.equal(mcp.estimated_charge_cents, 0);
  assert.equal(mcp.estimated_charge_display, "$0.00");
});

test("usage under the allowance is exactly the base price", async () => {
  const { key } = await fixture({
    rules: [
      {
        match: /FROM subscriptions s/,
        first: {
          plan_id: "starter",
          price_monthly_cents: 2_900,
          included_units: 1_000_000,
          overage_micros_per_unit: 2,
        },
      },
      {
        match: /FROM usage_counters[\s\S]*WHERE tenant_id/,
        all: [{ service_id: "ai-api", units: 400_000, requests: 4 }],
      },
    ],
  });

  const body = await (await call("/v1/usage", bearer(key.plaintext))).json();
  const ai = body.services.find((service) => service.service_id === "ai-api");

  assert.equal(ai.overage_units, 0);
  assert.equal(ai.estimated_charge_cents, 2_900);
  assert.equal(ai.estimated_charge_display, "$29.00");
});

/* ------------------------------------------------------------------------------- admin */

test("the admin overview rolls subscriptions and usage into an estimate", async () => {
  const db = fakeDb([
    { match: /COUNT\(\*\) AS total FROM tenants/, first: { total: 3 } },
    {
      match: /FROM usage_counters WHERE period/,
      all: [{ service_id: "ai-api", units: 2_000_000, requests: 40 }],
    },
    {
      match: /FROM plans p/,
      all: [
        {
          service_id: "ai-api",
          plan_id: "starter",
          price_monthly_cents: 2_900,
          included_units: 1_000_000,
          overage_micros_per_unit: 2,
          subscriptions: 2,
        },
      ],
    },
    { match: /FROM usage_events ORDER BY id DESC/, all: [] },
  ]);

  const response = await call("/v1/admin/overview", bearer(ADMIN_TOKEN), { DB: db });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.tenants, 3);

  // 2 starter subscriptions = $58.00
  assert.equal(body.revenue.base_mrr_cents, 5_800);
  assert.equal(body.revenue.base_mrr_display, "$58.00");
  // 1,000,000 overage tokens at 2 µUSD = $2.00
  assert.equal(body.revenue.overage_cents_estimate, 200);
  assert.equal(body.revenue.overage_display_estimate, "$2.00");
  assert.equal(body.revenue.total_cents_estimate, 6_000);
  assert.equal(body.revenue.total_display_estimate, "$60.00");
  // It must never claim to be an invoice.
  assert.match(body.revenue.note, /not an invoice/i);
});

test("the admin overview with no subscriptions is a zero estimate, not an error", async () => {
  const response = await call("/v1/admin/overview", bearer(ADMIN_TOKEN), { DB: fakeDb() });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.tenants, 0);
  assert.equal(body.revenue.total_cents_estimate, 0);
  assert.equal(body.revenue.total_display_estimate, "$0.00");
});
