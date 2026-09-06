import assert from "node:assert/strict";
import { test } from "node:test";
import { computeSubscriptionMetrics } from "../../src/protocol/subscription-metrics.ts";
import type { SubscriptionSampleEvidence } from "../../src/service/subscription-worker.ts";

const sample = (
  id: string,
  changes: Partial<SubscriptionSampleEvidence> = {},
): SubscriptionSampleEvidence => ({
  subscription_id: `0x${"55".repeat(32)}`,
  request_id: id,
  agent_id: "2",
  schema: "defi.return_forecast.v1",
  price_feed_id: `0x${"ff".repeat(32)}`,
  horizon_seconds: 900,
  payment_mode: "subscription",
  sampled: true,
  committed_at: 100,
  target_time: 1_000,
  revealed_at: 1_010,
  grade: {
    actual_return_bps: "50",
    absolute_error_bps: "20",
    direction_correct: true,
  },
  oracle_status: "graded",
  exclusion_reason: null,
  cohort_membership: "sampled_subscription",
  commitment_transaction_id: "commit",
  ...changes,
});

test("subscription metrics use only comparable sampled commitments and disclaim delivery coverage", () => {
  const metrics = computeSubscriptionMetrics(
    [
      sample(`0x${"11".repeat(32)}`),
      sample(`0x${"22".repeat(32)}`, {
        revealed_at: null,
        grade: null,
        oracle_status: "unavailable",
      }),
      sample(`0x${"33".repeat(32)}`, {
        target_time: 1_900,
        revealed_at: null,
        grade: null,
        oracle_status: "pending",
      }),
    ],
    { indexedThrough: 2_000, deliveredResponseCount: 9, agentId: "2" },
  );
  assert.deepEqual(metrics, {
    scope: "sampled_subscription_commitments",
    cohort_agent_id: "2",
    cohort_feed_id: sample("x").price_feed_id,
    cohort_horizon_seconds: 900,
    delivered_response_count: 9,
    sampled_commitment_count: 3,
    eligible_sampled_count: 2,
    revealed_count: 1,
    unrevealed_count: 1,
    graded_count: 1,
    oracle_excluded_count: 0,
    oracle_unavailable_count: 1,
    reveal_pct: 50,
    grade_coverage_pct: 50,
    mean_absolute_error_bps: 20,
    directional_hit_rate_pct: 100,
    reveal_status: "available",
    grade_coverage_status: "available",
    quality_status: "available",
    delivery_coverage_claim: "not_measured",
  });
});

test("subscription metrics distinguish zero grade coverage from unavailable quality", () => {
  const metrics = computeSubscriptionMetrics(
    [
      sample(`0x${"11".repeat(32)}`, {
        grade: null,
        oracle_status: "unavailable",
      }),
      sample(`0x${"22".repeat(32)}`, {
        revealed_at: null,
        grade: null,
        oracle_status: "pending",
      }),
      sample(`0x${"33".repeat(32)}`, {
        target_time: 1_900,
        revealed_at: null,
        grade: null,
        oracle_status: "pending",
      }),
    ],
    { indexedThrough: 2_000, deliveredResponseCount: 9, agentId: "2" },
  );

  assert.equal(metrics.sampled_commitment_count, 3);
  assert.equal(metrics.eligible_sampled_count, 2);
  assert.equal(metrics.reveal_pct, 50);
  assert.equal(metrics.grade_coverage_pct, 0);
  assert.equal(metrics.mean_absolute_error_bps, null);
  assert.equal(metrics.directional_hit_rate_pct, null);
  assert.equal(metrics.reveal_status, "available");
  assert.equal(metrics.grade_coverage_status, "available");
  assert.equal(metrics.quality_status, "no_graded_sampled_commitments");
});
