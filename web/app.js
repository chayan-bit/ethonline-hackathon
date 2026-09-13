import { demoApi, isStaticDemo } from "./demo-data.js";

const $ = (id) => document.getElementById(id);
const node = (tag, text, className) =>
  Object.assign(document.createElement(tag), {
    textContent: text ?? "",
    className: className ?? "",
  });
const HBAR_TINYBARS = 100_000_000n;
const DEFAULT_REVEAL_GRACE_SECONDS = 300;
const SNAPSHOT_URL =
  "https://github.com/chayan-bit/ethonline-hackathon/blob/main/docs/evidence/live-api-snapshot.json";

const formatPct = (value, unknown = false) => {
  if (value === null || value === undefined) return unknown ? "Unknown" : "—";
  return Number.isFinite(Number(value)) ? `${Number(value).toFixed(1)}%` : "—";
};
const shortId = (id) => (id ? `${id.slice(0, 8)}…${id.slice(-6)}` : "Pending");
const label = (value) => {
  const text = String(value ?? "unknown").replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
};
const date = (timestamp) =>
  Number.isFinite(Number(timestamp))
    ? new Date(Number(timestamp) * 1000).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "Unknown";

function hbarToTinybars(value) {
  const normalized = String(value ?? "").trim();
  const match = /^(\d+)(?:\.(\d{1,8}))?$/.exec(normalized);
  if (!match)
    throw new Error(
      "Maximum price must be HBAR with up to 8 decimal places, for example 0.01.",
    );
  const fraction = (match[2] ?? "").padEnd(8, "0");
  const atomic = BigInt(match[1]) * HBAR_TINYBARS + BigInt(fraction || "0");
  if (atomic > 9_999_999_999_999_999_999n)
    throw new Error("Maximum price is too large.");
  return atomic.toString();
}

function formatHbar(atomicValue) {
  const atomic = String(atomicValue ?? "");
  if (!/^\d+$/.test(atomic)) return "Unknown";
  const padded = atomic.padStart(9, "0");
  const whole = padded.slice(0, -8) || "0";
  const fraction = padded.slice(-8).replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""} HBAR`;
}

function formatAtomic(value, decimals, symbol = "") {
  const atomic = String(value ?? "");
  const places = Number(decimals);
  if (
    !/^\d+$/.test(atomic) ||
    !Number.isSafeInteger(places) ||
    places < 0 ||
    places > 18
  )
    return "Unknown";
  if (places === 0) return `${atomic}${symbol ? ` ${symbol}` : ""}`;
  const padded = atomic.padStart(places + 1, "0");
  const whole = padded.slice(0, -places) || "0";
  const fraction = padded.slice(-places).replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}${symbol ? ` ${symbol}` : ""}`;
}

function atomicValue(value, decimals, symbol, unit) {
  const wrapper = node("span", "", "atomic-value");
  wrapper.append(
    node("strong", formatAtomic(value, decimals, symbol)),
    node("small", `${String(value ?? "Unknown")} ${unit}`),
  );
  return wrapper;
}

let currentAgent;
let currentSamples = [];
let historyNextOffset = null;
let revealGraceSeconds = DEFAULT_REVEAL_GRACE_SECONDS;
let requestSequence = 0;
let activeRequest;
let detailFocusKey;
let currentSubscriptionAgent;
let currentSubscriptionTerms;
let subscriptionLookupId = "";
let currentReasons = [];
let currentPaymentMode = "x402";
let requestedFocusId;

async function api(path, options = {}) {
  if (isStaticDemo) return demoApi(path);
  const response = await fetch(path, options);
  if (!response.ok)
    throw new Error(
      "The service could not complete this request. Please try again.",
    );
  return response.json();
}

function startRequest() {
  activeRequest?.controller.abort();
  $("refresh").disabled = false;
  $("load-history").disabled = false;
  const request = { id: ++requestSequence, controller: new AbortController() };
  activeRequest = request;
  return request;
}

const isCurrentRequest = (id) => activeRequest?.id === id;

function link(text, url) {
  const a = node("a", text);
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

function txLink(text, reference) {
  const value = String(reference ?? "").trim();
  return value
    ? link(
        text,
        `https://hashscan.io/testnet/transaction/${encodeURIComponent(value)}`,
      )
    : node("span", "Unavailable", "muted-value");
}

function metric(title, value, caption) {
  const item = node("div");
  item.append(
    node("small", title),
    node("strong", value),
    node("span", caption),
  );
  return item;
}

/* prettier-ignore */
function metricCount(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
}

/* prettier-ignore */
function metricField(metrics, nested, ...keys) {
  return keys.map((key) => metrics?.[key] ?? nested?.[key]).find((value) => value !== undefined && value !== null) ?? null;
}

/* prettier-ignore */
function subscriptionMetrics(agent) {
  const metrics = agent?.metrics ?? agent?.subscription_metrics;
  if (!metrics || typeof metrics !== "object") return null;
  const reveal = metrics.reveal ?? {};
  const quality = metrics.quality ?? metrics.grade ?? {};
  return {
    isStale: metrics.is_stale === true,
    lagSeconds: metricCount(metrics.lag_seconds),
    sampled: metricCount(metricField(metrics, null, "sampled_commitment_count", "sampled_count", "sample_count", "delivered_sample_count", "delivered_count")),
    revealCount: metricCount(metricField(metrics, reveal, "revealed_count", "revealed_sample_count", "count")),
    revealDenominator: metricCount(metricField(metrics, reveal, "eligible_sampled_count", "eligible_subscription_count", "eligible_sample_count", "sampled_count", "sample_count", "denominator")),
    revealPct: metricField(metrics, reveal, "reveal_pct", "reveal_coverage_pct", "pct"),
    qualityCount: metricCount(metricField(metrics, quality, "graded_count", "quality_sample_count", "count")),
    qualityDenominator: metricCount(metricField(metrics, quality, "quality_denominator", "eligible_sampled_count", "eligible_subscription_count", "eligible_sample_count", "sampled_count", "sample_count", "denominator")),
    qualityPct: metricField(metrics, quality, "grade_coverage_pct", "quality_coverage_pct", "pct"),
  };
}

/* prettier-ignore */
function metricCoverageCaption(count, denominator, emptyLabel) { return count === null || denominator === null ? emptyLabel : `${count} / ${denominator} sampled outputs`; }
/* prettier-ignore */
function syncPolicyControls(mode) { const hidden = mode === "subscription"; for (const field of document.querySelectorAll('[data-payment-mode="x402"]')) field.hidden = hidden; $("mode-policy-note").hidden = !hidden; }
/* prettier-ignore */
function updateOracleNotice(health) { const oracle = health?.readiness?.oracle ?? health?.oracle, current = oracle?.current, legacy = oracle?.legacy, records = Number(legacy?.records), notice = $("oracle-notice"); notice.hidden = false; if (!current) { $("oracle-title").textContent = "Oracle status could not be loaded"; $("oracle-description").textContent = "Refresh to load the current oracle verification status."; return; } if (current.status === "compatible" && legacy?.status === "unavailable" && Number.isFinite(records) && records > 0) { $("oracle-title").textContent = "Earlier forecasts remain ungraded"; $("oracle-description").textContent = `Current oracle updates are compatible. Earlier forecasts remain ungraded (${records} legacy record${records === 1 ? "" : "s"}).`; return; } if (current.status === "compatible") { notice.hidden = true; return; } $("oracle-title").textContent = "Grading is temporarily unavailable"; $("oracle-description").textContent = "Current Pyth updates cannot yet be verified on Hedera testnet. Predictions can still be revealed; reveal coverage is measured separately."; }
function rememberFocus() {
  if (requestedFocusId) return { id: requestedFocusId };
  const active = document.activeElement;
  if (
    !(active instanceof HTMLElement) ||
    active === document.body ||
    active === $("detail")
  )
    return null;
  if (active.dataset.detailFocus)
    return { detailFocus: active.dataset.detailFocus };
  if (active.id) return { id: active.id };
  return null;
}

function restoreFocus(snapshot) {
  if (!snapshot) return;
  const target = snapshot.detailFocus
    ? [...document.querySelectorAll("[data-detail-focus]")].find(
        (element) => element.dataset.detailFocus === snapshot.detailFocus,
      )
    : document.getElementById(snapshot.id);
  target?.focus({ preventScroll: true });
}

function renderX402Provider(agent, reasons) {
  const m = agent.metrics;
  const card = node("article", "", "provider-card");
  const top = node("div", "", "provider-top");
  const name = node("div", "", "provider-name");
  name.append(
    node("h3", agent.name),
    node("p", `Agent ${agent.agent_id} · ${agent.model_version}`),
  );
  top.append(
    node("div", "Ξ", "provider-avatar"),
    name,
    node(
      "span",
      reasons.length ? "Not eligible" : "Eligible",
      reasons.length ? "badge" : "badge good",
    ),
  );
  card.append(top, node("p", agent.description, "provider-description"));
  const tags = node("div", "", "tags");
  tags.append(
    node("span", "ETH / USD", "tag"),
    node("span", "x402", "tag"),
    node("span", "Non-exclusive", "tag"),
  );
  card.append(tags);
  const metrics = node("div", "", "provider-metrics");
  const noHistory = m.eligible_paid_count === 0;
  metrics.append(
    metric(
      "Reveal coverage",
      formatPct(m.reveal_pct, noHistory),
      `${m.revealed_count} / ${m.eligible_paid_count} eligible samples`,
    ),
    metric(
      "Grade coverage",
      formatPct(m.grade_coverage_pct, noHistory),
      `${m.graded_count} oracle-backed grades`,
    ),
    metric(
      "Directional hit rate",
      formatPct(m.directional_hit_rate_pct),
      `${m.graded_count} graded samples`,
    ),
    metric(
      "Mean absolute error",
      m.mean_absolute_error_bps === null
        ? "—"
        : `${m.mean_absolute_error_bps.toFixed(1)} bps`,
      "Lower is better",
    ),
  );
  card.append(metrics);
  const footer = node("div", "", "provider-footer");
  const price = node("div", formatHbar(agent.price), "price");
  price.append(node("span", "/ forecast"));
  const inspect = node("button", "Inspect provider", "secondary");
  inspect.type = "button";
  inspect.dataset.detailFocus = `provider:${agent.agent_id}`;
  inspect.addEventListener("click", () =>
    providerDetail(agent, inspect.dataset.detailFocus),
  );
  footer.append(price, inspect);
  card.append(footer);
  return card;
}

function subscriptionState(terms) {
  if (terms.closed) return "Closed";
  if (Number(terms.cancelled_at) > 0) return "Cancelled";
  if (Number(terms.end) <= Math.floor(Date.now() / 1000)) return "Expired";
  return "Active";
}

/* prettier-ignore */
function scheduleState(terms) { if (terms.closed || Number(terms.cancelled_at) > 0) return "Stopped"; if (Number(terms.next_scheduled_at) > Math.floor(Date.now() / 1000)) return "Scheduled"; return "Manual checkpoint available"; }

/* prettier-ignore */
function subscriptionTerms(terms, metadata) {
  const symbol = terms.token_symbol || metadata.subscription_token?.symbol || "TOKEN";
  const decimals = terms.token_decimals ?? metadata.subscription_token?.decimals;
  const rows = [
    ["State", subscriptionState(terms)],
    ["Rate / second", atomicValue(terms.rate_per_second, decimals, symbol, "token atomic units / second")],
    ["Deposit", atomicValue(terms.deposit, decimals, symbol, "token atomic units")],
    ["Paid", atomicValue(terms.paid, decimals, symbol, "token atomic units")],
    ["Initial HBAR reserve", atomicValue(terms.automation_reserve_initial_tinybars, 8, "HBAR", "tinybars")],
    ["Current HBAR reserve", atomicValue(terms.automation_reserve_tinybars, 8, "HBAR", "tinybars")],
    ["Spent HBAR reserve", atomicValue(terms.automation_spent_tinybars, 8, "HBAR", "tinybars")],
    ["Schedule", scheduleState(terms)],
    ["Next scheduled checkpoint", terms.next_scheduled_at ? date(terms.next_scheduled_at) : "Not scheduled"],
    ["Schedule interval", `${terms.schedule_interval ?? "Unknown"} seconds`],
    ["Scheduled gas limit", String(terms.scheduled_gas_limit ?? "Unknown")],
    ["Schedule address", terms.schedule_address || "Not scheduled"],
  ];
  const root = node("section", "", "subscription-terms"), dl = node("dl");
  root.append(node("h4", "Subscription terms"));
  for (const [key, value] of rows) {
    const dd = node("dd");
    typeof value === "string" ? (dd.textContent = value) : dd.append(value);
    dl.append(node("dt", key), dd);
  }
  root.append(dl);
  return root;
}

/* prettier-ignore */
function renderSubscriptionProvider(agent, terms) {
  const token = agent.subscription_token || {}, evidence = subscriptionMetrics(agent);
  const reveal = evidence?.revealPct == null ? "Unknown" : formatPct(evidence.revealPct);
  const quality = evidence?.qualityPct == null ? "Unknown" : formatPct(evidence.qualityPct);
  const card = node("article", "", "provider-card subscription-card"), top = node("div", "", "provider-top");
  const name = node("div", "", "provider-name");
  name.append(node("h3", agent.name || "ETH Momentum 900s"), node("p", `Agent ${agent.agent_id} · ETH / USD · ${agent.horizon_seconds ?? 900}s`));
  top.append(node("div", "◌", "provider-avatar"), name, node("span", "Subscription", "badge good"));
  card.append(top, node("p", agent.description, "provider-description"));
  const tags = node("div", "", "tags");
  tags.append(node("span", "Subscription", "tag"), node("span", "Sampled outputs", "tag"), node("span", "ETH / USD · 900s", "tag"));
  card.append(tags);
  const metrics = node("div", "", "provider-metrics subscription-metrics");
  metrics.append(metric("Payment mode", "Subscription", "Prepaid vault access"), metric("Sampling", agent.sampled ? "Sampled" : "Unspecified", "Not all delivered outputs"), metric("Reveal coverage", reveal, metricCoverageCaption(evidence?.revealCount ?? null, evidence?.revealDenominator ?? null, "Separate sampled cohort; counts unavailable")), metric("Quality coverage", quality, metricCoverageCaption(evidence?.qualityCount ?? null, evidence?.qualityDenominator ?? null, "Separate from payment; counts unavailable")));
  card.append(metrics);
  const identity = node("div", "", "subscription-identity");
  identity.append(node("h4", "Subscription identity"), node("p", `${token.id || "Unknown token ID"} · ${token.symbol || "Unknown symbol"} · ${token.decimals ?? "Unknown"} decimals`), node("small", `Vault ${agent.subscription_vault || "Unknown"}`));
  card.append(identity);
  const form = node("form", "", "subscription-inspector"), label = node("label", "Inspect a subscription's public terms");
  label.htmlFor = "subscription-id-input";
  const input = Object.assign(document.createElement("input"), { id: "subscription-id-input", name: "subscription_id", type: "text", inputMode: "text", autocomplete: "off", placeholder: "0x… subscription ID", value: subscriptionLookupId, pattern: "0x[0-9a-fA-F]{64}" });
  input.setAttribute("aria-describedby", "subscription-id-help");
  const button = node("button", "Inspect terms", "secondary");
  button.type = "submit"; button.id = "subscription-terms-submit";
  input.addEventListener("focus", () => { requestedFocusId = input.id; });
  button.addEventListener("click", () => { requestedFocusId = button.id; });
  const controls = node("div", "", "subscription-inspector-controls"); controls.append(input, button);
  const hint = node("small", "Read-only. No funding or wallet signature is requested."); hint.id = "subscription-id-help";
  form.append(label, controls, hint); form.addEventListener("submit", (event) => { event.preventDefault(); void inspectSubscription(input.value); });
  card.append(form, terms ? subscriptionTerms(terms, agent) : node("p", "Enter a subscription ID to inspect its rate, deposit, paid amount, reserve, and schedule state.", "subscription-empty"));
  return card;
}

/* prettier-ignore */
function renderProvider(agent, reasons, subscriptionAgent, terms, mode = "x402") {
  const focus = rememberFocus();
  const root = $("providers");
  root.replaceChildren();
  if (mode === "subscription" && subscriptionAgent)
    root.append(renderSubscriptionProvider(subscriptionAgent, terms));
  else if (mode === "x402" && agent)
    root.append(renderX402Provider(agent, reasons));
  if (!root.children.length) root.append(node("p", mode === "subscription" ? "No subscription cohort is available for this service." : "No provider is available for this policy."));
  $("provider-count").textContent = String([...root.children].filter((child) => child.tagName === "ARTICLE").length);
  restoreFocus(focus);
}

async function inspectSubscription(value) {
  const id = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!/^0x[0-9a-fA-F]{64}$/.test(id)) {
    requestedFocusId = undefined;
    $("error").textContent =
      "Enter a 32-byte subscription ID beginning with 0x.";
    $("error").hidden = false;
    return;
  }
  subscriptionLookupId = id;
  currentSubscriptionTerms = undefined;
  renderProvider(
    currentAgent,
    currentReasons,
    currentSubscriptionAgent,
    currentSubscriptionTerms,
    currentPaymentMode,
  );
  try {
    currentSubscriptionTerms = await api(`/v1/subscriptions/${id}`);
    $("error").hidden = true;
    renderProvider(
      currentAgent,
      currentReasons,
      currentSubscriptionAgent,
      currentSubscriptionTerms,
      currentPaymentMode,
    );
  } catch (error) {
    $("error").textContent = error.message;
    $("error").hidden = false;
  } finally {
    requestedFocusId = undefined;
  }
}

/* prettier-ignore */
function renderSelectedStats(mode, agent) {
  const subscription = mode === "subscription";
  const metrics = subscription ? subscriptionMetrics(agent) : agent?.metrics;
  $("stat-paid-label").textContent = subscription ? "Sampled subscription outputs" : "Eligible paid forecasts";
  $("stat-grades-label").textContent = subscription ? "Sampled quality records" : "Oracle-backed grades";
  $("stat-paid-caption").textContent = subscription ? "Separate subscription cohort" : "Trailing 30 days · after grace";
  $("stat-grades-caption").textContent = subscription ? "Separate from x402 payment history" : "Independent of payment";
  if (!metrics) {
    $("stat-paid").textContent = $("stat-reveal").textContent = $("stat-grades").textContent = "—";
    $("stat-reveal-caption").textContent = subscription ? "No indexed subscription metrics" : "Waiting for indexed evidence";
    return;
  }
  if (subscription) {
    $("stat-paid").textContent = metrics.sampled ?? "—";
    $("stat-reveal").textContent = metrics.revealPct == null ? "Unknown" : formatPct(metrics.revealPct);
    $("stat-grades").textContent = metrics.qualityCount ?? "—";
    $("stat-reveal-caption").textContent = metricCoverageCaption(metrics.revealCount, metrics.revealDenominator, "Separate sampled cohort; coverage unavailable");
    return;
  }
  $("stat-paid").textContent = metrics.eligible_paid_count;
  $("stat-reveal").textContent = formatPct(
    metrics.reveal_pct,
    metrics.eligible_paid_count === 0,
  );
  $("stat-grades").textContent = metrics.graded_count;
  $("stat-reveal-caption").textContent =
    `${metrics.revealed_count} revealed · ${metrics.pending_expiry_or_grace_count} pending expiry or grace`;
}

function details(title, description, rows, raw, focusKey) {
  detailFocusKey = focusKey;
  const root = $("detail-body");
  const heading = node("h2", title);
  heading.id = "detail-title";
  const summary = node("p", description);
  summary.id = "detail-description";
  root.replaceChildren(heading, summary);
  const dl = node("dl");
  for (const [key, value] of rows) {
    const dd = node("dd");
    dd.append(
      typeof value === "string" ? document.createTextNode(value) : value,
    );
    dl.append(node("dt", key), dd);
  }
  root.append(dl);
  if (raw) {
    const block = node("details");
    block.append(
      node("summary", "Raw public evidence"),
      node("pre", JSON.stringify(raw, null, 2)),
    );
    root.append(block);
  }
  $("detail").showModal();
}

function providerDetail(agent, focusKey) {
  const m = agent.metrics;
  details(
    agent.name,
    agent.description,
    [
      [
        "Reveal coverage",
        formatPct(m.reveal_pct, m.eligible_paid_count === 0) +
          ` (${m.revealed_count}/${m.eligible_paid_count})`,
      ],
      ["Grade coverage", formatPct(m.grade_coverage_pct)],
      ["Directional hit rate", formatPct(m.directional_hit_rate_pct)],
      ["History", label(m.history_status)],
      ["Pending expiry or grace", String(m.pending_expiry_or_grace_count)],
      ["Oracle unavailable", String(m.oracle_unavailable_count)],
      ["Oracle excluded", String(m.oracle_excluded_count)],
      ["Pricing", `${formatHbar(agent.price)} per forecast`],
      ["Distribution", "Non-exclusive"],
      [
        "Metadata",
        link(
          "Verified metadata",
          isStaticDemo ? SNAPSHOT_URL : `/v1/metadata/${agent.agent_id}`,
        ),
      ],
      [
        "Metrics",
        link(
          "Machine-readable metrics",
          isStaticDemo ? SNAPSHOT_URL : `/v1/agents/${agent.agent_id}`,
        ),
      ],
    ],
    m,
    focusKey,
  );
}

function sampleState(sample, now = Date.now() / 1000) {
  if (sample.revealed_at) return "Revealed";
  if (now < sample.target_time) return "Pending expiry";
  if (now < sample.target_time + revealGraceSeconds)
    return "Within reporting grace";
  return "Unrevealed";
}

function sampleQuality(sample) {
  if (sample.grade) return `${sample.grade.absolute_error_bps} bps MAE`;
  if (sample.oracle_status === "unavailable") return "Oracle unavailable";
  if (sample.oracle_status === "excluded") return "Oracle excluded";
  return sample.revealed_at ? "Awaiting grade" : "Not revealed";
}

function signalDetail(sample, focusKey) {
  const rows = [
    ["State", sampleState(sample)],
    ["Request", sample.request_id],
    ["Committed", date(sample.committed_at)],
    ["Expires", date(sample.target_time)],
    ["Reveal", sample.revealed_at ? date(sample.revealed_at) : "Not revealed"],
    ["Grade", sampleQuality(sample)],
    ["Payment", txLink("View transfer", sample.native_payment_id)],
    ["Commitment", txLink("View commitment", sample.transaction_hash)],
  ];
  const predictedReturn = sample.reveal?.signal?.predictedReturnBps;
  if (predictedReturn !== undefined)
    rows.push(["Prediction", `${predictedReturn} bps`]);
  details(
    "Forecast evidence",
    "A public record of access, disclosure, and outcome.",
    rows,
    sample,
    focusKey,
  );
}

function renderHistory(samples, nextOffset, mode = "x402") {
  const rows = Array.isArray(samples) ? samples : [];
  const subscription = mode === "subscription";
  $("history-title").textContent = subscription
    ? "Sampled subscription history"
    : "Recent x402 signal history";
  $("history").replaceChildren();
  $("history-empty").hidden = rows.length > 0;
  $("history-empty").querySelector("strong").textContent = subscription
    ? "No sampled subscription record is indexed yet."
    : "A track record starts with one forecast.";
  $("history-empty").querySelector("p").textContent = subscription
    ? "Subscription outputs remain separate from the x402 paid history."
    : "Real paid commitments will appear here as they are indexed.";
  $("load-history").hidden = nextOffset === null || rows.length === 0;
  for (const sample of rows) {
    const tr = node("tr");
    const title = node("td", "ETH / USD");
    title.append(node("small", shortId(sample.request_id)));
    const state = sampleState(sample);
    const revealCell = node("td");
    revealCell.append(
      node("span", state, state === "Revealed" ? "badge good" : "badge"),
    );
    const evidence = node("td");
    const button = node("button", "Inspect", "secondary");
    button.type = "button";
    button.dataset.detailFocus = `history:${sample.request_id}`;
    button.addEventListener("click", () =>
      signalDetail(sample, button.dataset.detailFocus),
    );
    evidence.append(button);
    tr.append(
      title,
      node("td", date(sample.target_time)),
      revealCell,
      node("td", sampleQuality(sample)),
      evidence,
    );
    $("history").append(tr);
  }
}

function renderActivity(activity, mode = "x402") {
  const root = $("activity");
  root.replaceChildren();
  if (mode === "subscription") {
    root.append(
      node(
        "p",
        "Subscription samples are shown in the selected cohort history; x402 activity is hidden.",
      ),
    );
    return;
  }
  const purchases = Array.isArray(activity?.purchases)
    ? activity.purchases
    : [];
  if (!purchases.length) {
    root.append(
      node(
        "p",
        "No paid requests yet. Start the buyer agent to create the first public commitment.",
      ),
    );
    return;
  }
  for (const purchase of purchases.slice(0, 50)) {
    const item = node("article", "", "activity-item");
    const verified =
      purchase.status === "delivered" &&
      purchase.commitment_transaction_id &&
      purchase.commitment_hash;
    item.append(
      node(
        "span",
        verified ? "Delivered and committed" : label(purchase.status),
        verified ? "badge good" : "badge",
      ),
      node("h3", "ETH / USD forecast"),
      node(
        "p",
        `${formatHbar(purchase.amount)} · ${shortId(purchase.request_id)}`,
      ),
    );
    if (purchase.payment_ref)
      item.append(txLink("Payment", purchase.payment_ref));
    if (purchase.commitment_transaction_id)
      item.append(txLink("Commitment", purchase.commitment_transaction_id));
    const sample = currentSamples.find(
      (s) => s.request_id === purchase.request_id,
    );
    if (sample) {
      const button = node("button", "Full evidence", "secondary");
      button.type = "button";
      button.dataset.detailFocus = `activity:${sample.request_id}`;
      button.addEventListener("click", () =>
        signalDetail(sample, button.dataset.detailFocus),
      );
      item.append(button);
    }
    root.append(item);
  }
}

async function refresh() {
  const request = startRequest();
  $("refresh").disabled = true;
  $("providers").setAttribute("aria-busy", "true");
  const mode =
    $("payment-mode").value === "subscription" ? "subscription" : "x402";
  currentPaymentMode = mode;
  syncPolicyControls(mode);
  const healthPromise = api("/health").catch(() => null);
  $("selected-cohort").textContent = `Selected cohort: ${mode}`;
  try {
    let discovery;
    let history;
    let activity = { purchases: [] };
    if (mode === "subscription") {
      discovery = await api("/v1/agents?payment_mode=subscription", {
        signal: request.controller.signal,
      });
      /* prettier-ignore */
      const agentId = discovery.selected_agent_id ?? discovery.agents?.[0]?.agent_id;
      /* prettier-ignore */
      history = agentId ? await api(`/v1/agents/${encodeURIComponent(agentId)}/signals?offset=0`, { signal: request.controller.signal }).catch(() => ({ samples: [], next_offset: null })) : { samples: [], next_offset: null };
    } else {
      const params = new URLSearchParams(new FormData($("filters")));
      params.set("max_price", hbarToTinybars($("max-price").value));
      params.set("allow_unproven", String($("allow-unproven").checked));
      [discovery, history, activity] = await Promise.all([
        api(`/v1/agents?${params}`, { signal: request.controller.signal }),
        api("/v1/agents/1/signals?offset=0", {
          signal: request.controller.signal,
        }),
        api("/v1/activity", { signal: request.controller.signal }),
      ]);
    }
    if (!isCurrentRequest(request.id)) return;
    updateOracleNotice(await healthPromise);
    currentAgent = mode === "x402" ? discovery.agents?.[0] : undefined;
    currentReasons =
      mode === "x402" ? (discovery.decisions?.[0]?.reasons ?? []) : [];
    /* prettier-ignore */
    currentSubscriptionAgent = mode === "subscription" ? discovery.agents?.find((agent) => agent.agent_id === discovery.selected_agent_id) ?? discovery.agents?.[0] : undefined;
    const discoveredTerms = currentSubscriptionAgent?.subscription_terms;
    currentSubscriptionTerms =
      discoveredTerms ??
      (currentSubscriptionTerms?.subscription_id === subscriptionLookupId
        ? currentSubscriptionTerms
        : undefined);
    currentSamples = Array.isArray(history.samples) ? [...history.samples] : [];
    historyNextOffset = history.next_offset ?? null;
    revealGraceSeconds =
      Number(currentAgent?.metrics?.reveal_grace_seconds) ||
      DEFAULT_REVEAL_GRACE_SECONDS;
    const selectedAgent =
      mode === "subscription" ? currentSubscriptionAgent : currentAgent;
    const m =
      mode === "subscription"
        ? subscriptionMetrics(selectedAgent)
        : selectedAgent?.metrics;
    if (mode === "x402" && !m)
      throw new Error("The service returned no provider metrics.");
    const reasons = currentReasons;
    renderSelectedStats(mode, selectedAgent);
    if (mode === "subscription") {
      $("freshness").textContent = m?.isStale
        ? "Indexer catching up · stale subscription evidence"
        : m
          ? `Subscription metrics updated ${Math.max(0, m.lagSeconds ?? 0)}s ago`
          : "Subscription metrics not indexed";
      $("policy-result").textContent = currentSubscriptionAgent
        ? "Selected cohort: subscription. Sampled outputs remain separate from x402 history."
        : "No subscription cohort is available for this service.";
      $("policy-result").dataset.state = currentSubscriptionAgent
        ? "selected"
        : "blocked";
    } else {
      $("freshness").textContent = m.is_stale
        ? "Indexer catching up · stale evidence"
        : `Evidence updated ${Math.max(0, m.lag_seconds)}s ago`;
      $("policy-result").textContent = reasons.length
        ? `No provider meets this policy: ${reasons.map(label).join(", ")}.`
        : "Selected cohort: x402. Buyer policy selects ETH Momentum.";
      $("policy-result").dataset.state = reasons.length
        ? "blocked"
        : "selected";
      if ($("allow-unproven").checked)
        $("policy-result").textContent +=
          " Exploratory purchases are explicitly enabled.";
    }
    renderProvider(
      currentAgent,
      reasons,
      currentSubscriptionAgent,
      currentSubscriptionTerms,
      mode,
    );
    renderHistory(currentSamples, historyNextOffset, mode);
    renderActivity(activity, mode);
    $("error").hidden = true;
  } catch (error) {
    if (error?.name === "AbortError" || !isCurrentRequest(request.id)) return;
    $("error").textContent = error.message;
    $("error").hidden = false;
  } finally {
    if (isCurrentRequest(request.id)) {
      activeRequest = undefined;
      $("refresh").disabled = false;
      $("providers").setAttribute("aria-busy", "false");
    }
  }
}

async function loadHistory() {
  if (!Number.isSafeInteger(historyNextOffset) || historyNextOffset < 0) return;
  const offset = historyNextOffset;
  const request = startRequest();
  $("load-history").disabled = true;
  try {
    /* prettier-ignore */
    const agentId = currentPaymentMode === "subscription" ? currentSubscriptionAgent?.agent_id : currentAgent?.agent_id;
    if (!agentId) return;
    const history = await api(
      `/v1/agents/${agentId}/signals?offset=${offset}`,
      {
        signal: request.controller.signal,
      },
    );
    if (!isCurrentRequest(request.id)) return;
    currentSamples = [
      ...currentSamples,
      ...(Array.isArray(history.samples) ? history.samples : []),
    ];
    historyNextOffset = history.next_offset ?? null;
    renderHistory(currentSamples, historyNextOffset, currentPaymentMode);
  } catch (error) {
    if (error?.name === "AbortError" || !isCurrentRequest(request.id)) return;
    $("error").textContent = error.message;
    $("error").hidden = false;
  } finally {
    if (isCurrentRequest(request.id)) {
      activeRequest = undefined;
      $("load-history").disabled = false;
      $("refresh").disabled = false;
    }
  }
}

function navigate(event) {
  const selected = ["discover", "activity", "protocol"].includes(
    location.hash.slice(1),
  )
    ? location.hash.slice(1)
    : "discover";
  for (const view of ["discover", "activity", "protocol"])
    $(`${view}-view`).hidden = view !== selected;
  for (const link of document.querySelectorAll("[data-view]"))
    link.classList.toggle("active", link.dataset.view === selected);
  $("breadcrumb").textContent =
    `Signal Market / ${selected === "discover" ? "Discover" : selected === "activity" ? "Network activity" : "Protocol"}`;
  if (event?.type === "hashchange")
    window.scrollTo({
      top: 0,
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
}

$("filters").addEventListener("submit", (event) => {
  event.preventDefault();
  void refresh();
});
/* prettier-ignore */
$("payment-mode").addEventListener("change", () => syncPolicyControls($("payment-mode").value));
$("refresh").addEventListener("click", () => void refresh());
$("load-history").addEventListener("click", () => void loadHistory());
$("close-detail").addEventListener("click", () => $("detail").close());
$("detail").addEventListener("close", () => {
  const opener = [...document.querySelectorAll("[data-detail-focus]")].find(
    (element) => element.dataset.detailFocus === detailFocusKey,
  );
  opener?.focus();
});
window.addEventListener("hashchange", navigate);
if (isStaticDemo) {
  document.querySelector(".network-chip").lastChild.textContent =
    "Verified testnet snapshot";
  $("refresh").textContent = "Refresh snapshot";
  $("schema-link").href =
    "https://github.com/chayan-bit/ethonline-hackathon/blob/main/docs/openapi.yaml";
}
syncPolicyControls($("payment-mode").value);
navigate();
void refresh();
setInterval(() => void refresh(), 15000);
