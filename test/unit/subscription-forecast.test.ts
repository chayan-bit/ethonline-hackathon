import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../../src/adapters/config.ts";
import { generateSubscriptionForecast } from "../../src/adapters/subscription-forecast.ts";
import { ETH_USD, SCHEMA, hashSignal } from "../../src/protocol/signal.ts";

const now = 10_000;
const request = {
  request_id: `0x${"11".repeat(32)}` as const,
  buyer: "0.0.1001",
  agent_id: "2",
  schema: SCHEMA,
  price_feed_id: ETH_USD,
  target_time: now + 900,
};

test("subscription forecast keeps the honest momentum60 model while binding a 900-second cohort", async () => {
  const timestamps: number[] = [];
  const result = await generateSubscriptionForecast(
    loadConfig({
      PUBLIC_BASE_URL: "http://localhost:3000",
      SUBSCRIPTION_AGENT_ID: "2",
    }),
    request,
    {
      now: () => now,
      price: async (_config, timestamp) => {
        timestamps.push(timestamp);
        return {
          price: {
            price: BigInt(timestamp === now - 61 ? 100_000 : 100_100),
            conf: 1n,
            expo: -2,
          },
          publishTime: timestamp,
          updates: [`0x${"44".repeat(32)}`],
        };
      },
    },
  );
  assert.deepEqual(timestamps, [now - 61, now - 1]);
  assert.equal(result.signal.issued_at, now);
  assert.equal(result.signal.target_time - result.signal.issued_at, 900);
  assert.equal(result.signal.model_version, "momentum60.v1");
  assert.equal(result.signal.predicted_return_bps, 10);
  assert.equal(result.hash, hashSignal(result.signal, result.salt));
});
