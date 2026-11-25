// The service-manifest contract.
//
// A new sellable service is one manifest file plus one entry in `src/index.js`. If adding a
// service requires touching auth, metering, billing or the catalog, the contract is wrong and
// the contract is what should change — not the service.
//
// Every manifest must declare a countable `unit`. Nothing can be sold before it can be
// counted, so a manifest without a unit fails to load.

const ID_PATTERN = /^[a-z][a-z0-9-]{1,40}$/;
const UNIT_PATTERN = /^[a-z][a-z0-9_]{1,30}$/;
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function validatePlan(serviceId, plan, index, previous) {
  const where = `service "${serviceId}" plan[${index}]`;
  if (!plan || typeof plan !== "object") throw new TypeError(`${where} must be an object`);
  if (!isNonEmptyString(plan.id) || !ID_PATTERN.test(plan.id)) {
    throw new TypeError(`${where}.id must match ${ID_PATTERN}`);
  }
  if (!isNonEmptyString(plan.name)) throw new TypeError(`${where}.name is required`);
  if (!isNonNegativeInteger(plan.priceMonthlyCents)) {
    throw new TypeError(`${where}.priceMonthlyCents must be a non-negative integer (cents)`);
  }
  if (!isNonNegativeInteger(plan.includedUnits)) {
    throw new TypeError(`${where}.includedUnits must be a non-negative integer`);
  }
  if (!isNonNegativeInteger(plan.overageMicrosPerUnit)) {
    throw new TypeError(`${where}.overageMicrosPerUnit must be a non-negative integer (micro-USD)`);
  }
  if (previous && plan.priceMonthlyCents <= previous.priceMonthlyCents) {
    throw new TypeError(
      `${where} must be priced above plan "${previous.id}" (plans ascend by price)`,
    );
  }
  return {
    id: plan.id,
    name: plan.name,
    priceMonthlyCents: plan.priceMonthlyCents,
    includedUnits: plan.includedUnits,
    overageMicrosPerUnit: plan.overageMicrosPerUnit,
    ...(isNonEmptyString(plan.description) ? { description: plan.description } : {}),
  };
}

function validateRoute(serviceId, route, index) {
  const where = `service "${serviceId}" route[${index}]`;
  if (!route || typeof route !== "object") throw new TypeError(`${where} must be an object`);
  if (!METHODS.has(route.method)) {
    throw new TypeError(`${where}.method must be one of ${[...METHODS].join(", ")}`);
  }
  if (!isNonEmptyString(route.path) || !route.path.startsWith("/")) {
    throw new TypeError(`${where}.path must start with "/"`);
  }
  if (typeof route.handler !== "function") {
    throw new TypeError(`${where}.handler must be a function`);
  }
  return {
    method: route.method,
    path: route.path,
    auth: route.auth !== false,
    meter: route.meter !== false,
    handler: route.handler,
  };
}

/**
 * Validates and freezes one manifest. Throws on the first defect, at load time, so a broken
 * service can never serve a request.
 */
export function defineService(manifest) {
  if (!manifest || typeof manifest !== "object") {
    throw new TypeError("a service manifest must be an object");
  }
  if (!isNonEmptyString(manifest.id) || !ID_PATTERN.test(manifest.id)) {
    throw new TypeError(`service id must match ${ID_PATTERN}`);
  }
  const id = manifest.id;

  if (!isNonEmptyString(manifest.name)) throw new TypeError(`service "${id}": name is required`);
  if (!isNonEmptyString(manifest.summary)) throw new TypeError(`service "${id}": summary is required`);

  // The metering contract. Without a countable unit there is nothing to bill.
  if (!isNonEmptyString(manifest.unit) || !UNIT_PATTERN.test(manifest.unit)) {
    throw new TypeError(`service "${id}": unit must match ${UNIT_PATTERN}`);
  }

  if (!Array.isArray(manifest.plans) || manifest.plans.length === 0) {
    throw new TypeError(`service "${id}": at least one plan is required`);
  }
  const seenPlans = new Set();
  const plans = [];
  let previous = null;
  manifest.plans.forEach((plan, index) => {
    const validated = validatePlan(id, plan, index, previous);
    if (seenPlans.has(validated.id)) {
      throw new TypeError(`service "${id}": duplicate plan id "${validated.id}"`);
    }
    seenPlans.add(validated.id);
    plans.push(validated);
    previous = validated;
  });

  const routes = (manifest.routes ?? []).map((route, index) => validateRoute(id, route, index));

  const sellable = manifest.sellable === true;
  if (!sellable && !isNonEmptyString(manifest.blockedBy)) {
    throw new TypeError(
      `service "${id}": a non-sellable service must name what blocks it in "blockedBy"`,
    );
  }

  return Object.freeze({
    id,
    name: manifest.name,
    summary: manifest.summary,
    unit: manifest.unit,
    unitLabel: isNonEmptyString(manifest.unitLabel) ? manifest.unitLabel : manifest.unit,
    sellable,
    ...(sellable ? {} : { blockedBy: manifest.blockedBy }),
    ...(isNonEmptyString(manifest.docsUrl) ? { docsUrl: manifest.docsUrl } : {}),
    plans: Object.freeze(plans),
    routes: Object.freeze(routes),
  });
}

function splitPath(pathname) {
  return pathname.split("/").filter((segment) => segment.length > 0);
}

function matchPattern(patternSegments, pathSegments) {
  if (patternSegments.length !== pathSegments.length) return null;
  const params = {};
  for (let index = 0; index < patternSegments.length; index += 1) {
    const pattern = patternSegments[index];
    const actual = pathSegments[index];
    if (pattern.startsWith(":")) {
      params[pattern.slice(1)] = decodeURIComponent(actual);
    } else if (pattern !== actual) {
      return null;
    }
  }
  return params;
}

/**
 * Builds the registry. Duplicate method+path pairs across services are a load-time error:
 * two services claiming one route would make the catalog lie about what it sells.
 */
export function createRegistry(manifests) {
  if (!Array.isArray(manifests)) throw new TypeError("createRegistry expects an array of manifests");

  const services = manifests.map(defineService);
  const byId = new Map();
  const claimed = new Map();

  for (const service of services) {
    if (byId.has(service.id)) {
      throw new TypeError(`duplicate service id "${service.id}"`);
    }
    byId.set(service.id, service);

    for (const route of service.routes) {
      const key = `${route.method} ${route.path}`;
      if (claimed.has(key)) {
        throw new TypeError(
          `route "${key}" is claimed by both "${claimed.get(key)}" and "${service.id}"`,
        );
      }
      claimed.set(key, service.id);
    }
  }

  return Object.freeze({
    /** All services, sellable first, then by name. */
    list() {
      return [...services].sort((left, right) => {
        if (left.sellable !== right.sellable) return left.sellable ? -1 : 1;
        return left.name.localeCompare(right.name);
      });
    },

    get(id) {
      return byId.get(id) ?? null;
    },

    /** Public catalog. Non-sellable services appear with their blocker stated, never hidden. */
    catalog() {
      return this.list().map((service) => ({
        id: service.id,
        name: service.name,
        summary: service.summary,
        unit: service.unit,
        unit_label: service.unitLabel,
        sellable: service.sellable,
        ...(service.blockedBy ? { blocked_by: service.blockedBy } : {}),
        ...(service.docsUrl ? { docs_url: service.docsUrl } : {}),
        plans: service.plans.map((plan) => ({
          id: plan.id,
          name: plan.name,
          ...(plan.description ? { description: plan.description } : {}),
          price_monthly_cents: plan.priceMonthlyCents,
          included_units: plan.includedUnits,
          overage_micros_per_unit: plan.overageMicrosPerUnit,
        })),
      }));
    },

    /** Finds the service and route for a request, or null. */
    match(method, pathname) {
      const pathSegments = splitPath(pathname);
      for (const service of services) {
        for (const route of service.routes) {
          if (route.method !== method) continue;
          const params = matchPattern(splitPath(route.path), pathSegments);
          if (params) return { service, route, params };
        }
      }
      return null;
    },
  });
}
