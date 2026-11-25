import { defineService } from "./registry.js";
import { fail } from "../lib/http.js";

/**
 * Managed MCP Gateway — the second SKU, deliberately not sellable yet.
 *
 * Metering, authentication, quotas and the catalog exist; the gateway runtime does not. Every
 * route therefore answers 501 with the reason, and `sellable: false` keeps it off the price
 * list. Nothing may be sold before it can be counted *and delivered*, and only the first half
 * is built.
 *
 * This is not a duplicate of anything in Cloudflare OS. The OS has an MCP *client*
 * (`gatekeeper-mcp`), an MCP *portal client* (`gatekeeper-mcp-portal`) and, on the
 * `feat/agent-mcp-server` branch, a personal MCP *server* that drives one person's own agent
 * under their own session token. None of those is a multi-tenant, metered endpoint that a
 * business can buy for its own users. See docs/05-resource-audit.md.
 */
function notBuilt(tool) {
  return () => {
    throw fail(
      501,
      "not_implemented",
      "The Managed MCP Gateway runtime is not built yet. Metering, keys and quotas are in place; " +
        "the MCP server that would execute this call is not.",
      { tool, blocked_by: "gateway_runtime" },
    );
  };
}

export default defineService({
  id: "mcp-gateway",
  name: "Managed MCP Gateway",
  summary:
    "A hosted, authenticated MCP endpoint for your own tools, metered per tool call, with one key per tenant.",
  unit: "tool_call",
  unitLabel: "tool calls",
  sellable: false,
  blockedBy:
    "The MCP server runtime is not implemented. Keys, metering, quotas and the catalog are built; " +
    "the endpoint that executes a tool call is not, so nothing here is billed or sold.",
  plans: [
    {
      id: "free",
      name: "Free",
      description: "One server, evaluate only.",
      priceMonthlyCents: 0,
      includedUnits: 1_000,
      overageMicrosPerUnit: 0,
    },
    {
      id: "starter",
      name: "Starter",
      description: "One production server.",
      priceMonthlyCents: 2_900,
      includedUnits: 25_000,
      overageMicrosPerUnit: 1_000,
    },
    {
      id: "pro",
      name: "Pro",
      description: "Several servers, higher volume.",
      priceMonthlyCents: 9_900,
      includedUnits: 150_000,
      overageMicrosPerUnit: 600,
    },
    {
      id: "business",
      name: "Business",
      description: "Highest volume and the lowest per-call overage.",
      priceMonthlyCents: 34_900,
      includedUnits: 750_000,
      overageMicrosPerUnit: 400,
    },
  ],
  routes: [
    { method: "GET", path: "/v1/mcp/servers", handler: notBuilt("list_servers") },
    { method: "POST", path: "/v1/mcp/servers", handler: notBuilt("create_server") },
    { method: "GET", path: "/v1/mcp/servers/:id", handler: notBuilt("get_server") },
    { method: "POST", path: "/v1/mcp/servers/:id/tools/:tool/call", handler: notBuilt("call_tool") },
  ],
});
