import { SCHEMA } from './signal.ts';
import type { Metrics } from './metrics.ts';
export type Provider = { agent_id: string; active: boolean; price: string; network: string; schema: string; asset: string; feed_ids: string[]; metrics: Metrics };
export type DiscoveryPolicy = {
  min_samples: number; min_reveal_pct: number; max_price: string; allow_unproven: boolean;
  feed?: string; max_mae_bps?: number; min_grade_coverage_pct?: number; min_hit_rate_pct?: number;
};
export const DEFAULT_POLICY: DiscoveryPolicy = Object.freeze({ min_samples: 5, min_reveal_pct: 80, max_price: '10000000', allow_unproven: false });

export function parseProviders(input: unknown): Provider[] {
  if (!Array.isArray(input) || input.length > 1_000) throw new Error('invalid_discovery_response');
  for (const value of input) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_discovery_response');
    const p = value as Record<string, unknown>;
    const m = p.metrics as Record<string, unknown> | null;
    const count = (name: string) => Number.isSafeInteger(m?.[name]) && Number(m?.[name]) >= 0;
    const percentage = (name: string) => m?.[name] === null || (typeof m?.[name] === 'number' && Number.isFinite(m[name]) && Number(m[name]) >= 0 && Number(m[name]) <= 100);
    const eligible = Number(m?.eligible_paid_count);
    const revealed = Number(m?.revealed_count);
    const graded = Number(m?.graded_count);
    if (typeof p.agent_id !== 'string' || !/^[1-9][0-9]{0,77}$/.test(p.agent_id) || typeof p.active !== 'boolean' || typeof p.price !== 'string'
      || typeof p.network !== 'string' || typeof p.schema !== 'string' || typeof p.asset !== 'string'
      || !Array.isArray(p.feed_ids) || p.feed_ids.length > 100 || p.feed_ids.some(feed => typeof feed !== 'string')
      || !m || Array.isArray(m) || typeof m.is_stale !== 'boolean' || !count('eligible_paid_count') || !count('revealed_count')
      || !count('graded_count') || revealed > eligible || graded > eligible
      || !percentage('reveal_pct') || !percentage('grade_coverage_pct') || !percentage('directional_hit_rate_pct')
      || m.reveal_pct !== (eligible === 0 ? null : 100 * revealed / eligible)
      || m.grade_coverage_pct !== (eligible === 0 ? null : 100 * graded / eligible)
      || !(m.mean_absolute_error_bps === null || (typeof m.mean_absolute_error_bps === 'number' && Number.isFinite(m.mean_absolute_error_bps) && m.mean_absolute_error_bps >= 0))) {
      throw new Error('invalid_discovery_response');
    }
  }
  return input as Provider[];
}

function rejectionReasons(p: Provider, policy: DiscoveryPolicy): string[] {
  if (!/^[1-9][0-9]{0,18}$/.test(p.price)) return ['invalid_price'];
  const m = p.metrics;
  const unproven = m.eligible_paid_count < policy.min_samples;
  const percentageFails = m.eligible_paid_count === 0 || m.revealed_count * 100 < policy.min_reveal_pct * m.eligible_paid_count;
  return [
    !p.active && 'inactive', p.schema !== SCHEMA && 'unsupported_schema', p.asset !== '0.0.0' && 'unsupported_asset', p.network !== 'hedera:testnet' && 'unsupported_network',
    policy.feed && !p.feed_ids.includes(policy.feed) && 'unsupported_feed',
    BigInt(p.price) > BigInt(policy.max_price) && 'price_cap', m.is_stale && 'stale_metrics',
    unproven && !policy.allow_unproven && 'insufficient_history',
    !(unproven && policy.allow_unproven) && percentageFails && 'low_reveal',
    policy.max_mae_bps !== undefined && (m.mean_absolute_error_bps === null || m.mean_absolute_error_bps > policy.max_mae_bps) && 'quality_mae',
    policy.min_grade_coverage_pct !== undefined && (m.grade_coverage_pct === null || m.graded_count * 100 < policy.min_grade_coverage_pct * m.eligible_paid_count) && 'grade_coverage',
    policy.min_hit_rate_pct !== undefined && (m.directional_hit_rate_pct === null || m.directional_hit_rate_pct < policy.min_hit_rate_pct) && 'quality_hit_rate',
  ].filter((r): r is string => typeof r === 'string');
}

export function selectProvider(providers: readonly Provider[], policy: DiscoveryPolicy) {
  if (!Number.isSafeInteger(policy.min_samples) || policy.min_samples < 0 || !Number.isFinite(policy.min_reveal_pct)
    || policy.min_reveal_pct < 0 || policy.min_reveal_pct > 100 || !/^\d+$/.test(policy.max_price)) throw new Error('invalid_policy');
  for (const value of [policy.max_mae_bps, policy.min_grade_coverage_pct, policy.min_hit_rate_pct]) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error('invalid_policy');
  }
  if ([policy.min_grade_coverage_pct, policy.min_hit_rate_pct].some(n => n !== undefined && n > 100)) throw new Error('invalid_policy');
  const decisions = providers.map(p => ({ provider: p, reasons: rejectionReasons(p, policy) }));
  const eligible = decisions.filter(d => d.reasons.length === 0).map(d => d.provider).sort((a, b) => {
    const priceDiff = BigInt(a.price) - BigInt(b.price);
    if (priceDiff) return priceDiff < 0n ? -1 : 1;
    return (b.metrics.reveal_pct ?? -1) - (a.metrics.reveal_pct ?? -1) || a.agent_id.localeCompare(b.agent_id, 'en', { numeric: true });
  });
  return { selected: eligible[0] ?? null, decisions, status: eligible.length ? 'selected' : 'no_eligible_provider' };
}
