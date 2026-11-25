# Deploy and secrets

## Prerequisites

- Node 20+
- A Cloudflare API token scoped to this account with **Workers Scripts: Edit** and
  **D1: Edit**
- Account id: `1070f42f50aba614a00c682d2957befe`

## 1. Create the database (once)

This is the only new resource the Hub needs. Nothing else is provisioned.

```bash
npx wrangler d1 create mizan-ai-hub
```

Copy the returned `database_id` into `wrangler.toml`, replacing
`REPLACE_WITH_D1_DATABASE_ID`. **Both the deploy workflow and CI refuse to proceed while that
placeholder is present**, so a deploy cannot silently point at no database.

```bash
npm run db:migrate        # apply migrations/0001_init.sql to the remote database
npm run db:migrate:local  # the same, against the local dev database
```

## 2. Set the runtime secrets

Secrets are never written into `wrangler.toml`.

| Secret | Required | Purpose |
|---|---|---|
| `API_KEY_PEPPER` | **Yes** | Mixed into every key hash. Changing it invalidates every issued key. |
| `ADMIN_TOKEN` | **Yes** | Bearer token for `/v1/admin/*`. |
| `STRIPE_SECRET_KEY` | No | Reserved for checkout, blocked on the payment-processor decision. |
| `STRIPE_WEBHOOK_SECRET` | No | Same gate. |

```bash
npx wrangler secret put API_KEY_PEPPER
npx wrangler secret put ADMIN_TOKEN
```

Generate both with real entropy:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

**`API_KEY_PEPPER` is not rotatable in place.** Every stored key hash depends on it. Rotating it
requires issuing new keys to every customer; treat it as a long-lived secret and back it up in
the same place as the database credentials.

Both secrets fail closed: if either is missing, the affected routes return `500 misconfigured`
rather than behaving as if unauthenticated.

## 3. Deploy

```bash
npm run check   # module graph + manifest contract
npm test        # unit and HTTP-surface tests
npx wrangler deploy
```

On GitHub, `.github/workflows/deploy.yml` does this on every push to `main`:

1. `npm run check` and `npm test`
2. refuse to continue if `wrangler.toml` still holds the D1 placeholder
3. refuse to continue if `API_KEY_PEPPER` or `ADMIN_TOKEN` is absent from repository secrets
4. `wrangler d1 migrations apply mizan-ai-hub --remote`
5. `wrangler secret bulk` with the secrets, written to a `umask 077` temp file and deleted
6. `wrangler deploy`
7. optional smoke test against `HUB_BASE_URL`, if that repository variable is set

### Repository secrets to add

| Name | Notes |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Scoped to this repository's deploy. |
| `CLOUDFLARE_ACCOUNT_ID` | `1070f42f50aba614a00c682d2957befe` |
| `API_KEY_PEPPER` | Same value as the Worker secret. |
| `ADMIN_TOKEN` | Same value as the Worker secret. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Optional; only pushed once they exist. |

### Repository variable to add (optional)

| Name | Example |
|---|---|
| `HUB_BASE_URL` | `https://mizan-ai-hub.<subdomain>.workers.dev` |

Setting it enables the post-deploy smoke test, which checks `/health` returns `ok` and
`/v1/pricing` returns `currency: "USD"`. Without it that step is skipped.

## 4. The custom domain — gated

`ai.mizanconsult.com` is **not** configured. Until the DNS gate is approved, the Worker is
reachable only at its `workers.dev` hostname.

When approved:

1. Uncomment the `[env.production]` block in `wrangler.toml` — it carries the route
   `ai.mizanconsult.com/*`, `workers_dev = false`, production vars, and its own D1 and AI
   bindings.
2. Set `ALLOWED_ORIGINS` to the real front-end origin rather than `*`.
3. Change `package.json`'s `deploy` script to `wrangler deploy --env production`.
4. Add `--env production` to the `d1 migrations apply` and `secret bulk` commands in the
   workflow.
5. Set `HUB_BASE_URL` to `https://ai.mizanconsult.com`.

Until then, do not publish the hostname in customer-facing material: `workers.dev` is not a
brand.

## Rollback

Cloudflare keeps previous versions. To roll back:

```bash
npx wrangler deployments list
npx wrangler rollback [deployment-id]
```

Schema changes are **not** automatically rolled back. `0001_init.sql` is additive only, so a
Worker rollback is safe against the current schema. Any future migration that drops or renames
a column must ship as two deploys — expand, then contract — so that the previous Worker version
can still run during a rollback window.

## Operational checks

```bash
curl -s https://<host>/health | jq
curl -s https://<host>/v1/pricing | jq '.services[].plans[] | {id, price_monthly_display}'
curl -s https://<host>/v1/admin/overview -H "authorization: Bearer $ADMIN_TOKEN" | jq
```

`/v1/admin/overview` reports tenant count, base MRR, an overage estimate for the current period
and the 25 most recent usage events. It is explicitly labelled an **estimate, not an invoice**:
invoices must be computed from the `usage_events` ledger.

Watch in the dashboard:

- **5xx rate.** A `500 internal_error` almost always means a missing binding or secret.
- **D1 rows read.** A sudden rise suggests a query lost its `tenant_id` index.
- **Workers AI errors.** A `502 upstream_error` from `/v1/ai/chat/completions` is a provider
  problem; no units are recorded for those requests.

## Independence checklist before every release

- [ ] No change to any Cloudflare OS Worker, binding, route, KV namespace, R2 bucket or D1 database.
- [ ] No change to Mizan Voice.
- [ ] No shared secret between the Hub and either product.
- [ ] No shared table or database.
- [ ] No code imported from either repository.
- [ ] The Hub's `ALLOWED_ORIGINS` does not grant either product anything a customer does not have.
