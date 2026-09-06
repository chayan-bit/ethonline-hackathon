import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/service/store.ts';
import type { Purchase } from '../../src/service/gateway.ts';

const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

function purchase(requestId = id(1), paymentRef?: string): Purchase {
  return {
    quote: {
      request: { request_id: requestId, buyer: '0.0.1001', agent_id: '1', schema: 'defi.return_forecast.v1', price_feed_id: `0x${'aa'.repeat(32)}`, target_time: 1_330 },
      created_at: 1_000, expires_at: 1_120,
      requirements: { scheme: 'exact', network: 'hedera:testnet', asset: '0.0.0', amount: '100', payTo: '0.0.1002', maxTimeoutSeconds: 120, extra: { feePayer: '0.0.7162784' } },
    },
    status: 'quoted', payment_ref: paymentRef,
  } as Purchase;
}

test('purchase, records, and challenges survive a process restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'signal-store-'));
  const path = join(dir, 'state.db');
  try {
    const first = new Store(path);
    first.savePurchase(purchase());
    first.put('samples', id(1), { request_id: id(1), revealed_at: null });
    first.challenge(id(2), 'bound-message', '0.0.1001', 2_000);
    first.close();

    const recovered = new Store(path);
    assert.equal(recovered.purchase(id(1))?.quote.request.request_id, id(1));
    assert.deepEqual(recovered.get('samples', id(1)), { request_id: id(1), revealed_at: null });
    assert.deepEqual(recovered.readChallenge(id(2)), { message: 'bound-message', buyer: '0.0.1001', expires: 2_000, used: 0 });
    assert.equal(recovered.consumeChallenge(id(2), 1_999), true);
    assert.equal(recovered.consumeChallenge(id(2), 1_999), false);
    recovered.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('purchase identity, quote terms, prepared response, and settlement reference are immutable after first persistence', () => {
  const store = new Store(':memory:');
  const original = purchase();
  store.savePurchase(original);
  const prepared = { ...original, status: 'prepared' as const, payment_ref: '0.0.7162784@10000.000000000', prepared: {
    signal: { ...original.quote.request, issued_at: 1_000, predicted_return_bps: -42, model_version: 'momentum.v1', distribution: 'non-exclusive' as const },
    salt: `0x${'22'.repeat(32)}` as `0x${string}`, hash: `0x${'33'.repeat(32)}` as `0x${string}`,
  } } as Purchase;
  store.savePurchase(prepared);
  assert.equal(store.purchase(id(1))?.payment_ref, prepared.payment_ref);
  assert.doesNotThrow(() => store.savePurchase({ ...prepared, status: 'settlement_pending' }));
  assert.throws(() => store.savePurchase({ ...prepared, quote: { ...prepared.quote, request: { ...prepared.quote.request, target_time: 1_331 } } }), /immutable|conflict|mismatch/i);
  assert.throws(() => store.savePurchase({ ...prepared, prepared: { ...prepared.prepared!, hash: `0x${'44'.repeat(32)}` } }), /immutable|conflict|mismatch/i);
  assert.throws(() => store.savePurchase({ ...prepared, payment_ref: '0.0.7162784@10000.000000001' }), /immutable|conflict|mismatch/i);
  store.close();
});

test('settlement references are unique and reservation failures leave no partial budget row', () => {
  const store = new Store(':memory:');
  store.savePurchase(purchase(id(1), '0.0.7162784@10000.000000000'));
  assert.throws(() => store.savePurchase(purchase(id(2), '0.0.7162784@10000.000000000')), /UNIQUE|constraint/i);
  assert.throws(() => store.reserve('too-large', '1', '2026-09-06', 101n, 100n, 100n), /budget_exceeded/);
  assert.deepEqual(store.reservations(), []);
  store.reserve('ok', '1', '2026-09-06', 70n, 100n, 100n);
  assert.throws(() => store.reserve('ok', '1', '2026-09-06', 71n, 100n, 100n), /reservation_conflict/);
  store.close();
});

test('definitively failed reservations release capacity while paid reservations remain counted', () => {
  const store = new Store(':memory:');
  store.reserve('failed', '1', '2026-09-06', 70n, 100n, 100n);
  store.releaseReservation('failed');
  store.reserve('replacement', '1', '2026-09-06', 70n, 100n, 100n);
  store.settleReservation('replacement');
  store.releaseReservation('replacement');
  assert.equal(store.reservations().find(r => r.id === 'failed')?.state, 'released');
  assert.equal(store.reservations().find(r => r.id === 'replacement')?.state, 'settled');
  assert.throws(() => store.reserve('extra', '1', '2026-09-06', 31n, 100n, 100n), /budget_exceeded/);
  store.close();
});
