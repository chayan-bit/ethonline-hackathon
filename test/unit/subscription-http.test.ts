import assert from "node:assert/strict";
import { test } from "node:test";
import { PrivateKey } from "@x402/hedera";
import { getAddress } from "viem";
import { loadConfig } from "../../src/adapters/config.ts";
import { ETH_USD, SCHEMA } from "../../src/protocol/signal.ts";
import type {
  SubscriptionResponse,
  SubscriptionTerms,
} from "../../src/protocol/subscription.ts";
import { Auth, bodyHash } from "../../src/service/auth.ts";
import { createApp } from "../../src/service/app.ts";
import { subscriptionProviderMetadata } from "../../src/service/subscription-metadata.ts";
import { Store } from "../../src/service/store.ts";

const subscriptionId = `0x${"55".repeat(32)}`;
const requestId = `0x${"11".repeat(32)}`;

function proof(
  auth: Auth,
  key: InstanceType<typeof PrivateKey>,
  scope: Parameters<Auth["issue"]>[0],
) {
  const challenge = auth.issue(scope);
  return Buffer.from(
    JSON.stringify({
      challenge_id: challenge.id,
      signature: Buffer.from(key.sign(Buffer.from(challenge.message))).toString(
        "hex",
      ),
    }),
  ).toString("base64");
}

test("subscription HTTP mode checks wallet auth, exposes terms, and never fabricates x402 evidence", async () => {
  const store = new Store(":memory:");
  const config = loadConfig({
    PUBLIC_BASE_URL: "http://localhost:3000",
    HEDERA_OPERATOR_ID: "0.0.1001",
    SUBSCRIPTION_AGENT_ID: "7",
    HEDERA_PAYEE_ID: "0.0.1002",
    REGISTRY_ADDRESS: getAddress("0x0000000000000000000000000000000000003000"),
    SUBSCRIPTION_VAULT_ADDRESS: getAddress(
      "0x0000000000000000000000000000000000004000",
    ),
    SUBSCRIPTION_TOKEN_ADDRESS: getAddress(
      "0x0000000000000000000000000000000000002000",
    ),
    SUBSCRIPTION_TOKEN_ID: "0.0.2000",
    SUBSCRIPTION_TOKEN_SYMBOL: "SMTT",
    SUBSCRIPTION_TOKEN_DECIMALS: "6",
  });
  const key = PrivateKey.generateECDSA();
  const auth = new Auth(
    store,
    config.baseUrl,
    async () => key.publicKey,
    () => 10_000,
  );
  const request = {
    request_id: requestId,
    buyer: "0.0.1001",
    agent_id: "7",
    schema: SCHEMA,
    price_feed_id: ETH_USD,
    target_time: 10_900,
  };
  const response = {
    subscription_id: subscriptionId,
    payment_mode: "subscription",
    sampled: true,
    request,
    status: "delivered",
    prepared: {
      signal: {
        ...request,
        schema: SCHEMA,
        issued_at: 10_000,
        predicted_return_bps: 12,
        model_version: "momentum60.v1",
        distribution: "non-exclusive",
      },
      salt: `0x${"22".repeat(32)}`,
      hash: `0x${"33".repeat(32)}`,
    },
    commitment: { transaction_id: "0.0.1002@10001.000000000" },
  } as SubscriptionResponse;
  const terms = {
    subscription_id: subscriptionId,
    escrow: getAddress("0x0000000000000000000000000000000000005000"),
    agent_id: "7",
    buyer: "0.0.1001",
    provider: "0.0.1002",
    token: config.subscriptionTokenAddress!,
    token_symbol: "SMTT",
    token_decimals: 6,
    start: 9_000,
    end: 20_000,
    rate_per_second: "10",
    deposit: "110000",
    paid: "10000",
    cancelled_at: 0,
    closed: false,
    schedule_interval: 300,
    scheduled_gas_limit: 500_000,
    next_scheduled_at: 10_300,
    schedule_address: null,
    automation_reserve_initial_tinybars: "10000000",
    automation_reserve_tinybars: "9000000",
    automation_spent_tinybars: "1000000",
  } satisfies SubscriptionTerms;
  const service = { request: async () => response, recover: () => response };
  const vault = { subscription: async () => terms };
  store.put("subscription_samples", requestId, {
    subscription_id: subscriptionId,
    request_id: requestId,
    agent_id: "7",
    payment_mode: "subscription",
    sampled: true,
    committed_at: 10_001,
    target_time: 10_900,
  });
  const app = createApp({
    config,
    store,
    gateway: {
      quote: async () => {
        throw new Error("unused");
      },
      purchase: async () => {
        throw new Error("unused");
      },
    },
    auth,
    seller: async () => ({ active: true }),
    subscription: {
      agentId: "7",
      service,
      vault,
      metadata: () => subscriptionProviderMetadata(config),
    },
  });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  const address = app.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const path = `/v1/subscriptions/${subscriptionId}/signals`;
  const raw = JSON.stringify(request);
  try {
    assert.equal(
      (
        await fetch(`${base}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: raw,
        })
      ).status,
      401,
    );
    const authHeader = proof(auth, key, {
      buyer: request.buyer,
      request_id: requestId,
      method: "POST",
      path,
      body_hash: bodyHash(raw),
    });
    const delivered = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-wallet-proof": authHeader,
      },
      body: raw,
    });
    assert.equal(delivered.status, 200);
    const deliveredText = await delivered.text();
    assert.match(deliveredText, /"payment_mode":"subscription"/);
    assert.doesNotMatch(deliveredText, /payment_ref|PAYMENT-RESPONSE/);

    const recoveryPath = `/v1/subscriptions/${subscriptionId}/requests/${requestId}`;
    const recoveryProof = proof(auth, key, {
      buyer: request.buyer,
      request_id: requestId,
      method: "GET",
      path: recoveryPath,
      body_hash: bodyHash(""),
    });
    assert.equal(
      (
        await fetch(`${base}${recoveryPath}`, {
          headers: { "x-wallet-proof": recoveryProof },
        })
      ).status,
      200,
    );
    assert.deepEqual(
      await (await fetch(`${base}/v1/subscriptions/${subscriptionId}`)).json(),
      terms,
    );
    const metadata = (await (
      await fetch(`${base}/v1/agents/7`)
    ).json()) as Record<string, unknown>;
    assert.equal(metadata.agent_id, "7");
    assert.deepEqual(metadata.payment_modes, ["subscription"]);
    assert.equal(
      ((await (await fetch(`${base}/v1/agents`)).json()) as any).pagination
        .total,
      1,
    );
    assert.equal(
      (
        (await (
          await fetch(`${base}/v1/agents?payment_mode=subscription`)
        ).json()) as any
      ).agents[0].agent_id,
      "7",
    );
    const history = (await (
      await fetch(`${base}/v1/agents/7/signals`)
    ).json()) as any;
    assert.equal(history.samples[0].payment_mode, "subscription");
    assert.equal(history.delivery_coverage_claim, "not_measured");
  } finally {
    await new Promise<void>((resolve, reject) =>
      app.close((error) => (error ? reject(error) : resolve())),
    );
    store.close();
  }
});
