import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { AccountId } from '@hiero-ledger/sdk';
import { encodeAbiParameters, encodeEventTopics, type Abi, type Hex } from 'viem';
import { loadConfig } from '../../src/adapters/config.ts';
import { artifact } from '../../src/adapters/hedera.ts';
import { paymentReference } from '../../src/adapters/payment.ts';
import { ETH_USD, SCHEMA_ID } from '../../src/protocol/signal.ts';
import { Indexer } from '../../src/service/indexer.ts';
import { Store } from '../../src/service/store.ts';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const abi = artifact('SignalLedger').abi as Abi;
const requestId = `0x${'11'.repeat(32)}` as Hex;
const signalHash = `0x${'22'.repeat(32)}` as Hex;
const nativePaymentId = '0.0.7162784@900.000000001';
const ledgerAddress = '0x0000000000000000000000000000000000000001';

function eventLog(timestamp = '1000.000000000', eventRequestId: Hex = requestId, transactionByte = '33', paymentId = nativePaymentId) {
  const args = {
    requestId: eventRequestId,
    agentId: 1n,
    signalHash,
    schemaId: SCHEMA_ID,
    committedAt: 1_000n,
    issuedAt: 1_000n,
    targetTime: 1_600n,
    priceFeedId: ETH_USD,
    paymentMode: 1,
    paymentRef: paymentReference(paymentId),
    payer: `0x${AccountId.fromString('0.0.1001').toSolidityAddress()}`,
    payee: `0x${AccountId.fromString('0.0.1002').toSolidityAddress()}`,
    paymentAssetId: `0x${'00'.repeat(32)}`,
    amount: 100n,
    networkId: '0x081f0fc72bb86254998f581829076b0b77b5db595f7f4fd7f73a9d34bdb091f6',
    nativePaymentId: paymentId,
  } as const;
  const event = abi.find((item) => item.type === 'event' && item.name === 'SignalCommitted');
  assert.ok(event && event.type === 'event');
  const nonIndexed = event.inputs.filter((input) => !input.indexed);
  return {
    data: encodeAbiParameters(nonIndexed, nonIndexed.map((input) => args[input.name as keyof typeof args]) as never),
    topics: encodeEventTopics({
      abi: [event],
      eventName: 'SignalCommitted',
      args,
    }),
    transaction_hash: `0x${transactionByte.repeat(48)}`,
    index: 0,
    timestamp,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mirrorFetch(logs: unknown[][], watermark = '2000.000000000') {
  let logPage = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith('/supported'))
      return json({
        kinds: [
          {
            x402Version: 2,
            scheme: 'exact',
            network: 'hedera:testnet',
            extra: { feePayer: '0.0.7162784' },
          },
        ],
        extensions: [],
      });
    if (url.pathname.endsWith('/transactions/0.0.7162784-900-000000001'))
      return json({
        transactions: [
          {
            transaction_id: '0.0.7162784-900-000000001',
            result: 'SUCCESS',
            name: 'CRYPTOTRANSFER',
            nonce: 0,
            consensus_timestamp: '999.000000000',
            charged_tx_fee: 20,
            token_transfers: [],
            nft_transfers: [],
            transfers: [
              { account: '0.0.1001', amount: -100 },
              { account: '0.0.1002', amount: 100 },
              { account: '0.0.7162784', amount: -20 },
              { account: '0.0.3', amount: 20 },
            ],
          },
        ],
      });
    if (url.pathname.endsWith('/transactions')) return json({ transactions: [{ consensus_timestamp: watermark }] });
    if (url.pathname.endsWith('/results/logs')) {
      const page = logs[logPage++] ?? [];
      const next = logPage < logs.length ? `/api/v1/contracts/${ledgerAddress}/results/logs?page=${logPage + 1}` : null;
      return json({ logs: page, links: { next } });
    }
    throw new Error(`unexpected_fetch:${url.pathname}`);
  };
}

const commitKey = `SignalCommitted/${requestId}`;
function harness(
  snapshot = async () => ({
    watermark: '2000.000000000',
    eventKeys: new Set([commitKey]),
  }),
) {
  const store = new Store(':memory:');
  const config = loadConfig({
    PUBLIC_BASE_URL: 'http://localhost:3000',
    LEDGER_ADDRESS: ledgerAddress,
    LEDGER_DEPLOYMENT_BLOCK: '0',
  }, false);
  return { store, indexer: new Indexer(config, store, snapshot) };
}

test('indexer paginates, deduplicates replayed logs, and verifies the exact payment once', async () => {
  const log = eventLog();
  mirrorFetch([[log], [log]]);
  const h = harness();
  try {
    await h.indexer.sync();
    assert.equal(h.store.list('events').length, 1);
    assert.equal(h.store.list('samples').length, 1);
    assert.deepEqual(h.store.get<any>('samples', requestId)?.payment_status, 'verified');
    assert.equal(h.store.get<any>('samples', requestId)?.payment_verified_at, 999);
    assert.equal(h.store.get<string>('indexer', 'cursor'), '2000.000000000');
  } finally {
    h.store.close();
  }
});

test('indexer backfills ledger provenance onto a pre-cohort legacy sample during canonical replay', async () => {
  const log = eventLog();
  mirrorFetch([[log]]);
  const h = harness();
  h.store.put('samples', requestId, {
    request_id: requestId,
    payment_status: 'verified',
    payment_verified_at: 999,
    revealed_at: 1700,
    grade: null,
    oracle_status: 'unavailable',
    oracle_status_at: 1800,
  });
  h.store.put('events', log.transaction_hash + '/' + log.index, { eventName: 'SignalCommitted' });
  try {
    await h.indexer.sync();
    const sample = h.store.get<any>('samples', requestId);
    assert.equal(sample?.ledger_address, ledgerAddress);
    assert.equal(sample?.payment_status, 'verified');
    assert.equal(sample?.payment_verified_at, 999);
    assert.equal(sample?.revealed_at, 1700);
    assert.equal(sample?.oracle_status, 'unavailable');
    assert.equal(sample?.oracle_status_at, 1800);
  } finally {
    h.store.close();
  }
});

test('indexer rejects a same-second Mirror superset before applying any event', async () => {
  const extraRequest = `0x${'44'.repeat(32)}` as Hex;
  mirrorFetch([[eventLog(), eventLog('2000.500000000', extraRequest, '55', '0.0.7162784@901.000000001')]]);
  const h = harness(async () => ({ watermark: '2000.999999999', eventKeys: new Set([commitKey]) }));
  try {
    await assert.rejects(h.indexer.sync(), /mirror_contract_logs_not_canonical/);
    assert.deepEqual(h.store.list('samples'), []);
    assert.equal(h.store.get('indexer', 'cursor'), null);
  } finally {
    h.store.close();
  }
});

test('indexer rejects a page containing data beyond its captured watermark without advancing its cursor', async () => {
  mirrorFetch([[eventLog('2001.000000000')]]);
  const h = harness();
  try {
    await assert.rejects(h.indexer.sync(), /future_log/);
    assert.equal(h.store.get('indexer', 'cursor'), null);
    assert.deepEqual(h.store.list('samples'), []);
  } finally {
    h.store.close();
  }
});

test('indexer refuses to advance until delayed Mirror logs match the canonical block snapshot', async () => {
  let snapshot = {
    watermark: '2000.000000000',
    eventKeys: new Set([commitKey]),
  };
  const h = harness(async () => snapshot);
  try {
    mirrorFetch([[]]);
    await assert.rejects(h.indexer.sync(), /mirror_contract_logs_not_canonical/);
    assert.equal(h.store.get<string>('indexer', 'cursor'), null);

    snapshot = { watermark: '3000.000000000', eventKeys: new Set([commitKey]) };
    mirrorFetch([[eventLog('1000.000000000')]], '3000.000000000');
    await h.indexer.sync();
    assert.equal(h.store.list('samples').length, 1);
    assert.equal(h.store.get<string>('indexer', 'cursor'), '3000.000000000');
  } finally {
    h.store.close();
  }
});

test('hidden reveal at the canonical head cannot advance metrics or count a forecast as unrevealed', async () => {
  let snapshot = {
    watermark: '1400.000000000',
    eventKeys: new Set([commitKey]),
  };
  const h = harness(async () => snapshot);
  try {
    mirrorFetch([[eventLog('1000.000000000')]], '1400.000000000');
    await h.indexer.sync();
    snapshot = {
      watermark: '2000.000000000',
      eventKeys: new Set([commitKey, `SignalRevealed/${requestId}`]),
    };
    mirrorFetch([[eventLog('1000.000000000')]]);
    await assert.rejects(h.indexer.sync(), /mirror_contract_logs_not_canonical/);
    assert.equal(h.store.get<string>('indexer', 'cursor'), '1400.000000000');
  } finally {
    h.store.close();
  }
});

test('indexer keeps independent canonical watermarks and ledger provenance for both cohorts', async () => {
  const secondLedger = '0x0000000000000000000000000000000000000002';
  const secondRequest = `0x${'44'.repeat(32)}` as Hex;
  const logs = new Map([
    [ledgerAddress.toLowerCase(), eventLog('1000.000000000', requestId, '33')],
    [secondLedger.toLowerCase(), eventLog('1001.000000000', secondRequest, '55', '0.0.7162784@901.000000001')],
  ]);
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith('/supported'))
      return json({
        kinds: [
          {
            x402Version: 2,
            scheme: 'exact',
            network: 'hedera:testnet',
            extra: { feePayer: '0.0.7162784' },
          },
        ],
        extensions: [],
      });
    if (url.pathname.includes('/transactions/0.0.7162784-')) return json({ transactions: [] });
    if (url.pathname.endsWith('/transactions'))
      return json({
        transactions: [{ consensus_timestamp: '2000.000000000' }],
      });
    if (url.pathname.endsWith('/results/logs')) {
      const address = url.pathname.split('/contracts/')[1]?.split('/')[0]?.toLowerCase() ?? '';
      return json({
        logs: logs.has(address) ? [logs.get(address)] : [],
        links: { next: null },
      });
    }
    throw new Error(`unexpected_fetch:${url.pathname}`);
  };
  const store = new Store(':memory:');
  const config = loadConfig({
    PUBLIC_BASE_URL: 'http://localhost:3000',
    LEGACY_LEDGER_ADDRESS: ledgerAddress,
    ACTIVE_LEDGER_ADDRESS: secondLedger,
    LEDGER_DEPLOYMENT_BLOCK: '2',
    LEDGER_COHORTS_JSON: JSON.stringify([
      {
        address: ledgerAddress,
        deployment_block: 1,
        pyth_address: '0x0000000000000000000000000000000000000101',
      },
      {
        address: secondLedger,
        deployment_block: 2,
        pyth_address: '0x0000000000000000000000000000000000000102',
      },
    ]),
  }, false);
  const indexer = new Indexer(config, store, async (cohort) => ({
    watermark: cohort.address === ledgerAddress ? '2000.000000000' : '2001.000000000',
    eventKeys: new Set([`SignalCommitted/${cohort.address === ledgerAddress ? requestId : secondRequest}`]),
  }));
  try {
    await indexer.sync();
    assert.equal(store.get<any>('samples', requestId)?.ledger_address, ledgerAddress);
    assert.equal(store.get<any>('samples', secondRequest)?.ledger_address, secondLedger);
    assert.equal(store.get<string>('indexer', `cursor/${ledgerAddress}`), '2000.000000000');
    assert.equal(store.get<string>('indexer', `cursor/${secondLedger}`), '2001.000000000');
    assert.equal(store.get<string>('indexer', 'cursor'), '2000.000000000');
    assert.equal(store.get<any>('indexer', 'status')?.indexed_through, 2000);
  } finally {
    store.close();
  }
});

test('aggregate watermark stays at the last safe minimum and becomes unhealthy when any cohort fails', async () => {
  const secondLedger = '0x0000000000000000000000000000000000000002';
  const store = new Store(':memory:');
  const config = loadConfig({
    PUBLIC_BASE_URL: 'http://localhost:3000',
    LEGACY_LEDGER_ADDRESS: ledgerAddress,
    ACTIVE_LEDGER_ADDRESS: secondLedger,
    LEDGER_DEPLOYMENT_BLOCK: '2',
    LEDGER_COHORTS_JSON: JSON.stringify([
      {
        address: ledgerAddress,
        deployment_block: 1,
        pyth_address: '0x0000000000000000000000000000000000000101',
      },
      {
        address: secondLedger,
        deployment_block: 2,
        pyth_address: '0x0000000000000000000000000000000000000102',
      },
    ]),
  }, false);
  let shouldFail = false;
  const indexer = new Indexer(config, store, async (cohort) => {
    if (shouldFail && cohort.address === secondLedger) throw new Error('second_cohort_unavailable');
    return {
      watermark: cohort.address === ledgerAddress ? '2001.000000000' : '2000.000000000',
      eventKeys: new Set(),
    };
  });
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith('/supported'))
      return json({
        kinds: [
          {
            x402Version: 2,
            scheme: 'exact',
            network: 'hedera:testnet',
            extra: { feePayer: '0.0.7162784' },
          },
        ],
        extensions: [],
      });
    if (url.pathname.endsWith('/results/logs')) return json({ logs: [], links: { next: null } });
    throw new Error(`unexpected_fetch:${url.pathname}`);
  };
  try {
    await indexer.sync();
    assert.equal(store.get<string>('indexer', 'cursor'), '2000.000000000');
    shouldFail = true;
    await assert.rejects(indexer.sync(), /second_cohort_unavailable/);
    assert.equal(store.get<string>('indexer', 'cursor'), '2000.000000000');
    assert.equal(store.get<any>('indexer', 'status')?.indexed_through, 2000);
    assert.equal(store.get<any>('indexer', 'status')?.error, 'second_cohort_unavailable');
  } finally {
    store.close();
  }
});

test('indexer rejects cross-ledger native payment reuse without replacing the first sample', async () => {
  const secondLedger = '0x0000000000000000000000000000000000000002';
  const secondRequest = `0x${'44'.repeat(32)}` as Hex;
  const logs = new Map([
    [ledgerAddress.toLowerCase(), eventLog('1000.000000000', requestId, '33')],
    [secondLedger.toLowerCase(), eventLog('1001.000000000', secondRequest, '55')],
  ]);
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith('/supported'))
      return json({
        kinds: [
          {
            x402Version: 2,
            scheme: 'exact',
            network: 'hedera:testnet',
            extra: { feePayer: '0.0.7162784' },
          },
        ],
        extensions: [],
      });
    if (url.pathname.includes('/transactions/0.0.7162784-')) return json({ transactions: [] });
    if (url.pathname.endsWith('/transactions'))
      return json({
        transactions: [{ consensus_timestamp: '2000.000000000' }],
      });
    if (url.pathname.endsWith('/results/logs')) {
      const address = url.pathname.split('/contracts/')[1]?.split('/')[0]?.toLowerCase() ?? '';
      return json({
        logs: logs.has(address) ? [logs.get(address)] : [],
        links: { next: null },
      });
    }
    throw new Error(`unexpected_fetch:${url.pathname}`);
  };
  const store = new Store(':memory:');
  const config = loadConfig({
    PUBLIC_BASE_URL: 'http://localhost:3000',
    LEGACY_LEDGER_ADDRESS: ledgerAddress,
    ACTIVE_LEDGER_ADDRESS: secondLedger,
    LEDGER_DEPLOYMENT_BLOCK: '2',
    LEDGER_COHORTS_JSON: JSON.stringify([
      {
        address: ledgerAddress,
        deployment_block: 1,
        pyth_address: '0x0000000000000000000000000000000000000101',
      },
      {
        address: secondLedger,
        deployment_block: 2,
        pyth_address: '0x0000000000000000000000000000000000000102',
      },
    ]),
  }, false);
  const indexer = new Indexer(config, store, async (cohort) => ({
    watermark: '2000.000000000',
    eventKeys: new Set([`SignalCommitted/${cohort.address === ledgerAddress ? requestId : secondRequest}`]),
  }));
  try {
    await assert.rejects(indexer.sync(), /cross_ledger_payment_reuse/);
    assert.equal(store.get<any>('samples', requestId)?.ledger_address, ledgerAddress);
    assert.equal(store.get('samples', secondRequest), null);
    assert.equal(store.get('indexer', `cursor/${secondLedger}`), null);
  } finally {
    store.close();
  }
});
