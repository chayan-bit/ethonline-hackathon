export const isStaticDemo =
  typeof location !== "undefined" &&
  (location.hostname.endsWith("github.io") ||
    new URLSearchParams(location.search).has("snapshot"));

const agent = {
  agent_id: "1",
  name: "ETH Momentum",
  description:
    "A transparent 60-second momentum baseline for ETH/USD return forecasts.",
  schema: "defi.return_forecast.v1",
  model_version: "momentum60.v1",
  distribution: "non-exclusive",
  network: "hedera:testnet",
  asset: "0.0.0",
  price: "100000",
  payTo: "0.0.10384424",
  payment_modes: ["x402"],
  active: true,
  metrics: {
    lag_seconds: 0,
    is_stale: false,
    eligible_paid_count: 3,
    revealed_count: 3,
    unrevealed_count: 0,
    reveal_pct: 100,
    graded_count: 1,
    grade_coverage_pct: 33.333333333333336,
    directional_hit_rate_pct: 0,
    mean_absolute_error_bps: 14,
    oracle_excluded_count: 0,
    oracle_unavailable_count: 2,
    pending_expiry_or_grace_count: 0,
    history_status: "insufficient_history",
    reveal_grace_seconds: 300,
  },
};

const samples = [
  {
    request_id:
      "0x10d7ceb8b712edbe1738d0405e3b9b448610642353af3b4e672ca11b4a5158dc",
    agent_id: "1",
    committed_at: 1788668348,
    target_time: 1788668700,
    revealed_at: 1788668709,
    oracle_status: "pending",
    native_payment_id: "0.0.7162784@1788668338.206961381",
    transaction_hash:
      "0x0f7fdd8c28fb326bf2e8fb677bc74717f86bd95add9251f109f5d4e0fd3484fd",
    reveal: { signal: { predictedReturnBps: -3 } },
    grade: {
      graded_at: 1788668786,
      actual_return_bps: -17,
      absolute_error_bps: 14,
      direction_correct: false,
    },
  },
  {
    request_id:
      "0x63c07d42013194b7d974e4a48b058bd23c8f3da1fb615fc7dc39e25796ebd5fc",
    agent_id: "1",
    committed_at: 1788652626,
    target_time: 1788652979,
    revealed_at: 1788653040,
    oracle_status: "unavailable",
    native_payment_id: "0.0.7162784@1788652616.723469092",
    transaction_hash:
      "0x5d6f3ce29f063f950a082c314a4c44d2f600965cb32421a322dcd45e44feab78",
    reveal: { signal: { predictedReturnBps: -11 } },
    grade: null,
  },
  {
    request_id:
      "0x1381ef3f939efd9b5ccf2d0a7439b36ef585b4a76a6dcda9c2b79de7f649950a",
    agent_id: "1",
    committed_at: 1788652162,
    target_time: 1788652515,
    revealed_at: 1788652523,
    oracle_status: "unavailable",
    native_payment_id: "0.0.7162784@1788652152.867721393",
    transaction_hash:
      "0xda1b5cc2fb6ae04b2c1f5a5e847e2d0d39655fdae3553354979c8607fa786685",
    reveal: { signal: { predictedReturnBps: -1 } },
    grade: null,
  },
];

const activity = samples.map((sample) => ({
  request_id: sample.request_id,
  agent_id: "1",
  status: "delivered",
  amount: "100000",
  payment_ref: sample.native_payment_id,
  commitment_hash: "verified",
  commitment_transaction_id: sample.transaction_hash,
}));

export function demoApi(path) {
  const url = new URL(path, "https://demo.invalid");
  if (url.pathname === "/health")
    return structuredClone({
      live: true,
      readiness: {
        ready: true,
        indexer: { status: "verified_snapshot" },
        worker: { enabled: false },
        oracle: {
          current: { status: "compatible" },
          legacy: { records: 2, status: "unavailable" },
        },
      },
    });
  if (url.pathname === "/v1/activity")
    return structuredClone({ purchases: activity });
  if (url.pathname === "/v1/agents/1/signals")
    return structuredClone({ samples, next_offset: null });
  if (url.pathname === "/v1/agents/2/signals")
    return { samples: [], next_offset: null };
  if (url.pathname === "/v1/agents") {
    if (url.searchParams.get("payment_mode") === "subscription")
      return { agents: [], selected_agent_id: null };
    const reasons = [];
    if (Number(url.searchParams.get("min_reveal_pct") ?? 0) > 100)
      reasons.push("reveal_below_policy");
    if (Number(url.searchParams.get("min_samples") ?? 0) > 3)
      reasons.push("insufficient_history");
    if (
      BigInt(url.searchParams.get("max_price") ?? agent.price) <
      BigInt(agent.price)
    )
      reasons.push("price_above_limit");
    return structuredClone({
      agents: [agent],
      selected_agent_id: reasons.length ? null : "1",
      decisions: [{ agent_id: "1", reasons }],
      status: reasons.length ? "no_eligible_provider" : "selected",
    });
  }
  throw new Error("This read-only snapshot does not include that endpoint.");
}
