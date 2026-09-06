import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getAddress } from 'viem';
import { loadConfig } from '../../src/adapters/config.ts';

const legacyLedger = getAddress('0x0000000000000000000000000000000000000101');
const activeLedger = getAddress('0x0000000000000000000000000000000000000102');
const legacyPyth = getAddress('0x0000000000000000000000000000000000000201');
const activePyth = getAddress('0x0000000000000000000000000000000000000202');

const cohorts = JSON.stringify([
  { address: legacyLedger, deployment_block: 10, pyth_address: legacyPyth },
  { address: activeLedger, deployment_block: 20, pyth_address: activePyth },
]);

test('configuration preserves the legacy ledger while selecting a distinct active cohort', () => {
  const config = loadConfig({
    PUBLIC_BASE_URL: 'http://localhost:3000',
    LEGACY_LEDGER_ADDRESS: legacyLedger,
    ACTIVE_LEDGER_ADDRESS: activeLedger,
    LEDGER_DEPLOYMENT_BLOCK: '20',
    LEDGER_COHORTS_JSON: cohorts,
  }, false);
  assert.equal(config.legacyLedgerAddress, legacyLedger);
  assert.equal(config.ledgerAddress, activeLedger);
  assert.equal(config.ledgerDeploymentBlock, 20);
  assert.deepEqual(config.ledgerCohorts, [
    { address: legacyLedger, deploymentBlock: 10, pythAddress: legacyPyth },
    { address: activeLedger, deploymentBlock: 20, pythAddress: activePyth },
  ]);
});

test('configuration rejects an active ledger absent from the declared cohorts', () => {
  assert.throws(() => loadConfig({
    PUBLIC_BASE_URL: 'http://localhost:3000',
    ACTIVE_LEDGER_ADDRESS: getAddress('0x0000000000000000000000000000000000000103'),
    LEDGER_COHORTS_JSON: cohorts,
  }), /active_ledger_not_in_cohorts/);
});

test('configuration refuses a manually asserted compatible oracle status without bound evidence', () => {
  assert.throws(() => loadConfig({ PUBLIC_BASE_URL: 'http://localhost:3000', ORACLE_GRADING_STATUS: 'compatible' }), /oracle_attestation_required/);
});
