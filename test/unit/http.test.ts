import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../../src/service/app.ts';
import { loadConfig } from '../../src/adapters/config.ts';
import { Store } from '../../src/service/store.ts';
import { Auth } from '../../src/service/auth.ts';
import { PrivateKey } from '@x402/hedera';
import { bodyHash } from '../../src/service/auth.ts';
import { ETH_USD, SCHEMA, hashSignal, type Signal } from '../../src/protocol/signal.ts';
import type { Purchase } from '../../src/service/gateway.ts';

const requestId = `0x${'11'.repeat(32)}` as const;
const requirements = { scheme: 'exact', network: 'hedera:testnet', asset: '0.0.0', amount: '100', payTo: '0.0.1002', maxTimeoutSeconds: 120, extra: { feePayer: '0.0.7162784' } } as const;

function request() {
  return { request_id: requestId, buyer: '0.0.1001', agent_id: '1', price_feed_id: ETH_USD, schema: SCHEMA, target_time: 2_000 };
}

function privatePurchase(): Purchase {
  const { buyer: _, ...signalRequest } = request();
  const signal: Signal = { ...signalRequest, schema: SCHEMA, issued_at: 1_000, predicted_return_bps: -42, model_version: 'momentum.v1', distribution: 'non-exclusive' };
  const salt = `0x${'22'.repeat(32)}` as `0x${string}`;
  return {
    quote: { request: request(), created_at: 1_000, expires_at: 1_120, requirements }, status: 'delivered',
    prepared: { signal, salt, hash: hashSignal(signal, salt) },
    payment: { x402Version: 2, accepted: requirements, payload: { transaction: 'private-payment' } },
    payment_ref: '0.0.7162784@10000.000000000', commitment: { transaction_id: '0.0.1002@10001.000000000' },
  };
}

async function runningApp() {
  const store = new Store(':memory:');
  const config = loadConfig({ PUBLIC_BASE_URL: 'http://localhost:3000' });
  const key = PrivateKey.generateECDSA();
  const auth = new Auth(store, config.baseUrl, async () => key.publicKey, () => 1_000);
  const app = createApp({ config, store,
    gateway: { quote: async (input: any) => ({ request: input, created_at: 1000, expires_at: 1120, requirements }), purchase: async () => { throw new Error('should_not_run'); } },
    seller: async () => ({ active: true }), auth,
  });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const address = app.address();
  assert.ok(address && typeof address === 'object');
  return { app, store, auth, key, base: `http://127.0.0.1:${address.port}` };
}

function proofHeader(auth: Auth, key: InstanceType<typeof PrivateKey>, scope: Parameters<Auth['issue']>[0]) {
  const challenge = auth.issue(scope);
  return Buffer.from(JSON.stringify({ challenge_id: challenge.id, signature: Buffer.from(key.sign(Buffer.from(challenge.message))).toString('hex') })).toString('base64');
}

test('HTTP boundary returns real 402 shape and denies unauthenticated paid recovery', async () => {
  const store = new Store(':memory:');
  const config = loadConfig({ PUBLIC_BASE_URL: 'http://localhost:3000' });
  const app = createApp({ config, store,
    gateway: { quote: async (request: any) => ({ request, created_at: 1000, expires_at: 1120, requirements: { scheme: 'exact', network: 'hedera:testnet', asset: '0.0.0', amount: '100', payTo: '0.0.1002', maxTimeoutSeconds: 120, extra: { feePayer: '0.0.7162784' } } }), purchase: async () => { throw new Error('should_not_run'); } },
    seller: async () => ({ active: true }), auth: new Auth(store, config.baseUrl, async () => PrivateKey.generateECDSA().publicKey),
  });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const address = app.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${base}/v1/signals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request()) });
    assert.equal(response.status, 402);
    assert.equal(JSON.parse(Buffer.from(response.headers.get('payment-required')!, 'base64').toString()).x402Version, 2);
    assert.equal((await fetch(`${base}/v1/purchases/${requestId}`)).status, 401);
    assert.equal((await fetch(`${base}/.env`)).status, 404);
    const discovery = await (await fetch(`${base}/v1/agents`)).json() as any;
    assert.equal(discovery.agents[0].metrics.reveal_pct, null);
    assert.equal(discovery.agents[0].metrics.is_stale, true);
  } finally {
    await new Promise<void>((resolve, reject) => app.close(error => error ? reject(error) : resolve()));
    store.close();
  }
});

test('HTTP rejects malformed bodies and refuses file probing outside the static allowlist', async () => {
  const h = await runningApp();
  try {
    const invalidType = await fetch(`${h.base}/v1/signals`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(invalidType.status, 400);
    assert.deepEqual(await invalidType.json(), { error: 'invalid_content_type' });
    assert.equal((await fetch(`${h.base}/v1/signals`, { method: 'POST', headers: { 'Content-Type': 'application/jsonp' }, body: '{}' })).status, 400);
    const invalidJson = await fetch(`${h.base}/v1/signals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(invalidJson.status, 400);
    assert.deepEqual(await invalidJson.json(), { error: 'invalid_json' });
    const invalidScope = await fetch(`${h.base}/v1/auth/challenges`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(invalidScope.status, 400);
    for (const path of ['/.env', '/package.json', '/src/service/store.ts', '/node_modules/viem/package.json', '/../.env']) {
      assert.equal((await fetch(`${h.base}${path}`)).status, 404, path);
    }
  } finally {
    await new Promise<void>((resolve, reject) => h.app.close(error => error ? reject(error) : resolve()));
    h.store.close();
  }
});


test('private purchase recovery reveals the prepared payload only with a bound, single-use wallet proof', async () => {
  const h = await runningApp();
  const purchase = privatePurchase();
  h.store.savePurchase(purchase);
  try {
    const unauthenticated = await fetch(`${h.base}/v1/purchases/${requestId}`);
    assert.equal(unauthenticated.status, 401);
    assert.doesNotMatch(await unauthenticated.text(), /private-payment|momentum\.v1|0x2222/);

    const path = `/v1/purchases/${requestId}`;
    const scope = { buyer: '0.0.1001', request_id: requestId, method: 'GET', path, body_hash: bodyHash('') };
    const proof = proofHeader(h.auth, h.key, scope);
    const recovered = await fetch(`${h.base}${path}`, { headers: { 'x-wallet-proof': proof } });
    assert.equal(recovered.status, 200);
    const recoveredBody = await recovered.json() as any;
    assert.equal(recoveredBody.prepared.salt, purchase.prepared!.salt);
    assert.equal(recoveredBody.payment.payload.transaction, 'private-payment');
    assert.equal((await fetch(`${h.base}${path}`, { headers: { 'x-wallet-proof': proof } })).status, 401);

    h.store.put('samples', requestId, { request_id: requestId, commitment_hash: purchase.prepared!.hash, revealed_at: null, grade: null, oracle_status: 'pending' });
    const publicSignal = await fetch(`${h.base}/v1/signals/${requestId}`);
    assert.equal(publicSignal.status, 200);
    assert.doesNotMatch(await publicSignal.text(), /private-payment|momentum\.v1|0x2222/);
    const activity = await (await fetch(`${h.base}/v1/activity`)).text();
    assert.doesNotMatch(activity, /private-payment|momentum\.v1|0x2222/);
  } finally {
    await new Promise<void>((resolve, reject) => h.app.close(error => error ? reject(error) : resolve()));
    h.store.close();
  }
});
