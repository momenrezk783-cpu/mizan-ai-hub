import { parseKey, verifyKey, timingSafeEqual } from "./keys.js";
import { fail } from "./http.js";
import { findKeyByPrefix, touchApiKey } from "./store.js";

export function bearerToken(request) {
  const header = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * Authenticates a request from its API key and returns the tenant identity every downstream
 * query is scoped by. This is the only place tenant_id enters the system.
 */
export async function authenticate(request, env, execCtx) {
  const token = bearerToken(request);
  if (!token) {
    throw fail(401, "missing_credentials", "Send an API key as: Authorization: Bearer <key>");
  }

  const parsed = parseKey(token);
  if (!parsed) throw fail(401, "invalid_key", "That API key is not valid.");

  const pepper = env.API_KEY_PEPPER;
  if (!pepper) {
    throw fail(500, "misconfigured", "API_KEY_PEPPER is not set on this deployment.");
  }

  const row = await findKeyByPrefix(env.DB, parsed.prefix);
  // One message for unknown prefix, wrong secret and mode mismatch: never confirm which.
  const rejected = () => fail(401, "invalid_key", "That API key is not valid.");
  if (!row) throw rejected();
  if (row.mode !== parsed.mode) throw rejected();
  if (row.revoked_at) throw fail(401, "revoked_key", "That API key has been revoked.");

  const matches = await verifyKey({
    pepper,
    storedHash: row.secret_hash,
    secret: parsed.secret,
  });
  if (!matches) throw rejected();

  if (row.tenant_status !== "active") {
    throw fail(403, "tenant_inactive", "This account is not active. Contact support.");
  }

  // Best effort, off the response path: a failed timestamp write must not fail the request.
  const touch = touchApiKey(env.DB, row.id).catch(() => {});
  if (execCtx?.waitUntil) execCtx.waitUntil(touch);
  else await touch;

  return {
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    keyId: row.id,
    mode: row.mode,
  };
}

/** Admin routes use a single operator token, never a tenant key. */
export function requireAdmin(request, env) {
  const configured = env.ADMIN_TOKEN;
  if (!configured) {
    throw fail(500, "misconfigured", "ADMIN_TOKEN is not set on this deployment.");
  }
  const presented = bearerToken(request);
  if (!presented || !timingSafeEqual(presented, configured)) {
    throw fail(401, "unauthorized", "An admin token is required.");
  }
}
