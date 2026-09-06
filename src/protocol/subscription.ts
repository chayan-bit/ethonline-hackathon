import { isDeepStrictEqual } from "node:util";
import { Ajv } from "ajv";
import type { Hex } from "viem";
import { ETH_USD, SCHEMA } from "./signal.ts";
import type { BuyRequest, Prepared } from "../service/gateway.ts";

export const SUBSCRIPTION_HORIZON_SECONDS = 900;
export const SUBSCRIPTION_MODEL_VERSION = "momentum60.v1";

export type SubscriptionTerms = {
  subscription_id: string;
  escrow: string;
  agent_id: string;
  buyer: string;
  provider: string;
  token: string;
  token_symbol: string;
  token_decimals: number;
  start: number;
  end: number;
  rate_per_second: string;
  deposit: string;
  paid: string;
  cancelled_at: number;
  closed: boolean;
  schedule_interval: number;
  scheduled_gas_limit: number;
  next_scheduled_at: number;
  schedule_address: string | null;
  automation_reserve_initial_tinybars: string;
  automation_reserve_tinybars: string;
  automation_spent_tinybars: string;
};

export type SubscriptionResponse = {
  subscription_id: string;
  payment_mode: "subscription";
  sampled: true;
  request: BuyRequest;
  status: "prepared" | "commit_pending" | "delivered";
  prepared: Prepared;
  commitment?: { transaction_id: string };
  error?: "commit_pending";
};

const validateRequest = new Ajv().compile({
  type: "object",
  additionalProperties: false,
  required: [
    "request_id",
    "buyer",
    "agent_id",
    "schema",
    "price_feed_id",
    "target_time",
  ],
  properties: {
    request_id: { type: "string", pattern: "^0x[0-9a-f]{64}$" },
    buyer: { type: "string", pattern: "^0\\.0\\.[1-9][0-9]{0,18}$" },
    agent_id: { type: 'string', pattern: '^[1-9][0-9]{0,77}$' },
    schema: { const: SCHEMA },
    price_feed_id: { const: ETH_USD },
    target_time: {
      type: "integer",
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    },
  },
});

export function parseSubscriptionRequest(
  input: unknown,
  now: number,
  horizonSeconds: number,
): BuyRequest {
  if (
    !validateRequest(input) ||
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(horizonSeconds) ||
    horizonSeconds <= 0
  ) {
    throw new Error("invalid_subscription_request");
  }
  const request = input as BuyRequest;
  if (BigInt(request.agent_id) >= 2n ** 256n || request.target_time !== now + horizonSeconds)
    throw new Error("invalid_subscription_request");
  return { ...request };
}

export function assertSameSubscriptionRequest(
  existing: SubscriptionResponse,
  subscriptionId: string,
  request: BuyRequest,
): void {
  if (
    existing.subscription_id !== subscriptionId ||
    !isDeepStrictEqual(existing.request, request)
  )
    throw new Error("request_conflict");
}

export function assertSubscriptionTerms(
  input: SubscriptionTerms,
  subscriptionId: string,
  request: BuyRequest,
): void {
  if (
    input.subscription_id !== subscriptionId ||
    input.agent_id !== request.agent_id ||
    !/^0x[0-9a-fA-F]{40}$/.test(input.escrow) ||
    !/^0x[0-9a-fA-F]{40}$/.test(input.token) ||
    !/^0\.0\.[1-9][0-9]{0,18}$/.test(input.provider) ||
    !Number.isSafeInteger(input.start) ||
    !Number.isSafeInteger(input.end) ||
    input.end <= input.start ||
    !/^\d+$/.test(input.deposit) ||
    !/^\d+$/.test(input.rate_per_second) ||
    !Number.isSafeInteger(input.token_decimals) ||
    input.token_decimals < 0 ||
    input.token_decimals > 18 ||
    typeof input.token_symbol !== "string" ||
    !/^[A-Z0-9]{1,16}$/.test(input.token_symbol)
  ) {
    throw new Error("invalid_subscription_evidence");
  }
}

export const subscriptionSignalKey = (requestId: string): Hex =>
  requestId as Hex;
