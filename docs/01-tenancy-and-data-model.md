# Tenancy and data model

## The isolation invariant

> `tenant_id` is derived from a verified API key or session, never from request input.

This is the whole security model in one line. `authenticate()` in `src/lib/auth.js` is the only
function that produces a `tenant_id`, and it produces it from a database row reached by the
key's prefix after the key's secret has been verified. No route handler accepts a tenant
identifier from a body, query string or header. If a future feature seems to need one, the
feature is wrong.

Every tenant-scoped table has a composite index that **leads with `tenant_id`**, so a query
that forgets its tenant filter is also a query that misses every index — a loud failure, not a
quiet one.

## Why logical tenancy, not a database per tenant

D1 bills per database. A database per tenant would make the marginal cost of a free-tier
signup non-zero and would turn a self-service funnel into a provisioning pipeline. Every query
in `src/lib/store.js` therefore takes `tenantId` as its first argument after the binding.

Physical isolation remains available as an enterprise escape hatch **on the same schema**: the
migration is written so it can be applied verbatim to a dedicated database, and the only change
required is which `DB` binding a tenant's requests are routed to. That is a routing decision,
not a schema decision, so it does not need to be made now.

## Tables

### `tenants`

One row per customer account.

| Column | Notes |
|---|---|
| `id` | `ten_<24 hex>`, generated server-side |
| `slug` | Stable, derived from the name; collision-suffixed |
| `name`, `email` | `email` is unique and lowercased at the boundary |
| `status` | `active` / `suspended`; anything but `active` yields `403 tenant_inactive` |
| `created_at` | ISO 8601 UTC |

### `api_keys`

| Column | Notes |
|---|---|
| `id` | `key_<24 hex>` |
| `tenant_id` | The only place a tenant identity is bound to a credential |
| `prefix` | 12 characters, unique, indexed — the lookup key for authentication |
| `secret_hash` | `sha256(pepper + ":" + secret)`; the plaintext is never stored |
| `mode` | `live` or `test`; a mode mismatch is rejected as an invalid key |
| `revoked_at` | `NULL` while usable; revocation is a timestamp, never a delete |
| `last_used_at` | Best-effort, written off the response path via `waitUntil` |

Authentication deliberately gives one message — *"That API key is not valid."* — for an unknown
prefix, a wrong secret and a mode mismatch. Distinguishing them would let an attacker
enumerate valid prefixes.

### `plans`

The manifest's prices, mirrored into storage so an invoice can be reproduced after a price
change. Primary key is `(service_id, id)`.

Prices are `price_monthly_cents` (integer cents) and `overage_micros_per_unit` (integer
micro-USD). **No column in this schema is a float.** One dollar is 1,000,000 micro-USD, so a
rate of `$0.002` per 1,000 tokens is stored as `2` per token.

### `subscriptions`

`UNIQUE(tenant_id, service_id)` — one active plan per service per tenant. Foreign key to
`plans`. Signup opens the free subscription automatically; changing plan updates this row
rather than appending, because plan history belongs in the audit log.

### `usage_events` — the billing source of truth

Append-only. One row per metered request.

| Column | Notes |
|---|---|
| `units` | Billable units; `0` for a request that failed |
| `billable` | Explicit flag, so a zero-unit success and a zero-unit failure differ |
| `status`, `latency_ms`, `request_id` | Operational evidence for support |
| `period` | `YYYY-MM`, the billing period key |

Rows are never updated or deleted. A correction is a new row. This is what makes an invoice
defensible: every cent can be traced to a request id.

### `usage_counters` — derived, rebuildable

`PRIMARY KEY (tenant_id, service_id, period)`. Maintained in the same batch as the ledger
insert so reads stay cheap, but it is **never** the billing authority. It can be rebuilt from
`usage_events` at any time, and a reconciliation job should verify it does not drift.

The rule: read the counter for quota checks and dashboards; compute invoices from the ledger.

### `invoices`

Reserved for the payment integration. Present in the schema so the billing model is complete,
unused until a payment processor is chosen.

### `audit_log`

Who did what: `tenant.created`, `key.created`, `key.revoked`. `actor` is `self-service` for
signup and the key id for authenticated actions.

## Money arithmetic

`src/lib/money.js` is the only place billing arithmetic happens.

- All inputs must be **non-negative integers**; a float throws `TypeError`. Money never
  silently rounds.
- There is exactly **one rounding point**: `microsToCents()`, half up.
- `monthlyChargeCents(plan, units)` = base price + `overageUnits × overageMicrosPerUnit`
  converted once.
- `estimateTokens()` exists only for the pre-flight quota check. It is never a billing figure;
  the bill uses the provider's reported `usage.total_tokens`.

## Metering flow

```
request ─► authenticate ─► resolve plan ─► quota check (402 if a hard-stop plan is exhausted)
        ─► handler does the work
        ─► ctx.record({ units })  ─► append usage_events + upsert usage_counters
```

Quota is checked **before** the work and units are recorded **after** it, because the cost is
only known once the provider reports it. A `4xx` or `5xx` records nothing: the handler never
reaches `record()`, or records zero units.

### Hard stop vs. billed overage

A plan with `overageMicrosPerUnit === 0` is a hard stop: once `includedUnits` is exhausted the
next request is refused with `402 quota_exceeded`. A plan with a non-zero overage rate is
billed instead, so `remainingUnits` is `null` and nothing is ever refused.

This is why the free tier can never produce a surprise bill and a paid tier can never be
silently throttled. Both behaviours are asserted in `test/registry.test.js`.

## Deliberate omissions

- **No soft deletes** except `api_keys.revoked_at`, which must be observable.
- **No `updated_at` triggers** — every mutation is explicit in `store.js`.
- **No tenant-supplied ids.** All ids are generated server-side.
- **No PII beyond name and email.** Nothing else is needed to bill or to support.
