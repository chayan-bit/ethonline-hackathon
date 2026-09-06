import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keccak256, stringToHex, zeroAddress } from 'viem';
import { loadConfig } from '../../src/adapters/config.ts';
import { accountAddress } from '../../src/adapters/hedera.ts';
import { Ledger } from '../../src/adapters/ledger.ts';
import { providerMetadata } from '../../src/service/metadata.ts';
import { Store } from '../../src/service/store.ts';

test('registry seller verification supports a payee distinct from the owner', async () => {
  const config = loadConfig({ PUBLIC_BASE_URL: 'http://localhost:3000', HEDERA_OPERATOR_ID: '0.0.1001', HEDERA_PAYEE_ID: '0.0.1002' });
  const store = new Store(':memory:');
  const ledger = new Ledger(config, store);
  const metadataHash = keccak256(stringToHex(JSON.stringify(providerMetadata(config))));
  Object.assign((ledger as unknown as { client: object }).client, {
    readContract: async () => [accountAddress('0.0.1001'), zeroAddress, accountAddress('0.0.1002'), true, metadataHash],
  });
  assert.deepEqual(await ledger.seller(), { agent_id: '1', payTo: '0.0.1002', price: '100000', active: true });
  store.close();
});
