import { isDeepStrictEqual } from "node:util";
import { hashSignal, parseSignal } from "../protocol/signal.ts";
import {
  assertSameSubscriptionRequest,
  assertSubscriptionTerms,
  parseSubscriptionRequest,
  SUBSCRIPTION_MODEL_VERSION,
  type SubscriptionResponse,
  type SubscriptionTerms,
} from "../protocol/subscription.ts";
import type { BuyRequest, Prepared } from "./gateway.ts";
import type { Store } from "./store.ts";

export type SubscriptionEffects = {
  now(): number;
  subscription(id: string): Promise<SubscriptionTerms>;
  isEntitled(id: string, buyer: string): Promise<boolean>;
  isProviderActive(agentId: string): Promise<boolean>;
  generate(request: BuyRequest): Promise<Prepared>;
  commit(
    subscriptionId: string,
    prepared: Prepared,
  ): Promise<{ transaction_id: string }>;
};

type SubscriptionPolicy = { agentId: string; horizonSeconds: number };

export class SubscriptionService {
  private readonly inflight = new Map<string, Promise<SubscriptionResponse>>();

  constructor(
    private readonly store: Store,
    public readonly effects: SubscriptionEffects,
    private readonly policy: SubscriptionPolicy,
  ) {}

  async request(
    subscriptionId: string,
    input: unknown,
  ): Promise<SubscriptionResponse> {
    if (!/^0x[0-9a-f]{64}$/.test(subscriptionId))
      throw new Error("invalid_subscription_id");
    const request = parseSubscriptionRequest(
      input,
      this.effects.now(),
      this.policy.horizonSeconds,
    );
    if (request.agent_id !== this.policy.agentId)
      throw new Error("invalid_subscription_request");
    const existing = this.store.get<SubscriptionResponse>(
      "subscription_responses",
      request.request_id,
    );
    if (existing) {
      assertSameSubscriptionRequest(existing, subscriptionId, request);
      return this.advance(existing);
    }
    const current = this.inflight.get(request.request_id);
    if (current) return current;
    const work = this.prepare(subscriptionId, request).finally(() =>
      this.inflight.delete(request.request_id),
    );
    this.inflight.set(request.request_id, work);
    return work;
  }

  recover(subscriptionId: string, requestId: string): SubscriptionResponse {
    const existing = this.store.get<SubscriptionResponse>(
      "subscription_responses",
      requestId,
    );
    if (!existing || existing.subscription_id !== subscriptionId)
      throw new Error("unknown_subscription_request");
    return existing;
  }

  private save(value: SubscriptionResponse): SubscriptionResponse {
    const current = this.store.get<SubscriptionResponse>(
      "subscription_responses",
      value.request.request_id,
    );
    if (
      current &&
      (!isDeepStrictEqual(current.request, value.request) ||
        current.subscription_id !== value.subscription_id ||
        !isDeepStrictEqual(current.prepared, value.prepared) ||
        (current.status === "delivered" && value.status !== "delivered"))
    ) {
      throw new Error("immutable_subscription_response_conflict");
    }
    this.store.put("subscription_responses", value.request.request_id, value);
    return value;
  }

  private async prepare(
    subscriptionId: string,
    request: BuyRequest,
  ): Promise<SubscriptionResponse> {
    const terms = await this.effects.subscription(subscriptionId);
    assertSubscriptionTerms(terms, subscriptionId, request);
    if (terms.buyer !== request.buyer)
      throw new Error("subscription_not_entitled");
    if (!(await this.effects.isEntitled(subscriptionId, request.buyer)))
      throw new Error("subscription_not_entitled");
    if (!(await this.effects.isProviderActive(request.agent_id)))
      throw new Error("inactive_provider");
    const generated = await this.effects.generate(request);
    const signal = parseSignal(generated.signal);
    if (
      signal.request_id !== request.request_id ||
      signal.agent_id !== request.agent_id ||
      signal.price_feed_id !== request.price_feed_id ||
      signal.target_time !== request.target_time ||
      signal.model_version !== SUBSCRIPTION_MODEL_VERSION ||
      hashSignal(signal, generated.salt) !== generated.hash
    ) {
      throw new Error("invalid_subscription_signal");
    }
    return this.advance(
      this.save({
        subscription_id: subscriptionId,
        payment_mode: "subscription",
        sampled: true,
        request: { ...request },
        status: "prepared",
        prepared: { ...generated, signal },
      }),
    );
  }

  private async advance(
    response: SubscriptionResponse,
  ): Promise<SubscriptionResponse> {
    if (response.status === "delivered") return response;
    try {
      const commitment = await this.effects.commit(
        response.subscription_id,
        response.prepared,
      );
      const { error: _, ...withoutError } = response;
      return this.save({ ...withoutError, status: "delivered", commitment });
    } catch {
      return this.save({
        ...response,
        status: "commit_pending",
        error: "commit_pending",
      });
    }
  }
}
