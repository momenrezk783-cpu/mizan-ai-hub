# Resource audit — what already exists, and what the Hub must not duplicate

Read-only audit of the Cloudflare account that hosts Mizan Voice and Cloudflare OS, performed
to answer one question: **what can the Hub reuse instead of provisioning?**

Standing instruction for this audit: read-only, no paid resource provisioning, no duplicate
infrastructure, and no modification of an existing Worker without explicit approval.

- **Account id:** `1070f42f50aba614a00c682d2957befe` (committed in Cloudflare OS's CI).
- **Source of truth:** the committed `wrangler`/`cloudflare.config.ts` deploy configuration in
  each repository, not the dashboard. Deploy config is deployed intent.

## The deployed Cloudflare OS stack

Cloudflare OS is a pnpm monorepo, not a single Worker. The `mizanconsult` instance runs six
Workers, all on `compatibility_date: 2026-09-04`:

| Worker | Role | Notable bindings |
|---|---|---|
| `mizanconsult` | Router (`packages/router/src/index.ts`) | `ASSETS`, service bindings to the five below |
| `mizanconsult-backend` | Workshop backend | KV `AVATARS`, KV `BLUEPRINTS`, R2 `mizanconsult-blueprint-content`, `WORKERS_AI`, `BROWSER`, `LOADER`, Durable Objects for user, overseer, admin settings, pending login, user directory, admin audit |
| `mizanconsult-gk-context` | Gatekeeper | `sharingDomain: https://manage.mizanconsult.com/` |
| `mizanconsult-gk-scheduler` | Gatekeeper | — |
| `mizanconsult-gk-websearch` | Gatekeeper | Workers AI |
| `mizanconsult-github-connector` | Gatekeeper | GitHub account/hook Durable Objects, `BASE_URL: https://manage.mizanconsult.com/gatekeeper/github` |

**26 deployable Worker names** are declared across the repository's `cloudflare.config.ts`
files. The production hostname is **`manage.mizanconsult.com`**.

**Consequence:** `ai.mizanconsult.com` is free for the Hub. There is no route, zone or Worker
name collision to resolve.

## Platform capabilities: what is absent

| Capability | In the deployed configs? | Consequence for the Hub |
|---|---|---|
| **D1** | **No — zero databases** | The Hub needs **one new D1 database**. This is its only genuinely new storage. |
| Vectorize | No | A vector/RAG SKU would be net-new paid infrastructure. Deferred. |
| Hyperdrive | No | No Postgres to front. Irrelevant. |
| Queues | No | Metering must be synchronous, which it is. |
| Workers AI | **Yes**, bound on four Workers | Adding the `AI` binding to the Hub provisions nothing new. |
| AI Gateway | **Yes**, via environment variables rather than a binding | Reuse the *pattern*, not the code. See below. |
| R2 | Yes (blueprint content) | Not needed by the Hub. |
| Durable Objects | Yes, several | Not needed by the Hub; its state is relational. |

So the marginal infrastructure cost of the Hub is **one D1 database**, and D1's free tier covers
early usage comfortably. Nothing else is provisioned.

## Reuse: AI Gateway

Cloudflare OS reads AI Gateway configuration from environment variables — `CF_AI_GATEWAY`,
`_ACCOUNT_ID`, `_PROVIDERS`, `_API_TOKEN`, `_USE_BINDING` — in
`packages/workshop-backend/src/ai-gateway.ts`, which already reads **per-request cost** from the
gateway response.

The Hub's AI API meters the same way: it bills the provider's reported token usage rather than
estimating. The *pattern* is reused deliberately; **no code is shared**, because sharing code
would couple two products that must stay independent.

Cloudflare OS also documents a per-user daily free allowance in
`docs/ai-gateway-billing.md` (implementation under
`packages/workshop-backend/src/ai-gateway-billing/`). The Hub's free tier is the same idea at a
different scope — per tenant rather than per user — and is implemented independently against
its own ledger.

## Reuse: Workers AI

The `AI` binding is already enabled on four Cloudflare OS Workers, so binding it in the Hub
requires no account-level change and no spend beyond inference. This is the decisive reason the
**Managed AI API ships first**: it is the one SKU that needs no new infrastructure and has a
countable unit today.

## The MCP question, settled

Cloudflare OS already contains three MCP-related pieces. The Hub must not duplicate any of them:

| Existing piece | What it actually is |
|---|---|
| `gatekeeper-mcp` | An MCP **client**. OAuth discovery, `McpAccount` / `McpGatekeeperImpl` Durable Objects, SSRF bounded by `global_fetch_strictly_public`, trust tiers `byo` / `vetted`. |
| `gatekeeper-mcp-portal` | The same client pointed at one administrator-configured portal URL. The only source of `vetted` endpoints. |
| `feat/agent-mcp-server` branch | Adds `packages/workshop-backend/src/mcp-server.ts`: the OS's own agent exposed as a **personal** remote MCP server at `/api/mcp`, stateless Streamable HTTP, bearer = the user's own session token, 13 tools. |

None of these is a **metered, multi-tenant, sellable** MCP endpoint:

- the clients *consume* MCP servers that someone else operates;
- the personal server is authenticated by a first-party session token, has no tenants, no API
  keys, no quotas and no billing.

So the Hub's Managed MCP Gateway is a genuinely different product: a customer-facing endpoint
with Hub API keys, per-tenant quotas, per-tool metering and a price. Building it does not
duplicate anything.

**And it must not be coupled to any of them.** Cloudflare OS and the opencode harness are, or
will be, *customers* of the Hub's endpoint — they call it over HTTPS with a Hub API key, like
anyone else. They are never dependencies of it.

The `feat/agent-mcp-server` branch is additionally **unusable as a base**: it is mixed and
dirty (it rolls `workspace-ads/blueprint.json` from revision 2 back to 1 and deletes ad-studio
tests). It was read for the audit and deliberately not built on.

## SKU order: reversed from the original plan

The original sequence was MCP Gateway first, AI API second. The audit reverses it.

| SKU | Countable unit today? | New infrastructure | Order |
|---|---|---|---|
| Managed AI API | Yes — tokens, reported by the provider | None | **Ships first** |
| Managed MCP Gateway | Yes — tool calls, but nothing produces them yet | An MCP server runtime that does not exist | Second |
| Managed Vector / RAG | Yes — queries | A Vectorize index: net-new paid infrastructure | Deferred |
| WebMCP | Not yet defined | Undefined | Last |

The rule this enforces: **nothing can be sold before it can be counted *and delivered*.** The
AI API can be both today. The MCP gateway can be counted but not delivered, so it is published
with `sellable: false` and an explicit `blockedBy`, its routes return `501`, and signup refuses
it with `409`.

This is the shortest honest path to revenue: one SKU that works, priced, metered and billable,
instead of four that are planned.

## What the Hub did not touch

- No change to any Cloudflare OS Worker, binding, route, D1 database, KV namespace or R2 bucket.
- No change to Mizan Voice.
- No new paid resource: no Vectorize index, no Hyperdrive config, no Queue, no R2 bucket.
- No shared secret and no shared table. The Hub's D1 database is created fresh and belongs to
  the Hub alone.
- No code imported from Cloudflare OS or Mizan Voice. The Hub has no dependency on either.

## Still open (needs the operator, not a tool)

| Item | Why it is open |
|---|---|
| D1 `database_id` | The database must be created in the account and its id committed. |
| `CLOUDFLARE_API_TOKEN` for the Hub repo | Each repository deploys with its own scoped token. |
| `ai.mizanconsult.com` DNS | Custom-domain gate; until approved the Worker stays on `workers.dev`. |
| Payment processor and merchant of record | Blocks checkout, invoices and the Stripe secrets. |
| VAT/GST treatment and price option | Blocks announcing the published prices. |
| Repo names for Mizan Voice Gateway and the opencode harness | Needed to finish the audit of the other two Workers of record. |
