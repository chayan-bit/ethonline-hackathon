import { POLICY } from "./signal.ts";
import type { SubscriptionSampleEvidence } from "../service/subscription-worker.ts";

type Options = { indexedThrough: number; deliveredResponseCount: number; agentId: string };

export function computeSubscriptionMetrics(
  samples: readonly SubscriptionSampleEvidence[],
  options: Options,
) {
  if (
    !Number.isSafeInteger(options.indexedThrough) ||
    options.indexedThrough < 0 ||
    !Number.isSafeInteger(options.deliveredResponseCount) ||
    options.deliveredResponseCount < 0 ||
    !/^[1-9][0-9]{0,77}$/.test(options.agentId) ||
    BigInt(options.agentId) >= 2n ** 256n
  ) {
    throw new Error("invalid_subscription_metrics_options");
  }
  const first = samples[0];
  const cohort = first
    ? samples.filter(
        (sample) =>
          sample.agent_id === first.agent_id &&
          sample.price_feed_id === first.price_feed_id &&
          sample.horizon_seconds === first.horizon_seconds,
      )
    : [];
  const eligible = cohort.filter(
    (sample) =>
      sample.target_time <= options.indexedThrough - POLICY.revealGrace &&
      sample.target_time >= options.indexedThrough - POLICY.historyWindow,
  );
  const revealed = eligible.filter((sample) => sample.revealed_at !== null);
  const graded = eligible.filter((sample) => sample.grade !== null);
  const sumAbsoluteError = graded.reduce(
    (sum, sample) => sum + Number(sample.grade!.absolute_error_bps),
    0,
  );
  return {
    scope: "sampled_subscription_commitments" as const,
    cohort_agent_id: first?.agent_id ?? options.agentId,
    cohort_feed_id: first?.price_feed_id ?? null,
    cohort_horizon_seconds: first?.horizon_seconds ?? 900,
    delivered_response_count: options.deliveredResponseCount,
    sampled_commitment_count: cohort.length,
    eligible_sampled_count: eligible.length,
    revealed_count: revealed.length,
    unrevealed_count: eligible.length - revealed.length,
    graded_count: graded.length,
    oracle_excluded_count: eligible.filter(
      (sample) => sample.oracle_status === "excluded",
    ).length,
    oracle_unavailable_count: eligible.filter(
      (sample) => sample.oracle_status === "unavailable",
    ).length,
    reveal_pct: eligible.length
      ? (revealed.length * 100) / eligible.length
      : null,
    grade_coverage_pct: eligible.length
      ? (graded.length * 100) / eligible.length
      : null,
    mean_absolute_error_bps: graded.length
      ? sumAbsoluteError / graded.length
      : null,
    directional_hit_rate_pct: graded.length
      ? (graded.filter((sample) => sample.grade!.direction_correct).length *
          100) /
        graded.length
      : null,
    reveal_status: eligible.length
      ? ("available" as const)
      : ("no_eligible_sampled_commitments" as const),
    grade_coverage_status: eligible.length
      ? ("available" as const)
      : ("no_eligible_sampled_commitments" as const),
    quality_status: graded.length
      ? ("available" as const)
      : ("no_graded_sampled_commitments" as const),
    delivery_coverage_claim: "not_measured" as const,
  };
}
