import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeMetrics, type Sample } from '../../src/protocol/metrics.ts';
import { selectProvider, DEFAULT_POLICY, parseProviders } from '../../src/protocol/discovery.ts';

const now = 100_000;
const rows: Sample[] = Array.from({ length: 10 }, (_, i) => ({
  request_id: String(i), agent_id: '1', schema: 'defi.return_forecast.v1',
  price_feed_id: 'eth', payment_mode: 'x402', payment_status: 'verified',
  payer: `wallet${i}`, committed_at: now - 1000, target_time: now - 500, payment_verified_at: now - 1000,
  revealed_at: i < 8 ? now - 450 : null,
  grade: i < 6 ? { graded_at: now - 400, actual_return_bps: 10, absolute_error_bps: 20, direction_correct: i < 3 } : null,
  oracle_status: i === 6 ? 'excluded' : i === 7 ? 'unavailable' : 'pending', oracle_status_at: now - 400,
}));

test('reveal and quality use different numerators in exactly the same eligible cohort', () => {
  const m = computeMetrics(rows, { agentId: '1', indexedThrough: now, computedAt: now });
  assert.equal(m.reveal_pct, 80);
  assert.equal(m.grade_coverage_pct, 60);
  assert.equal(m.directional_hit_rate_pct, 50);
  assert.equal(m.mean_absolute_error_bps, 20);
  assert.equal(m.oracle_excluded_count, 1);
  assert.equal(m.oracle_unavailable_count, 1);
});

test('future and within-grace reveals do not inflate or dilute coverage; late reveal counts', () => {
  const pending = rows.slice(0, 5).map((s, i) => ({ ...s, request_id: `future${i}`, target_time: now + i }));
  assert.equal(computeMetrics([...rows, ...pending], { agentId: '1', indexedThrough: now, computedAt: now }).reveal_pct, 80);
  const late = rows.map((s, i) => i === 9 ? { ...s, revealed_at: now } : s);
  assert.equal(computeMetrics(late, { agentId: '1', indexedThrough: now, computedAt: now }).reveal_pct, 90);
});

test('unknown history stays null; watermark rather than wall clock controls cohort', () => {
  assert.equal(computeMetrics([], { agentId: '1', indexedThrough: now, computedAt: now }).reveal_pct, null);
  const m = computeMetrics(rows, { agentId: '1', indexedThrough: now - 1000, computedAt: now });
  assert.equal(m.reveal_pct, null);
  assert.equal(m.is_stale, true);
});

test('discovery rejects cheap low-reveal provider, stale data, and unknown quality', () => {
  const m = computeMetrics(rows, { agentId: '1', indexedThrough: now, computedAt: now });
  const provider = { agent_id: '1', active: true, price: '100', payTo: '0.0.1002', network: 'hedera:testnet', schema: 'defi.return_forecast.v1', asset: '0.0.0', feed_ids: ['eth'], metrics: m };
  const low = { ...provider, agent_id: '2', price: '1', metrics: { ...m, revealed_count: 6, reveal_pct: 60 } };
  assert.equal(selectProvider([low, provider], DEFAULT_POLICY).selected?.agent_id, '1');
  assert.equal(selectProvider([{ ...provider, metrics: { ...m, is_stale: true } }], DEFAULT_POLICY).selected, null);
  const empty = { ...provider, metrics: computeMetrics([], { agentId: '1', indexedThrough: now, computedAt: now }) };
  assert.equal(selectProvider([empty], DEFAULT_POLICY).selected, null);
  assert.equal(selectProvider([empty], { ...DEFAULT_POLICY, allow_unproven: true }).selected?.agent_id, '1');
  assert.equal(selectProvider([empty], { ...DEFAULT_POLICY, allow_unproven: true, max_mae_bps: 50 }).selected, null);
  for (const price of ['-1', 'garbage', '0']) assert.equal(selectProvider([{ ...provider, price }], DEFAULT_POLICY).selected, null);
  assert.equal(selectProvider([{ ...provider, network: 'hedera:mainnet' }], DEFAULT_POLICY).selected, null);
  for (const field of ['max_mae_bps', 'min_grade_coverage_pct', 'min_hit_rate_pct']) {
    for (const value of [NaN, Infinity, -1]) assert.throws(() => selectProvider([provider], { ...DEFAULT_POLICY, [field]: value }));
  }
});

test('duplicate events and post-watermark payment evidence do not inflate metrics', () => {
  const options = { agentId: '1', indexedThrough: now, computedAt: now };
  assert.equal(computeMetrics([...rows, ...rows], options).eligible_paid_count, 10);
  assert.equal(computeMetrics(rows.map(s => ({ ...s, payment_verified_at: now + 1 })), options).eligible_paid_count, 0);
  assert.throws(() => computeMetrics(rows, { ...options, indexedThrough: NaN }));
});

test('buyer rejects malformed provider metadata before selection', () => {
  const metrics = computeMetrics(rows, { agentId: '1', indexedThrough: now, computedAt: now });
  const provider = { agent_id: '1', active: true, price: '100', payTo: '0.0.1002', network: 'hedera:testnet', schema: 'defi.return_forecast.v1', asset: '0.0.0', feed_ids: ['eth'], metrics };
  assert.deepEqual(parseProviders([provider]), [provider]);
  for (const malformed of [null, {}, [null], [{ ...provider, agent_id: 1 }], [{ ...provider, feed_ids: 'eth' }],
    [{ ...provider, payTo: 'not-an-account' }], [{ ...provider, metrics: { ...metrics, reveal_pct: '80' } }],
    [{ ...provider, metrics: { ...metrics, reveal_pct: 70 } }]]) {
    assert.throws(() => parseProviders(malformed), /invalid_discovery_response/);
  }
});
