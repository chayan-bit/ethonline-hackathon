import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getContractAddress } from 'viem';
import {
  FULL_RECOVERY_CAP_TINYBARS,
  PYTH_STACK_CAP_TINYBARS,
  deploymentNonces,
  estimatePythStackTinybars,
  estimateFullRecoveryTinybars,
  requireDeploymentBudget,
  corruptAccumulatorSignature,
  parseVaaMetadata,
  splitFileContents,
  maskRuntimeImmutables,
  isInvalidWormholeVaa,
  remainingDeploymentBudget,
} from '../../src/protocol/pyth-deployment.ts';

test('Pyth deployment budget includes five Hedera contract-create base fees and bounded gas', () => {
  const estimate = estimatePythStackTinybars(1_110_000_000_000n, {
    cent_equivalent: 240_516n,
    hbar_equivalent: 30_000n,
  });
  assert.equal(estimate.gasTinybars, 1_209_900_000n);
  assert.equal(estimate.createTinybars, 6_236_591_329n);
  assert.equal(estimate.totalTinybars, 7_446_491_329n);
  assert.ok(estimate.totalTinybars < PYTH_STACK_CAP_TINYBARS);
});

test('full recovery estimate includes the new ledger and lifecycle while remaining below its separate cap', () => {
  const estimate = estimateFullRecoveryTinybars(1_110_000_000_000n, {
    cent_equivalent: 240_516n,
    hbar_equivalent: 30_000n,
  });
  assert.equal(estimate.createTinybars, 7_483_909_595n);
  assert.ok(estimate.totalTinybars > PYTH_STACK_CAP_TINYBARS);
  assert.ok(estimate.totalTinybars < FULL_RECOVERY_CAP_TINYBARS);
});

test('file chunks round-trip without sharing mutable buffers', () => {
  const input = Uint8Array.from({ length: 9 }, (_, index) => index);
  const chunks = splitFileContents(input, 4);
  assert.deepEqual(
    chunks.map((chunk) => [...chunk]),
    [[0, 1, 2, 3], [4, 5, 6, 7], [8]],
  );
  chunks[0]![0] = 99;
  assert.equal(input[0], 0);
  assert.throws(() => splitFileContents(input, 0), /invalid_file_chunk_size/);
});

test('runtime masking zeros only compiler-declared immutable ranges', () => {
  const runtime = Uint8Array.from([1, 2, 3, 4, 5, 6]);
  assert.deepEqual(
    [
      ...maskRuntimeImmutables(runtime, [
        { start: 1, length: 2 },
        { start: 5, length: 1 },
      ]),
    ],
    [1, 0, 0, 4, 5, 0],
  );
  assert.deepEqual([...runtime], [1, 2, 3, 4, 5, 6]);
  assert.throws(() => maskRuntimeImmutables(runtime, [{ start: 5, length: 2 }]), /invalid_immutable_range/);
});

test('VAA metadata parser validates bounds and reads guardian, source, and sequence', () => {
  const body = Buffer.alloc(51);
  body.writeUInt32BE(123, 0);
  body.writeUInt32BE(7, 4);
  body.writeUInt16BE(1, 8);
  body.fill(0xaa, 10, 42);
  body.writeBigUInt64BE(1030n, 42);
  body[50] = 32;
  const vaa = Buffer.concat([Buffer.from([1, 0, 0, 0, 7, 1, 0]), Buffer.alloc(65, 0xbb), body]);
  assert.deepEqual(parseVaaMetadata(vaa), {
    version: 1,
    guardianSetIndex: 7,
    signatureCount: 1,
    emitterChain: 1,
    emitterAddress: `0x${'aa'.repeat(32)}`,
    sequence: 1030n,
  });
  assert.throws(() => parseVaaMetadata(vaa.subarray(0, 20)), /invalid_vaa/);
});

test('accumulator corruption changes one signature byte while preserving the input', () => {
  const vaa = Buffer.concat([Buffer.from([1, 0, 0, 0, 1, 1, 0]), Buffer.alloc(65, 0x44), Buffer.alloc(51)]);
  const update = Buffer.concat([Buffer.from('504e415501000000', 'hex'), Buffer.from([vaa.length >> 8, vaa.length & 255]), vaa, Buffer.from([0])]);
  const corrupted = corruptAccumulatorSignature(update);
  assert.notDeepEqual(corrupted, update);
  assert.equal(update[17], 0x44);
  assert.equal(corrupted[17], 0x45);
  assert.throws(() => corruptAccumulatorSignature(Buffer.alloc(5)), /invalid_accumulator_update/);
});

test('corrupt-proof rejection accepts only the exact InvalidWormholeVaa custom error', () => {
  assert.equal(isInvalidWormholeVaa({ cause: { data: '0x2acbe915' } }), true);
  assert.equal(
    isInvalidWormholeVaa({
      cause: { data: { errorName: 'InvalidWormholeVaa' } },
    }),
    true,
  );
  assert.equal(isInvalidWormholeVaa(new Error('RPC timeout mentioning 0x2acbe915')), false);
  assert.equal(isInvalidWormholeVaa({ cause: { data: '0xdeadbeef' } }), false);
});

test('deployment gate reserves the full recovery cap and rejects stale fee estimates', () => {
  const estimate = {
    totalTinybars: 7_500_000_000n,
    gasTinybars: 1n,
    createTinybars: 1n,
  };
  assert.doesNotThrow(() => requireDeploymentBudget(estimate, FULL_RECOVERY_CAP_TINYBARS, 1_000));
  assert.throws(() => requireDeploymentBudget({ ...estimate, totalTinybars: PYTH_STACK_CAP_TINYBARS + 1n }, FULL_RECOVERY_CAP_TINYBARS, 1_000), /pyth_stack_cap_exceeded/);
  assert.throws(() => requireDeploymentBudget(estimate, FULL_RECOVERY_CAP_TINYBARS - 1n, 1_000), /recovery_balance_insufficient/);
  assert.throws(() => requireDeploymentBudget(estimate, FULL_RECOVERY_CAP_TINYBARS, 3_601), /stale_fee_quote/);
});

test('resume budget requires only the unspent portion of the bound recovery cap', () => {
  assert.equal(remainingDeploymentBudget(100n, [20n, 52n]), 28n);
  assert.throws(() => remainingDeploymentBudget(100n, [100n]), /deployment_cap_exhausted/);
  assert.throws(() => remainingDeploymentBudget(100n, [-1n]), /invalid_deployment_spend/);
});

test('planned nonces count only Ethereum transactions from the alias deployer', () => {
  const sender = '0x0000000000000000000000000000000000001234';
  const nonces = deploymentNonces(7);
  assert.deepEqual(nonces, {
    receiverSetup: 7,
    receiverImplementation: 8,
    receiverProxy: 9,
    pythImplementation: 10,
    pythProxy: 11,
    signalLedger: 12,
  });
  assert.equal(
    getContractAddress({
      from: sender,
      nonce: BigInt(nonces.pythImplementation),
    }),
    '0x601ea21B4DC7345fE7e3633F52db59CeEe0711Ca',
  );
});
