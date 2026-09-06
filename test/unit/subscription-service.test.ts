import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../../src/service/store.ts";
import {
  SubscriptionService,
  type SubscriptionEffects,
} from "../../src/service/subscriptions.ts";
import {
  ETH_USD,
  SCHEMA,
  hashSignal,
  type Signal,
} from "../../src/protocol/signal.ts";

const now = 10_000;
const subscriptionId = `0x${"55".repeat(32)}`;
const requestId = `0x${"11".repeat(32)}` as const;
const request = {
  request_id: requestId,
  buyer: "0.0.1001",
  agent_id: "2",
  schema: SCHEMA,
  price_feed_id: ETH_USD,
  target_time: now + 900,
};
const signal: Signal = {
  schema: SCHEMA,
  request_id: requestId,
  agent_id: "2",
  price_feed_id: ETH_USD,
  issued_at: now,
  target_time: now + 900,
  predicted_return_bps: 12,
  model_version: "momentum60.v1",
  distribution: "non-exclusive",
};
const salt = `0x${"22".repeat(32)}` as const;

function harness(options: { entitled?: boolean; active?: boolean } = {}) {
  const store = new Store(":memory:");
  const calls = { generate: 0, commit: 0 };
  const effects: SubscriptionEffects = {
    now: () => now,
    subscription: async () => ({
      subscription_id: subscriptionId,
      escrow: "0x0000000000000000000000000000000000001000",
      agent_id: "2",
      buyer: "0.0.1001",
      provider: "0.0.1002",
      token: "0x0000000000000000000000000000000000002000",
      start: now - 1,
      token_symbol: "SMTT",
      token_decimals: 6,
      end: now + 3_600,
      rate_per_second: "10",
      deposit: "36000",
      paid: "10",
      cancelled_at: 0,
      closed: false,
      schedule_interval: 300,
      scheduled_gas_limit: 500_000,
      next_scheduled_at: 0,
      schedule_address: null,
      automation_reserve_initial_tinybars: "10000000",
      automation_reserve_tinybars: "10000000",
      automation_spent_tinybars: "0",
    }),
    isEntitled: async (_id, buyer) =>
      (options.entitled ?? true) && buyer === "0.0.1001",
    isProviderActive: async () => options.active ?? true,
    generate: async () => {
      calls.generate++;
      return { signal, salt, hash: hashSignal(signal, salt) };
    },
    commit: async () => {
      calls.commit++;
      return { transaction_id: "0.0.1002@10001.000000000" };
    },
  };
  return {
    store,
    calls,
    effects,
    service: new SubscriptionService(store, effects, {
      agentId: "2",
      horizonSeconds: 900,
    }),
  };
}

test("entitled subscription request persists one sampled response and explicit subscription commitment", async () => {
  const h = harness();
  const [first, second] = await Promise.all([
    h.service.request(subscriptionId, request),
    h.service.request(subscriptionId, request),
  ]);
  assert.equal(first.status, "delivered");
  assert.deepEqual(first, second);
  assert.equal(first.subscription_id, subscriptionId);
  assert.equal(first.payment_mode, "subscription");
  assert.equal(first.sampled, true);
  assert.equal("payment_ref" in first, false);
  assert.equal(h.calls.generate, 1);
  assert.equal(h.calls.commit, 1);
  h.store.close();
});

test("cancelled, expired, inactive, mismatched, or unentitled subscriptions cannot create new outputs", async () => {
  for (const options of [{ entitled: false }, { active: false }]) {
    const h = harness(options);
    await assert.rejects(
      h.service.request(subscriptionId, request),
      /subscription_not_entitled|inactive_provider/,
    );
    assert.equal(h.calls.generate, 0);
    h.store.close();
  }
  const h = harness();
  for (const bad of [
    { ...request, agent_id: "1" },
    { ...request, buyer: "0.0.9999" },
    { ...request, target_time: now + 899 },
    { ...request, schema: "wrong" },
  ])
    await assert.rejects(
      h.service.request(subscriptionId, bad),
      /invalid_subscription_request|subscription_not_entitled/,
    );
  h.store.close();
});

test("commit failure remains recoverable and retries the same prepared response without regenerating", async () => {
  const h = harness();
  h.effects.commit = async () => {
    h.calls.commit++;
    if (h.calls.commit === 1) throw new Error("commit_pending");
    return { transaction_id: "recovered" };
  };
  const pending = await h.service.request(subscriptionId, request);
  assert.equal(pending.status, "commit_pending");
  const delivered = await h.service.request(subscriptionId, request);
  assert.equal(delivered.status, "delivered");
  assert.deepEqual(delivered.prepared, pending.prepared);
  assert.equal(h.calls.generate, 1);
  assert.equal(h.calls.commit, 2);
  h.store.close();
});

test("authenticated recovery can return an old response without current entitlement and rejects request conflicts", async () => {
  const h = harness();
  const delivered = await h.service.request(subscriptionId, request);
  h.effects.isEntitled = async () => false;
  assert.deepEqual(h.service.recover(subscriptionId, requestId), delivered);
  await assert.rejects(
    h.service.request(subscriptionId, { ...request, buyer: "0.0.1003" }),
    /request_conflict/,
  );
  h.store.close();
});
