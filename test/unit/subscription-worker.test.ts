import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddress } from "viem";
import { loadConfig } from "../../src/adapters/config.ts";
import {
  ETH_USD,
  SCHEMA,
  hashSignal,
  type Signal,
} from "../../src/protocol/signal.ts";
import type { SubscriptionResponse } from "../../src/protocol/subscription.ts";
import { Store } from "../../src/service/store.ts";
import { SubscriptionWorker } from "../../src/service/subscription-worker.ts";

const requestId = `0x${"11".repeat(32)}` as const;
const subscriptionId = `0x${"55".repeat(32)}` as const;
const signal: Signal = {
  schema: SCHEMA,
  request_id: requestId,
  agent_id: "2",
  price_feed_id: ETH_USD,
  issued_at: 10_000,
  target_time: 10_900,
  predicted_return_bps: 12,
  model_version: "momentum60.v1",
  distribution: "non-exclusive",
};
const salt = `0x${"22".repeat(32)}` as const;
const response: SubscriptionResponse = {
  subscription_id: subscriptionId,
  payment_mode: "subscription",
  sampled: true,
  request: {
    request_id: requestId,
    buyer: "0.0.1001",
    agent_id: "2",
    schema: SCHEMA,
    price_feed_id: ETH_USD,
    target_time: 10_900,
  },
  status: "delivered",
  prepared: { signal, salt, hash: hashSignal(signal, salt) },
  commitment: { transaction_id: "commit-tx" },
};

test("subscription worker projects only sampled subscription evidence and completes reveal and grade", async () => {
  const store = new Store(":memory:");
  store.put("subscription_responses", requestId, response);
  let now = 10_800;
  const calls = { reveal: 0, grade: 0, simulate: 0 };
  const ledger = {
    address: getAddress("0x0000000000000000000000000000000000006000"),
    abi: [],
    commitment: async () => ({
      exists: true,
      subscription_id: subscriptionId,
      agent_id: "2",
      hash: response.prepared.hash,
      committed_at: 10_001,
      issued_at: 10_000,
      target_time: 10_900,
      price_feed_id: ETH_USD,
      subscriber: getAddress("0x0000000000000000000000000000000000001001"),
      revealed: calls.reveal > 0,
    }),
    reveal: async () => {
      calls.reveal++;
    },
    grade: async () => {
      calls.grade++;
    },
    revealRecord: async () => ({
      revealed: calls.reveal > 0,
      revealed_at: calls.reveal > 0 ? 10_901 : 0,
    }),
    gradeRecord: async () => ({
      graded: calls.grade > 0,
      oracle_excluded: false,
      exclusion_reason: 0,
      actual_return_bps: "50",
      absolute_error_bps: "38",
      direction_correct: true,
      issue: null,
      target: null,
      finalized_at: calls.grade > 0 ? 10_902 : 0,
    }),
  };
  const config = loadConfig({
    PUBLIC_BASE_URL: "http://localhost:3000",
    PYTH_ADDRESS: getAddress("0x0000000000000000000000000000000000007000"),
  });
  const worker = new SubscriptionWorker(config, store, ledger as never, {
    now: () => now,
    price: async (_config, timestamp) => ({
      price: { price: 100n, conf: 1n, expo: 0 },
      publishTime: timestamp,
      updates: [`0x${"44".repeat(32)}`],
    }),
    fee: async () => 1n,
    simulate: async () => {
      calls.simulate++;
    },
  });
  await worker.tick();
  assert.equal(calls.reveal, 0);
  const pending = store.get<any>("subscription_samples", requestId);
  assert.equal(pending.payment_mode, "subscription");
  assert.equal(pending.sampled, true);
  assert.equal("payment_ref" in pending, false);

  now = 10_901;
  await worker.tick();
  assert.deepEqual(calls, { reveal: 1, grade: 1, simulate: 1 });
  const graded = store.get<any>("subscription_samples", requestId);
  assert.equal(graded.revealed_at, 10_901);
  assert.deepEqual(graded.grade, {
    actual_return_bps: "50",
    absolute_error_bps: "38",
    direction_correct: true,
  });
  assert.equal(graded.cohort_membership, "sampled_subscription");
  store.close();
});

test("subscription worker records oracle unavailability without changing delivery or payment state", async () => {
  const store = new Store(":memory:");
  store.put("subscription_responses", requestId, response);
  const ledger = {
    address: getAddress("0x0000000000000000000000000000000000006000"),
    abi: [],
    commitment: async () => ({
      exists: true,
      subscription_id: subscriptionId,
      agent_id: "2",
      hash: response.prepared.hash,
      committed_at: 10_001,
      issued_at: 10_000,
      target_time: 10_900,
      price_feed_id: ETH_USD,
      subscriber: getAddress("0x0000000000000000000000000000000000001001"),
      revealed: true,
    }),
    reveal: async () => {},
    grade: async () => {
      throw new Error("oracle");
    },
    revealRecord: async () => ({ revealed: true, revealed_at: 10_901 }),
    gradeRecord: async () => ({
      graded: false,
      oracle_excluded: false,
      exclusion_reason: 0,
      actual_return_bps: "0",
      absolute_error_bps: "0",
      direction_correct: false,
      issue: null,
      target: null,
      finalized_at: 0,
    }),
  };
  const worker = new SubscriptionWorker(
    loadConfig({ PUBLIC_BASE_URL: "http://localhost:3000" }),
    store,
    ledger as never,
    {
      now: () => 10_901,
      price: async () => {
        throw new Error("unavailable");
      },
      fee: async () => 0n,
      simulate: async () => {},
    },
  );
  await worker.tick();
  assert.equal(
    store.get<any>("subscription_samples", requestId).oracle_status,
    "unavailable",
  );
  assert.equal(
    store.get<SubscriptionResponse>("subscription_responses", requestId)
      ?.status,
    "delivered",
  );
  store.close();
});
