# The service-manifest contract

A service is **one file** in `src/services/` plus **one entry** in the registry array in
`src/index.js`. That is the whole cost of adding a SKU.

If adding a service requires touching `lib/auth.js`, `lib/store.js`, `lib/money.js` or the
router, the contract is wrong — and the contract is what should change, not the service. The
point of the boundary is that auth, metering and billing are written once and are provably the
same for every SKU.

## Shape

```js
import { defineService } from "./registry.js";

export default defineService({
  id: "example-service",        // /^[a-z][a-z0-9-]{1,40}$/
  name: "Example Service",
  summary: "One sentence a buyer can act on.",
  unit: "request",              // /^[a-z][a-z0-9_]{1,30}$/ — REQUIRED
  unitLabel: "API request",     // optional, human-facing
  sellable: true,               // default is false
  docsUrl: "https://…",         // optional
  plans: [
    {
      id: "free",               // /^[a-z][a-z0-9-]{1,40}$/, unique within the service
      name: "Free",
      priceMonthlyCents: 0,     // non-negative INTEGER cents
      includedUnits: 50000,     // non-negative INTEGER
      overageMicrosPerUnit: 0,  // non-negative INTEGER micro-USD; 0 = hard stop
      description: "…",         // optional
    },
  ],
  routes: [
    {
      method: "POST",           // GET | POST | PUT | PATCH | DELETE
      path: "/v1/example",      // must start with "/"; ":name" matches one segment
      auth: true,               // default true
      meter: true,              // default true
      handler: async (ctx) => { … },
    },
  ],
});
```

## Rules, and why each one exists

| Rule | Enforced | Why |
|---|---|---|
| `unit` is required and well formed | load time | Nothing can be sold before it can be counted. A service with no unit has no meter, so it cannot be billed. |
| At least one plan | load time | A service with no price cannot be bought. |
| Plan prices strictly ascend | load time | Prevents a published ladder where a higher tier is cheaper. |
| Plan ids unique | load time | Plans are addressed by id in subscriptions and invoices. |
| Money fields are non-negative integers | load time | Floats in money are a defect, not a rounding preference. |
| `sellable: false` requires `blockedBy` | load time | A non-sellable service must say what is missing. Silence reads as "coming soon", which is a promise. |
| Routes have a valid method, a leading `/`, and a function handler | load time | A route that cannot run must not be routable. |
| No duplicate service id | registry build | Two services with one id makes `GET /v1/services/:id` a lie. |
| No duplicate `METHOD path` across services | registry build | Two services claiming one route makes the catalog lie about what it sells. |

All of these throw at import time. Because `src/index.js` builds the registry at module scope,
a defective manifest means the Worker does not boot at all — it cannot serve a broken request
to a paying customer. `scripts/check.mjs` surfaces the same failure in CI.

## What the framework gives a handler

```js
handler: async (ctx) => { … }
```

| Field | Meaning |
|---|---|
| `ctx.service` | The validated manifest |
| `ctx.params` | Path parameters, percent-decoded |
| `ctx.auth` | `{ tenantId, tenantName, keyId, mode }`, or `null` if `auth: false` |
| `ctx.plan` | `{ plan_id, price_monthly_cents, included_units, overage_micros_per_unit }` |
| `ctx.period` | `YYYY-MM` |
| `ctx.remainingUnits` | Finite for a hard-stop plan, `null` when overage is billed |
| `ctx.requestId` | The same id returned in the response header |
| `ctx.env` | Worker bindings |
| `ctx.record({ units })` | Records what this call consumed. Call it once, after the work. |

The framework handles authentication, plan resolution, quota lookup and ledger writes. The
handler's only obligation is to call `ctx.record({ units })` with the units it actually
consumed.

### `remainingUnits` is the whole quota model

- `overageMicrosPerUnit > 0` → `null`. The customer is billed for extra usage, so nothing is
  refused.
- `overageMicrosPerUnit === 0` → `max(0, includedUnits - used)`. The plan is a hard stop, so
  the handler may refuse with `402 quota_exceeded` when the estimate exceeds the remainder.

A handler that ignores `remainingUnits` on a hard-stop plan would give away unlimited free
service. A handler that refuses when `remainingUnits` is `null` would break a paying customer.
Both mistakes are one line apart, which is why the framework computes the value rather than
each handler.

## Reference implementation

`src/services/ai-api.js` is the worked example and the launch SKU:

1. Validate the request shape (message count, roles, per-message length).
2. Pre-flight: estimate tokens; if the plan is a hard stop and the estimate exceeds
   `remainingUnits`, throw `402 quota_exceeded` before spending anything on the model.
3. Call `ctx.env.AI.run(model, { messages })`.
4. On provider failure, throw `502 upstream_error` — nothing is recorded.
5. Bill `usage.total_tokens` when the provider reports it, falling back to the estimate only if
   it does not.
6. `await ctx.record({ units })`, then return an OpenAI-compatible body.

## Declaring a service you cannot sell yet

`src/services/mcp-gateway.js` shows the pattern: publish the plans, publish the routes, set
`sellable: false`, and state the blocker.

```js
sellable: false,
blockedBy: "No MCP server runtime exists in this Worker. The routes below return 501 until a " +
  "stateless Streamable HTTP transport, per-server tool discovery and per-tool metering are built.",
```

The catalog then renders the service with `blocked_by`, signup refuses it with
`409 service_not_available`, and the build stays green. This is how the roadmap is expressed
without any of it being mistaken for a shipped feature.

## Checklist for a new SKU

1. Write the manifest with a countable unit and ascending plans.
2. Add it to the `createRegistry([...])` array in `src/index.js`.
3. Add it to the `modules` list in `scripts/check.mjs`.
4. Add a test that the unit is countable and that a sellable service has at least one route.
5. Document its prices in the README table.
6. Only then set `sellable: true` — and only once the route actually returns a result.
