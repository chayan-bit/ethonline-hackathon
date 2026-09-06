import { publicClient } from "../adapters/hedera.ts";
import { historicalPrice, pythAbi } from "../adapters/pyth.ts";
import type { Config } from "../adapters/config.ts";
import type { SubscriptionLedgerAdapter } from "../adapters/subscription-ledger.ts";
import { POLICY } from "../protocol/signal.ts";
import {
  SUBSCRIPTION_HORIZON_SECONDS,
  type SubscriptionResponse,
} from "../protocol/subscription.ts";
import type { Store } from "./store.ts";

type Historical = Awaited<ReturnType<typeof historicalPrice>>;
export type SubscriptionSampleEvidence = {
  subscription_id: string;
  request_id: string;
  agent_id: string;
  schema: string;
  price_feed_id: string;
  horizon_seconds: number;
  payment_mode: "subscription";
  sampled: true;
  committed_at: number;
  target_time: number;
  revealed_at: number | null;
  grade: {
    actual_return_bps: string;
    absolute_error_bps: string;
    direction_correct: boolean;
  } | null;
  oracle_status: "pending" | "graded" | "excluded" | "unavailable";
  exclusion_reason: number | null;
  cohort_membership: "sampled_subscription";
  commitment_transaction_id: string;
};

export type SubscriptionWorkerEffects = {
  now(): number;
  price(config: Config, timestamp: number): Promise<Historical>;
  fee(updates: Historical["updates"]): Promise<bigint>;
  simulate(
    requestId: string,
    issue: Historical["updates"],
    target: Historical["updates"],
    value: bigint,
  ): Promise<unknown>;
};

type Job = {
  attempts: number;
  next_attempt: number;
  status: "pending" | "retrying" | "done";
  error?: string;
};

export class SubscriptionWorker {
  private running = false;
  private readonly effects: SubscriptionWorkerEffects;

  constructor(
    private readonly config: Config,
    private readonly store: Store,
    private readonly ledger: SubscriptionLedgerAdapter,
    effects?: SubscriptionWorkerEffects,
  ) {
    const client = publicClient(config);
    this.effects = effects ?? {
      now: () => Math.floor(Date.now() / 1000),
      price: historicalPrice,
      fee: async (updates) =>
        client.readContract({
          address: await ledger.oracleAddress(),
          abi: pythAbi,
          functionName: "getUpdateFee",
          args: [updates],
        }),
      simulate: (requestId, issue, target, value) =>
        client.simulateContract({
          address: ledger.address,
          abi: ledger.abi,
          functionName: "grade",
          args: [requestId, issue, target],
          value: value * 10_000_000_000n,
        }),
    };
  }

  async tick(): Promise<void> {
    if (this.running || !this.config.workerEnabled) return;
    this.running = true;
    try {
      for (const response of this.store.list<SubscriptionResponse>(
        "subscription_responses",
      )) {
        if (response.status !== "delivered" || !response.commitment) continue;
        await this.project(response);
        if (this.effects.now() < response.request.target_time) continue;
        await this.attempt(`reveal/${response.request.request_id}`, () =>
          this.ledger.reveal(response.prepared),
        );
        await this.attempt(`grade/${response.request.request_id}`, () =>
          this.grade(response),
        );
        await this.project(response);
      }
    } finally {
      this.running = false;
    }
  }

  private async attempt(id: string, action: () => Promise<unknown>) {
    const now = this.effects.now();
    const previous = this.store.get<Job>("subscription_jobs", id) ?? {
      attempts: 0,
      next_attempt: 0,
      status: "pending",
    };
    if (previous.status === "done" || previous.next_attempt > now) return;
    try {
      const result = await action();
      this.store.put("subscription_jobs", id, {
        ...previous,
        status: "done",
        result,
      });
    } catch {
      const attempts = previous.attempts + 1;
      this.store.put("subscription_jobs", id, {
        attempts,
        status: "retrying",
        next_attempt: now + Math.min(3_600, 30 * 2 ** Math.min(attempts, 7)),
        error: "oracle_unavailable",
      });
    }
  }

  private async grade(response: SubscriptionResponse) {
    const commitment = await this.ledger.commitment(
      response.request.request_id,
    );
    if (!commitment.revealed) throw new Error("not_revealed");
    const [issue, target] = await Promise.all([
      this.effects.price(this.config, commitment.committed_at),
      this.effects.price(this.config, commitment.target_time),
    ]);
    if (
      issue.publishTime > commitment.committed_at + POLICY.oracleWindow ||
      target.publishTime > commitment.target_time + POLICY.oracleWindow
    )
      throw new Error("oracle_window");
    const fees = await Promise.all([
      this.effects.fee(issue.updates),
      this.effects.fee(target.updates),
    ]);
    const fee = fees[0] + fees[1];
    await this.effects.simulate(
      response.request.request_id,
      issue.updates,
      target.updates,
      fee,
    );
    return this.ledger.grade(
      response.request.request_id,
      issue.updates,
      target.updates,
      fee,
    );
  }

  private async project(response: SubscriptionResponse) {
    const requestId = response.request.request_id;
    const [commitment, reveal, grade] = await Promise.all([
      this.ledger.commitment(requestId),
      this.ledger.revealRecord(requestId),
      this.ledger.gradeRecord(requestId),
    ]);
    if (
      !commitment.exists ||
      commitment.subscription_id !== response.subscription_id ||
      commitment.hash !== response.prepared.hash
    ) {
      throw new Error("subscription_commitment_mismatch");
    }
    const gradeJob = this.store.get<Job>(
      "subscription_jobs",
      `grade/${requestId}`,
    );
    const oracleStatus = grade.graded
      ? "graded"
      : grade.oracle_excluded
        ? "excluded"
        : gradeJob?.status === "retrying"
          ? "unavailable"
          : "pending";
    const sample: SubscriptionSampleEvidence = {
      subscription_id: response.subscription_id,
      request_id: requestId,
      agent_id: response.request.agent_id,
      schema: response.request.schema,
      price_feed_id: response.request.price_feed_id,
      horizon_seconds: SUBSCRIPTION_HORIZON_SECONDS,
      payment_mode: "subscription",
      sampled: true,
      committed_at: commitment.committed_at,
      target_time: commitment.target_time,
      revealed_at: reveal.revealed ? reveal.revealed_at : null,
      grade: grade.graded
        ? {
            actual_return_bps: grade.actual_return_bps,
            absolute_error_bps: grade.absolute_error_bps,
            direction_correct: grade.direction_correct,
          }
        : null,
      oracle_status: oracleStatus,
      exclusion_reason: grade.oracle_excluded ? grade.exclusion_reason : null,
      cohort_membership: "sampled_subscription",
      commitment_transaction_id: response.commitment!.transaction_id,
    };
    this.store.put("subscription_samples", requestId, sample);
  }
}
