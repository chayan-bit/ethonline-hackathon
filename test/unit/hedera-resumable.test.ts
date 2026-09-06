import assert from 'node:assert/strict';
import { PrivateKey, Status, type Client, type TransactionReceipt } from '@hiero-ledger/sdk';
import { test } from 'node:test';
import { ResumableTransactionRunner, type TransactionAttempt, type TransactionStep } from '../../src/adapters/hedera-resumable.ts';

test('entity-bearing receipt cannot clear a signed journal until its native ID is present', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 404 });
  const attempt: TransactionAttempt = {
    transaction_id: '0.0.1001@1000.000000001',
    planned_at: 1000,
    signed_transaction: 'still-recoverable',
    transaction_hash: 'hash',
    status: 'submitted',
  };
  let steps: Record<string, TransactionStep<'full'>> = {
    'contract.SignalLedger': { phase: 'full', attempts: [attempt] },
  };
  const runner = new ResumableTransactionRunner({
    client: {} as Client,
    key: PrivateKey.generateECDSA(),
    mirrorUrl: 'https://example.invalid/api/v1',
    getSteps: () => steps,
    saveSteps: (next) => {
      steps = next;
    },
    capFor: () => 100n,
    budgetFor: () => ({ total: 1n, gas: 0n }),
    requiresEntity: () => true,
  });
  const finish = (
    runner as unknown as {
      finish: (id: string, phase: 'full', index: number, value: TransactionAttempt, receipt: TransactionReceipt) => Promise<TransactionAttempt>;
    }
  ).finish.bind(runner);
  try {
    await assert.rejects(finish('contract.SignalLedger', 'full', 0, attempt, { status: Status.Success } as TransactionReceipt), /transaction_entity_pending/);
    assert.equal(steps['contract.SignalLedger']?.attempts[0]?.signed_transaction, 'still-recoverable');
    assert.equal(steps['contract.SignalLedger']?.attempts[0]?.status, 'submitted');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('missing receipt entity finalizes only after Mirror supplies the native ID', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        transactions: [
          {
            nonce: 0,
            transaction_id: '0.0.1001-1000-000000001',
            result: 'SUCCESS',
            charged_tx_fee: 42,
            entity_id: '0.0.2002',
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  const attempt: TransactionAttempt = {
    transaction_id: '0.0.1001@1000.000000001',
    planned_at: 1000,
    signed_transaction: 'recoverable',
    transaction_hash: 'hash',
    status: 'submitted',
  };
  let steps: Record<string, TransactionStep<'full'>> = { 'contract.SignalLedger': { phase: 'full', attempts: [attempt] } };
  const runner = new ResumableTransactionRunner({
    client: {} as Client,
    key: PrivateKey.generateECDSA(),
    mirrorUrl: 'https://mirror.example/api/v1',
    getSteps: () => steps,
    saveSteps: (next) => {
      steps = next;
    },
    capFor: () => 100n,
    budgetFor: () => ({ total: 1n, gas: 0n }),
    requiresEntity: () => true,
  });
  const finish = (
    runner as unknown as {
      finish: (id: string, phase: 'full', index: number, value: TransactionAttempt, receipt: TransactionReceipt) => Promise<TransactionAttempt>;
    }
  ).finish.bind(runner);
  try {
    const complete = await finish('contract.SignalLedger', 'full', 0, attempt, { status: Status.Success } as TransactionReceipt);
    assert.equal(complete.entity_id, '0.0.2002');
    assert.equal(complete.fee_tinybars, '42');
    assert.equal(complete.signed_transaction, '');
    assert.equal(complete.status, 'consensus');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
