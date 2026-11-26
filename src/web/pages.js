// Server-rendered pages: the public front door, the customer console and the docs.
//
// No build step and no client framework: every page is a string. That keeps the Worker
// bundle small and means a customer sees the catalog even before any JavaScript runs.
//
// Everything interpolated here is either a number, a constant, or escaped by `esc`.

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
  );

/** 50000 -> "50k", 6000000 -> "6M". Used for included units only. */
export function compactUnits(units) {
  if (units >= 1_000_000) return `${units / 1_000_000}M`;
  if (units >= 1_000) return `${units / 1_000}k`;
  return String(units);
}

/** Micro-USD per unit is exactly dollars per million units. 2 -> "$2". */
export function perMillion(micros) {
  if (micros === 0) return "—";
  const dollars = micros / 1_000_000;
  return `$${dollars % 1 === 0 ? dollars.toFixed(0) : dollars.toFixed(2)}`;
}

function money(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

function styles() {
  return `
:root {
  --bg: #0b0d10; --panel: #14181d; --line: #242b33; --ink: #e8edf2; --dim: #93a1b0;
  --accent: #4da3ff; --good: #35c48a; --warn: #e8b24d;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.wrap { max-width: 960px; margin: 0 auto; padding: 0 20px; }
header.top {
  border-bottom: 1px solid var(--line); position: sticky; top: 0;
  background: rgba(11,13,16,.85); backdrop-filter: blur(8px); z-index: 10;
}
header.top .wrap { display: flex; align-items: center; gap: 20px; height: 60px; }
.brand { font-weight: 650; letter-spacing: -.01em; }
.brand span { color: var(--accent); }
header.top nav { margin-left: auto; display: flex; gap: 18px; font-size: 14px; }
header.top nav a { color: var(--dim); }
h1 { font-size: clamp(30px, 5vw, 46px); line-height: 1.1; letter-spacing: -.02em; margin: 0 0 16px; }
h2 { font-size: 22px; letter-spacing: -.01em; margin: 0 0 8px; }
h3 { font-size: 15px; margin: 0 0 6px; }
p { margin: 0 0 14px; color: var(--dim); }
.hero { padding: 72px 0 56px; }
.hero p.lead { font-size: 19px; max-width: 620px; }
.cta { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 24px; }
.btn {
  display: inline-block; padding: 11px 20px; border-radius: 8px; font-weight: 600;
  font-size: 15px; border: 1px solid var(--line); background: var(--panel); color: var(--ink);
  cursor: pointer; font-family: inherit;
}
.btn.primary { background: var(--accent); border-color: var(--accent); color: #05131f; }
.btn:hover { text-decoration: none; filter: brightness(1.08); }
.btn.danger { border-color: #7a2c33; color: #ff9aa2; background: transparent; }
.grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 20px; }
.card p { margin: 0; font-size: 14px; }
section { padding: 44px 0; border-top: 1px solid var(--line); }
pre {
  background: #0f1216; border: 1px solid var(--line); border-radius: 10px; padding: 16px;
  overflow-x: auto; font-size: 13px; line-height: 1.55;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .92em; }
p code, li code { background: #1b2027; padding: 1px 5px; border-radius: 4px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 12px 10px; border-bottom: 1px solid var(--line); }
th { color: var(--dim); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
tr.hl td { background: rgba(77,163,255,.07); }
.pill { font-size: 11px; padding: 2px 8px; border-radius: 99px; border: 1px solid var(--line); color: var(--dim); }
.pill.soon { color: #e8b24d; border-color: #4a3c1e; }
.pill.live { color: var(--good); border-color: #1e4a38; }
label { display: block; font-size: 13px; color: var(--dim); margin: 0 0 6px; }
input[type=text], input[type=email], input[type=password] {
  width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--line);
  background: #0f1216; color: var(--ink); font: inherit; font-size: 15px;
}
form.stack { display: grid; gap: 14px; max-width: 420px; }
.note { font-size: 13px; color: var(--dim); }
.err { color: #ff9aa2; font-size: 14px; min-height: 20px; }
.keybox {
  background: #0f1216; border: 1px solid #2a5a3f; border-radius: 10px; padding: 14px;
  font-family: ui-monospace, monospace; font-size: 13px; word-break: break-all; color: #9ff0c4;
}
.bar { height: 8px; background: #0f1216; border-radius: 99px; overflow: hidden; border: 1px solid var(--line); }
.bar > i { display: block; height: 100%; background: var(--accent); }
footer { padding: 40px 0; color: var(--dim); font-size: 13px; border-top: 1px solid var(--line); }
footer .wrap { display: flex; gap: 16px; flex-wrap: wrap; }
.muted { color: var(--dim); }
@media (max-width: 640px) {
  .hero { padding: 48px 0 36px; }
  header.top nav { gap: 12px; font-size: 13px; }
  th, td { padding: 10px 6px; }
}
`.trim();
}

function layout({ title, description, body, script = "", baseUrl = "" }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
<style>${styles()}</style>
</head>
<body>
<header class="top"><div class="wrap">
  <a class="brand" href="/">Mizan <span>AI Hub</span></a>
  <nav>
    <a href="/#pricing">Pricing</a>
    <a href="/visibility">AI visibility</a>
    <a href="/docs">Docs</a>
    <a href="/console">Console</a>
  </nav>
</div></header>
${body}
<footer><div class="wrap">
  <span>Mizan AI Hub</span>
  <span class="muted">·</span>
  <a href="/docs">Documentation</a>
  <a href="/v1/pricing">API catalog</a>
  <a href="/health">Status</a>
  <span class="muted" style="margin-left:auto">${esc(baseUrl)}</span>
</div></footer>
${script ? `<script>${script}</script>` : ""}
</body>
</html>`;
}

const CURL = `curl https://YOUR-HOST/v1/ai/chat/completions \\
  -H "Authorization: Bearer mzk_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{"messages":[{"role":"user","content":"Hello"}]}'`;

function pricingRows(plans) {
  return plans
    .map((plan) => {
      const free = plan.priceMonthlyCents === 0;
      return `<tr${plan.id === "starter" ? ' class="hl"' : ""}>
  <td><strong>${esc(plan.name)}</strong>${plan.id === "starter" ? ' <span class="pill live">most popular</span>' : ""}</td>
  <td class="num">${money(plan.priceMonthlyCents)}<span class="muted">/mo</span></td>
  <td class="num">${compactUnits(plan.includedUnits)}</td>
  <td class="num">${free ? "hard stop" : `${perMillion(plan.overageMicrosPerUnit)}/1M`}</td>
</tr>`;
    })
    .join("\n");
}

export function landingPage({ service, blocked = [], baseUrl }) {
  const plans = service.plans;
  const signupScript = `
const form = document.getElementById("signup");
const out = document.getElementById("out");
const err = document.getElementById("err");
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  err.textContent = "";
  const button = form.querySelector("button");
  button.disabled = true;
  button.textContent = "Creating…";
  try {
    const response = await fetch("/v1/tenants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: form.elements.name.value,
        email: form.elements.email.value,
      }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body?.error?.message || "Could not create the account.");
    form.hidden = true;
    document.getElementById("keyValue").textContent = body.api_key.key;
    out.hidden = false;
  } catch (error) {
    err.textContent = error.message;
    button.disabled = false;
    button.textContent = "Create free account";
  }
});
document.getElementById("copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText(document.getElementById("keyValue").textContent);
  document.getElementById("copy").textContent = "Copied";
});
`;

  const body = `
<div class="wrap hero">
  <h1>Managed AI, billed by the token.</h1>
  <p class="lead">${esc(service.summary)}</p>
  <p class="lead">One API key. One invoice. No vendor account, no card on file in another country.</p>
  <div class="cta">
    <a class="btn primary" href="#start">Start free</a>
    <a class="btn" href="/docs">Read the docs</a>
  </div>
</div>

<section><div class="wrap">
  <h2>What you get</h2>
  <div class="grid" style="margin-top:20px">
    <div class="card"><h3>Metered by the token</h3><p>Every call is counted and priced. You see the charge before the invoice arrives, not after.</p></div>
    <div class="card"><h3>One key, many apps</h3><p>Issue a key per product or environment. Revoke one without disturbing the others.</p></div>
    <div class="card"><h3>Quota you control</h3><p>The free plan stops at its limit instead of surprising you. Paid plans bill the overage.</p></div>
  </div>
</div></section>

<section id="pricing"><div class="wrap">
  <h2>Pricing</h2>
  <p>Prices in US dollars. Usage resets monthly; unused allowance does not roll over.</p>
  <table style="margin-top:18px">
    <thead><tr><th>Plan</th><th class="num">Monthly</th><th class="num">Included tokens</th><th class="num">Overage</th></tr></thead>
    <tbody>${pricingRows(plans)}</tbody>
  </table>
  <p class="note" style="margin-top:16px">Example: 2,000,000 tokens on Starter is ${money(plans.find((p) => p.id === "starter")?.priceMonthlyCents ?? 0)} plus ${compactUnits(1000000)} overage — billed once, on the invoice.</p>
</div></section>

<section id="start"><div class="wrap">
  <h2>Start free</h2>
  <p>50,000 tokens a month, no card, no sales call. A key is issued immediately.</p>
  <form class="stack" id="signup">
    <div><label for="name">Company or project name</label><input id="name" name="name" type="text" required maxlength="100" autocomplete="organization"></div>
    <div><label for="email">Work email</label><input id="email" name="email" type="email" required maxlength="254" autocomplete="email"></div>
    <button class="btn primary" type="submit">Create free account</button>
    <div class="err" id="err"></div>
  </form>
  <div id="out" hidden>
    <h3 style="margin-top:8px">Your API key</h3>
    <p class="note">This is the only time the full key is shown. Store it somewhere safe — a lost key is revoked and replaced, never recovered.</p>
    <div class="keybox" id="keyValue"></div>
    <div class="cta"><button class="btn" id="copy" type="button">Copy key</button><a class="btn" href="/console">Open console</a></div>
  </div>
</div></section>

<section><div class="wrap">
  <h2>Call it</h2>
<pre>${esc(CURL.replace("YOUR-HOST", baseUrl.replace(/^https?:\/\//, "")))}</pre>
  <p class="note">The response includes token usage and the remaining allowance for the month.</p>
</div></section>

<section id="visibility"><div class="wrap">
  <h2>AI doesn't know you exist yet</h2>
  <p>Your customers have started asking an assistant instead of scrolling a search page. The assistant answers with what it can read and verify — and most business websites, however good-looking, give it almost nothing to work with.</p>
  <div class="grid" style="margin-top:18px">
    <div class="card"><h3>Readable</h3><p>Your services, prices and coverage published in a form a machine can extract — in Arabic and English.</p></div>
    <div class="card"><h3>Callable</h3><p>An endpoint an assistant can act on: check a price, confirm availability, take a request.</p></div>
    <div class="card"><h3>Measured</h3><p>A monthly report of what assistants now say about you, and what changed.</p></div>
  </div>
  <div class="cta"><a class="btn" href="/visibility">How it works</a><a class="btn primary" href="/visibility#audit">Request an audit</a></div>
</div></section>

${
  blocked.length
    ? `<section><div class="wrap">
  <h2>On the roadmap</h2>
  <p>Listed so you can plan, not so you can buy. These are not available yet and cannot be purchased.</p>
  <div class="grid" style="margin-top:18px">
${blocked
  .map(
    (entry) => `    <div class="card"><h3>${esc(entry.name)} <span class="pill soon">coming soon</span></h3><p>${esc(entry.summary)}</p></div>`,
  )
  .join("\n")}
  </div>
</div></section>`
    : ""
}
`;
  return layout({
    title: "Mizan AI Hub — managed AI, billed by the token",
    description: service.summary,
    body,
    script: signupScript,
    baseUrl,
  });
}

export function docsPage({ service, baseUrl }) {
  const plans = service.plans;
  const host = baseUrl.replace(/^https?:\/\//, "");
  const body = `
<div class="wrap hero" style="padding-bottom:24px">
  <h1 style="font-size:34px">Documentation</h1>
  <p class="lead">Everything below is the live API. Base URL <code>${esc(baseUrl)}</code>.</p>
</div>

<section><div class="wrap">
  <h2>Quickstart</h2>
<pre>${esc(`# 1. create an account (returns the key once)
curl -X POST https://${host}/v1/tenants \\
  -H "Content-Type: application/json" \\
  -d '{"name":"Acme Ltd","email":"you@acme.com"}'

# 2. call a model
${CURL.replace("YOUR-HOST", host)}`)}</pre>
</div></section>

<section><div class="wrap">
  <h2>Endpoints</h2>
  <table>
    <thead><tr><th>Method</th><th>Path</th><th>Auth</th><th>Purpose</th></tr></thead>
    <tbody>
      <tr><td>GET</td><td><code>/v1/services</code></td><td>—</td><td>Catalog of services</td></tr>
      <tr><td>GET</td><td><code>/v1/pricing</code></td><td>—</td><td>Plans, rates, worked examples</td></tr>
      <tr><td>POST</td><td><code>/v1/tenants</code></td><td>—</td><td>Create an account, returns the key</td></tr>
      <tr><td>GET</td><td><code>/v1/usage</code></td><td>key</td><td>This period's units and estimated charge</td></tr>
      <tr><td>GET</td><td><code>/v1/keys</code></td><td>key</td><td>List keys, masked</td></tr>
      <tr><td>POST</td><td><code>/v1/keys</code></td><td>key</td><td>Issue another key</td></tr>
      <tr><td>DELETE</td><td><code>/v1/keys/:id</code></td><td>key</td><td>Revoke a key</td></tr>
      <tr><td>POST</td><td><code>/v1/ai/chat/completions</code></td><td>key</td><td>Chat completion, metered</td></tr>
    </tbody>
  </table>
</div></section>

<section><div class="wrap">
  <h2>Authentication</h2>
  <p>Send the key as a bearer token. A key identifies one account; it cannot reach another account's data.</p>
<pre>Authorization: Bearer mzk_live_xxxxxxxxxxxx_yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy</pre>
  <p class="note">Keys come in <code>live</code> and <code>test</code> modes. A test key is metered separately and is never billed.</p>
</div></section>

<section><div class="wrap">
  <h2>Errors</h2>
  <p>Every failure uses one shape, with a request id you can quote to support.</p>
<pre>{
  "error": {
    "code": "invalid_key",
    "message": "The API key is not valid.",
    "request_id": "6f1c…"
  }
}</pre>
  <table>
    <thead><tr><th>Status</th><th>Meaning</th></tr></thead>
    <tbody>
      <tr><td>401</td><td>Missing, malformed, revoked or wrong-account key</td></tr>
      <tr><td>402</td><td>Allowance exhausted on a plan with no overage</td></tr>
      <tr><td>404</td><td>No such route or resource</td></tr>
      <tr><td>409</td><td>Conflict, such as a duplicate email</td></tr>
      <tr><td>429</td><td>Rate limited</td></tr>
    </tbody>
  </table>
</div></section>

<section><div class="wrap">
  <h2>Billing</h2>
  <p>Units are counted per request and priced per plan. The monthly charge is the plan price plus any overage, rounded once, in cents.</p>
  <table>
    <thead><tr><th>Plan</th><th class="num">Monthly</th><th class="num">Included</th><th class="num">Overage</th></tr></thead>
    <tbody>${pricingRows(plans)}</tbody>
  </table>
  <p class="note" style="margin-top:14px">Figures shown in the console are an estimate of the current month, not an invoice.</p>
</div></section>
`;
  return layout({
    title: "Mizan AI Hub — documentation",
    description: "API reference, authentication, errors and billing for Mizan AI Hub.",
    body,
    baseUrl,
  });
}

export function consolePage({ baseUrl }) {
  const script = `
const KEY = "mzh.key";
const keyInput = document.getElementById("key");
const status = document.getElementById("status");
const panel = document.getElementById("panel");

function stored() { return sessionStorage.getItem(KEY) || ""; }
function remember(value) { sessionStorage.setItem(KEY, value); }

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.headers || {}), authorization: "Bearer " + stored() },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || "Request failed (" + response.status + ")");
  return body;
}

function show(message, bad) {
  status.textContent = message || "";
  status.className = bad ? "err" : "note";
}

async function load() {
  if (!stored()) { panel.hidden = true; return; }
  try {
    const usage = await api("/v1/usage");
    panel.hidden = false;
    show("");
    render(usage);
    const keys = await api("/v1/keys");
    renderKeys(keys.keys);
  } catch (error) {
    panel.hidden = true;
    show(error.message, true);
  }
}

function render(usage) {
  const rows = usage.services.map((s) => {
    const used = s.units_used || 0;
    const included = s.included_units || 0;
    const pct = included ? Math.min(100, Math.round((used / included) * 100)) : 0;
    return "<tr><td>" + s.service_name + "</td><td>" + (s.plan_id || "—") +
      "</td><td class='num'>" + used.toLocaleString() + " / " + included.toLocaleString() +
      "</td><td class='num'>" + s.estimated_charge_display + "</td></tr>" +
      "<tr><td colspan='4'><div class='bar'><i style='width:" + pct + "%'></i></div></td></tr>";
  }).join("");
  document.getElementById("usage").innerHTML = rows ||
    "<tr><td colspan='4' class='muted'>No usage this period.</td></tr>";
  document.getElementById("period").textContent = usage.period;
  document.getElementById("tenant").textContent = usage.tenant_id;
}

function renderKeys(keys) {
  document.getElementById("keys").innerHTML = keys.map((k) =>
    "<tr><td><code>" + k.masked + "</code></td><td>" + k.label + "</td><td>" + k.mode +
    "</td><td>" + (k.last_used_at || "never") + "</td><td>" +
    (k.revoked_at ? "<span class='muted'>revoked</span>" :
      "<button class='btn danger' data-revoke='" + k.id + "'>Revoke</button>") + "</td></tr>"
  ).join("");
  for (const button of document.querySelectorAll("[data-revoke]")) {
    button.addEventListener("click", async () => {
      if (!confirm("Revoke this key? Applications using it stop working immediately.")) return;
      try {
        await api("/v1/keys/" + button.dataset.revoke, { method: "DELETE" });
        await load();
        show("Key revoked.");
      } catch (error) { show(error.message, true); }
    });
  }
}

document.getElementById("connect").addEventListener("submit", (event) => {
  event.preventDefault();
  remember(keyInput.value.trim());
  keyInput.value = "";
  load();
});
document.getElementById("forget").addEventListener("click", () => {
  sessionStorage.removeItem(KEY);
  panel.hidden = true;
  show("");
});
document.getElementById("createKey").addEventListener("click", async () => {
  try {
    const body = await api("/v1/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "Additional" }),
    });
    document.getElementById("newKey").textContent = body.key;
    document.getElementById("newKeyBox").hidden = false;
    await load();
  } catch (error) { show(error.message, true); }
});

if (stored()) load();
`;

  const body = `
<div class="wrap hero" style="padding-bottom:20px">
  <h1 style="font-size:34px">Console</h1>
  <p class="lead">Your key stays in this browser tab. It is never stored on the server, and closing the tab forgets it.</p>
</div>

<section><div class="wrap">
  <form class="stack" id="connect">
    <div>
      <label for="key">API key</label>
      <input id="key" type="password" placeholder="mzk_live_..." autocomplete="off" spellcheck="false">
    </div>
    <div class="cta" style="margin-top:0">
      <button class="btn primary" type="submit">Open account</button>
      <button class="btn" type="button" id="forget">Forget</button>
    </div>
    <div id="status" class="note"></div>
  </form>
</div></section>

<div id="panel" hidden>
<section><div class="wrap">
  <h2>This month</h2>
  <p class="note">Account <code id="tenant"></code> · period <code id="period"></code></p>
  <table>
    <thead><tr><th>Service</th><th>Plan</th><th class="num">Tokens used / included</th><th class="num">Estimate</th></tr></thead>
    <tbody id="usage"></tbody>
  </table>
  <p class="note" style="margin-top:14px">An estimate of the current period, not an invoice.</p>
</div></section>

<section><div class="wrap">
  <h2>Keys</h2>
  <table>
    <thead><tr><th>Key</th><th>Label</th><th>Mode</th><th>Last used</th><th></th></tr></thead>
    <tbody id="keys"></tbody>
  </table>
  <div class="cta"><button class="btn" id="createKey" type="button">Issue another key</button></div>
  <div id="newKeyBox" hidden style="margin-top:16px">
    <p class="note">Copy it now — it is shown once.</p>
    <div class="keybox" id="newKey"></div>
  </div>
</div></section>
</div>
`;
  return layout({
    title: "Console — Mizan AI Hub",
    description: "Usage, keys and this month's estimate.",
    body,
    script,
    baseUrl,
  });
}

/* ------------------------------------------------------------------- AI visibility */

/**
 * The second product: making a client's business readable and callable by AI assistants.
 *
 * It is NOT sold through the API. It is delivered by a person, quoted per site, and entered
 * through a lead form. So this page publishes no price and no buy button — only the argument
 * and a way to ask. Publishing a price here would mean the platform could take money for
 * something the platform cannot yet deliver on its own.
 */
export function visibilityPage({ baseUrl }) {
  const script = `
const form = document.getElementById("lead");
const err = document.getElementById("leadErr");
const done = document.getElementById("leadDone");
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  err.textContent = "";
  const button = form.querySelector("button");
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Sending\\u2026";
  try {
    const response = await fetch("/v1/leads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: form.elements.name.value,
        company: form.elements.company.value,
        website: form.elements.website.value,
        email: form.elements.email.value,
        message: form.elements.message.value,
        interest: "visibility-audit",
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error?.message || "Could not send the enquiry.");
    form.hidden = true;
    done.hidden = false;
  } catch (error) {
    err.textContent = error.message;
    button.disabled = false;
    button.textContent = original;
  }
});
`;

  const body = `
<div class="wrap hero">
  <h1>Make your business the answer.</h1>
  <p class="lead">When someone asks an assistant who to hire, who to call, or who sells what they need, the assistant answers from what it can read. Most businesses are not readable. We make you readable — and then callable.</p>
  <div class="cta">
    <a class="btn primary" href="#audit">Request an audit</a>
    <a class="btn" href="#how">How it works</a>
  </div>
</div>

<section><div class="wrap">
  <h2>What this actually is</h2>
  <p>Three things, in order. Each one is worth something on its own, and each one is useless without the one before it.</p>
  <div class="grid" style="margin-top:18px">
    <div class="card">
      <h3>1. Readable</h3>
      <p>Your services, prices, hours, coverage and location published as structured facts a machine can extract — not as a picture, not as a paragraph of marketing, and not only in English.</p>
    </div>
    <div class="card">
      <h3>2. Callable</h3>
      <p>An endpoint an assistant can act on. Reading is not enough once assistants start transacting: they need to check a price, confirm availability, and place a request without a human retyping it.</p>
    </div>
    <div class="card">
      <h3>3. Measured</h3>
      <p>A monthly record of what assistants actually say about you, from the questions your customers really ask. Without this you are paying for work you cannot see.</p>
    </div>
  </div>
</div></section>

<section><div class="wrap">
  <h2>Why this is happening now</h2>
  <p>Discovery is moving. For twenty years the front door was a search box: a buyer typed keywords, got ten links, and clicked. Ranking was the whole game, and it was played with pages.</p>
  <p>An assistant does not give ten links. It gives one answer, assembled from sources it can parse and check. That changes what a business is competing for. You are no longer competing to be a <em>result</em>; you are competing to be a <em>sentence</em> in someone else's answer.</p>
  <p>And an assistant can only put you in that sentence if it can read you. A website built to look good to a human, with prices inside an image and services described in slogans, is close to invisible to the machine deciding who gets mentioned.</p>
</div></section>

<section id="how"><div class="wrap">
  <h2>How the engagement works</h2>
  <p>Four steps. The first one is fixed-fee and standalone: if the audit says this will not help your category yet, you stop there and we tell you so.</p>
  <table style="margin-top:18px">
    <thead><tr><th>Step</th><th>What we do</th><th>What you get</th></tr></thead>
    <tbody>
      <tr>
        <td><strong>1. Audit</strong></td>
        <td>Read your site the way a machine does: crawlability, structured data, whether services and prices are extractable, whether an Arabic version exists and is machine-readable.</td>
        <td>A written scorecard of what is missing and what it costs you, in plain language.</td>
      </tr>
      <tr>
        <td><strong>2. Publish</strong></td>
        <td>Write the structured layer: service and price markup, a machine-readable catalog, an <code>llms.txt</code>, Arabic and English.</td>
        <td>The facts an assistant needs, in a form it can quote.</td>
      </tr>
      <tr>
        <td><strong>3. Make it callable</strong></td>
        <td>Publish an endpoint — an MCP server — exposing your services so an assistant can query prices, check availability and submit a request.</td>
        <td>You stop being mentionable and start being usable.</td>
      </tr>
      <tr>
        <td><strong>4. Report</strong></td>
        <td>Ask the questions your customers ask, record what comes back, repeat monthly.</td>
        <td>Evidence of change, and the next thing to fix.</td>
      </tr>
    </tbody>
  </table>
  <p class="note" style="margin-top:16px">Steps 2 and 3 run on this platform. The endpoint in step 3 is the same managed MCP gateway listed on the main page — it is being built for exactly this use.</p>
</div></section>

<section><div class="wrap">
  <h2>What we will not promise</h2>
  <p>This is the part most people selling "AI visibility" leave out, so read it before anything else.</p>
  <ul>
    <li><strong>We cannot guarantee you get named first.</strong> Which sources an assistant trusts is decided by that assistant, not by us. We can make you legible and callable; we cannot make a model prefer you.</li>
    <li><strong>This is not advertising.</strong> There is no inventory to buy and no placement to rent. Anyone selling you a "spot" in an AI answer is selling you something that does not exist.</li>
    <li><strong>A one-off fix decays.</strong> Models change, formats change, indexes change. That is why the work is monthly, and why we will say so rather than sell you a project and disappear.</li>
    <li><strong>Some categories will not benefit yet.</strong> If assistants already answer your category from two large marketplaces, fixing your own site moves little. The audit will say that plainly, and the honest recommendation may be to get listed well with those marketplaces instead.</li>
  </ul>
</div></section>

<section><div class="wrap">
  <h2>The market, as we read it</h2>
  <p class="note">These are predictions, not measurements. We have no proprietary dataset and will not invent one. What follows is reasoning you can disagree with — that is the point of writing it down.</p>
  <ol style="padding-left:20px; color:var(--dim)">
    <li style="margin-bottom:14px"><strong style="color:var(--ink)">The assistant becomes the front door.</strong> Buyers increasingly begin with a question to an assistant rather than a search box. Search rewarded pages that matched words; assistants answer with sentences assembled from sources they can parse. The unit of competition moves from the ranking to the sentence.</li>
    <li style="margin-bottom:14px"><strong style="color:var(--ink)">Being cited overtakes being ranked.</strong> An assistant asked for a recommendation names two or three options, not ten. Businesses that exist only as human-readable pages are rarely among them. The work shifts from keywords to being quotable and verifiable.</li>
    <li style="margin-bottom:14px"><strong style="color:var(--ink)">Readable is a phase, callable is the destination.</strong> Assistants are moving from recommending to transacting — quoting, booking, ordering — through tool protocols, MCP being the one gaining traction. A business with a callable endpoint captures the transaction; one without gets mentioned at best. This is why the MCP gateway is our second product and not an afterthought.</li>
    <li style="margin-bottom:14px"><strong style="color:var(--ink)">It becomes a retainer, not a project.</strong> Models and formats change monthly, so a one-off fix decays. This is the shape SEO took: a project to start, a retainer to maintain. We expect the same curve, faster, because the buyer's own customers are already asking assistants.</li>
    <li style="margin-bottom:14px"><strong style="color:var(--ink)">Consolidation is the real risk.</strong> If assistants end up answering mostly from a handful of large sources — marketplaces, review platforms, directories — then optimising your own site matters less than being listed well with those sources. We expect a split: categories with strong marketplaces consolidate, local and niche categories fragment.</li>
    <li style="margin-bottom:14px"><strong style="color:var(--ink)">Arabic-language presence is unusually thin.</strong> Machine-readable Arabic service and price data is scarce compared with English. For a business in MENA, publishing structured Arabic facts early is disproportionately visible, because there is far less to compete against. This is the one structural advantage a local operator has over a global agency.</li>
    <li style="margin-bottom:14px"><strong style="color:var(--ink)">Budget follows the buyer, not the technology.</strong> We expect this to become a line item for mid-sized businesses within roughly 12–24 months — not because the technology is ready, but because their customers will already be asking. We would not bet a business on that timeline.</li>
  </ol>
  <h3 style="margin-top:26px">How this could be wrong</h3>
  <p>If assistants keep answering from a small set of dominant sources, if regulation forces citation formats that commoditise the work, or if buyers simply keep using search, then the value moves from "optimise your site" to "be listed with the giants" — a smaller, different service. We would rather say that now than discover it after you have paid for a year.</p>
</div></section>

<section><div class="wrap">
  <h2>Who this is for</h2>
  <div class="grid" style="margin-top:18px">
    <div class="card"><h3>A good fit</h3><p>You sell services or products where a buyer would ask an assistant for a recommendation — clinics, agencies, contractors, hotels, professional services, local retail with delivery. You have a website and a real business behind it.</p></div>
    <div class="card"><h3>A poor fit</h3><p>You want guaranteed placement, a one-week fix, or traffic without changing how your services are described. If the facts are not true and current, no amount of structuring helps.</p></div>
  </div>
</div></section>

<section id="audit"><div class="wrap">
  <h2>Request an audit</h2>
  <p>The audit is quoted per site and delivered by our team — it is not something this API can do on its own yet. Tell us what you sell and where, and we will reply to the address you give.</p>
  <form class="stack" id="lead">
    <div><label for="company">Company</label><input id="company" name="company" type="text" required maxlength="120" autocomplete="organization"></div>
    <div><label for="name">Your name</label><input id="name" name="name" type="text" maxlength="120" autocomplete="name"></div>
    <div><label for="website">Website</label><input id="website" name="website" type="text" maxlength="200" placeholder="https://" autocomplete="url"></div>
    <div><label for="email">Email</label><input id="email" name="email" type="email" required maxlength="254" autocomplete="email"></div>
    <div><label for="message">What do you sell, and where?</label><input id="message" name="message" type="text" maxlength="2000" placeholder="Dental clinic, two branches, Cairo"></div>
    <button class="btn primary" type="submit">Send enquiry</button>
    <div class="err" id="leadErr"></div>
  </form>
  <div id="leadDone" hidden>
    <h3>Received.</h3>
    <p>We will reply to the address you gave. If your category is not a good fit yet, we will say so in that reply rather than sell you a retainer.</p>
  </div>
</div></section>
`;

  return layout({
    title: "AI visibility — Mizan AI Hub",
    description:
      "Make your business readable and callable by AI assistants: audit, structured publishing, an MCP endpoint, and a monthly report.",
    body,
    script,
    baseUrl,
  });
}
