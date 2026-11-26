// All database access. Every tenant-scoped statement takes tenant_id as a bound parameter
// derived from a verified key — never from request input.

export function nowIso() {
  return new Date().toISOString();
}

/* -------------------------------------------------------------------------- tenants */

export async function createTenant(db, { id, slug, name, email }) {
  await db
    .prepare(
      `INSERT INTO tenants (id, slug, name, email) VALUES (?, ?, ?, ?)`,
    )
    .bind(id, slug, name, email)
    .run();
  return { id, slug, name, email, status: "active" };
}

export async function findTenantByEmail(db, email) {
  return db.prepare(`SELECT * FROM tenants WHERE email = ? LIMIT 1`).bind(email).first();
}

export async function findTenantBySlug(db, slug) {
  return db.prepare(`SELECT * FROM tenants WHERE slug = ? LIMIT 1`).bind(slug).first();
}

export async function getTenant(db, tenantId) {
  return db.prepare(`SELECT * FROM tenants WHERE id = ? LIMIT 1`).bind(tenantId).first();
}

export async function countTenants(db) {
  const row = await db.prepare(`SELECT COUNT(*) AS total FROM tenants`).first();
  return row?.total ?? 0;
}

/* -------------------------------------------------------------------------- api keys */

export async function insertApiKey(db, { id, tenantId, prefix, secretHash, mode, label }) {
  await db
    .prepare(
      `INSERT INTO api_keys (id, tenant_id, prefix, secret_hash, mode, label)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, tenantId, prefix, secretHash, mode, label)
    .run();
}

/** Looks a key up by its public prefix and joins the tenant status needed for the auth check. */
export async function findKeyByPrefix(db, prefix) {
  return db
    .prepare(
      `SELECT k.id, k.tenant_id, k.secret_hash, k.mode, k.revoked_at,
              t.status AS tenant_status, t.name AS tenant_name
       FROM api_keys k
       JOIN tenants t ON t.id = k.tenant_id
       WHERE k.prefix = ?
       LIMIT 1`,
    )
    .bind(prefix)
    .first();
}

export async function touchApiKey(db, keyId) {
  await db
    .prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`)
    .bind(nowIso(), keyId)
    .run();
}

export async function listApiKeys(db, tenantId) {
  const { results } = await db
    .prepare(
      `SELECT id, prefix, mode, label, created_at, last_used_at, revoked_at
       FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC`,
    )
    .bind(tenantId)
    .all();
  return results ?? [];
}

export async function revokeApiKey(db, tenantId, keyId) {
  const result = await db
    .prepare(
      `UPDATE api_keys SET revoked_at = ?
       WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL`,
    )
    .bind(nowIso(), keyId, tenantId)
    .run();
  return (result?.meta?.changes ?? 0) > 0;
}

/* -------------------------------------------------------------------------- plans */

/**
 * Mirrors a service's manifest pricing into the plans table. Called when a tenant is created,
 * so a new service's plans exist before any subscription can reference them.
 */
export async function ensureServicePlans(db, service) {
  if (service.plans.length === 0) return;
  const statement = db.prepare(
    `INSERT INTO plans (service_id, id, name, price_monthly_cents, included_units, overage_micros_per_unit)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (service_id, id) DO UPDATE SET
       name = excluded.name,
       price_monthly_cents = excluded.price_monthly_cents,
       included_units = excluded.included_units,
       overage_micros_per_unit = excluded.overage_micros_per_unit`,
  );
  await db.batch(
    service.plans.map((plan) =>
      statement.bind(
        service.id,
        plan.id,
        plan.name,
        plan.priceMonthlyCents,
        plan.includedUnits,
        plan.overageMicrosPerUnit,
      ),
    ),
  );
}

export async function getSubscriptionPlan(db, tenantId, serviceId) {
  return db
    .prepare(
      `SELECT s.plan_id, p.price_monthly_cents, p.included_units, p.overage_micros_per_unit
       FROM subscriptions s
       JOIN plans p ON p.service_id = s.service_id AND p.id = s.plan_id
       WHERE s.tenant_id = ? AND s.service_id = ? AND s.status = 'active'
       LIMIT 1`,
    )
    .bind(tenantId, serviceId)
    .first();
}

export async function ensureFreeSubscription(db, { id, tenantId, service, periodStart, periodEnd }) {
  const freePlan = service.plans.find((plan) => plan.priceMonthlyCents === 0);
  if (!freePlan) return;
  await db
    .prepare(
      `INSERT INTO subscriptions
         (id, tenant_id, service_id, plan_id, status, current_period_start, current_period_end)
       VALUES (?, ?, ?, ?, 'active', ?, ?)
       ON CONFLICT (tenant_id, service_id) DO NOTHING`,
    )
    .bind(id, tenantId, service.id, freePlan.id, periodStart, periodEnd)
    .run();
}

/* -------------------------------------------------------------------------- usage */

/**
 * Appends to the ledger and updates the derived counter in one batch.
 * The ledger is the source of truth; the counter is a cache that can be rebuilt from it.
 */
export async function recordUsage(db, entry) {
  const timestamp = nowIso();
  await db.batch([
    db
      .prepare(
        `INSERT INTO usage_events
           (tenant_id, service_id, api_key_id, units, billable, status, latency_ms, request_id, period)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        entry.tenantId,
        entry.serviceId,
        entry.apiKeyId ?? null,
        entry.units,
        entry.billable ? 1 : 0,
        entry.status,
        entry.latencyMs ?? null,
        entry.requestId ?? null,
        entry.period,
      ),
    db
      .prepare(
        `INSERT INTO usage_counters (tenant_id, service_id, period, units, requests, updated_at)
         VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT (tenant_id, service_id, period) DO UPDATE SET
           units = units + excluded.units,
           requests = requests + 1,
           updated_at = excluded.updated_at`,
      )
      .bind(entry.tenantId, entry.serviceId, entry.period, entry.units, timestamp),
  ]);
}

export async function getUsedUnits(db, tenantId, serviceId, period) {
  const row = await db
    .prepare(
      `SELECT units FROM usage_counters
       WHERE tenant_id = ? AND service_id = ? AND period = ? LIMIT 1`,
    )
    .bind(tenantId, serviceId, period)
    .first();
  return row?.units ?? 0;
}

export async function usageForTenant(db, tenantId, period) {
  const { results } = await db
    .prepare(
      `SELECT service_id, units, requests FROM usage_counters
       WHERE tenant_id = ? AND period = ? ORDER BY service_id`,
    )
    .bind(tenantId, period)
    .all();
  return results ?? [];
}

export async function usageByService(db, period) {
  const { results } = await db
    .prepare(
      `SELECT service_id, SUM(units) AS units, SUM(requests) AS requests
       FROM usage_counters WHERE period = ? GROUP BY service_id`,
    )
    .bind(period)
    .all();
  return results ?? [];
}

/* -------------------------------------------------------------------------- admin */

export async function subscriptionCounts(db) {
  const { results } = await db
    .prepare(
      `SELECT p.service_id, p.id AS plan_id, p.price_monthly_cents,
              p.included_units, p.overage_micros_per_unit, COUNT(s.id) AS subscriptions
       FROM plans p
       LEFT JOIN subscriptions s
         ON s.service_id = p.service_id AND s.plan_id = p.id AND s.status = 'active'
       GROUP BY p.service_id, p.id
       ORDER BY p.service_id, p.price_monthly_cents`,
    )
    .all();
  return results ?? [];
}

export async function recentUsageEvents(db, limit = 50) {
  const { results } = await db
    .prepare(
      `SELECT tenant_id, service_id, units, billable, status, created_at
       FROM usage_events ORDER BY id DESC LIMIT ?`,
    )
    .bind(limit)
    .all();
  return results ?? [];
}

export async function appendAudit(db, { tenantId, actor, action, detail }) {
  await db
    .prepare(`INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES (?, ?, ?, ?)`)
    .bind(tenantId ?? null, actor, action, detail ? JSON.stringify(detail) : null)
    .run();
}

/* -------------------------------------------------------------------------- leads */

/**
 * Records a public enquiry. Leads are not tenant-scoped: they exist before an account does.
 * Re-submitting the same email is allowed — a business may ask twice, and losing the second
 * enquiry would lose the deal.
 */
export async function insertLead(db, { id, name, email, company, website, interest, message }) {
  await db
    .prepare(
      `INSERT INTO leads (id, name, email, company, website, interest, message)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, name, email, company, website, interest, message)
    .run();
}

export async function countLeads(db) {
  const row = await db.prepare(`SELECT COUNT(*) AS total FROM leads`).first();
  return row?.total ?? 0;
}

export async function recentLeads(db, limit = 25) {
  const { results } = await db
    .prepare(
      `SELECT id, name, email, company, website, interest, message, status, created_at
       FROM leads ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all();
  return results ?? [];
}
