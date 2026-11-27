// Tests for the rendered pages: the public site, the docs and the console.
//
// These assert what a browser actually receives — status, content type, security headers and
// the words on the page — so a broken template fails here rather than on a customer's screen.

import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { landingPage, docsPage, consolePage, compactUnits, perMillion } from "../src/web/pages.js";

const ORIGIN = "https://ai.mizanconsult.com";

function env(overrides = {}) {
  return {
    ENVIRONMENT: "test",
    DEFAULT_AI_MODEL: "@cf/meta/llama-3.1-8b-instruct",
    ALLOWED_ORIGINS: "*",
    API_KEY_PEPPER: "test-pepper",
    ADMIN_TOKEN: "test-admin-token",
    DB: { prepare: () => ({ bind() { return this; }, async first() { return null; }, async all() { return { results: [] }; }, async run() { return { meta: { changes: 1 } }; } }) },
    ...overrides,
  };
}

const browser = (path) =>
  worker.fetch(
    new Request(`${ORIGIN}${path}`, { headers: { accept: "text/html,application/xhtml+xml" } }),
    env(),
    {},
  );

/* --------------------------------------------------------------------- content negotiation */

test("GET / renders a page for a browser and JSON for an API client", async () => {
  const page = await browser("/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);

  const api = await worker.fetch(new Request(`${ORIGIN}/`, { headers: { accept: "*/*" } }), env(), {});
  assert.match(api.headers.get("content-type"), /application\/json/);
  assert.equal((await api.json()).name, "Mizan AI Hub");
});

test("the JSON index advertises the site, docs and console", async () => {
  const body = await (await worker.fetch(new Request(`${ORIGIN}/`), env(), {})).json();

  assert.equal(body.pages.website, `${ORIGIN}/`);
  assert.equal(body.pages.docs, `${ORIGIN}/docs`);
  assert.equal(body.pages.console, `${ORIGIN}/console`);
});

/* ------------------------------------------------------------------------------- headers */

test("pages are served with a restrictive content security policy", async () => {
  for (const path of ["/", "/docs", "/console"]) {
    const response = await browser(path);
    const csp = response.headers.get("content-security-policy");

    assert.match(csp, /default-src 'none'/, path);
    assert.match(csp, /frame-ancestors 'none'/, path);
    assert.match(csp, /connect-src 'self'/, path);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", path);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer", path);
  }
});

test("the console is never cached", async () => {
  const response = await browser("/console");

  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.status, 200);
});

/* --------------------------------------------------------------------------- landing page */

test("the landing page publishes the real prices", async () => {
  const html = await (await browser("/")).text();

  assert.match(html, /Managed AI, billed by the token/);
  assert.match(html, /\$29\.00/);
  assert.match(html, /\$99\.00/);
  assert.match(html, /\$349\.00/);
  assert.match(html, /per 1M|1M/);
});

test("the landing page says what the free tier gives and how to start", async () => {
  const html = await (await browser("/")).text();

  assert.match(html, /50,000 tokens/);
  assert.match(html, /id="signup"/);
  assert.match(html, /Create free account/);
});

test("the landing page shows the roadmap without selling it", async () => {
  const html = await (await browser("/")).text();

  assert.match(html, /coming soon/i);
  assert.match(html, /MCP/);
  // A blocked service must never appear with a price next to it.
  assert.doesNotMatch(html, /mcp-gateway[\s\S]{0,80}\$\d/);
});

test("the landing page shows a runnable curl example against its own host", async () => {
  const html = await (await browser("/")).text();

  assert.match(html, /curl https:\/\/ai\.mizanconsult\.com\/v1\/ai\/chat\/completions/);
  assert.match(html, /Authorization: Bearer/);
});

/* ---------------------------------------------------------------------------------- docs */

test("the docs page lists every public endpoint", async () => {
  const html = await (await browser("/docs")).text();

  for (const path of [
    "/v1/services",
    "/v1/pricing",
    "/v1/tenants",
    "/v1/usage",
    "/v1/keys",
    "/v1/ai/chat/completions",
  ]) {
    assert.ok(html.includes(path), `docs are missing ${path}`);
  }
  assert.match(html, /https:\/\/ai\.mizanconsult\.com/);
  assert.match(html, /Authorization: Bearer/);
});

test("the docs explain the error shape and the estimate caveat", async () => {
  const html = await (await browser("/docs")).text();

  assert.match(html, /request_id/);
  assert.match(html, /not an invoice/);
});

/* ------------------------------------------------------------------------------- console */

test("the console keeps the key in the tab and offers no server storage", async () => {
  const html = await (await browser("/console")).text();

  assert.match(html, /sessionStorage/);
  assert.doesNotMatch(html, /localStorage/);
  assert.match(html, /type="password"/);
  assert.match(html, /Forget/);
});

test("the console can revoke a key and issue another", async () => {
  const html = await (await browser("/console")).text();

  assert.match(html, /Revoke/);
  assert.match(html, /Issue another key/);
  assert.match(html, /\/v1\/usage/);
});

/* ------------------------------------------------------------------------------ escaping */

test("page text is escaped, so a tenant name cannot inject markup", async () => {
  const hostile = {
    id: "ai-api",
    name: "AI",
    summary: '<script>alert("xss")</script>',
    unit: "token",
    plans: [
      { id: "free", name: "Free", priceMonthlyCents: 0, includedUnits: 50000, overageMicrosPerUnit: 0 },
    ],
  };
  const html = landingPage({ service: hostile, blocked: [], baseUrl: ORIGIN });

  assert.ok(!html.includes('<script>alert("xss")</script>'));
  assert.match(html, /&lt;script&gt;/);
});

test("a blocked service's summary is escaped too", async () => {
  const service = {
    id: "ai-api",
    name: "AI",
    summary: "ok",
    plans: [{ id: "free", name: "Free", priceMonthlyCents: 0, includedUnits: 0, overageMicrosPerUnit: 0 }],
  };
  const html = landingPage({
    service,
    blocked: [{ name: "<b>Evil</b>", summary: "<img src=x onerror=alert(1)>" }],
    baseUrl: ORIGIN,
  });

  assert.ok(!html.includes("<img src=x onerror=alert(1)>"));
  assert.ok(!html.includes("<b>Evil</b>"));
});

/* ------------------------------------------------------------------------------- helpers */

test("compactUnits renders allowances the way a buyer reads them", () => {
  assert.equal(compactUnits(50000), "50k");
  assert.equal(compactUnits(1000000), "1M");
  assert.equal(compactUnits(6000000), "6M");
  assert.equal(compactUnits(30000000), "30M");
  assert.equal(compactUnits(500), "500");
});

test("perMillion converts micro-USD per token to dollars per million", () => {
  // A rate is stored in micro-USD per unit. 2 micro-USD per token is 2,000,000 micro-USD
  // per million tokens, which is $2.00 -- so the number needs no scaling at all.
  assert.equal(perMillion(2), "$2");
  assert.equal(perMillion(1), "$1");
  assert.equal(perMillion(1.5), "$1.50");
  assert.equal(perMillion(0), "—");
});

test("the public pricing table never advertises free overage", async () => {
  // Regression: perMillion divided by a million, so every paid plan rendered "$0.00/1M"
  // and the front page told buyers that usage beyond the allowance cost nothing.
  const html = await (await browser("/")).text();

  assert.ok(!html.includes("$0.00/1M"), "a paid plan must never render its overage as $0.00");
  assert.match(html, /\$2\/1M/); // starter and pro
  assert.match(html, /\$1\/1M/); // business
});

test("the worked example matches what the invoice would charge", async () => {
  const html = await (await browser("/")).text();

  // 2,000,000 tokens on starter: $29.00 plan plus 1M overage at $2/1M = $31.00, which is
  // the same figure the pricing API reports as charge_display.
  assert.match(html, /\$31\.00/);
});

test("every page renders without a database, because none of them read one", async () => {
  for (const path of ["/", "/docs", "/console"]) {
    const response = await browser(path);
    assert.equal(response.status, 200, path);
  }
});

test("the console page and docs page are standalone templates", () => {
  const service = {
    id: "ai-api",
    name: "AI",
    summary: "s",
    plans: [{ id: "free", name: "Free", priceMonthlyCents: 0, includedUnits: 0, overageMicrosPerUnit: 0 }],
  };

  assert.match(docsPage({ service, baseUrl: ORIGIN }), /<!doctype html>/);
  assert.match(consolePage({ baseUrl: ORIGIN }), /<!doctype html>/);
});

/* ------------------------------------------------------------------- AI visibility */

test("the site advertises the visibility service from the front page", async () => {
  const landing = await (await browser("/")).text();

  assert.match(landing, /href="\/visibility"/);
  assert.match(landing, /AI doesn't know you exist yet/);
  assert.equal((await browser("/visibility")).status, 200);
});

test("the visibility page answers what, why and how", async () => {
  const html = await (await browser("/visibility")).text();

  assert.match(html, /What this actually is/);
  assert.match(html, /Why this is happening now/);
  assert.match(html, /How the engagement works/);
  // The four delivery steps, in order.
  assert.match(html, /1\. Audit/);
  assert.match(html, /2\. Publish/);
  assert.match(html, /3\. Make it callable/);
  assert.match(html, /4\. Report/);
});

test("the market outlook is labelled as prediction, not data", async () => {
  const html = await (await browser("/visibility")).text();

  assert.match(html, /These are predictions, not measurements/);
  assert.match(html, /How this could be wrong/);
  // No fabricated statistics: no percentage points or "study" claims.
  assert.doesNotMatch(html, /\d+(\.\d+)?\s?% of/i);
  assert.doesNotMatch(html, /according to a (study|report)/i);
});

test("the visibility page promises nothing it cannot deliver", async () => {
  const html = await (await browser("/visibility")).text();

  assert.match(html, /What we will not promise/);
  assert.match(html, /cannot guarantee you get named first/);
  assert.match(html, /not advertising/i);
});

test("the visibility service publishes no price and no buy button", async () => {
  const html = await (await browser("/visibility")).text();

  // It is delivered by a person and quoted per site, so it must not look purchasable.
  assert.ok(!html.includes("$"), "the visibility page must not show a price");
  assert.doesNotMatch(html, /Start free|Subscribe|Buy now/);
});

test("the visibility page captures a real enquiry", async () => {
  const html = await (await browser("/visibility")).text();

  assert.match(html, /fetch\("\/v1\/leads"/);
  assert.match(html, /id="lead"/);
  assert.match(html, /id="audit"/);
});

test("the JSON index advertises the visibility page", async () => {
  const body = await (await worker.fetch(new Request(`${ORIGIN}/`), env(), {})).json();

  assert.equal(body.pages.visibility, `${ORIGIN}/visibility`);
});
