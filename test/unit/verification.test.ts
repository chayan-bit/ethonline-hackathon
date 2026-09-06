import assert from 'node:assert/strict';
import { test } from 'node:test';
import { confirmCommitment, validateAndReconcilePurchase, validateQuote } from '../../src/protocol/verification.ts';
import { Store } from '../../src/service/store.ts';
import type { PaymentPayload } from '@x402/core/types';
import type { BuyRequest, Quote } from '../../src/service/gateway.ts';

test('buyer waits for indexing lag without changing the request or paying again', async () => {
  let reads = 0;
  const calls: string[] = [];
  const result = await confirmCommitment('request-1', 'hash-1', async id => {
    calls.push(id); reads++;
    return { exists: reads >= 3, hash: 'hash-1' };
  }, async () => {});
  assert.equal(result.hash, 'hash-1');
  assert.deepEqual(calls, ['request-1', 'request-1', 'request-1']);
});

test('buyer rejects a mismatched commitment and preserves an explicit pending boundary', async () => {
  await assert.rejects(confirmCommitment('id', 'expected', async () => ({ exists: true, hash: 'wrong' }), async () => {}), /commitment_verification_failed/);
  await assert.rejects(confirmCommitment('id', 'expected', async () => ({ exists: false, hash: '' }), async () => {}), /commitment_verification_pending/);
});

test('buyer retries a transient RPC read failure without creating a new workflow', async () => {
  let reads = 0;
  const result = await confirmCommitment('same-request', 'same-hash', async () => {
    reads++;
    if (reads === 1) throw new Error('rpc_indexing_lag');
    return { exists: true, hash: 'same-hash' };
  }, async () => {});
  assert.equal(result.hash, 'same-hash');
  assert.equal(reads, 2);
});

test('buyer validates a resumed response against its local request before mutating any reservation', () => {
  const store = new Store(':memory:');
  const idA = `0x${'aa'.repeat(32)}`;
  const idB = `0x${'bb'.repeat(32)}`;
  const requirements = { scheme: 'exact', network: 'hedera:testnet', asset: '0.0.0', amount: '100', payTo: '0.0.1002', maxTimeoutSeconds: 120, extra: { feePayer: '0.0.7162784' } } as const;
  const request = { request_id: idA, buyer: '0.0.1001', agent_id: '1', schema: 'defi.return_forecast.v1', price_feed_id: `0x${'11'.repeat(32)}`, target_time: 2_000 } as BuyRequest;
  const quote = { request, requirements, created_at: 1_000, expires_at: 1_120 } as Quote;
  const payment = { x402Version: 2, accepted: requirements, payload: { transaction: 'signed-a' } } as PaymentPayload;
  store.reserve(idA, '1', '2026-09-06', 100n, 1_000n, 1_000n);
  store.reserve(idB, '1', '2026-09-06', 100n, 1_000n, 1_000n);

  const malicious = { quote: { ...quote, request: { ...request, request_id: idB } }, status: 'payment_failed', payment, payment_ref: 'ref-a' };
  assert.throws(() => validateAndReconcilePurchase(malicious, idA, { quote, payment }, 'ref-a', store), /invalid_purchase_response/);
  assert.equal(store.reservations().find(row => row.id === idA)?.state, 'reserved');
  assert.equal(store.reservations().find(row => row.id === idB)?.state, 'reserved');
  store.close();
});

test('buyer binds a quote to the payee from validated discovery metadata', () => {
  const request = { request_id: `0x${'aa'.repeat(32)}`, buyer: '0.0.1001', agent_id: '1', schema: 'defi.return_forecast.v1', price_feed_id: `0x${'11'.repeat(32)}`, target_time: 2_000 } as BuyRequest;
  const requirements = { scheme: 'exact', network: 'hedera:testnet', asset: '0.0.0', amount: '100', payTo: '0.0.1002', maxTimeoutSeconds: 120, extra: { feePayer: '0.0.7162784' } } as const;
  const quote = { request, requirements, created_at: 1_000, expires_at: 1_120 };
  const provider = { price: '100', payTo: '0.0.1002' };
  assert.equal(validateQuote(quote, request, provider, '0.0.7162784', 1_000).requirements.payTo, provider.payTo);
  assert.throws(() => validateQuote({ ...quote, requirements: { ...requirements, payTo: '0.0.9999' } }, request, provider, '0.0.7162784', 1_000), /unsafe_quote/);
});
