import type { Config } from "../adapters/config.ts";
import { createHcs14Identity } from "../protocol/hcs14.ts";
import { ETH_USD, SCHEMA } from "../protocol/signal.ts";
import {
  SUBSCRIPTION_HORIZON_SECONDS,
  SUBSCRIPTION_MODEL_VERSION,
} from "../protocol/subscription.ts";

export function subscriptionProviderMetadata(config: Config) {
  const {
    operatorId: owner,
    registryAddress,
    subscriptionVaultAddress,
    subscriptionTokenAddress,
    subscriptionTokenId,
    subscriptionTokenSymbol,
    subscriptionTokenDecimals,
    subscriptionPayeeId,
    subscriptionAgentId,
  } = config;
  if (
    !owner ||
    !registryAddress ||
    !subscriptionVaultAddress ||
    !subscriptionTokenAddress ||
    !subscriptionTokenId ||
    !subscriptionTokenSymbol ||
    !Number.isSafeInteger(subscriptionTokenDecimals) ||
    !subscriptionPayeeId ||
    !subscriptionAgentId
  ) {
    throw new Error("subscription_metadata_not_configured");
  }
  const endpoint = `${config.baseUrl}/v1/subscriptions/{subscription_id}/signals`;
  const identity = createHcs14Identity({
    registry: "hedera-agent-registry",
    name: "ETH Momentum 900s",
    version: "0.1.0",
    protocol: "rest",
    nativeId: `${config.network}:${registryAddress}:${subscriptionAgentId}`,
    skills: [100],
    uid: subscriptionAgentId,
    domain: new URL(config.baseUrl).hostname,
  });
  return {
    agent_id: subscriptionAgentId,
    owner,
    payTo: subscriptionPayeeId,
    name: "ETH Momentum 900s",
    description:
      "The same transparent 60-second momentum baseline for an ETH/USD forecast 900 seconds ahead.",
    schema: SCHEMA,
    model_version: SUBSCRIPTION_MODEL_VERSION,
    horizon_seconds: SUBSCRIPTION_HORIZON_SECONDS,
    distribution: "non-exclusive",
    endpoint,
    network: config.network,
    payment_modes: ["subscription"] as const,
    sampled: true as const,
    sampled_scope: "sampled_outputs_only" as const,
    reveal_metrics: "independent" as const,
    quality_metrics: "independent" as const,
    feed_ids: [ETH_USD],
    subscription_vault: subscriptionVaultAddress,
    subscription_token: {
      id: subscriptionTokenId,
      address: subscriptionTokenAddress,
      symbol: subscriptionTokenSymbol,
      decimals: subscriptionTokenDecimals,
    },
    identity,
  };
}
