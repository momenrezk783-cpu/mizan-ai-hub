-- Mizan AI Hub — initial schema.
--
-- Isolation invariant: every tenant-scoped table carries tenant_id, every index leads with
-- tenant_id, and tenant_id is ALWAYS derived from a verified API key or session. It is never
-- read from request input. Any query that lacks a tenant_id predicate is a bug.
--
-- Money is integer cents (price_monthly_cents, subtotal_cents) and integer micro-USD
-- (overage_micros_per_unit). No floats anywhere.

PRAGMA foreign_keys = ON;

CREATE TABLE tenants (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'suspended', 'closed')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_tenants_email ON tenants (email);

-- Only sha256(pepper || secret) is stored. `prefix` is public and is the lookup key.
CREATE TABLE api_keys (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  prefix       TEXT NOT NULL UNIQUE,
  secret_hash  TEXT NOT NULL,
  mode         TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  label        TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at TEXT,
  revoked_at   TEXT
);

CREATE INDEX idx_api_keys_tenant ON api_keys (tenant_id, created_at DESC);

-- Mirrors the service manifests. Written by `npm run db:seed-plans` so that foreign keys
-- from subscriptions hold, while the manifest stays the single source of truth for pricing.
CREATE TABLE plans (
  service_id               TEXT NOT NULL,
  id                       TEXT NOT NULL,
  name                     TEXT NOT NULL,
  price_monthly_cents      INTEGER NOT NULL CHECK (price_monthly_cents >= 0),
  included_units           INTEGER NOT NULL CHECK (included_units >= 0),
  overage_micros_per_unit  INTEGER NOT NULL CHECK (overage_micros_per_unit >= 0),
  PRIMARY KEY (service_id, id)
);

CREATE TABLE subscriptions (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  service_id           TEXT NOT NULL,
  plan_id              TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'past_due', 'canceled')),
  current_period_start TEXT NOT NULL,
  current_period_end   TEXT NOT NULL,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, service_id),
  FOREIGN KEY (service_id, plan_id) REFERENCES plans (service_id, id)
);

CREATE INDEX idx_subscriptions_tenant ON subscriptions (tenant_id);

-- Append-only ledger. This is the billing source of truth. Never updated, never deleted.
-- billable = 0 for 4xx/5xx: we prefer to under-bill rather than over-bill.
CREATE TABLE usage_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   TEXT NOT NULL,
  service_id  TEXT NOT NULL,
  api_key_id  TEXT,
  units       INTEGER NOT NULL CHECK (units >= 0),
  billable    INTEGER NOT NULL CHECK (billable IN (0, 1)),
  status      INTEGER NOT NULL,
  latency_ms  INTEGER,
  request_id  TEXT,
  period      TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_usage_events_tenant_period ON usage_events (tenant_id, service_id, period);
CREATE INDEX idx_usage_events_created ON usage_events (created_at);

-- Derived, rebuildable cache of the ledger, used only for the pre-flight quota check.
-- Never bill from this table.
CREATE TABLE usage_counters (
  tenant_id  TEXT NOT NULL,
  service_id TEXT NOT NULL,
  period     TEXT NOT NULL,
  units      INTEGER NOT NULL DEFAULT 0,
  requests   INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, service_id, period)
);

CREATE TABLE invoices (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  period         TEXT NOT NULL,
  subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents >= 0),
  status         TEXT NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft', 'open', 'paid', 'void', 'uncollectible')),
  issued_at      TEXT,
  paid_at        TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, period)
);

CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  TEXT,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_audit_log_tenant ON audit_log (tenant_id, created_at DESC);
