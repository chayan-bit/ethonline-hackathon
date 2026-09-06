import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddress } from "viem";
import { loadConfig } from "../../src/adapters/config.ts";
import { ETH_USD, SCHEMA } from "../../src/protocol/signal.ts";
import { subscriptionProviderMetadata } from "../../src/service/subscription-metadata.ts";

test("configured agent is a distinct ETH/USD 900-second subscription cohort with draft HCS-14 identity", () => {
  const config = loadConfig({
    PUBLIC_BASE_URL: "http://localhost:3000",
    HEDERA_OPERATOR_ID: "0.0.1001",
    SUBSCRIPTION_AGENT_ID: "7",
    SUBSCRIPTION_PAYEE_ID: "0.0.1002",
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

  const metadata = subscriptionProviderMetadata(config);
  assert.equal(metadata.agent_id, "7");
  assert.equal(metadata.schema, SCHEMA);
  assert.deepEqual(metadata.feed_ids, [ETH_USD]);
  assert.equal(metadata.horizon_seconds, 900);
  assert.equal(metadata.model_version, "momentum60.v1");
  assert.deepEqual(metadata.payment_modes, ["subscription"]);
  assert.equal(metadata.owner, "0.0.1001");
  assert.deepEqual(metadata.subscription_token, {
    id: "0.0.2000",
    address: config.subscriptionTokenAddress,
    symbol: "SMTT",
    decimals: 6,
  });
  assert.equal(metadata.identity.standard, "HCS-14");
  assert.equal(metadata.identity.status, "draft");
  assert.match(metadata.identity.uaid, /^uaid:aid:/);
  assert.equal("price" in metadata, false);
});

test("subscription provider metadata fails closed until all deployed identity and token fields exist", () => {
  const config = loadConfig({ PUBLIC_BASE_URL: "http://localhost:3000" });
  assert.throws(
    () => subscriptionProviderMetadata(config),
    /subscription_metadata_not_configured/,
  );
});

test("subscription writes require an explicit runtime opt-in", () => {
  assert.equal(
    loadConfig({ PUBLIC_BASE_URL: "http://localhost:3000" })
      .subscriptionWritesEnabled,
    false,
  );
  assert.equal(
    loadConfig({
      PUBLIC_BASE_URL: "http://localhost:3000",
      SUBSCRIPTION_WRITES_ENABLED: "true",
    }).subscriptionWritesEnabled,
    true,
  );
});
