// Tests for public enquiry capture — the entry point to the AI-visibility service.
//
// A lead is the only write on the site that creates no tenant and no key, so it gets its own
// file: the failure that matters is a lost enquiry, and a lost enquiry is silent.

import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";

const ORIGIN = "https://ai.mizanconsult.com";

function fakeDb(rules = []) {
  const answer = (sql) => rules.find((rule) => rule.match.test(sql)) ?? {};
  const resolve = (fn, sql, args, fallback) =>
    typeof fn === "function" ? fn(sql, args) : (fn ?? fallback);

  const statement = (sql) => {
    const self = {
      sql,
      args: [],
      bind(...args) {
        self.args = args;
        return self;
      },
      async first() {
        const rule = answer(sql);
        return resolve(rule.first, sql, self.args, null);
      },
      async all() {
        const rule = answer(sql);
        return { results: resolve(rule.all, sql, self.args, []) };
      },
      async run() {
        const rule = answer(sql);
        return resolve(rule.run, sql, self.args, { meta: { changes: 1 } });
      },
    };
    return self;
  };

  return {
    prepare: statement,
    async batch(statements) {
      return statements.map(() => ({ meta: { changes: 1 } }));
    },
  };
}

function env(overrides = {}) {
  return {
    ENVIRONMENT: "test",
    DEFAULT_AI_MODEL: "@cf/meta/llama-3.1-8b-instruct",
    ALLOWED_ORIGINS: "*",
    API_KEY_PEPPER: "test-pepper",
    ADMIN_TOKEN: "test-admin-token",
    DB: fakeDb(),
    ...overrides,
  };
}

function call(path, init, envOverrides) {
  return worker.fetch(new Request(`${ORIGIN}${path}`, init), env(envOverrides), {});
}

const post = (path, body, envOverrides) =>
  call(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    envOverrides,
  );

const bearer = (token) => ({ headers: { authorization: `Bearer ${token}` } });

/** Captures the bound parameters of every INSERT INTO leads. */
function capturingDb() {
  const inserted = [];
  const db = fakeDb([
    {
      match: /INSERT INTO leads/,
      run: (sql, args) => {
        inserted.push(args);
        return { meta: { changes: 1 } };
      },
    },
    { match: /INSERT INTO audit_log/, run: () => ({ meta: { changes: 1 } }) },
  ]);
  return { db, inserted };
}

/* ------------------------------------------------------------------------- happy path */

test("an enquiry is accepted and stored", async () => {
  const { db, inserted } = capturingDb();
  const response = await post(
    "/v1/leads",
    {
      company: "Nile Dental",
      name: "Sara",
      email: "sara@niledental.example",
      website: "https://niledental.example",
      message: "Dental clinic, two branches, Cairo",
    },
    { DB: db },
  );

  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.received, true);
  assert.match(body.id, /^lead_[0-9a-f]{24}$/);

  assert.equal(inserted.length, 1);
  const [id, name, email, company, website, interest, message] = inserted[0];
  assert.equal(id, body.id);
  assert.equal(name, "Sara");
  assert.equal(email, "sara@niledental.example");
  assert.equal(company, "Nile Dental");
  assert.equal(website, "https://niledental.example");
  assert.equal(interest, "visibility-audit");
  assert.equal(message, "Dental clinic, two branches, Cairo");
});

test("interest defaults to the visibility audit", async () => {
  const { db, inserted } = capturingDb();
  await post("/v1/leads", { company: "Acme", email: "a@acme.example" }, { DB: db });

  assert.equal(inserted[0][5], "visibility-audit");
});

test("only the company and email are required", async () => {
  const { db, inserted } = capturingDb();
  const response = await post("/v1/leads", { company: "Acme", email: "a@acme.example" }, { DB: db });

  assert.equal(response.status, 202);
  const [, name, , , website, , message] = inserted[0];
  assert.equal(name, "");
  assert.equal(website, "");
  assert.equal(message, "");
});

test("the same business may enquire twice", async () => {
  const { db, inserted } = capturingDb();
  const payload = { company: "Acme", email: "a@acme.example" };

  const first = await post("/v1/leads", payload, { DB: db });
  const second = await post("/v1/leads", payload, { DB: db });

  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  assert.equal(inserted.length, 2);
  assert.notEqual(inserted[0][0], inserted[1][0]);
});

/* ---------------------------------------------------------------------------- rejects */

test("an enquiry without a company is rejected", async () => {
  const response = await post("/v1/leads", { email: "a@acme.example" });

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(typeof body.error.code, "string");
  assert.ok(body.error.request_id);
});

test("an enquiry without a usable email is rejected", async () => {
  for (const email of [undefined, "", "not-an-email", "a@", 42]) {
    const response = await post("/v1/leads", { company: "Acme", email });
    assert.equal(response.status, 400, `email ${JSON.stringify(email)} should be rejected`);
  }
});

test("an over-long message is rejected rather than truncated", async () => {
  const response = await post("/v1/leads", {
    company: "Acme",
    email: "a@acme.example",
    message: "x".repeat(2001),
  });

  assert.equal(response.status, 400);
});

test("a malformed body is a 400, not a crash", async () => {
  const response = await call("/v1/leads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(typeof body.error.code, "string");
});

test("leads cannot be read without the admin token", async () => {
  assert.equal((await call("/v1/admin/leads")).status, 401);
  assert.equal((await call("/v1/admin/leads", bearer("guess"))).status, 401);
  assert.equal(
    (await call("/v1/admin/leads", bearer("anything"), { ADMIN_TOKEN: undefined })).status,
    401,
  );
});

test("an operator can read the enquiries with the admin token", async () => {
  const db = fakeDb([
    { match: /COUNT\(\*\) AS total FROM leads/, first: () => ({ total: 2 }) },
    {
      match: /FROM leads ORDER BY created_at DESC/,
      all: () => [
        {
          id: "lead_1",
          name: "Sara",
          email: "sara@niledental.example",
          company: "Nile Dental",
          website: "",
          interest: "visibility-audit",
          message: "Cairo",
          status: "new",
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    },
  ]);

  const response = await call("/v1/admin/leads", bearer("test-admin-token"), { DB: db });
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.total, 2);
  assert.equal(body.leads.length, 1);
  assert.equal(body.leads[0].email, "sara@niledental.example");
});
