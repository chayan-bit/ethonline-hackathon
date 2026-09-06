import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../../src/adapters/config.ts';
import { Worker } from '../../src/service/worker.ts';
import { Store } from '../../src/service/store.ts';
import type { Ledger } from '../../src/adapters/ledger.ts';
import type { Gateway, Purchase } from '../../src/service/gateway.ts';
import { ETH_USD, SCHEMA, hashSignal, type Signal } from '../../src/protocol/signal.ts';

const requestId = `0x${'11'.repeat(32)}` as const;
const requirements = { scheme: 'exact', network: 'hedera:testnet', asset: '0.0.0', amount: '100', payTo: '0.0.1002', maxTimeoutSeconds: 120, extra: { feePayer: '0.0.7162784' } } as const;

function deliveredPurchase(targetTime = 1_000): Purchase {
  const signal: Signal = { schema: SCHEMA, request_id: requestId, agent_id: '1', price_feed_id: ETH_USD, issued_at: 1, target_time: targetTime,
    predicted_return_bps: -42, model_version: 'momentum.v1', distribution: 'non-exclusive' };
  const salt = `0x${'22'.repeat(32)}` as `0x${string}`;
  return { quote: { request: { ...signal, buyer: '0.0.1001' }, created_at: 1, expires_at: 2_000, requirements }, status: 'delivered',
    prepared: { signal, salt, hash: hashSignal(signal, salt) }, payment_ref: '0.0.7162784@10000.000000000',
    commitment: { transaction_id: '0.0.1002@10001.000000000' } } as Purchase;
}

function harness(options: { workerEnabled?: boolean; pythApiKey?: string } = {}) {
  const store = new Store(':memory:');
  const config = loadConfig({ PUBLIC_BASE_URL: 'http://localhost:3000', WORKER_ENABLED: options.workerEnabled === false ? 'false' : 'true', ...(options.pythApiKey ? { PYTH_API_KEY: options.pythApiKey } : {}) });
  const calls = { recover: 0, reveal: 0, grade: 0 };
  const ledger = {
    abi: [], address: '0x0000000000000000000000000000000000000001',
    reveal: async () => { calls.reveal++; },
    grade: async () => { calls.grade++; },
    commitment: async () => ({ exists: true, hash: `0x${'33'.repeat(32)}`, committed_at: 1, target_time: 1, revealed: true }),
  } as unknown as Ledger;
  const gateway = { purchase: async () => { calls.recover++; return deliveredPurchase(); } } as unknown as Gateway;
  const worker = new Worker(config, store, ledger, gateway);
  return { store, worker, calls };
}

test('worker retries audit/oracle work without rewarding any party and preserves independent reveal', async () => {
  const h = harness();
  const purchase = deliveredPurchase();
  h.store.savePurchase(purchase);
  h.store.put('samples', requestId, { request_id: requestId, agent_id: '1', schema: SCHEMA, payment_mode: 'x402', payment_status: 'verified', payer: '0.0.1001', committed_at: 1, target_time: 1, revealed_at: 1, grade: null, oracle_status: 'pending' });
  await h.worker.tick();
  assert.equal(h.calls.reveal, 1);
  assert.equal(h.calls.grade, 0);
  assert.equal(h.store.get<any>('jobs', `reveal/${requestId}`)?.status, 'done');
  const gradeJob = h.store.get<any>('jobs', `grade/${requestId}`);
  assert.equal(gradeJob.status, 'retrying');
  assert.equal(gradeJob.error, 'oracle_unavailable');
  assert.equal(h.store.get<any>('samples', requestId)?.oracle_status, 'unavailable');
  assert.deepEqual(h.store.list('rewards'), []);
  assert.deepEqual(h.store.list('transfers'), []);
  h.store.close();
});

test('disabled worker does not reveal, grade, recover, or create jobs', async () => {
  const h = harness({ workerEnabled: false });
  h.store.savePurchase(deliveredPurchase());
  await h.worker.tick();
  assert.deepEqual(h.calls, { recover: 0, reveal: 0, grade: 0 });
  assert.deepEqual(h.store.list('jobs'), []);
  h.store.close();
});

test('worker retries a paid recovery by the original request without issuing a second payment', async () => {
  const h = harness();
  const pending = { ...deliveredPurchase(), status: 'settlement_pending' as const, payment: { x402Version: 2, accepted: requirements, payload: { transaction: 'original' } } } as Purchase;
  h.store.savePurchase(pending);
  await h.worker.tick();
  assert.equal(h.calls.recover, 1);
  assert.equal(h.store.get<any>('jobs', `recover/${requestId}`)?.status, 'done');
  assert.equal(h.calls.reveal, 0);
  assert.equal(h.calls.grade, 0);
  h.store.close();
});
