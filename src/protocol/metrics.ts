import { POLICY, SCHEMA } from './signal.ts';
import type { Grade } from './grade.ts';
import { isDeepStrictEqual } from 'node:util';

export type Sample = {
  request_id: string; agent_id: string; schema: string; price_feed_id: string;
  payment_mode: 'x402' | 'subscription'; payment_status: 'verified' | 'pending' | 'invalid';
  payer: string; committed_at: number; target_time: number; revealed_at: number | null; payment_verified_at: number | null;
  grade: (Grade & { graded_at: number }) | null;
  oracle_status: 'pending' | 'excluded' | 'unavailable'; oracle_status_at: number | null;
};
type Options = { agentId: string; indexedThrough: number; computedAt: number; feed?: string; minHorizon?: number; maxHorizon?: number };
const pct = (n: number, d: number) => d === 0 ? null : 100 * n / d;

function summarize(rows: readonly Sample[], t: number) {
  const revealed = rows.filter(s => s.revealed_at !== null && s.revealed_at <= t);
  const graded = revealed.filter(s => s.grade && s.grade.graded_at <= t);
  const excluded = revealed.filter(s => !s.grade && s.oracle_status === 'excluded' && s.oracle_status_at !== null && s.oracle_status_at <= t).length;
  const unavailable = revealed.filter(s => !s.grade && s.oracle_status === 'unavailable' && s.oracle_status_at !== null && s.oracle_status_at <= t).length;
  return {
    eligible_paid_count: rows.length, revealed_count: revealed.length, unrevealed_count: rows.length - revealed.length,
    reveal_pct: pct(revealed.length, rows.length), graded_count: graded.length,
    grade_coverage_pct: pct(graded.length, rows.length),
    directional_hit_rate_pct: pct(graded.filter(s => s.grade!.direction_correct).length, graded.length),
    mean_absolute_error_bps: graded.length ? graded.reduce((sum, s) => sum + s.grade!.absolute_error_bps, 0) / graded.length : null,
    oracle_excluded_count: excluded, oracle_unavailable_count: unavailable,
    grade_pending_count: revealed.length - graded.length - excluded - unavailable,
    unique_paying_wallets: new Set(rows.map(s => s.payer)).size,
  };
}

export function computeMetrics(samples: readonly Sample[], o: Options) {
  if (![o.indexedThrough, o.computedAt].every(n => Number.isSafeInteger(n) && n >= 0) || o.indexedThrough > o.computedAt) throw new Error('invalid_metrics_time');
  if ([o.minHorizon, o.maxHorizon].some(n => n !== undefined && (!Number.isSafeInteger(n) || n < 0))) throw new Error('invalid_horizon');
  const unique = new Map(samples.map(s => [s.request_id, s]));
  if (samples.some(s => !isDeepStrictEqual(s, unique.get(s.request_id)))) throw new Error('conflicting_sample_evidence');
  const t = o.indexedThrough;
  const scope = [...unique.values()].filter(s => s.agent_id === o.agentId && s.schema === SCHEMA && s.payment_mode === 'x402'
    && s.committed_at <= t && (!o.feed || s.price_feed_id === o.feed)
    && (o.minHorizon === undefined || s.target_time - s.committed_at >= o.minHorizon)
    && (o.maxHorizon === undefined || s.target_time - s.committed_at <= o.maxHorizon));
  const paid = scope.filter(s => s.payment_status === 'verified' && s.payment_verified_at !== null && s.payment_verified_at <= t);
  const lifetime = paid.filter(s => s.target_time <= t - POLICY.revealGrace);
  const eligible = lifetime.filter(s => s.target_time >= t - POLICY.historyWindow);
  const summary = summarize(eligible, t);
  return {
    metric_version: '1', schema: SCHEMA, payment_mode: 'x402' as const,
    feed_filter: o.feed ?? null, horizon_filter: { min: o.minHorizon ?? null, max: o.maxHorizon ?? null },
    window_start: t - POLICY.historyWindow, window_end: t - POLICY.revealGrace,
    reveal_grace_seconds: POLICY.revealGrace, indexed_through: t, computed_at: o.computedAt,
    lag_seconds: Math.max(0, o.computedAt - t), is_stale: t === 0 || o.computedAt - t > POLICY.freshness,
    ...summary, pending_expiry_or_grace_count: paid.length - lifetime.length,
    payment_verification_pending_count: scope.filter(s => s.payment_status === 'pending').length,
    invalid_payment_reference_count: scope.filter(s => s.payment_status === 'invalid').length,
    history_status: summary.eligible_paid_count < 5 ? 'insufficient_history' : 'available',
    lifetime: summarize(lifetime, t), evidence_url: `/v1/agents/${o.agentId}/signals`,
  };
}
export type Metrics = ReturnType<typeof computeMetrics>;
