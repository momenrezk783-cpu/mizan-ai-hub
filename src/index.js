// Mizan AI Hub — HTTP entry point.
//
// Independence: this Worker shares no binding, secret, route or table with Cloudflare OS or
// Mizan Voice. Cloudflare OS reaches the Hub only over its public HTTPS API, exactly as any
// other customer would.

import { createRegistry } from "./services/registry.js";
import aiApi from "./services/ai-api.js";
import mcpGateway from "./services/mcp-gateway.js";
import {
  fail,
  json,
  currentPeriod,
  corsHeaders,
  errorResponse,
  readJson,
  requireEmail,
  requireString,
  optionalString,
  slugify,
} from "./lib/http.js";
import { authenticate, requireAdmin } from "./lib/auth.js";
import { issueKey, maskKey } from "./lib/keys.js";
import { monthlyChargeCents, formatUsd, overageUnits } from "./lib/money.js";
import * as store from "./lib/store.js";

const registry = createRegistry([aiApi, mcpGateway]);

const VERSION = "0.1.0";

/* ---------------------------------------------------------------------------- handlers */

function handleHealth({ env }) {
  return json({
    status: "ok",
    service: "mizan-ai-hub",
    version: VERSION,
    environment: env.ENVIRONMENT ?? "unknown",
    time: new Date().toISOString(),
  });
}

function handleIndex({ url }) {
  const base = url.origin;
  return json({
    name: "Mizan AI Hub",
    version: VERSION,
    description: "Managed AI services for businesses, developers and website owners.",
    endpoints: {
      health: `${base}/health`,
      services: `${base}/v1/services`,
      pricing: `${base}/v1/pricing`,
      signup: `${base}/v1/tenants`,
      keys: `${base}/v1/keys`,
      usage: `${base}/v1/usage`,
    },
    authentication: "Authorization: Bearer <api-key>",
  });
}

function handleServices() {
  return json({ services: registry.catalog() });
}

function handleService({ params }) {
  const service = registry.get(params.id);
  if (!service) throw fail(404, "service_not_found", `No service with id "${params.id}".`);
  return json({
    id: service.id,
    name: service.name,
    summary: service.summary,
    unit: service.unit,
    unit_label: service.unitLabel,
    sellable: service.sellable,
    ...(service.blockedBy ? { blocked_by: service.blockedBy } : {}),
    plans: service.plans.map((plan) => ({
      id: plan.id,
      name: plan.name,
      price_monthly_cents: plan.priceMonthlyCents,
      price_monthly_display: formatUsd(plan.priceMonthlyCents),
      included_units: plan.includedUnits,
      overage_micros_per_unit: plan.overageMicrosPerUnit,
    })),
    routes: service.routes.map((route) => ({
      method: route.method,
      path: route.path,
      auth_required: route.auth,
    })),
  });
}

function handlePricing() {
  const services = registry.list().map((service) => ({
    id: service.id,
    name: service.name,
    unit: service.unit,
    sellable: service.sellable,
    ...(service.blockedBy ? { blocked_by: service.blockedBy } : {}),
    plans: service.plans.map((plan) => ({
      id: plan.id,
      name: plan.name,
      price_monthly_cents: plan.priceMonthlyCents,
      price_monthly_display: formatUsd(plan.priceMonthlyCents),
      included_units: plan.includedUnits,
      overage_micros_per_unit: plan.overageMicrosPerUnit,
      // Worked example so a buyer can price a month without arithmetic.
      example: {
        units: plan.includedUnits * 2,
        charge_cents: monthlyChargeCents(plan, plan.includedUnits * 2),
        charge_display: formatUsd(monthlyChargeCents(plan, plan.includedUnits * 2)),
      },
    })),
  }));
  return json({ currency: "USD", services });
}

async function handleCreateTenant({ request, env }) {
  const body = await readJson(request);
  const name = requireString(body, "name", { maxLength: 100 });
  const email = requireEmail(body);
  const requestedService = optionalString(body, "service", aiApi.id, 40);

  const service = registry.get(requestedService);
  if (!service) {
    throw fail(400, "unknown_service", `No service with id "${requestedService}".`);
  }
  if (!service.sellable) {
    throw fail(409, "service_not_available", `${service.name} is not available yet.`);
  }

  if (await store.findTenantByEmail(env.DB, email)) {
    throw fail(409, "email_in_use", "An account already exists for that email address.");
  }

  const tenantId = `ten_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  let slug = slugify(name);
  if (await store.findTenantBySlug(env.DB, slug)) {
    slug = `${slug}-${tenantId.slice(-6)}`;
  }

  await store.createTenant(env.DB, { id: tenantId, slug, name, email });

  const periodStart = new Date();
  const periodEnd = new Date(periodStart);
  periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);

  // Mirror this service's pricing into the plans table, then open the free subscription.
  await store.ensureServicePlans(env.DB, service);
  await store.ensureFreeSubscription(env.DB, {
    id: `sub_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
    tenantId,
    service,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
  });

  const key = await issueKey({ mode: "live", pepper: env.API_KEY_PEPPER });
  const keyId = `key_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  await store.insertApiKey(env.DB, {
    id: keyId,
    tenantId,
    prefix: key.prefix,
    secretHash: key.secretHash,
    mode: key.mode,
    label: "Default",
  });

  await store.appendAudit(env.DB, {
    tenantId,
    actor: "self-service",
    action: "tenant.created",
    detail: { service: service.id, email },
  });

  return json(
    {
      tenant: { id: tenantId, slug, name, email, status: "active" },
      subscription: { service_id: service.id, plan_id: "free", status: "active" },
      api_key: {
        id: keyId,
        key: key.plaintext,
        mode: key.mode,
        prefix: key.prefix,
        warning:
          "This is the only time the full key is shown. Store it now; a lost key is revoked and replaced, never recovered.",
      },
    },
    { status: 201 },
  );
}

async function handleListKeys({ env, auth }) {
  const keys = await store.listApiKeys(env.DB, auth.tenantId);
  return json({
    keys: keys.map((row) => ({
      id: row.id,
      masked: maskKey(row.mode, row.prefix),
      mode: row.mode,
      label: row.label,
      created_at: row.created_at,
      last_used_at: row.last_used_at,
      revoked_at: row.revoked_at,
    })),
  });
}

async function handleCreateKey({ request, env, auth }) {
  const body = await readJson(request).catch(() => ({}));
  const label = optionalString(body, "label", "Additional", 60);
  const mode = optionalString(body, "mode", auth.mode, 4);
  if (mode !== "live" && mode !== "test") {
    throw fail(400, "invalid_field", '"mode" must be "live" or "test".');
  }

  const key = await issueKey({ mode, pepper: env.API_KEY_PEPPER });
  const keyId = `key_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  await store.insertApiKey(env.DB, {
    id: keyId,
    tenantId: auth.tenantId,
    prefix: key.prefix,
    secretHash: key.secretHash,
    mode: key.mode,
    label,
  });

  await store.appendAudit(env.DB, {
    tenantId: auth.tenantId,
    actor: auth.keyId,
    action: "key.created",
    detail: { key_id: keyId, mode },
  });

  return json(
    {
      id: keyId,
      key: key.plaintext,
      mode: key.mode,
      label,
      warning: "This is the only time the full key is shown.",
    },
    { status: 201 },
  );
}

async function handleRevokeKey({ env, auth, params }) {
  const revoked = await store.revokeApiKey(env.DB, auth.tenantId, params.id);
  if (!revoked) {
    throw fail(404, "key_not_found", "No active key with that id on this account.");
  }
  await store.appendAudit(env.DB, {
    tenantId: auth.tenantId,
    actor: auth.keyId,
    action: "key.revoked",
    detail: { key_id: params.id },
  });
  return json({ id: params.id, revoked: true });
}

async function handleUsage({ env, auth }) {
  const period = currentPeriod();
  const counters = await store.usageForTenant(env.DB, auth.tenantId, period);

  const services = [];
  for (const service of registry.list()) {
    const counter = counters.find((row) => row.service_id === service.id);
    const used = counter?.units ?? 0;
    const plan = await store.getSubscriptionPlan(env.DB, auth.tenantId, service.id);
    const included = plan?.included_units ?? 0;
    const overageRate = plan?.overage_micros_per_unit ?? 0;
    const chargeCents = plan
      ? monthlyChargeCents(
          {
            priceMonthlyCents: plan.price_monthly_cents,
            includedUnits: included,
            overageMicrosPerUnit: overageRate,
          },
          used,
        )
      : 0;

    services.push({
      service_id: service.id,
      service_name: service.name,
      unit: service.unit,
      subscribed: Boolean(plan),
      plan_id: plan?.plan_id ?? null,
      period,
      units_used: used,
      requests: counter?.requests ?? 0,
      included_units: included,
      overage_units: overageUnits(used, included),
      estimated_charge_cents: chargeCents,
      estimated_charge_display: formatUsd(chargeCents),
    });
  }

  return json({ tenant_id: auth.tenantId, period, services });
}

async function handleAdminOverview({ env }) {
  const period = currentPeriod();
  const [tenantCount, usage, planRows, recent] = await Promise.all([
    store.countTenants(env.DB),
    store.usageByService(env.DB, period),
    store.subscriptionCounts(env.DB),
    store.recentUsageEvents(env.DB, 25),
  ]);

  let baseMrrCents = 0;
  let overageCents = 0;
  const byService = new Map();

  for (const row of planRows) {
    const subscriptions = row.subscriptions ?? 0;
    baseMrrCents += row.price_monthly_cents * subscriptions;

    const serviceUsage = usage.find((entry) => entry.service_id === row.service_id);
    const units = serviceUsage?.units ?? 0;
    const entry = byService.get(row.service_id) ?? {
      service_id: row.service_id,
      units: units,
      requests: serviceUsage?.requests ?? 0,
      subscriptions: 0,
      plans: [],
    };
    entry.subscriptions += subscriptions;
    entry.plans.push({
      plan_id: row.plan_id,
      subscriptions,
      price_monthly_cents: row.price_monthly_cents,
    });
    byService.set(row.service_id, entry);
  }

  // Overage is estimated from this period's actual units at each plan's rate.
  for (const row of planRows) {
    if ((row.subscriptions ?? 0) === 0) continue;
    const serviceUsage = usage.find((entry) => entry.service_id === row.service_id);
    const units = serviceUsage?.units ?? 0;
    const extra = overageUnits(units, row.included_units) * row.overage_micros_per_unit;
    overageCents += Math.round(extra / 10_000);
  }

  return json({
    period,
    tenants: tenantCount,
    revenue: {
      base_mrr_cents: baseMrrCents,
      base_mrr_display: formatUsd(baseMrrCents),
      overage_cents_estimate: overageCents,
      overage_display_estimate: formatUsd(overageCents),
      total_cents_estimate: baseMrrCents + overageCents,
      total_display_estimate: formatUsd(baseMrrCents + overageCents),
      note: "Estimate from active subscriptions and this period's metered usage. Not an invoice.",
    },
    services: [...byService.values()],
    recent_events: recent,
  });
}

/* ------------------------------------------------------------------------------ router */

const ROUTES = [
  { method: "GET", pattern: [], handler: handleIndex },
  { method: "GET", pattern: ["health"], handler: handleHealth },
  { method: "GET", pattern: ["v1", "services"], handler: handleServices },
  { method: "GET", pattern: ["v1", "services", ":id"], handler: handleService },
  { method: "GET", pattern: ["v1", "pricing"], handler: handlePricing },
  { method: "POST", pattern: ["v1", "tenants"], handler: handleCreateTenant },
  { method: "GET", pattern: ["v1", "keys"], handler: handleListKeys, auth: true },
  { method: "POST", pattern: ["v1", "keys"], handler: handleCreateKey, auth: true },
  { method: "DELETE", pattern: ["v1", "keys", ":id"], handler: handleRevokeKey, auth: true },
  { method: "GET", pattern: ["v1", "usage"], handler: handleUsage, auth: true },
  { method: "GET", pattern: ["v1", "admin", "overview"], handler: handleAdminOverview, admin: true },
];

function matchSegments(pattern, segments) {
  if (pattern.length !== segments.length) return null;
  const params = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index];
    const actual = segments[index];
    if (expected.startsWith(":")) params[expected.slice(1)] = decodeURIComponent(actual);
    else if (expected !== actual) return null;
  }
  return params;
}

/**
 * Runs a route declared by a service manifest: authenticate, resolve the plan, enforce the
 * quota before any work is done, then let the handler record what it actually consumed.
 */
async function runServiceRoute(matched, base) {
  const { service, route, params } = matched;
  const { request, env, execCtx, requestId } = base;

  const auth = route.auth ? await authenticate(request, env, execCtx) : null;
  const period = currentPeriod();

  let plan = null;
  let remainingUnits = null;

  if (auth) {
    plan = await store.getSubscriptionPlan(env.DB, auth.tenantId, service.id);
    if (!plan) {
      // No subscription yet: fall back to the free plan so the call is still metered.
      const freePlan = service.plans.find((entry) => entry.priceMonthlyCents === 0);
      if (freePlan) {
        plan = {
          plan_id: freePlan.id,
          price_monthly_cents: freePlan.priceMonthlyCents,
          included_units: freePlan.includedUnits,
          overage_micros_per_unit: freePlan.overageMicrosPerUnit,
        };
      }
    }
    if (plan) {
      const used = await store.getUsedUnits(env.DB, auth.tenantId, service.id, period);
      // A plan with no overage rate is a hard stop; one with overage is billed, not refused.
      remainingUnits = plan.overage_micros_per_unit > 0
        ? null
        : Math.max(0, plan.included_units - used);
    }
  }

  const started = Date.now();

  const ctx = {
    request,
    env,
    execCtx,
    params,
    service,
    plan,
    requestId,
    period,
    remainingUnits,
    auth,
    /** Records the units this call actually consumed. Called once, by the handler. */
    async record({ units }) {
      if (!auth || !route.meter) return;
      const billable = units > 0;
      await store.recordUsage(env.DB, {
        tenantId: auth.tenantId,
        serviceId: service.id,
        apiKeyId: auth.keyId,
        units: billable ? units : 0,
        billable,
        status: 200,
        latencyMs: Date.now() - started,
        requestId,
        period,
      });
    },
  };

  return route.handler(ctx);
}

async function dispatch(request, env, execCtx, url, requestId) {
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);

  for (const entry of ROUTES) {
    if (entry.method !== request.method) continue;
    const params = matchSegments(entry.pattern, segments);
    if (!params) continue;

    if (entry.admin) requireAdmin(request, env);
    const auth = entry.auth ? await authenticate(request, env, execCtx) : null;
    return entry.handler({ request, env, execCtx, url, requestId, params, auth });
  }

  const matched = registry.match(request.method, url.pathname);
  if (matched) return runServiceRoute(matched, { request, env, execCtx, url, requestId });

  throw fail(404, "not_found", `No route for ${request.method} ${url.pathname}.`);
}

export default {
  async fetch(request, env, execCtx) {
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);
    const cors = corsHeaders(env, request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    let response;
    try {
      response = await dispatch(request, env, execCtx, url, requestId);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      response = errorResponse(error, requestId);
    }

    const headers = new Headers(response.headers);
    for (const [name, value] of cors) headers.set(name, value);
    headers.set("x-request-id", requestId);
    return new Response(response.body, { status: response.status, headers });
  },
};
