import { calculateGrade } from "../protocol/grade.ts";
import {
  ETH_USD,
  SCHEMA,
  hashSignal,
  parseSignal,
  randomId,
} from "../protocol/signal.ts";
import {
  SUBSCRIPTION_HORIZON_SECONDS,
  SUBSCRIPTION_MODEL_VERSION,
} from "../protocol/subscription.ts";
import type { BuyRequest, Prepared } from "../service/gateway.ts";
import type { Config } from "./config.ts";
import { historicalPrice } from "./pyth.ts";

type ForecastDependencies = {
  now(): number;
  price(config: Config, timestamp: number): ReturnType<typeof historicalPrice>;
};
const defaults: ForecastDependencies = {
  now: () => Math.floor(Date.now() / 1000),
  price: historicalPrice,
};

export async function generateSubscriptionForecast(
  config: Config,
  request: BuyRequest,
  dependencies: ForecastDependencies = defaults,
): Promise<Prepared> {
  if (
    !config.subscriptionAgentId ||
    request.agent_id !== config.subscriptionAgentId ||
    request.price_feed_id !== ETH_USD ||
    request.schema !== SCHEMA
  )
    throw new Error("invalid_subscription_request");
  const observedAt = dependencies.now();
  const issuedAt = request.target_time - SUBSCRIPTION_HORIZON_SECONDS;
  if (Math.abs(observedAt - issuedAt) > 30)
    throw new Error("invalid_subscription_commit_timing");
  const [before, after] = await Promise.all([
    dependencies.price(config, observedAt - 61),
    dependencies.price(config, observedAt - 1),
  ]);
  if (
    before.publishTime >= after.publishTime ||
    after.publishTime > observedAt ||
    after.publishTime < observedAt - 30
  ) {
    throw new Error("oracle_unavailable");
  }
  const predictedReturnBps = calculateGrade(
    0,
    before.price,
    after.price,
  ).actual_return_bps;
  const signal = parseSignal({
    schema: SCHEMA,
    request_id: request.request_id,
    agent_id: config.subscriptionAgentId,
    price_feed_id: ETH_USD,
    issued_at: issuedAt,
    target_time: request.target_time,
    predicted_return_bps: predictedReturnBps,
    model_version: SUBSCRIPTION_MODEL_VERSION,
    distribution: "non-exclusive",
  });
  const salt = randomId();
  return { signal, salt, hash: hashSignal(signal, salt) };
}
