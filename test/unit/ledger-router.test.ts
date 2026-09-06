import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getAddress } from 'viem';
import { loadConfig } from '../../src/adapters/config.ts';
import { LedgerRouter } from '../../src/adapters/ledger.ts';
import { Store } from '../../src/service/store.ts';

const legacyLedger = getAddress('0x0000000000000000000000000000000000000101');
const activeLedger = getAddress('0x0000000000000000000000000000000000000102');
const legacyPyth = getAddress('0x0000000000000000000000000000000000000201');
const activePyth = getAddress('0x0000000000000000000000000000000000000202');

function harness() {
  const store = new Store(':memory:');
  const config = loadConfig({
    PUBLIC_BASE_URL: 'http://localhost:3000', LEGACY_LEDGER_ADDRESS: legacyLedger, ACTIVE_LEDGER_ADDRESS: activeLedger,
    LEDGER_DEPLOYMENT_BLOCK: '20',
    LEDGER_COHORTS_JSON: JSON.stringify([
      { address: legacyLedger, deployment_block: 10, pyth_address: legacyPyth },
      { address: activeLedger, deployment_block: 20, pyth_address: activePyth },
    ]),
  }, false);
  return { store, router: new LedgerRouter(config, store) };
}

test('ledger router selects the quote-bound cohort and its matching oracle', () => {
  const h = harness();
  assert.equal(h.router.active.address, activeLedger);
  assert.equal(h.router.forQuote({ ledger_address: legacyLedger }).address, legacyLedger);
  assert.equal(h.router.forQuote({ ledger_address: legacyLedger }).pythAddress, legacyPyth);
  assert.equal(h.router.forQuote({ ledger_address: activeLedger }).pythAddress, activePyth);
  h.store.close();
});

test('ledger router sends an unbound historical quote only to the explicit legacy cohort', () => {
  const h = harness();
  assert.equal(h.router.forQuote({}).address, legacyLedger);
  assert.throws(() => h.router.forQuote({ ledger_address: getAddress('0x0000000000000000000000000000000000000999') }), /unknown_ledger_cohort/);
  h.store.close();
});
