import {
  AccountAllowanceApproveTransaction,
  ContractId,
} from "@hiero-ledger/sdk";
import { loadConfig } from "../src/adapters/config.ts";
import { operatorClient } from "../src/adapters/hedera.ts";
import { SubscriptionVaultAdapter } from "../src/adapters/subscription-vault.ts";
import { randomId } from "../src/protocol/signal.ts";

const MAX_DURATION = 30n * 86_400n;

function integer(
  value: string | undefined,
  name: string,
  allowZero = false,
): bigint {
  if (!value || !/^\d+$/.test(value)) throw new Error(`invalid_${name}`);
  const parsed = BigInt(value);
  if (allowZero ? parsed < 0n : parsed <= 0n)
    throw new Error(`invalid_${name}`);
  return parsed;
}

async function approveDeposit(
  config: ReturnType<typeof loadConfig>,
  deposit: bigint,
) {
  if (
    !config.buyerId ||
    !config.buyerKey ||
    !config.subscriptionTokenId ||
    !config.subscriptionVaultAddress
  ) {
    throw new Error("subscription_funding_not_configured");
  }
  const buyerConfig = {
    ...config,
    operatorId: config.buyerId,
    operatorKey: config.buyerKey,
  };
  const client = operatorClient(buyerConfig);
  try {
    const spender = ContractId.fromEvmAddress(
      0,
      0,
      config.subscriptionVaultAddress,
    );
    const response = await new AccountAllowanceApproveTransaction()
      .approveTokenAllowance(
        config.subscriptionTokenId,
        config.buyerId,
        spender,
        deposit,
      )
      .setTransactionMemo("Exact subscription deposit allowance")
      .execute(client);
    await response.getReceipt(client);
    return response.transactionId.toString();
  } finally {
    client.close();
  }
}

async function main() {
  const config = loadConfig();
  if (!config.subscriptionAgentId)
    throw new Error("subscription_agent_not_configured");
  const adapter = new SubscriptionVaultAdapter(config);
  const [command, id, ...args] = process.argv.slice(2);
  if (command === "status" && id)
    return console.info(JSON.stringify(await adapter.subscription(id)));
  if (!config.subscriptionWritesEnabled)
    throw new Error("subscription_writes_disabled");
  if (command === "checkpoint" && id)
    return console.info(JSON.stringify(await adapter.checkpoint(id)));
  if (command === "claim" && id)
    return console.info(JSON.stringify(await adapter.claim(id)));
  if (command === "schedule" && id)
    return console.info(JSON.stringify(await adapter.requestSchedule(id)));
  if (command === "cancel" && id)
    return console.info(
      JSON.stringify(
        await adapter.cancelTo(id, args[0] ?? config.buyerId ?? ""),
      ),
    );
  if (command === "close" && id)
    return console.info(
      JSON.stringify(
        await adapter.closeTo(id, args[0] ?? config.buyerId ?? ""),
      ),
    );
  if (command !== "create")
    throw new Error(
      "usage: subscription create <duration-seconds> <rate-atomic-per-second> <reserve-tinybars> [schedule-interval] [schedule-gas]",
    );

  const duration = integer(id, "duration");
  const rate = integer(args[0], "rate");
  const reserveTinybars = integer(args[1], "reserve", true);
  const scheduleInterval = integer(args[2] ?? "300", "schedule_interval");
  const scheduledGasLimit = integer(args[3] ?? "500000", "schedule_gas");
  if (duration > MAX_DURATION) throw new Error("invalid_duration");
  await adapter.verifyTokenPolicy();
  const deposit = rate * duration;
  const allowance_transaction_id = await approveDeposit(config, deposit);
  const subscriptionId = randomId();
  const start = BigInt(Math.floor(Date.now() / 1000) + 30);
  const creation = await adapter.create({
    subscriptionId,
    agentId: BigInt(config.subscriptionAgentId),
    start,
    end: start + duration,
    ratePerSecond: rate,
    deposit,
    scheduleInterval,
    scheduledGasLimit,
    reserveTinybars,
  });
  console.info(
    JSON.stringify({
      subscription_id: subscriptionId,
      allowance_transaction_id,
      creation_transaction_id: creation.transaction_id,
      deposit_atomic_units: deposit.toString(),
      reserve_tinybars: reserveTinybars.toString(),
    }),
  );
}

main().catch((error) => {
  console.error(
    error instanceof Error
      ? error.message.split(":")[0]
      : "subscription_command_failed",
  );
  process.exitCode = 1;
});
