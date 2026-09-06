import { Ajv } from 'ajv';
import { parseAbi, type Hex } from 'viem';
import { calculateGrade, type Price } from '../protocol/grade.ts';
import { ETH_USD, SCHEMA, hashSignal, parseSignal, randomId } from '../protocol/signal.ts';
import type { BuyRequest, Prepared } from '../service/gateway.ts';
import type { Config } from './config.ts';
import { fetchJson, record } from './http.ts';

export const pythAbi = parseAbi([
  'function getUpdateFee(bytes[] updateData) view returns (uint256)',
  'function parsePriceFeedUpdatesUnique(bytes[] updateData, bytes32[] priceIds, uint64 minPublishTime, uint64 maxPublishTime) payable returns ((bytes32 id,(int64 price,uint64 conf,int32 expo,uint256 publishTime) price,(int64 price,uint64 conf,int32 expo,uint256 publishTime) emaPrice)[])',
]);
const validatePrice = new Ajv().compile({ type: 'object', required: ['price','conf','expo','publish_time'], properties: {
  price: { type: 'string', pattern: '^-?[0-9]{1,19}$' }, conf: { type: 'string', pattern: '^[0-9]{1,20}$' },
  expo: { type: 'integer', minimum: -18, maximum: 18 }, publish_time: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
} });

export async function historicalPrice(config: Config, timestamp: number): Promise<{ price: Price; publishTime: number; updates: Hex[] }> {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('invalid_oracle_timestamp');
  const url = new URL(`${config.hermesUrl}/v2/updates/price/${timestamp}`);
  url.searchParams.set('ids[]', ETH_USD.slice(2));
  url.searchParams.set('encoding', 'hex');
  if (!config.pythApiKey) throw new Error('oracle_api_key_required');
  const response = record(await fetchJson(url, { headers: { Authorization: `Bearer ${config.pythApiKey}` } }));
  const parsed = response.parsed;
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error('oracle_unavailable');
  const item = record(parsed[0]);
  const p = record(item.price);
  const binary = record(response.binary);
  if (item.id !== ETH_USD.slice(2) || !validatePrice(p) || !Array.isArray(binary.data) || binary.encoding !== 'hex'
    || !binary.data.length || binary.data.some(d => typeof d !== 'string' || !/^[0-9a-f]+$/i.test(d) || d.length % 2)) throw new Error('invalid_oracle_response');
  return { price: { price: BigInt(String(p.price)), conf: BigInt(String(p.conf)), expo: Number(p.expo) }, publishTime: Number(p.publish_time), updates: binary.data.map(d => `0x${d}` as Hex) };
}

export async function generateForecast(config: Config, request: BuyRequest): Promise<Prepared> {
  const timestamp = Math.floor(Date.now() / 1000);
  const [before, after] = await Promise.all([historicalPrice(config, timestamp - 61), historicalPrice(config, timestamp - 1)]);
  const issuedAt = Math.floor(Date.now() / 1000);
  if (before.publishTime >= after.publishTime || after.publishTime > issuedAt || after.publishTime < issuedAt - 30) throw new Error('oracle_unavailable: observation timing');
  const predicted = calculateGrade(0, before.price, after.price).actual_return_bps;
  const signal = parseSignal({ schema: SCHEMA, request_id: request.request_id, agent_id: request.agent_id, price_feed_id: ETH_USD,
    issued_at: issuedAt, target_time: request.target_time, predicted_return_bps: predicted, model_version: 'momentum60.v1', distribution: 'non-exclusive' });
  const salt = randomId();
  return { signal, salt, hash: hashSignal(signal, salt) };
}
