import { setTimeout } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import type { PaymentPayload } from '@x402/core/types';
import type { Purchase, Quote } from '../service/gateway.ts';

type SavedRequest = { quote: Quote; payment: PaymentPayload };
type ReservationStore = { releaseReservation(id: string): void; settleReservation(id: string): void };
type BoundPurchase = Purchase & { payment: PaymentPayload; payment_ref: string };
const PURCHASE_STATES = new Set(['quoted', 'prepared', 'settlement_pending', 'paid', 'commit_pending', 'delivered', 'paid_commit_failed', 'payment_failed']);

export function validateAndReconcilePurchase(input: unknown, expectedId: string, saved: SavedRequest, expectedPaymentRef: string, store: ReservationStore): BoundPurchase {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_purchase_response');
  const result = input as Purchase;
  if (!PURCHASE_STATES.has(result.status) || !result.quote || result.quote.request?.request_id !== expectedId
    || !isDeepStrictEqual(result.quote, saved.quote) || !isDeepStrictEqual(result.payment, saved.payment)
    || result.payment_ref !== expectedPaymentRef) throw new Error('invalid_purchase_response');
  if (result.status === 'payment_failed') store.releaseReservation(expectedId);
  if (result.status === 'paid_commit_failed') store.settleReservation(expectedId);
  return result as BoundPurchase;
}

export async function confirmCommitment<T extends { exists: boolean; hash: string }>(
  requestId: string, expectedHash: string, read: (id: string) => Promise<T>, wait: () => Promise<unknown> = () => setTimeout(1000),
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const evidence = await read(requestId);
      if (evidence.exists) {
        if (evidence.hash !== expectedHash) throw new Error('commitment_verification_failed');
        return evidence;
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'commitment_verification_failed') throw error;
      lastError = error;
    }
    if (attempt < 19) await wait();
  }
  throw new Error('commitment_verification_pending', { cause: lastError });
}
