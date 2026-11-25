# Mizan AI Hub

A commercial platform that sells managed AI services on Cloudflare, to businesses, developers
and website owners. It is a **third, independent Worker** — its own repository, its own
storage, its own secrets. It shares no binding, route, secret or table with Cloudflare OS or
with Mizan Voice. Those products reach the Hub the same way any other customer does: over its
public HTTPS API with an API key.

Public hostname when released: **`ai.mizanconsult.com`**.

---

## What this repository contains today

| Area | State |
|---|---|
| Public catalog, pricing, worked examples | Built |
| Self-service signup, tenant + first API key | Built |
| API key issuing, listing, revocation | Built |
| Usage metering (append-only ledger + derived counters) | Built |
| Quotas and overage estimation | Built |
| **Managed AI API** (`POST /v1/ai/chat/completions`) | Built — the launch SKU |
| Admin overview (tenants, MRR, overage estimate) | Built |
| Managed MCP Gateway | **Not sellable.** Routes exist and return `501`; see below |
| Managed Vector / RAG | Not started — needs a Vectorize index, which is net-new paid infrastructure |
| Stripe checkout and invoicing | Not started — blocked on the payment-processor decision |
| Custom domain `ai.mizanconsult.com` | Not configured — blocked on the DNS gate |

The MCP Gateway is declared in the catalog with `sellable: false` and an explicit `blockedBy`.
It is listed, priced and documented, but signup refuses it with `409 service_not_available`.
The manifest contract makes that impossible to forget: a non-sellable service that does not
name its blocker fails to load, and the build fails with it.

---

## Quick start

```bash
npm install
npm run check          # loads every module, re-validates both service manifests
npm test               # pure unit + HTTP surface tests, no network and no database
npm run db:migrate:local
npm run dev            # local Worker on http://localhost:8787
```

Deployment is described in [`docs/06-deploy-and-secrets.md`](docs/06-deploy-and-secrets.md).

---

## The API

All responses are JSON. Every response carries `x-request-id`. Every error uses one shape:

```json
{ "error": { "code": "invalid_key", "message": "That API key is not valid.", "request_id": "…" } }
```

### Public

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | Discovery document |
| `GET` | `/health` | Liveness |
| `GET` | `/v1/services` | Catalog, sellable services first |
| `GET` | `/v1/services/:id` | One service, with plans and routes |
| `GET` | `/v1/pricing` | Prices plus a worked example per plan |
| `POST` | `/v1/tenants` | Sign up; returns the tenant and its first API key |

### Authenticated (`Authorization: Bearer mzk_live_…`)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/keys` | List keys, masked |
| `POST` | `/v1/keys` | Issue another key |
| `DELETE` | `/v1/keys/:id` | Revoke a key |
| `GET` | `/v1/usage` | This period's usage, quota and estimated charge |
| `POST` | `/v1/ai/chat/completions` | OpenAI-compatible chat completion |

### Operator (`Authorization: Bearer <ADMIN_TOKEN>`)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/admin/overview` | Tenants, base MRR, overage estimate, recent events |

### Signing up

```bash
curl -X POST https://ai.mizanconsult.com/v1/tenants \
  -H 'content-type: application/json' \
  -d '{"name":"Acme Ltd","email":"ops@acme.example"}'
```

The response contains the account and **the only copy of the API key that will ever exist**.
Keys are stored as `sha256(pepper + ":" + secret)`; a lost key is revoked and replaced, never
recovered.

### Using the AI API

```bash
curl -X POST https://ai.mizanconsult.com/v1/ai/chat/completions \
  -H "authorization: Bearer $MIZAN_KEY" \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"Explain D1 read replication in one paragraph."}]}'
```

The request and response shapes match OpenAI's chat completions, so an existing client changes
only its base URL and key.

---

## Pricing

Published in the service manifests (`src/services/ai-api.js`, `src/services/mcp-gateway.js`).
Prices are integers in cents and overage rates are integers in **micro-USD per unit**, so no
billing arithmetic ever touches a float.

**Managed AI API** — metered per token.

| Plan | Monthly | Included tokens | Overage per 1k tokens |
|---|---|---|---|
| Free | $0.00 | 50,000 | hard stop — not billed |
| Starter | $29.00 | 1,000,000 | $0.002 |
| Pro | $99.00 | 6,000,000 | $0.002 |
| Business | $349.00 | 30,000,000 | $0.001 |

Worked example: Starter, 2,000,000 tokens → $29.00 + 1,000,000 × 2 µUSD = **$31.00**. That
figure is asserted in the test suite and shown by `GET /v1/pricing`, so the published example
cannot drift from the code.

The free tier has no overage rate, which is what makes it a hard stop rather than a bill.
Paid tiers always have an overage rate, so usage is billed and never refused. That asymmetry is
deliberate and is enforced by tests.

> **Not yet announced.** These prices are implemented and visible on the API, but have not
> been publicly published. Sign-off on the price option and on VAT/GST treatment is still
> outstanding.

---

## Architecture

```
client ──► Worker (src/index.js)
              │
              ├─ static routes ─────────────► catalog, pricing, signup, keys, usage, admin
              │
              └─ registry.match() ──────────► service manifest route
                                                │ authenticate (only source of tenant_id)
                                                │ resolve plan + quota
                                                │ handler does the work
                                                └ ctx.record({ units }) ──► usage ledger
```

- **One Worker, one D1 database, logical multi-tenancy.** Every tenant-scoped query is filtered
  by a `tenant_id` that came from a verified key, never from the request body.
- **Two usage tables.** `usage_events` is an append-only ledger and the billing source of
  truth. `usage_counters` is derived from it and can be rebuilt at any time. Invoices are never
  computed from a counter alone.
- **The service manifest is the modularity boundary.** A new SKU is one file plus one registry
  entry. If adding a service requires editing auth, metering or billing, the contract is wrong.
- **No build step.** Plain ESM JavaScript; `node --check`-equivalent verification via
  `npm run check`, which actually imports the graph and re-validates every manifest.

Design notes live in [`docs/01-tenancy-and-data-model.md`](docs/01-tenancy-and-data-model.md)
and [`docs/02-service-manifest.md`](docs/02-service-manifest.md).

---

## Repository layout

```
src/
  index.js                  HTTP entry point, router, signup, usage, admin
  lib/keys.js               key format, hashing, verification, masking
  lib/http.js               one JSON shape, one error shape, one request id
  lib/money.js              integer cents + micro-USD arithmetic
  lib/auth.js               bearer key → tenant identity; admin token
  lib/store.js              every SQL statement in the system
  services/registry.js      the manifest contract, validation and route matching
  services/ai-api.js        launch SKU: metered chat completions
  services/mcp-gateway.js   declared, priced, not sellable
migrations/0001_init.sql    the whole schema
scripts/check.mjs           module-graph and manifest verification
test/                       unit and HTTP-surface tests
docs/                       tenancy, manifest contract, resource audit, deployment
```

---

## Guardrails

- **Independence.** No shared code, secrets, routes, bindings or tables with Cloudflare OS or
  Mizan Voice. The Hub never writes to either product.
- **Nothing is sold before it can be counted *and* delivered.** A manifest must declare a unit,
  and a sellable service must have at least one route. Both rules fail the build.
- **Fails closed.** Missing pepper, missing admin token or missing database produce a `500`
  with a generic message, never an open door and never a stack trace.
- **Under-bill rather than over-bill.** A failed request records nothing.
