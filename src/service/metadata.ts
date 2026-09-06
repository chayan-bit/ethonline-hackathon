import { ETH_USD, SCHEMA } from '../protocol/signal.ts';
import type { Config } from '../adapters/config.ts';

export function providerMetadata(config: Config) {
  return {
    agent_id: config.agentId, name: 'ETH Momentum', description: 'A transparent 60-second momentum baseline for ETH/USD return forecasts.',
    schema: SCHEMA, model_version: 'momentum60.v1', distribution: 'non-exclusive',
    endpoint: `${config.baseUrl}/v1/signals`, agent_card_url: `${config.baseUrl}/.well-known/agent-card.json`,
    network: config.network, asset: '0.0.0', price: config.price, payTo: config.payeeId,
    payment_modes: ['x402'], feed_ids: [ETH_USD], min_target_lead: 300, max_target_lead: 3600,
    metrics_url: `${config.baseUrl}/v1/agents/${config.agentId}`, protocol_fee_pct: 0,
  };
}
