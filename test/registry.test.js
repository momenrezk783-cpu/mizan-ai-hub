// Unit tests for the service-manifest contract and the registry.
// The contract is the modularity boundary: if these rules loosen, a service can ship that
// cannot be counted, and therefore cannot be billed.

import test from "node:test";
import assert from "node:assert/strict";

import { defineService, createRegistry } from "../src/services/registry.js";
import aiApi from "../src/services/ai-api.js";
import mcpGateway from "../src/services/mcp-gateway.js";

/** A minimal valid manifest that individual tests then break in one specific way. */
function baseManifest(overrides = {}) {
  return {
    id: "demo-service",
    name: "Demo Service",
    summary: "A demo service used only by the test suite.",
    unit: "call",
    plans: [
      { id: "free", name: "Free", priceMonthlyCents: 0, includedUnits: 100, overageMicrosPerUnit: 0 },
    ],
    routes: [{ method: "GET", path: "/v1/demo", handler: () => new Response("ok") }],
    sellable: true,
    ...overrides,
  };
}

const plan = (id, priceMonthlyCents) => ({
  id,
  name: id,
  priceMonthlyCents,
  includedUnits: 1_000,
  overageMicrosPerUnit: 1,
});

/* ------------------------------------------------------------------ defineService: accepts */

test("a valid manifest is accepted and frozen", () => {
  const service = defineService(baseManifest());

  assert.equal(service.id, "demo-service");
  assert.equal(service.unit, "call");
  assert.equal(service.sellable, true);
  assert.equal(service.plans.length, 1);
  assert.equal(service.routes.length, 1);
  assert.ok(Object.isFrozen(service));
  assert.ok(Object.isFrozen(service.plans));
  assert.ok(Object.isFrozen(service.routes));
});

test("unitLabel falls back to the unit when not given", () => {
  assert.equal(defineService(baseManifest()).unitLabel, "call");
  assert.equal(defineService(baseManifest({ unitLabel: "API call" })).unitLabel, "API call");
});

test("routes default to authenticated and metered", () => {
  const [route] = defineService(baseManifest()).routes;

  assert.equal(route.auth, true);
  assert.equal(route.meter, true);
});

test("a route may opt out of auth and metering explicitly", () => {
  const service = defineService(
    baseManifest({
      routes: [{ method: "GET", path: "/v1/public", auth: false, meter: false, handler: () => 1 }],
    }),
  );

  assert.equal(service.routes[0].auth, false);
  assert.equal(service.routes[0].meter, false);
});

test("a sellable service carries no blocker", () => {
  assert.equal("blockedBy" in defineService(baseManifest()), false);
});

test("a non-sellable service keeps its stated blocker", () => {
  const service = defineService(
    baseManifest({ sellable: false, blockedBy: "the runtime that would serve it does not exist" }),
  );

  assert.equal(service.sellable, false);
  assert.equal(service.blockedBy, "the runtime that would serve it does not exist");
});

/* ---------------------------------------------------------------- defineService: rejects */

test("a manifest that cannot be counted is rejected", () => {
  assert.throws(() => defineService(baseManifest({ unit: undefined })), /unit must match/);
  assert.throws(() => defineService(baseManifest({ unit: "" })), /unit must match/);
  assert.throws(() => defineService(baseManifest({ unit: "token call" })), /unit must match/);
  assert.throws(() => defineService(baseManifest({ unit: "Token" })), /unit must match/);
});

test("a non-sellable service must say what blocks it", () => {
  assert.throws(
    () => defineService(baseManifest({ sellable: false })),
    /must name what blocks it/,
  );
  assert.throws(
    () => defineService(baseManifest({ sellable: false, blockedBy: "   " })),
    /must name what blocks it/,
  );
});

test("a manifest needs identity and a summary", () => {
  assert.throws(() => defineService(null), /must be an object/);
  assert.throws(() => defineService(baseManifest({ id: undefined })), /service id must match/);
  assert.throws(() => defineService(baseManifest({ id: "Demo Service" })), /service id must match/);
  assert.throws(() => defineService(baseManifest({ id: "a" })), /service id must match/);
  assert.throws(() => defineService(baseManifest({ name: "" })), /name is required/);
  assert.throws(() => defineService(baseManifest({ summary: undefined })), /summary is required/);
});

test("a manifest needs at least one plan", () => {
  assert.throws(() => defineService(baseManifest({ plans: [] })), /at least one plan/);
  assert.throws(() => defineService(baseManifest({ plans: undefined })), /at least one plan/);
});

test("plans must ascend by price", () => {
  assert.throws(
    () => defineService(baseManifest({ plans: [plan("pro", 9_900), plan("starter", 2_900)] })),
    /must be priced above/,
  );
  assert.throws(
    () => defineService(baseManifest({ plans: [plan("one", 2_900), plan("two", 2_900)] })),
    /must be priced above/,
  );
});

test("plan ids must be unique", () => {
  assert.throws(
    () => defineService(baseManifest({ plans: [plan("starter", 2_900), plan("starter", 9_900)] })),
    /duplicate plan id/,
  );
});

test("plan money must be non-negative integers", () => {
  assert.throws(
    () => defineService(baseManifest({ plans: [{ ...plan("starter", 2_900), priceMonthlyCents: 29.5 }] })),
    /non-negative integer/,
  );
  assert.throws(
    () => defineService(baseManifest({ plans: [{ ...plan("starter", 2_900), priceMonthlyCents: -1 }] })),
    /non-negative integer/,
  );
  assert.throws(
    () => defineService(baseManifest({ plans: [{ ...plan("starter", 2_900), includedUnits: -1 }] })),
    /non-negative integer/,
  );
  assert.throws(
    () => defineService(baseManifest({ plans: [{ ...plan("starter", 2_900), overageMicrosPerUnit: 0.5 }] })),
    /non-negative integer/,
  );
  assert.throws(
    () => defineService(baseManifest({ plans: [{ id: "xx", name: "X" }] })),
    /non-negative integer/,
  );
});

test("routes must be complete and well formed", () => {
  assert.throws(
    () => defineService(baseManifest({ routes: [{ method: "GET", path: "/x" }] })),
    /handler must be a function/,
  );
  assert.throws(
    () => defineService(baseManifest({ routes: [{ method: "GET", handler: () => 1 }] })),
    /path must start with/,
  );
  assert.throws(
    () => defineService(baseManifest({ routes: [{ method: "GET", path: "v1/x", handler: () => 1 }] })),
    /path must start with/,
  );
  assert.throws(
    () => defineService(baseManifest({ routes: [{ method: "FETCH", path: "/x", handler: () => 1 }] })),
    /method must be one of/,
  );
  assert.throws(
    () => defineService(baseManifest({ routes: [{ method: "get", path: "/x", handler: () => 1 }] })),
    /method must be one of/,
  );
});

/* --------------------------------------------------------------------- createRegistry */

test("createRegistry requires an array", () => {
  assert.throws(() => createRegistry(baseManifest()), /expects an array/);
  assert.throws(() => createRegistry(undefined), /expects an array/);
});

test("createRegistry rejects a duplicate service id", () => {
  assert.throws(
    () => createRegistry([baseManifest(), baseManifest({ name: "Second" })]),
    /duplicate service id/,
  );
});

test("createRegistry rejects two services claiming the same route", () => {
  assert.throws(
    () => createRegistry([baseManifest(), baseManifest({ id: "other-service", name: "Other" })]),
    /is claimed by both/,
  );
});

test("two services may share a path under different methods", () => {
  const registry = createRegistry([
    baseManifest(),
    baseManifest({
      id: "other-service",
      name: "Other",
      routes: [{ method: "POST", path: "/v1/demo", handler: () => 1 }],
    }),
  ]);

  assert.ok(registry.match("GET", "/v1/demo"));
  assert.ok(registry.match("POST", "/v1/demo"));
});

test("get returns null for an unknown service", () => {
  const registry = createRegistry([baseManifest()]);

  assert.equal(registry.get("nope"), null);
  assert.ok(registry.get("demo-service"));
});

/* ------------------------------------------------------------------------------ match */

test("match resolves literal routes", () => {
  const registry = createRegistry([baseManifest()]);
  const matched = registry.match("GET", "/v1/demo");

  assert.ok(matched);
  assert.equal(matched.service.id, "demo-service");
  assert.deepEqual(matched.params, {});
});

test("match is method sensitive and returns null when nothing fits", () => {
  const registry = createRegistry([baseManifest()]);

  assert.equal(registry.match("POST", "/v1/demo"), null);
  assert.equal(registry.match("GET", "/v1/nothing"), null);
  assert.equal(registry.match("GET", "/"), null);
});

test("match tolerates a trailing slash", () => {
  const registry = createRegistry([baseManifest()]);

  assert.ok(registry.match("GET", "/v1/demo/"));
});

test("match extracts one and many path parameters", () => {
  const registry = createRegistry([
    baseManifest({
      routes: [
        { method: "GET", path: "/v1/things/:id", handler: () => 1 },
        { method: "POST", path: "/v1/servers/:id/tools/:tool/call", handler: () => 1 },
      ],
    }),
  ]);

  const single = registry.match("GET", "/v1/things/abc");
  assert.deepEqual(single.params, { id: "abc" });

  const many = registry.match("POST", "/v1/servers/srv_123/tools/search/call");
  assert.deepEqual(many.params, { id: "srv_123", tool: "search" });
});

test("match decodes percent-encoded parameters", () => {
  const registry = createRegistry([
    baseManifest({ routes: [{ method: "GET", path: "/v1/things/:id", handler: () => 1 }] }),
  ]);

  assert.deepEqual(registry.match("GET", "/v1/things/a%20b").params, { id: "a b" });
});

test("match rejects extra and missing segments", () => {
  const registry = createRegistry([
    baseManifest({
      routes: [{ method: "POST", path: "/v1/servers/:id/tools/:tool/call", handler: () => 1 }],
    }),
  ]);

  assert.equal(registry.match("POST", "/v1/servers/a/tools/b/call/extra"), null);
  assert.equal(registry.match("POST", "/v1/servers/a/tools/b"), null);
  assert.equal(registry.match("POST", "/v1/servers/a/call"), null);
});

/* ---------------------------------------------------------------------------- catalog */

test("catalog lists sellable services first, then by name", () => {
  const registry = createRegistry([
    baseManifest({ id: "zeta-blocked", name: "Zeta", sellable: false, blockedBy: "not built" }),
    baseManifest({ id: "alpha-sold", name: "Alpha", routes: [{ method: "GET", path: "/a", handler: () => 1 }] }),
    baseManifest({ id: "beta-blocked", name: "Beta", sellable: false, blockedBy: "not built", routes: [{ method: "GET", path: "/b", handler: () => 1 }] }),
  ]);

  assert.deepEqual(
    registry.catalog().map((entry) => entry.id),
    ["alpha-sold", "beta-blocked", "zeta-blocked"],
  );
});

test("catalog publishes the blocker of a non-sellable service instead of hiding it", () => {
  const registry = createRegistry([
    baseManifest({ id: "later", name: "Later", sellable: false, blockedBy: "needs a runtime" }),
  ]);
  const [entry] = registry.catalog();

  assert.equal(entry.sellable, false);
  assert.equal(entry.blocked_by, "needs a runtime");
});

test("catalog exposes prices in machine-readable cents", () => {
  const registry = createRegistry([baseManifest({ plans: [plan("starter", 2_900)] })]);
  const [entry] = registry.catalog();

  assert.equal(entry.plans[0].price_monthly_cents, 2_900);
  assert.equal(entry.plans[0].included_units, 1_000);
  assert.equal(entry.plans[0].overage_micros_per_unit, 1);
});

/* ------------------------------------------------------------- the two real launch SKUs */

test("the real manifests load together without a route collision", () => {
  const registry = createRegistry([aiApi, mcpGateway]);

  assert.deepEqual(registry.list().map((service) => service.id), ["ai-api", "mcp-gateway"]);
});

test("the AI API is sellable and has a countable unit and a route to sell", () => {
  assert.equal(aiApi.sellable, true);
  assert.equal(aiApi.unit, "token");
  assert.ok(aiApi.routes.length > 0);
  assert.equal("blockedBy" in aiApi, false);
});

test("the MCP gateway is not sellable and states why", () => {
  assert.equal(mcpGateway.sellable, false);
  assert.equal(typeof mcpGateway.blockedBy, "string");
  assert.ok(mcpGateway.blockedBy.length > 20, "blockedBy must be a real explanation");
});

test("the two SKUs are metered in different units", () => {
  assert.notEqual(aiApi.unit, mcpGateway.unit);
  assert.equal(mcpGateway.unit, "tool_call");
});

test("both SKUs publish the same four-step price ladder", () => {
  const ladder = (service) => service.plans.map((entry) => entry.priceMonthlyCents);

  assert.deepEqual(ladder(aiApi), [0, 2_900, 9_900, 34_900]);
  assert.deepEqual(ladder(mcpGateway), [0, 2_900, 9_900, 34_900]);
});

test("the AI API's published prices match the documented $29 / $99 / $349 tiers", () => {
  const byId = Object.fromEntries(aiApi.plans.map((entry) => [entry.id, entry]));

  assert.equal(byId.free.priceMonthlyCents, 0);
  assert.equal(byId.starter.priceMonthlyCents, 2_900);
  assert.equal(byId.pro.priceMonthlyCents, 9_900);
  assert.equal(byId.business.priceMonthlyCents, 34_900);
});

test("the free tier is a hard stop: no overage rate, finite allowance", () => {
  const free = aiApi.plans.find((entry) => entry.priceMonthlyCents === 0);

  assert.equal(free.overageMicrosPerUnit, 0);
  assert.ok(free.includedUnits > 0);
});

test("paid tiers all carry an overage rate so usage is billed, not refused", () => {
  for (const entry of aiApi.plans.filter((candidate) => candidate.priceMonthlyCents > 0)) {
    assert.ok(entry.overageMicrosPerUnit > 0, `plan ${entry.id} would refuse instead of bill`);
  }
});

test("the MCP gateway's routes exist but are not yet backed by a runtime", () => {
  const registry = createRegistry([aiApi, mcpGateway]);

  assert.ok(registry.match("POST", "/v1/mcp/servers/abc/tools/x/call"));
  assert.ok(registry.match("GET", "/v1/mcp/servers"));
});

test("manifest routes never shadow the public catalog", () => {
  const registry = createRegistry([aiApi, mcpGateway]);

  assert.equal(registry.match("GET", "/v1/services"), null);
  assert.equal(registry.match("GET", "/v1/services/ai-api"), null);
});
