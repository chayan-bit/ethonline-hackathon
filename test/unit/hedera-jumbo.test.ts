import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { getContractAddress, recoverTransactionAddress } from 'viem';
import { buildJumboCreateTransaction, createJumboDeployerAccountTransaction, generateJumboDeployer, loadOrCreateJumboDeployer } from '../../src/adapters/hedera-jumbo.ts';

test('jumbo deployer secret is stable, private, and distinct across files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jumbo-deployer-'));
  const firstPath = join(directory, 'first.json');
  const secondPath = join(directory, 'second.json');
  const first = loadOrCreateJumboDeployer(firstPath);
  const reloaded = loadOrCreateJumboDeployer(firstPath);
  const second = loadOrCreateJumboDeployer(secondPath);
  assert.equal(reloaded.publicKey, first.publicKey);
  assert.equal(reloaded.evmAddress, first.evmAddress);
  assert.notEqual(second.publicKey, first.publicKey);
  assert.equal(statSync(firstPath).mode & 0o077, 0);
  const accountCreate = createJumboDeployerAccountTransaction(first);
  assert.equal(accountCreate.initialBalance?.toTinybars().toString(), '0');
  assert.equal(accountCreate.key?.toString(), first.publicKey);
  assert.equal(accountCreate.alias?.toString(), first.evmAddress.slice(2).toLowerCase());
});

test('jumbo CREATE signs the exact alias nonce and embeds initcode without a file', async () => {
  const deployer = generateJumboDeployer();
  const result = await buildJumboCreateTransaction({
    deployer,
    nonce: 3,
    initCode: '0x60006000f3',
    gasLimit: 100_000n,
    maxGasAllowanceTinybars: 25_000_000n,
  });
  assert.equal(
    await recoverTransactionAddress({
      serializedTransaction: result.rawEthereumData as `0x02${string}`,
    }),
    deployer.evmAddress,
  );
  assert.equal(result.evmAddress, getContractAddress({ from: deployer.evmAddress, nonce: 3n }));
  assert.ok(result.transaction.ethereumData instanceof Uint8Array);
  assert.deepEqual(Buffer.from(result.transaction.ethereumData), Buffer.from(result.rawEthereumData.slice(2), 'hex'));
  assert.equal(result.transaction.maxGasAllowance?.toTinybars().toString(), '25000000');
});
