const $ = (id) => document.getElementById(id);
const node = (tag, text, className) =>
  Object.assign(document.createElement(tag), {
    textContent: text ?? "",
    className: className ?? "",
  });
const HBAR_TINYBARS = 100_000_000n;
const DEFAULT_REVEAL_GRACE_SECONDS = 300;

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

let currentAgent;
let currentSamples = [];
let historyNextOffset = null;
let revealGraceSeconds = DEFAULT_REVEAL_GRACE_SECONDS;
let requestSequence = 0;
let activeRequest;
let detailFocusKey;

async function api(path, options = {}) {
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

function renderProvider(agent, reasons) {
  if (!agent) {
    $("providers").replaceChildren(
      node("p", "No provider is available for this policy."),
    );
    return;
  }
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
  const inspect = node("button", "Inspect provider ↗", "secondary");
  inspect.type = "button";
  inspect.dataset.detailFocus = `provider:${agent.agent_id}`;
  inspect.addEventListener("click", () =>
    providerDetail(agent, inspect.dataset.detailFocus),
  );
  footer.append(price, inspect);
  card.append(footer);
  $("providers").replaceChildren(card);
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
        link("Verified metadata ↗", `/v1/metadata/${agent.agent_id}`),
      ],
      [
        "Metrics",
        link("Machine-readable metrics ↗", `/v1/agents/${agent.agent_id}`),
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
    ["Payment", txLink("View transfer ↗", sample.native_payment_id)],
    ["Commitment", txLink("View commitment ↗", sample.transaction_hash)],
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

function renderHistory(samples, nextOffset) {
  const rows = Array.isArray(samples) ? samples : [];
  $("history").replaceChildren();
  $("history-empty").hidden = rows.length > 0;
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
    const button = node("button", "Inspect ↗", "secondary");
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

function renderActivity(activity) {
  const root = $("activity");
  root.replaceChildren();
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
      item.append(txLink("Payment ↗", purchase.payment_ref));
    if (purchase.commitment_transaction_id)
      item.append(txLink("Commitment ↗", purchase.commitment_transaction_id));
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
  try {
    const params = new URLSearchParams(new FormData($("filters")));
    params.set("max_price", hbarToTinybars($("max-price").value));
    params.set("allow_unproven", String($("allow-unproven").checked));
    const [discovery, history, activity] = await Promise.all([
      api(`/v1/agents?${params}`, { signal: request.controller.signal }),
      api("/v1/agents/1/signals?offset=0", {
        signal: request.controller.signal,
      }),
      api("/v1/activity", { signal: request.controller.signal }),
    ]);
    if (!isCurrentRequest(request.id)) return;
    currentAgent = discovery.agents?.[0];
    currentSamples = Array.isArray(history.samples) ? [...history.samples] : [];
    historyNextOffset = history.next_offset ?? null;
    revealGraceSeconds =
      Number(currentAgent?.metrics?.reveal_grace_seconds) ||
      DEFAULT_REVEAL_GRACE_SECONDS;
    const m = currentAgent?.metrics;
    if (!m) throw new Error("The service returned no provider metrics.");
    const reasons = discovery.decisions?.[0]?.reasons ?? [];
    $("stat-paid").textContent = m.eligible_paid_count;
    $("stat-reveal").textContent = formatPct(
      m.reveal_pct,
      m.eligible_paid_count === 0,
    );
    $("stat-grades").textContent = m.graded_count;
    $("stat-reveal-caption").textContent =
      `${m.revealed_count} revealed · ${m.pending_expiry_or_grace_count} pending expiry or grace`;
    $("freshness").textContent = m.is_stale
      ? "Indexer catching up · stale evidence"
      : `Evidence updated ${Math.max(0, m.lag_seconds)}s ago`;
    $("policy-result").textContent = reasons.length
      ? `No provider meets this policy: ${reasons.map(label).join(", ")}.`
      : "1 eligible provider. Buyer policy selects ETH Momentum.";
    if ($("allow-unproven").checked)
      $("policy-result").textContent +=
        " Exploratory purchases are explicitly enabled.";
    renderProvider(currentAgent, reasons);
    renderHistory(currentSamples, historyNextOffset);
    renderActivity(activity);
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
    const history = await api(`/v1/agents/1/signals?offset=${offset}`, {
      signal: request.controller.signal,
    });
    if (!isCurrentRequest(request.id)) return;
    currentSamples = [
      ...currentSamples,
      ...(Array.isArray(history.samples) ? history.samples : []),
    ];
    historyNextOffset = history.next_offset ?? null;
    renderHistory(currentSamples, historyNextOffset);
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

function navigate() {
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
    `Marketplace / ${selected === "discover" ? "Discover providers" : selected === "activity" ? "Network activity" : "The protocol"}`;
}

$("filters").addEventListener("submit", (event) => {
  event.preventDefault();
  void refresh();
});
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
navigate();
void refresh();
setInterval(() => void refresh(), 15000);
