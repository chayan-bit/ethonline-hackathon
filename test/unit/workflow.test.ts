import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/service/store.ts';
import { Gateway, type GatewayEffects } from '../../src/service/gateway.ts';
import { ETH_USD, SCHEMA, hashSignal, type Signal } from '../../src/protocol/signal.ts';

const now = 10000;
const request = { request_id: `0x${'11'.repeat(32)}`, agent_id: '1', price_feed_id: ETH_USD, target_time: now + 350, schema: SCHEMA, buyer: '0.0.1001' };
const salt = `0x${'22'.repeat(32)}` as const;
const signal: Signal = { ...request, schema: SCHEMA, request_id: request.request_id as `0x${string}`, issued_at: now, predicted_return_bps: -42, model_version: 'momentum.v1', distribution: 'non-exclusive' };
const { buyer: _, ...cleanSignal } = signal as Signal & { buyer: string };

function harness(store = new Store(':memory:')) {
  const calls = { settle: 0, commit: 0, generate: 0 };
  const effects: GatewayEffects = {
    now: () => now,
    seller: async () => ({ agent_id: '1', payTo: '0.0.1002', price: '100', active: true }),
    feePayer: async () => '0.0.7162784',
    verify: async () => ({ isValid: true, payer: request.buyer }),
    paymentId: () => '0.0.7162784@10000.000000000',
    generate: async () => { calls.generate++; return { signal: cleanSignal, salt, hash: hashSignal(cleanSignal, salt) }; },
    settle: async () => { calls.settle++; return { success: true, transaction: '0.0.7162784@10000.000000000' }; },
    lookupPayment: async () => 'verified',
    commit: async () => { calls.commit++; return { transaction_id: '0.0.1002@10001.000000000' }; },
  };
  return { effects, calls, store, gateway: new Gateway(store, effects) };
}

test('paid workflow persists before settlement and concurrent retries charge once', async () => {
  const h = harness();
  const quote = await h.gateway.quote(request);
  const payment = { x402Version: 2, accepted: quote.requirements, payload: { transaction: 'test-signed-payload' } };
  const originalSettle = h.effects.settle;
  h.effects.settle = async (...args) => {
    assert.equal(h.store.purchase(request.request_id)?.status, 'settlement_pending');
    assert.ok(h.store.purchase(request.request_id)?.prepared);
    return originalSettle(...args);
  };
  const results = await Promise.all([h.gateway.purchase(request.request_id, payment), h.gateway.purchase(request.request_id, payment)]);
  assert.equal(results[0].status, 'delivered');
  assert.deepEqual(results[0].prepared, results[1].prepared);
  assert.equal(h.calls.settle, 1);
  assert.equal(h.calls.generate, 1);
  h.store.close();
});

test('generation failure never settles', async () => {
  const h = harness();
  const quote = await h.gateway.quote(request);
  h.effects.generate = async () => { throw new Error('oracle_unavailable'); };
  await assert.rejects(h.gateway.purchase(request.request_id, { x402Version: 2, accepted: quote.requirements, payload: { transaction: 'test' } }));
  assert.equal(h.calls.settle, 0);
  h.store.close();
});

test('settlement timeout survives restart and reconciles without a second transfer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'signal-test-'));
  try {
    const path = join(dir, 'state.db');
    const h = harness(new Store(path));
    const quote = await h.gateway.quote(request);
    h.effects.settle = async () => { h.calls.settle++; throw new Error('timeout'); };
    const payment = { x402Version: 2, accepted: quote.requirements, payload: { transaction: 'test' } };
    assert.equal((await h.gateway.purchase(request.request_id, payment)).status, 'settlement_pending');
    h.store.close();
    const recovered = harness(new Store(path));
    assert.equal((await recovered.gateway.purchase(request.request_id, payment)).status, 'delivered');
    assert.equal(recovered.calls.settle, 0);
    assert.equal(recovered.calls.generate, 0);
    recovered.store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('changed retry terms, wrong buyer verification, and expired commit never trigger replacement payment', async () => {
  const h = harness();
  const quote = await h.gateway.quote(request);
  await assert.rejects(h.gateway.quote({ ...request, target_time: request.target_time + 1 }), /request_conflict/);
  const payload = { x402Version: 2, accepted: { ...quote.requirements, amount: '99' }, payload: { transaction: 'test' } };
  await assert.rejects(h.gateway.purchase(request.request_id, payload), /quote_mismatch/);
  h.effects.verify = async () => ({ isValid: true, payer: '0.0.9999' });
  await assert.rejects(h.gateway.purchase(request.request_id, { ...payload, accepted: quote.requirements }), /payer_mismatch/);
  assert.equal(h.calls.settle, 0);
  h.store.close();
});

test('an existing commitment awaiting its receipt never becomes a false delivery failure', async () => {
  const h = harness();
  const quote = await h.gateway.quote(request);
  h.effects.commit = async () => { throw new Error('commit_receipt_pending'); };
  h.effects.now = () => now + 100;
  const prepared = { signal: cleanSignal, salt, hash: hashSignal(cleanSignal, salt) };
  const payment = { x402Version: 2, accepted: quote.requirements, payload: { transaction: 'test' } };
  h.store.savePurchase({ quote, status: 'paid', payment, prepared, payment_ref: '0.0.7162784@10000.000000000' });
  assert.equal((await h.gateway.purchase(request.request_id, payment)).status, 'commit_pending');
  assert.equal(h.calls.settle, 0);
  h.store.close();
});

test('unknown commit outcome stays recoverable after expiry until a ledger reread succeeds', async () => {
  const h = harness();
  const quote = await h.gateway.quote(request);
  const payment = { x402Version: 2, accepted: quote.requirements, payload: { transaction: 'test' } };
  const prepared = { signal: cleanSignal, salt, hash: hashSignal(cleanSignal, salt) };
  h.store.savePurchase({ quote, status: 'paid', payment, prepared, payment_ref: '0.0.7162784@10000.000000000' });
  h.effects.now = () => now + 100;
  h.effects.commit = async () => { h.calls.commit++; if (h.calls.commit === 1) throw new Error('receipt_timeout'); return { transaction_id: 'recovered-chain-commit' }; };
  assert.equal((await h.gateway.purchase(request.request_id, payment)).status, 'commit_pending');
  const recovered = await h.gateway.purchase(request.request_id, payment);
  assert.equal(recovered.status, 'delivered');
  assert.equal(recovered.commitment?.transaction_id, 'recovered-chain-commit');
  assert.equal(h.calls.settle, 0);
  h.store.close();
});
