import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddress } from "viem";
import { loadConfig } from "../../src/adapters/config.ts";
import { accountAddress } from "../../src/adapters/hedera.ts";
import { SubscriptionVaultAdapter } from "../../src/adapters/subscription-vault.ts";

const subscriptionId = `0x${"55".repeat(32)}` as const;
const escrow = getAddress("0x0000000000000000000000000000000000001000");
const token = getAddress("0x0000000000000000000000000000000000002000");

test("subscription adapter returns auditable token terms and isolated automation reserve", async () => {
  const config = loadConfig({
    PUBLIC_BASE_URL: "http://localhost:3000",
    SUBSCRIPTION_AGENT_ID: "2",
    SUBSCRIPTION_VAULT_ADDRESS: getAddress(
      "0x0000000000000000000000000000000000003000",
    ),
    SUBSCRIPTION_TOKEN_ADDRESS: token,
    SUBSCRIPTION_TOKEN_ID: "0.0.2000",
    SUBSCRIPTION_TOKEN_SYMBOL: "SMTT",
    SUBSCRIPTION_TOKEN_DECIMALS: "6",
    HEDERA_PAYEE_ID: "0.0.1002",
  });
  const adapter = new SubscriptionVaultAdapter(config);
  Object.assign((adapter as unknown as { client: object }).client, {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "subscriptionEscrow") return escrow;
      if (functionName === "terms")
        return [
          accountAddress("0.0.1001"),
          accountAddress("0.0.1002"),
          token,
          2n,
          10_000n,
          13_600n,
          10n,
          36_000n,
          100n,
          0n,
          false,
          300n,
          500_000n,
        ];
      if (functionName === "automationReserveInitial") return 10_000_000n;
      if (functionName === "automationReserve") return 9_000_000n;
      if (functionName === "automationSpent") return 1_000_000n;
      if (functionName === "nextScheduledAt") return 10_300n;
      if (functionName === "scheduleAddress")
        return getAddress("0x0000000000000000000000000000000000004000");
      if (functionName === "isEntitled") return true;
      throw new Error(`unexpected_${functionName}`);
    },
    getBalance: async () => 90_000_000_000_000_000n,
  });

  assert.deepEqual(await adapter.subscription(subscriptionId), {
    subscription_id: subscriptionId,
    escrow,
    agent_id: "2",
    buyer: "0.0.1001",
    provider: "0.0.1002",
    token,
    token_symbol: "SMTT",
    token_decimals: 6,
    start: 10_000,
    end: 13_600,
    rate_per_second: "10",
    deposit: "36000",
    paid: "100",
    cancelled_at: 0,
    closed: false,
    schedule_interval: 300,
    scheduled_gas_limit: 500_000,
    next_scheduled_at: 10_300,
    schedule_address: getAddress("0x0000000000000000000000000000000000004000"),
    automation_reserve_initial_tinybars: "10000000",
    automation_reserve_tinybars: "9000000",
    automation_spent_tinybars: "1000000",
  });
  assert.equal(await adapter.isEntitled(subscriptionId, "0.0.1001"), true);
});

test("subscription adapter rejects unknown subscriptions and invalid token configuration", async () => {
  assert.throws(
    () =>
      loadConfig({
        PUBLIC_BASE_URL: "http://localhost:3000",
        SUBSCRIPTION_TOKEN_DECIMALS: "19",
      }),
    /Invalid SUBSCRIPTION_TOKEN_DECIMALS/,
  );
  const config = loadConfig({
    PUBLIC_BASE_URL: "http://localhost:3000",
    SUBSCRIPTION_AGENT_ID: "2",
    SUBSCRIPTION_VAULT_ADDRESS: getAddress(
      "0x0000000000000000000000000000000000003000",
    ),
    SUBSCRIPTION_TOKEN_ADDRESS: token,
    SUBSCRIPTION_TOKEN_ID: "0.0.2000",
    SUBSCRIPTION_TOKEN_SYMBOL: "SMTT",
    SUBSCRIPTION_TOKEN_DECIMALS: "6",
  });
  const adapter = new SubscriptionVaultAdapter(config);
  Object.assign((adapter as unknown as { client: object }).client, {
    readContract: async () =>
      getAddress("0x0000000000000000000000000000000000000000"),
  });
  await assert.rejects(
    adapter.subscription(subscriptionId),
    /unknown_subscription/,
  );
});

test("subscription adapter binds create and exit writes to the intended signer and exact native value", async () => {
  const config = loadConfig({
    PUBLIC_BASE_URL: "http://localhost:3000",
    SUBSCRIPTION_AGENT_ID: "2",
    HEDERA_OPERATOR_ID: "0.0.1002",
    HEDERA_OPERATOR_KEY: "operator-key",
    HEDERA_BUYER_ID: "0.0.1001",
    HEDERA_BUYER_KEY: "buyer-key",
    SUBSCRIPTION_VAULT_ADDRESS: getAddress(
      "0x0000000000000000000000000000000000003000",
    ),
    SUBSCRIPTION_TOKEN_ADDRESS: token,
    SUBSCRIPTION_TOKEN_ID: "0.0.2000",
    SUBSCRIPTION_TOKEN_SYMBOL: "SMTT",
    SUBSCRIPTION_TOKEN_DECIMALS: "6",
  });
  const calls: Array<{
    signer?: string;
    name: string;
    args: readonly unknown[];
    value: bigint;
    maxFee: bigint | undefined;
  }> = [];
  const execute = async (
    used: typeof config,
    _address: unknown,
    _abi: unknown,
    name: string,
    args: readonly unknown[],
    value = 0n,
    maxFee?: bigint,
  ) => {
    calls.push({ signer: used.operatorId, name, args, value, maxFee });
    return { transaction_id: `${name}-tx` };
  };
  const adapter = new SubscriptionVaultAdapter(config, execute as never);
  Object.assign((adapter as unknown as { client: object }).client, {
    readContract: async () => escrow,
  });
  await adapter.create({
    subscriptionId,
    agentId: 2n,
    start: 10_000n,
    end: 13_600n,
    ratePerSecond: 10n,
    deposit: 36_000n,
    scheduleInterval: 300n,
    scheduledGasLimit: 500_000n,
    reserveTinybars: 10_000_000n,
  });
  await adapter.checkpoint(subscriptionId);
  await adapter.cancelTo(subscriptionId, "0.0.1003");
  assert.deepEqual(
    calls.map((call) => [call.signer, call.name, call.value, call.maxFee]),
    [
      ["0.0.1001", "createSubscription", 10_000_000n, 500_000_000n],
      ["0.0.1002", "checkpoint", 0n, 300_000_000n],
      ["0.0.1001", "cancelTo", 0n, 300_000_000n],
    ],
  );
  assert.deepEqual(calls[0].args, [
    subscriptionId,
    2n,
    10_000n,
    13_600n,
    10n,
    36_000n,
    300n,
    500_000n,
  ]);
  assert.equal(calls[2].args[0], accountAddress("0.0.1003"));
});
