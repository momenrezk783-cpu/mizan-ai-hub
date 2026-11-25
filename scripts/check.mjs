// Loads every source module and re-asserts the manifest invariants.
//
// This is stronger than `node --check`: it proves the whole module graph resolves, that no
// module throws at import time, and that every service manifest still passes the contract in
// `src/services/registry.js`. A manifest defect fails the build, not a customer request.

import assert from "node:assert/strict";

const modules = [
  "../src/lib/keys.js",
  "../src/lib/http.js",
  "../src/lib/money.js",
  "../src/lib/auth.js",
  "../src/lib/store.js",
  "../src/services/registry.js",
  "../src/services/ai-api.js",
  "../src/services/mcp-gateway.js",
  "../src/index.js",
];

const loaded = [];
for (const path of modules) {
  await import(new URL(path, import.meta.url));
  loaded.push(path.replace("../src/", ""));
}

// Importing src/index.js already built the registry, which validates both manifests. Re-derive
// it here so the assertions below fail with a clear message rather than a bare import error.
const { createRegistry } = await import(new URL("../src/services/registry.js", import.meta.url));
const { default: aiApi } = await import(new URL("../src/services/ai-api.js", import.meta.url));
const { default: mcpGateway } = await import(new URL("../src/services/mcp-gateway.js", import.meta.url));

const registry = createRegistry([aiApi, mcpGateway]);
const services = registry.list();

assert.equal(services.length, 2, "expected exactly the two launch SKUs");

const sellable = services.filter((service) => service.sellable);
assert.ok(sellable.length >= 1, "at least one service must be sellable or there is no revenue");
for (const service of services) {
  assert.ok(service.unit, `service "${service.id}" has no countable unit`);
  assert.ok(service.plans.length >= 1, `service "${service.id}" has no plans`);
  if (!service.sellable) {
    assert.ok(service.blockedBy, `service "${service.id}" is not sellable but names no blocker`);
  }
  if (service.sellable) {
    assert.ok(service.routes.length >= 1, `service "${service.id}" is sellable but has no route`);
  }
}

assert.equal(aiApi.sellable, true, "the AI API is the launch SKU and must be sellable");
assert.equal(mcpGateway.sellable, false, "the MCP gateway must not be sold before it exists");
assert.ok(mcpGateway.blockedBy, "the MCP gateway must state what blocks it");

console.log(`loaded ${loaded.length} modules: ${loaded.join(", ")}`);
console.log(
  `services: ${services
    .map((service) => `${service.id} (${service.sellable ? "sellable" : "blocked"}, ${service.unit})`)
    .join(", ")}`,
);
console.log("ok");
