import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClientHederaSigner, PrivateKey, TransferTransaction, Hbar, Client, TransactionId, AccountId } from '@x402/hedera';
import { ExactHederaScheme } from '@x402/hedera/exact/client';
import { inspectPayment, normalizeTransactionId, paymentReference, verifyPaymentTransaction } from '../../src/adapters/payment.ts';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import type { Quote } from '../../src/service/gateway.ts';

const requirements: PaymentRequirements = { scheme: 'exact', network: 'hedera:testnet', asset: '0.0.0', amount: '100', payTo: '0.0.1002', maxTimeoutSeconds: 120, extra: { feePayer: '0.0.7162784' } };

test('official SDK signing and transaction inspection work with patched transitive dependencies', async () => {
  const signer = createClientHederaSigner('0.0.1001', PrivateKey.generateECDSA(), { network: 'hedera:testnet' });
  const created = await new ExactHederaScheme(signer).createPaymentPayload(2, requirements);
  const payload: PaymentPayload = { ...created, accepted: requirements };
  assert.match(inspectPayment(payload, requirements, '0.0.1001'), /^0\.0\.7162784@\d+\.\d{9}$/);
  assert.throws(() => inspectPayment(payload, { ...requirements, amount: '101' }, '0.0.1001'), /unsafe_payment/);
  assert.throws(() => inspectPayment(payload, requirements, '0.0.9999'), /unsafe_payment/);
});

test('extra recipient transfers are refused', async () => {
  const client = Client.forTestnet();
  try {
    const tx = new TransferTransaction().addHbarTransfer('0.0.1001', Hbar.fromTinybars(-101))
      .addHbarTransfer('0.0.1002', Hbar.fromTinybars(100)).addHbarTransfer('0.0.1003', Hbar.fromTinybars(1))
      .setTransactionId(TransactionId.generate(AccountId.fromString('0.0.7162784'))).freezeWith(client);
    const payload = { x402Version: 2, accepted: requirements, payload: { transaction: Buffer.from(tx.toBytes()).toString('base64') } };
    assert.throws(() => inspectPayment(payload, requirements, '0.0.1001'), /unsafe_payment/);
  } finally { client.close(); }
});

test('native and Mirror transaction spellings deduplicate', () => {
  assert.equal(normalizeTransactionId('0.0.1001-1700000000-123'), '0.0.1001@1700000000.000000123');
  assert.equal(paymentReference('0.0.1001-1700000000-123'), paymentReference('0.0.1001@1700000000.000000123'));
  for (const invalid of ['0.0.1', 'mainnet/0.0.1@1.0', '0.0.1@1.1234567890']) assert.throws(() => normalizeTransactionId(invalid));
});

test('Mirror evidence binds the exact transaction and separates service payment from network fees', () => {
  const id = '0.0.7162784@10000.000000000';
  const quote = { requirements, request: { buyer: '0.0.1001' } } as Quote;
  const tx = { transaction_id: '0.0.7162784-10000-000000000', result: 'SUCCESS', name: 'CRYPTOTRANSFER', nonce: 0,
    consensus_timestamp: '10001.000000000', charged_tx_fee: 20, node: '0.0.3', token_transfers: [], nft_transfers: [], transfers: [
      { account: '0.0.1001', amount: -100 }, { account: '0.0.1002', amount: 100 },
      { account: '0.0.7162784', amount: -20 }, { account: '0.0.3', amount: 5 }, { account: '0.0.98', amount: 15 },
    ] };
  assert.deepEqual(verifyPaymentTransaction(tx, id, quote), { status: 'verified', consensus_time: 10001 });
  assert.equal(verifyPaymentTransaction({ ...tx, transaction_id: '0.0.7162784-10001-000000000' }, id, quote).status, 'invalid');
  assert.equal(verifyPaymentTransaction({ ...tx, token_transfers: [{ token_id: '0.0.123' }] }, id, quote).status, 'invalid');
  assert.equal(verifyPaymentTransaction({ ...tx, transfers: [...tx.transfers, { account: '0.0.777', amount: -1 }, { account: '0.0.888', amount: 1 }] }, id, quote).status, 'invalid');
});
