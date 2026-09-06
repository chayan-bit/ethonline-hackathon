import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddress } from "viem";
import { loadConfig } from "../../src/adapters/config.ts";
import { SubscriptionLedgerAdapter } from "../../src/adapters/subscription-ledger.ts";
import {
  ETH_USD,
  SCHEMA,
  SCHEMA_ID,
  hashSignal,
  type Signal,
} from "../../src/protocol/signal.ts";
import { Store } from "../../src/service/store.ts";

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

test("subscription ledger adapter submits only subscription and signal identity fields", async () => {
  const config = loadConfig({
    PUBLIC_BASE_URL: "http://localhost:3000",
    SUBSCRIPTION_AGENT_ID: "2",
    HEDERA_OPERATOR_ID: "0.0.1002",
    HEDERA_OPERATOR_KEY: "key",
    SUBSCRIPTION_LEDGER_ADDRESS: getAddress(
      "0x0000000000000000000000000000000000006000",
    ),
  });
  const store = new Store(":memory:");
  const calls: Array<{ name: string; args: readonly unknown[] }> = [];
  const execute = async (
    _config: unknown,
    _address: unknown,
    _abi: unknown,
    name: string,
    args: readonly unknown[],
  ) => {
    calls.push({ name, args });
    return { transaction_id: "commit-tx" };
  };
  const ledger = new SubscriptionLedgerAdapter(
    config,
    store,
    execute as never,
    () => 10_000,
  );
  Object.assign((ledger as unknown as { client: object }).client, {
    readContract: async () =>
      calls.length
        ? [
            true,
            subscriptionId,
            2n,
            hashSignal(signal, salt),
            10_001n,
            10_000n,
            10_900n,
            ETH_USD,
            getAddress("0x0000000000000000000000000000000000001001"),
            false,
          ]
        : [false],
  });
  const prepared = { signal, salt, hash: hashSignal(signal, salt) };
  assert.deepEqual(await ledger.commit(subscriptionId, prepared), {
    transaction_id: "commit-tx",
  });
  assert.deepEqual(calls[0], {
    name: "commit",
    args: [
      subscriptionId,
      requestId,
      2n,
      prepared.hash,
      SCHEMA_ID,
      10_000n,
      10_900n,
      ETH_USD,
    ],
  });
  assert.equal(calls[0].args.length, 8);
  assert.equal(
    await ledger
      .commit(subscriptionId, prepared)
      .then((result) => result.transaction_id),
    "commit-tx",
  );
  assert.equal(calls.length, 1);
  store.close();
});

test("subscription ledger adapter rejects wrong horizon and commitment conflicts", async () => {
  const config = loadConfig({
    PUBLIC_BASE_URL: "http://localhost:3000",
    SUBSCRIPTION_AGENT_ID: "2",
    SUBSCRIPTION_LEDGER_ADDRESS: getAddress(
      "0x0000000000000000000000000000000000006000",
    ),
  });
  const store = new Store(":memory:");
  const ledger = new SubscriptionLedgerAdapter(
    config,
    store,
    async () => ({ transaction_id: "unused" }) as never,
    () => 10_000,
  );
  Object.assign((ledger as unknown as { client: object }).client, {
    readContract: async () => [
      true,
      subscriptionId,
      2n,
      `0x${"99".repeat(32)}`,
    ],
  });
  await assert.rejects(
    ledger.commit(subscriptionId, {
      signal: { ...signal, target_time: 10_899 },
      salt,
      hash: hashSignal({ ...signal, target_time: 10_899 }, salt),
    }),
    /invalid_subscription_commit_timing/,
  );
  await assert.rejects(
    ledger.commit(subscriptionId, {
      signal,
      salt,
      hash: hashSignal(signal, salt),
    }),
    /commitment_conflict/,
  );
  store.close();
});
