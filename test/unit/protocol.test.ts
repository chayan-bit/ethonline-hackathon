import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeAbiParameters, parseAbiParameters } from 'viem';
import { encodeSignal, hashSignal, parseSignal, assertCommitTiming, ETH_USD, SCHEMA } from '../../src/protocol/signal.ts';
import { calculateGrade } from '../../src/protocol/grade.ts';

const signal = {
  schema: SCHEMA, request_id: `0x${'11'.repeat(32)}`, agent_id: '42',
  price_feed_id: ETH_USD, issued_at: 1_000, target_time: 1_330,
  predicted_return_bps: -42, model_version: 'momentum.v1', distribution: 'non-exclusive',
};
const salt = `0x${'22'.repeat(32)}` as const;

test('canonical encoding preserves negative returns and every committed field', () => {
  const parsed = parseSignal(signal);
  const encoded = encodeSignal(parsed, salt);
  const decoded = decodeAbiParameters(parseAbiParameters('bytes32, bytes32, uint256, bytes32, uint64, uint64, int32, bytes32, uint8, bytes32'), encoded);
  assert.equal(decoded[2], 42n);
  assert.equal(decoded[6], -42);
  assert.equal(decoded[9], salt);
  assert.notEqual(hashSignal(parsed, salt), hashSignal({ ...parsed, predicted_return_bps: 42 }, salt));
  assert.notEqual(hashSignal(parsed, salt), hashSignal(parsed, `0x${'33'.repeat(32)}`));
});

test('schema rejects unknown fields, unsafe IDs, feeds, numbers, and Unicode model versions', () => {
  for (const changes of [
    { extra: true }, { agent_id: '0' }, { agent_id: '01' }, { agent_id: (2n ** 256n).toString() },
    { predicted_return_bps: 1.5 }, { predicted_return_bps: 100_001 },
    { target_time: 1_000.1 }, { issued_at: Number.MAX_SAFE_INTEGER + 1 },
    { price_feed_id: `0x${'00'.repeat(32)}` }, { model_version: 'mödél' },
  ]) assert.throws(() => parseSignal({ ...signal, ...changes }), /invalid_signal/);
});

test('commit timing rejects non-finite clocks', () => {
  for (const time of [NaN, Infinity, -1, 1.5]) assert.throws(() => assertCommitTiming(parseSignal(signal), time));
});

test('grade normalizes oracle exponents and truncates signed returns toward zero', () => {
  const result = calculateGrade(-42, { price: 200000n, expo: -2, conf: 10n }, { price: 1991600n, expo: -3, conf: 10n });
  assert.deepEqual(result, { actual_return_bps: -42, absolute_error_bps: 0, direction_correct: true });
  assert.equal(calculateGrade(0, { price: 3n, expo: 0, conf: 0n }, { price: 2n, expo: 0, conf: 0n }).actual_return_bps, -3333);
  assert.equal(calculateGrade(5, { price: 10_000n, expo: 0, conf: 0n }, { price: 9995n, expo: 0, conf: 0n }).direction_correct, true);
});

test('grade rejects invalid confidence and arithmetic ranges', () => {
  const valid = { price: 100n, expo: 0, conf: 0n };
  for (const bad of [{ ...valid, price: 0n }, { ...valid, conf: 2n }, { ...valid, expo: 100 }]) {
    assert.throws(() => calculateGrade(0, bad, valid));
  }
});
