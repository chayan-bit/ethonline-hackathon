import { loadConfig } from "./adapters/config.ts";
import { Store } from "./service/store.ts";
import { LedgerRouter } from "./adapters/ledger.ts";
import {
  facilitator,
  inspectPayment,
  lookupPayment,
  normalizeTransactionId,
} from "./adapters/payment.ts";
import { Transaction } from "@x402/hedera";
import { generateForecast } from "./adapters/pyth.ts";
import { Gateway } from "./service/gateway.ts";
import { Auth } from "./service/auth.ts";
import { accountKey } from "./adapters/identity.ts";
import { Indexer } from "./service/indexer.ts";
import { Worker } from "./service/worker.ts";
import { createApp } from "./service/app.ts";
import { acquireProcessLock } from "./service/process-lock.ts";
import { SubscriptionVaultAdapter } from "./adapters/subscription-vault.ts";
import { SubscriptionLedgerAdapter } from "./adapters/subscription-ledger.ts";
import { generateSubscriptionForecast } from "./adapters/subscription-forecast.ts";
import { SubscriptionService } from "./service/subscriptions.ts";
import {
  SubscriptionWorker,
  type SubscriptionSampleEvidence,
} from "./service/subscription-worker.ts";
import { subscriptionProviderMetadata } from "./service/subscription-metadata.ts";
import { computeSubscriptionMetrics } from "./protocol/subscription-metrics.ts";

const config = loadConfig();
const releaseLock = acquireProcessLock(`${config.databasePath}.lock`);
process.once("exit", releaseLock);
const store = new Store(config.databasePath);
const ledgers = new LedgerRouter(config, store);
const payments = facilitator(config);
const gateway = new Gateway(store, {
  activeLedgerAddress: ledgers.active.address,
  legacyLedgerAddress: config.legacyLedgerAddress,
  now: () => Math.floor(Date.now() / 1000),
  seller: () => ledgers.active.seller(),
  feePayer: payments.feePayer,
  verify: async (payload, requirements) => {
    const result = await payments.verify(payload, requirements);
    if (result.isValid && result.payer)
      inspectPayment(payload, requirements, result.payer);
    return result;
  },
  paymentId: (payload) => {
    const tx = Transaction.fromBytes(
      Buffer.from(String(payload.payload.transaction), "base64"),
    );
    if (!tx.transactionId) throw new Error("invalid_transaction_id");
    return normalizeTransactionId(tx.transactionId.toString());
  },
  generate: (request) => generateForecast(config, request),
  settle: payments.settle,
  lookupPayment: (id, quote) => lookupPayment(config, id, quote),
  commit: (q, p, id) => ledgers.forQuote(q).commit(q, p, id),
});
const auth = new Auth(store, config.baseUrl, (buyer) =>
  accountKey(config, buyer),
);
const indexer = new Indexer(config, store);
const worker = new Worker(config, store, ledgers, gateway);
const hasSubscriptionConfig = Boolean(
  config.registryAddress &&
    config.subscriptionVaultAddress &&
    config.subscriptionLedgerAddress &&
    config.subscriptionTokenAddress &&
    config.subscriptionTokenId &&
    config.subscriptionTokenSymbol &&
    Number.isSafeInteger(config.subscriptionTokenDecimals) &&
    config.subscriptionPayeeId &&
    config.subscriptionAgentId &&
    config.operatorId,
);
let subscriptionWorker: SubscriptionWorker | undefined;
let subscriptionContext: Parameters<typeof createApp>[0]["subscription"];
if (hasSubscriptionConfig) {
  const vault = new SubscriptionVaultAdapter(config);
  const subscriptionLedger = new SubscriptionLedgerAdapter(config, store);
  let isTokenPolicyVerified = false;
  try {
    await vault.verifyTokenPolicy();
    isTokenPolicyVerified = true;
  } catch {
    console.error(
      JSON.stringify({ event: "subscription_token_policy_unavailable" }),
    );
  }
  const service = new SubscriptionService(
    store,
    {
      now: () => Math.floor(Date.now() / 1000),
      subscription: (id) => vault.subscription(id),
      isEntitled: (id, buyer) => vault.isEntitled(id, buyer),
      isProviderActive: async (agentId) =>
        config.subscriptionWritesEnabled &&
        isTokenPolicyVerified &&
        agentId === config.subscriptionAgentId &&
        (await subscriptionLedger.provider()).active,
      generate: (request) => generateSubscriptionForecast(config, request),
      commit: (subscriptionId, prepared) => {
        if (!config.subscriptionWritesEnabled)
          throw new Error("subscription_writes_disabled");
        return subscriptionLedger.commit(subscriptionId, prepared);
      },
    },
    { agentId: config.subscriptionAgentId!, horizonSeconds: 900 },
  );
  if (config.subscriptionWritesEnabled)
    subscriptionWorker = new SubscriptionWorker(
      config,
      store,
      subscriptionLedger,
    );
  subscriptionContext = {
    agentId: config.subscriptionAgentId!,
    service,
    vault,
    metadata: () => {
      const responses = store.list<{ status: string }>(
        "subscription_responses",
      );
      const metrics = computeSubscriptionMetrics(
        store.list<SubscriptionSampleEvidence>("subscription_samples"),
        {
          indexedThrough: Math.floor(Date.now() / 1000),
          deliveredResponseCount: responses.filter(
            (value) => value.status === "delivered",
          ).length,
          agentId: config.subscriptionAgentId!,
        },
      );
      return {
        ...subscriptionProviderMetadata(config),
        active: isTokenPolicyVerified && config.subscriptionWritesEnabled,
        metrics,
      };
    },
  };
}
const app = createApp({
  config,
  store,
  gateway,
  auth,
  seller: () => ledgers.active.seller(),
  subscription: subscriptionContext,
});
app.listen(config.port, "0.0.0.0", () =>
  console.info(
    JSON.stringify({
      event: "listening",
      port: config.port,
      network: config.network,
    }),
  ),
);
const tick = async () => {
  try {
    await indexer.sync();
    await worker.tick();
    await subscriptionWorker?.tick();
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "background_retry",
        error: error instanceof Error ? error.name : "unknown",
      }),
    );
  }
};
void tick();
const timer = setInterval(() => void tick(), 15000);
process.once("SIGINT", () => {
  clearInterval(timer);
  app.close(() => {
    store.close();
    process.exit(0);
  });
});
process.once("SIGTERM", () => {
  clearInterval(timer);
  app.close(() => {
    store.close();
    process.exit(0);
  });
});
