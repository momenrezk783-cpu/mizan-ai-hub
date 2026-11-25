// HTTP helpers shared by every route. One error shape, one JSON shape, one request id.

export class ApiError extends Error {
  constructor(status, code, message, extra = undefined) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function fail(status, code, message, extra) {
  return new ApiError(status, code, message, extra);
}

export function json(data, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data, null, 2) + "\n", { ...init, headers });
}

export function empty(status, init = {}) {
  return new Response(null, { ...init, status });
}

/** Reads a JSON body, refusing anything that is not an object. */
export async function readJson(request) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw fail(415, "unsupported_media_type", "Send Content-Type: application/json.");
  }
  let parsed;
  try {
    parsed = await request.json();
  } catch {
    throw fail(400, "invalid_json", "The request body is not valid JSON.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw fail(400, "invalid_body", "The request body must be a JSON object.");
  }
  return parsed;
}

export function requireString(body, field, { maxLength = 200, minLength = 1 } = {}) {
  const value = body[field];
  if (typeof value !== "string") {
    throw fail(400, "invalid_field", `"${field}" is required and must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length < minLength) {
    throw fail(400, "invalid_field", `"${field}" must be at least ${minLength} character(s).`);
  }
  if (trimmed.length > maxLength) {
    throw fail(400, "invalid_field", `"${field}" must be at most ${maxLength} characters.`);
  }
  return trimmed;
}

export function optionalString(body, field, fallback = "", maxLength = 200) {
  if (body[field] === undefined || body[field] === null) return fallback;
  return requireString(body, field, { maxLength, minLength: 0 });
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function requireEmail(body, field = "email") {
  const value = requireString(body, field, { maxLength: 254 });
  if (!EMAIL_PATTERN.test(value)) {
    throw fail(400, "invalid_field", `"${field}" must be a valid email address.`);
  }
  return value.toLowerCase();
}

/** Stable slug for a tenant name; collisions are resolved by the caller. */
export function slugify(text) {
  return String(text)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "tenant";
}

export function corsHeaders(env, request) {
  const configured = String(env.ALLOWED_ORIGINS || "").trim();
  const origin = request.headers.get("origin");
  const headers = new Headers();
  headers.set("vary", "origin");

  if (configured === "*") {
    headers.set("access-control-allow-origin", "*");
  } else if (origin && configured.split(",").map((entry) => entry.trim()).includes(origin)) {
    headers.set("access-control-allow-origin", origin);
  }
  headers.set("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  headers.set("access-control-allow-headers", "authorization, content-type");
  headers.set("access-control-max-age", "86400");
  return headers;
}

export function errorResponse(error, requestId) {
  const isApiError = error instanceof ApiError;
  const status = isApiError ? error.status : 500;
  const body = {
    error: {
      code: isApiError ? error.code : "internal_error",
      message: isApiError ? error.message : "Something went wrong on our side.",
      request_id: requestId,
    },
  };
  if (isApiError && error.extra !== undefined) body.error.detail = error.extra;
  return json(body, { status });
}

/** UTC month, used as the usage period key. */
export function currentPeriod(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}
