import { isDeepStrictEqual } from 'node:util';
import { Ajv } from 'ajv';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import type { Hex } from 'viem';
import { SCHEMA, ETH_USD, POLICY, assertCommitTiming, hashSignal, parseSignal, type Signal } from '../protocol/signal.ts';
import type { Store } from './store.ts';

export type BuyRequest = { request_id: string; buyer: string; agent_id: string; schema: string; price_feed_id: Hex; target_time: number };
export type Quote = { request: BuyRequest; requirements: PaymentRequirements; created_at: number; expires_at: number };
export type Prepared = { signal: Signal; salt: Hex; hash: Hex };
export type Purchase = {
  quote: Quote; status: 'quoted' | 'prepared' | 'settlement_pending' | 'paid' | 'commit_pending' | 'delivered' | 'paid_commit_failed' | 'payment_failed';
  prepared?: Prepared; payment?: PaymentPayload; payment_ref?: string; commitment?: { transaction_id: string }; error?: string;
};
export type GatewayEffects = {
  now(): number;
  seller(): Promise<{ agent_id: string; payTo: string; price: string; active: boolean }>;
  feePayer(): Promise<string>;
  verify(p: PaymentPayload, r: PaymentRequirements): Promise<{ isValid: boolean; payer?: string }>;
  paymentId(p: PaymentPayload): string;
  generate(r: BuyRequest): Promise<Prepared>;
  settle(p: PaymentPayload, r: PaymentRequirements): Promise<{ success: boolean; transaction?: string }>;
  lookupPayment(id: string, quote: Quote): Promise<'pending' | 'verified' | 'invalid'>;
  commit(quote: Quote, prepared: Prepared, paymentRef: string): Promise<{ transaction_id: string }>;
};
const validateRequest = new Ajv().compile({
  type: 'object', additionalProperties: false,
  required: ['request_id', 'buyer', 'agent_id', 'schema', 'price_feed_id', 'target_time'],
  properties: {
    request_id: { type: 'string', pattern: '^0x[0-9a-f]{64}$' }, buyer: { type: 'string', pattern: '^0\\.0\\.[1-9][0-9]{0,18}$' },
    agent_id: { type: 'string', pattern: '^[1-9][0-9]{0,77}$' }, schema: { const: SCHEMA }, price_feed_id: { const: ETH_USD },
    target_time: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  },
});

export class Gateway {
  // ponytail: one process owns the workflow; use distributed leases before multiple gateway instances.
  private readonly inflight = new Map<string, Promise<Purchase>>();
  constructor(private readonly store: Store, private readonly effects: GatewayEffects) {}

  async quote(input: unknown): Promise<Quote> {
    if (!validateRequest(input)) throw new Error('invalid_request');
    const request = input as BuyRequest;
    const existing = this.store.purchase(request.request_id);
    if (existing) {
      if (!isDeepStrictEqual(existing.quote.request, request)) throw new Error('request_conflict');
      return existing.quote;
    }
    const seller = await this.effects.seller();
    if (!seller.active || seller.agent_id !== request.agent_id) throw new Error('inactive_provider');
    const now = this.effects.now();
    if (!this.store.quoteCapacity(now)) throw new Error('quote_capacity_exceeded');
    if (request.target_time < now + POLICY.minLead + POLICY.issueTolerance || request.target_time > now + POLICY.maxLead) throw new Error('invalid_target');
    const quote: Quote = { request: { ...request }, created_at: now, expires_at: now + 120,
      requirements: { scheme: 'exact', network: 'hedera:testnet', asset: '0.0.0', amount: seller.price, payTo: seller.payTo, maxTimeoutSeconds: 120, extra: { feePayer: await this.effects.feePayer() } },
    };
    const raced = this.store.purchase(request.request_id);
    if (raced) {
      if (!isDeepStrictEqual(raced.quote.request, request)) throw new Error('request_conflict');
      return raced.quote;
    }
    this.store.savePurchase({ quote, status: 'quoted' });
    return quote;
  }

  async purchase(id: string, payment: PaymentPayload): Promise<Purchase> {
    const p = this.store.purchase(id);
    if (!p) throw new Error('unknown_request');
    if (payment.x402Version !== 2 || !isDeepStrictEqual(payment.accepted, p.quote.requirements)) throw new Error('quote_mismatch');
    if (p.payment && !isDeepStrictEqual(p.payment, payment)) throw new Error('payment_conflict');
    const current = this.inflight.get(id);
    if (current) return current;
    const work = this.advance(p, payment).finally(() => this.inflight.delete(id));
    this.inflight.set(id, work);
    return work;
  }

  private save(p: Purchase): Purchase { this.store.savePurchase(p); return p; }

  private async prepare(p: Purchase, payment: PaymentPayload): Promise<Purchase> {
    if (this.effects.now() >= p.quote.expires_at) throw new Error('quote_expired');
    if (!(await this.effects.seller()).active) throw new Error('inactive_provider');
    const verified = await this.effects.verify(payment, p.quote.requirements);
    if (!verified.isValid || verified.payer !== p.quote.request.buyer) throw new Error('payer_mismatch');
    const generated = p.prepared ?? await this.effects.generate(p.quote.request);
    const signal = parseSignal(generated.signal);
    const r = p.quote.request;
    if (signal.request_id !== r.request_id || signal.agent_id !== r.agent_id || signal.price_feed_id !== r.price_feed_id || signal.target_time !== r.target_time) throw new Error('invalid_signal: request binding');
    assertCommitTiming(signal, this.effects.now());
    if (hashSignal(signal, generated.salt) !== generated.hash) throw new Error('invalid_signal: hash');
    return this.save({ ...p, status: 'prepared', prepared: { ...generated, signal }, payment, payment_ref: this.effects.paymentId(payment) });
  }

  private async advance(original: Purchase, payment: PaymentPayload): Promise<Purchase> {
    if (['delivered', 'paid_commit_failed', 'payment_failed'].includes(original.status)) return original;
    if (original.status === 'settlement_pending') return this.reconcile(original);
    if (original.status === 'paid' || original.status === 'commit_pending') return this.finishCommit(original);
    const p = await this.prepare(original, payment);
    const pending = this.save({ ...p, status: 'settlement_pending' });
    try {
      const result = await this.effects.settle(payment, p.quote.requirements);
      if (!result.success || result.transaction !== pending.payment_ref) return this.reconcile(pending);
      return this.finishCommit(this.save({ ...pending, status: 'paid' }));
    } catch {
      // Unknown settlement outcomes remain reserved and are reconciled by the original transaction ID.
      return this.save({ ...pending, error: 'payment_pending' });
    }
  }

  private async reconcile(p: Purchase): Promise<Purchase> {
    const state = await this.effects.lookupPayment(p.payment_ref!, p.quote);
    if (state === 'pending') return p;
    if (state === 'invalid') return this.save({ ...p, status: 'payment_failed', error: 'payment_failed' });
    return this.finishCommit(this.save({ ...p, status: 'paid', error: undefined }));
  }

  private async finishCommit(p: Purchase): Promise<Purchase> {
    const pending = this.save({ ...p, status: 'commit_pending', error: undefined });
    try {
      const commitment = await this.effects.commit(p.quote, p.prepared!, p.payment_ref!);
      return this.save({ ...pending, status: 'delivered', commitment });
    } catch (error) {
      const definitelyExpired = error instanceof Error && error.message === 'invalid_signal: commitment timing';
      return this.save({ ...pending, status: definitelyExpired ? 'paid_commit_failed' : 'commit_pending', error: definitelyExpired ? 'paid_commit_failed' : 'commit_pending' });
    }
  }
}
