import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrivateKey } from '@x402/hedera';
import { Auth, bodyHash } from '../../src/service/auth.ts';
import { Store } from '../../src/service/store.ts';

const scope = { buyer: '0.0.1001', request_id: `0x${'11'.repeat(32)}`, method: 'GET', path: `/v1/purchases/0x${'11'.repeat(32)}`, body_hash: bodyHash('') };
test('wallet challenge is bound to buyer, operation and expiry, then consumed exactly once', async () => {
  const store = new Store(':memory:');
  const key = PrivateKey.generateECDSA();
  const auth = new Auth(store, 'https://example.com', async () => key.publicKey, () => 1000);
  assert.throws(() => auth.issue({ ...scope, body_hash: 'not-a-sha256-digest' }), /invalid_auth_scope/);
  const challenge = auth.issue(scope);
  const signature = Buffer.from(key.sign(Buffer.from(challenge.message))).toString('hex');
  const proof = { challenge_id: challenge.id, signature };
  await assert.rejects(auth.verify(proof, { ...scope, buyer: '0.0.9999' }), /invalid_auth/);
  await assert.rejects(auth.verify(proof, { ...scope, method: 'POST' }), /invalid_auth/);
  await auth.verify(proof, scope);
  await assert.rejects(auth.verify(proof, scope), /invalid_auth/);
  store.close();
});

test('wrong key and expired challenge cannot recover a public receipt', async () => {
  const store = new Store(':memory:');
  const key = PrivateKey.generateECDSA();
  const auth = new Auth(store, 'https://example.com', async () => key.publicKey, () => 1000);
  const c = auth.issue(scope);
  await assert.rejects(auth.verify({ challenge_id: c.id, signature: Buffer.from(PrivateKey.generateECDSA().sign(Buffer.from(c.message))).toString('hex') }, scope), /invalid_auth/);
  const expired = new Auth(store, 'https://example.com', async () => key.publicKey, () => 2000);
  await assert.rejects(expired.verify({ challenge_id: c.id, signature: Buffer.from(key.sign(Buffer.from(c.message))).toString('hex') }, scope), /invalid_auth/);
  store.close();
});

test('persisted reservations include in-flight payments and enforce provider/global caps', () => {
  const store = new Store(':memory:');
  store.reserve('a', '1', '2026-09-06', 70n, 100n, 100n);
  assert.throws(() => store.reserve('b', '1', '2026-09-06', 40n, 100n, 100n), /budget_exceeded/);
  assert.throws(() => store.reserve('b', '2', '2026-09-06', 40n, 100n, 100n), /budget_exceeded/);
  store.reserve('a', '1', '2026-09-06', 70n, 100n, 100n);
  assert.equal(store.reservations().length, 1);
  store.close();
});
