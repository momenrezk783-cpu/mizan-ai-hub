-- Public enquiries about services that are delivered by a human, not by the API.
--
-- Not tenant-scoped on purpose: a lead arrives before any account, key or tenant exists.
-- tenant_id is therefore absent rather than nullable, so no query can accidentally join a
-- lead to an account it does not belong to.
--
-- status is a sales pipeline, not billing state. Nothing here is ever invoiced.

CREATE TABLE leads (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  email      TEXT NOT NULL,
  company    TEXT NOT NULL DEFAULT '',
  website    TEXT NOT NULL DEFAULT '',
  interest   TEXT NOT NULL DEFAULT 'visibility-audit',
  message    TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'new'
             CHECK (status IN ('new', 'contacted', 'quoted', 'won', 'lost', 'spam')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_leads_created ON leads (created_at DESC);
CREATE INDEX idx_leads_email ON leads (email);
