// HTTP surface tests for the Worker entry point.
//
// These run under plain `node --test` with no Workers runtime. D1 is replaced by a small
// in-memory double that answers by SQL shape, so the real handlers run end to end — signup,
// key issuing, metering and the admin rollup — without a database and without a network.
//
// What is deliberately NOT covered here: real SQL execution, D1 constraints, and Workers AI.
// Those are covered by the migration and by the deployed smoke test, not by a fake.

import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { KEY_PATTERN } from "../src/lib/keys.js";

const ORIGIN = "https://ai.mizanconsult.com";

/* --------------------------------------------------------------------------- D1 double */

/**
 * Builds a fake D1 binding. Each rule matches the statement's SQL and may answer `first`,
 * `all` or `run`. Bound parameters are captured so a rule can answer per tenant or per service.
 */
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
    API_KEY_PEPPER: "test-pepper",
    ADMIN_TOKEN: "test-admin-token",
    DB: fakeDb(),
    ...overrides,
  };
}

function call(path, init, envOverrides) {
  return worker.fetch(new Request(`${ORIGIN}${path}`, init), env(envOverrides), {});
}

const post = (path, body, envOverrides) =>
  call(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    envOverrides,
  );

const bearer = (token) => ({ headers: { authorization: `Bearer ${token}` } });

/* ------------------------------------------------------------------------ public surface */

test("GET / describes the service and its endpoints", async () => {
  const response = await call("/");
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.name, "Mizan AI Hub");
  assert.equal(body.endpoints.pricing, `${ORIGIN}/v1/pricing`);
  assert.equal(body.endpoints.signup, `${ORIGIN}/v1/tenants`);
  assert.match(body.authentication, /Bearer/);
});

test("GET /health reports ok", async () => {
  const response = await call("/health");
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.status, "ok");
  assert.equal(body.service, "mizan-ai-hub");
  assert.equal(body.environment, "test");
  assert.ok(!Number.isNaN(Date.parse(body.time)));
});

test("GET /v1/services returns the catalog, sellable service first", async () => {
  const response = await call("/v1/services");
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.services.length, 2);
  assert.equal(body.services[0].id, "ai-api");
  assert.equal(body.services[0].sellable, true);
  assert.equal(body.services[1].id, "mcp-gateway");
  assert.equal(body.services[1].sellable, false);
  assert.ok(body.services[1].blocked_by);
});

test("GET /v1/services/ai-api publishes prices, routes and units", async () => {
  const body = await (await call("/v1/services/ai-api")).json();

  assert.equal(body.unit, "token");
  assert.equal(body.sellable, true);
  assert.deepEqual(
    body.plans.map((entry) => entry.price_monthly_display),
    ["$0.00", "$29.00", "$99.00", "$349.00"],
  );
  assert.ok(body.routes.length > 0);
  assert.ok(body.routes.every((route) => route.auth_required === true));
});

test("GET /v1/services/mcp-gateway is honest about being unavailable", async () => {
  const response = await call("/v1/services/mcp-gateway");
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.sellable, false);
  assert.equal(typeof body.blocked_by, "string");
  assert.ok(body.blocked_by.length > 20);
});

test("GET /v1/services/:id rejects an unknown service with a 404 envelope", async () => {
  const response = await call("/v1/services/does-not-exist");
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(body.error.code, "service_not_found");
  assert.equal(typeof body.error.request_id, "string");
});

test("GET /v1/pricing publishes USD prices with a worked example per plan", async () => {
  const body = await (await call("/v1/pricing")).json();

  assert.equal(body.currency, "USD");
  const ai = body.services.find((service) => service.id === "ai-api");
  const starter = ai.plans.find((entry) => entry.id === "starter");

  assert.equal(starter.price_monthly_display, "$29.00");
  assert.equal(starter.example.units, starter.included_units * 2);
  // $29.00 + 1M overage tokens at 2 micro-USD = $31.00
  assert.equal(starter.example.charge_display, "$31.00");
});

test("no plan's worked example ever costs less than its base price", async () => {
  const body = await (await call("/v1/pricing")).json();

  for (const service of body.services) {
    for (const plan of service.plans) {
      assert.ok(
        plan.example.charge_cents >= plan.price_monthly_cents,
        `${service.id}/${plan.id} example undercuts its base price`,
      );
    }
  }
});

test("the free plan's worked example is zero", async () => {
  const body = await (await call("/v1/pricing")).json();
  const free = body.services
    .find((service) => service.id === "ai-api")
    .plans.find((entry) => entry.id === "free");

  assert.equal(free.example.charge_cents, 0);
  assert.equal(free.example.charge_display, "$0.00");
});

/* --------------------------------------------------------------------- transport details */

test("every response carries a request id and CORS headers", async () => {
  const response = await call("/v1/services");

  assert.match(response.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("vary"), "origin");
  assert.match(response.headers.get("content-type"), /application\/json/);
});

test("request ids differ between requests", async () => {
  const first = await call("/health");
  const second = await call("/health");

  assert.notEqual(first.headers.get("x-request-id"), second.headers.get("x-request-id"));
});

test("OPTIONS is answered with 204 and preflight headers", async () => {
  const response = await call("/v1/services", { method: "OPTIONS" });

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.match(response.headers.get("access-control-allow-methods"), /POST/);
  assert.match(response.headers.get("access-control-allow-headers"), /authorization/);
});

test("a restricted origin list reflects only an allowed origin", async () => {
  const allowed = await call(
    "/v1/services",
    { headers: { origin: "https://app.example.com" } },
    { ALLOWED_ORIGINS: "https://app.example.com,https://other.example.com" },
  );
  assert.equal(allowed.headers.get("access-control-allow-origin"), "https://app.example.com");

  const denied = await call(
    "/v1/services",
    { headers: { origin: "https://evil.example.com" } },
    { ALLOWED_ORIGINS: "https://app.example.com" },
  );
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
});

test("an unknown route is a 404 in the standard error envelope", async () => {
  const response = await call("/nope");
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(body.error.code, "not_found");
  assert.equal(typeof body.error.message, "string");
  assert.equal(typeof body.error.request_id, "string");
});

test("a known path with the wrong method is a 404", async () => {
  const response = await call("/v1/services", { method: "DELETE" });

  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "not_found");
});

/* -------------------------------------------------------------------- authentication */

test("a protected route without a key is 401 missing_credentials", async () => {
  for (const path of ["/v1/keys", "/v1/usage"]) {
    const response = await call(path);
    const body = await response.json();

    assert.equal(response.status, 401, path);
    assert.equal(body.error.code, "missing_credentials", path);
  }
});

test("a malformed key is 401 invalid_key", async () => {
  const response = await call("/v1/keys", bearer("not-a-key"));
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.equal(body.error.code, "invalid_key");
});

test("the admin route rejects a missing or wrong token", async () => {
  const missing = await call("/v1/admin/overview");
  assert.equal(missing.status, 401);
  assert.equal((await missing.json()).error.code, "unauthorized");

  const wrong = await call("/v1/admin/overview", bearer("guess"));
  assert.equal(wrong.status, 401);
});

test("the admin route fails closed when no admin token is configured", async () => {
  const response = await call("/v1/admin/overview", bearer("anything"), { ADMIN_TOKEN: undefined });

  assert.equal(response.status, 500);
  assert.equal((await response.json()).error.code, "misconfigured");
});

test("a tenant key cannot be used as an admin token", async () => {
  const response = await call(
    "/v1/admin/overview",
    bearer(`mzk_live_${"a".repeat(12)}_${"b".repeat(32)}`),
  );

  assert.equal(response.status, 401);
});

test("the AI API requires a key before doing any work", async () => {
  const response = await post("/v1/ai/chat/completions", {
    messages: [{ role: "user", content: "hi" }],
  });

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "missing_credentials");
});

/* ------------------------------------------------------------------------ signup input */

test("signup refuses a non-JSON content type", async () => {
  const response = await call("/v1/tenants", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "name=x",
  });

  assert.equal(response.status, 415);
  assert.equal((await response.json()).error.code, "unsupported_media_type");
});

test("signup refuses invalid JSON", async () => {
  const response = await post("/v1/tenants", "{not json");

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "invalid_json");
});

test("signup refuses a JSON value that is not an object", async () => {
  const response = await post("/v1/tenants", "[1,2,3]");

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "invalid_body");
});

test("signup requires a name and a valid email before touching storage", async () => {
  const noName = await post("/v1/tenants", { email: "a@b.co" });
  assert.equal(noName.status, 400);
  assert.equal((await noName.json()).error.code, "invalid_field");

  const badEmail = await post("/v1/tenants", { name: "Acme", email: "not-an-email" });
  assert.equal(badEmail.status, 400);
  assert.equal((await badEmail.json()).error.code, "invalid_field");

  const longName = await post("/v1/tenants", { name: "x".repeat(101), email: "a@b.co" });
  assert.equal(longName.status, 400);
});

test("signup rejects an unknown service id", async () => {
  const response = await post("/v1/tenants", {
    name: "Acme",
    email: "a@b.co",
    service: "no-such-service",
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "unknown_service");
});

test("signup refuses to sell a service that is not sellable", async () => {
  const response = await post("/v1/tenants", {
    name: "Acme",
    email: "a@b.co",
    service: "mcp-gateway",
  });

  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "service_not_available");
});

/* --------------------------------------------------------------------- signup, end to end */

test("signup creates the tenant and returns the only copy of the key", async () => {
  const response = await post("/v1/tenants", { name: "Acme Ltd", email: "Ops@Acme.example" });
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.match(body.tenant.id, /^ten_[0-9a-f]{24}$/);
  assert.equal(body.tenant.slug, "acme-ltd");
  assert.equal(body.tenant.status, "active");
  // Emails are normalised at the boundary so a duplicate check cannot be bypassed by case.
  assert.equal(body.tenant.email, "ops@acme.example");

  assert.equal(body.subscription.service_id, "ai-api");
  assert.equal(body.subscription.plan_id, "free");
  assert.equal(body.subscription.status, "active");

  assert.match(body.api_key.id, /^key_[0-9a-f]{24}$/);
  assert.match(body.api_key.key, KEY_PATTERN);
  assert.equal(body.api_key.mode, "live");
  assert.match(body.api_key.warning, /only time/i);
});

test("signup defaults to the sellable service and honours an explicit one", async () => {
  const implicit = await (await post("/v1/tenants", { name: "A Co", email: "a@co.example" })).json();
  assert.equal(implicit.subscription.service_id, "ai-api");

  const explicit = await (
    await post("/v1/tenants", { name: "B Co", email: "b@co.example", service: "ai-api" })
  ).json();
  assert.equal(explicit.subscription.service_id, "ai-api");
});

test("signup refuses a duplicate email", async () => {
  const db = fakeDb([
    { match: /FROM tenants WHERE email/, first: { id: "ten_existing" } },
  ]);
  const response = await post(
    "/v1/tenants",
    { name: "Acme", email: "a@b.co" },
    { DB: db },
  );

  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "email_in_use");
});

test("signup disambiguates a slug that is already taken", async () => {
  const db = fakeDb([{ match: /FROM tenants WHERE slug/, first: { id: "ten_taken" } }]);
  const body = await (
    await post("/v1/tenants", { name: "Acme Ltd", email: "a@b.co" }, { DB: db })
  ).json();

  assert.match(body.tenant.slug, /^acme-ltd-[0-9a-f]{6}$/);
});

test("signup derives a usable slug from an awkward name", async () => {
  const body = await (
    await post("/v1/tenants", { name: "  Öztürk & Sons, Ltd.  ", email: "a@b.co" })
  ).json();

  assert.match(body.tenant.slug, /^[a-z0-9-]+$/);
  assert.ok(body.tenant.slug.length > 0);
});

test("a storage failure is a 500 envelope, never an unhandled crash", async () => {
  const response = await post("/v1/tenants", { name: "Acme", email: "a@b.co" }, { DB: undefined });
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.equal(body.error.code, "internal_error");
  assert.equal(typeof body.error.request_id, "string");
  // The internal message must not leak.
  assert.doesNotMatch(body.error.message, /DB|undefined|prepare/i);
});

test("the API version and worker name are stable", async () => {
  const body = await (await call("/")).json();

  assert.equal(body.version, "0.1.0");
  assert.equal(body.name, "Mizan AI Hub");
});
