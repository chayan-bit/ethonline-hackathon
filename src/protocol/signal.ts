import { randomBytes } from 'node:crypto';
import { Ajv } from 'ajv';
import { encodeAbiParameters, keccak256, parseAbiParameters, stringToHex, type Hex } from 'viem';

export const SCHEMA = 'defi.return_forecast.v1';
export const ETH_USD: Hex = '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace';
export const SCHEMA_ID = keccak256(stringToHex(SCHEMA));
export const POLICY = Object.freeze({ minLead: 300, maxLead: 3600, issueTolerance: 30, oracleWindow: 60, revealGrace: 300, historyWindow: 30 * 86400, freshness: 120 });
export type Signal = {
  schema: typeof SCHEMA; request_id: Hex; agent_id: string; price_feed_id: Hex;
  issued_at: number; target_time: number; predicted_return_bps: number;
  model_version: string; distribution: 'non-exclusive';
};
export const signalSchema = {
  $id: SCHEMA, type: 'object', additionalProperties: false,
  required: ['schema', 'request_id', 'agent_id', 'price_feed_id', 'issued_at', 'target_time', 'predicted_return_bps', 'model_version', 'distribution'],
  properties: {
    schema: { const: SCHEMA }, request_id: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' },
    agent_id: { type: 'string', pattern: '^[1-9][0-9]{0,77}$' },
    price_feed_id: { enum: [ETH_USD] },
    issued_at: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    target_time: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    predicted_return_bps: { type: 'integer', minimum: -10000, maximum: 100000 },
    model_version: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,64}$' },
    distribution: { const: 'non-exclusive' },
  },
} as const;
const validate = new Ajv({ allErrors: true }).compile(signalSchema);

export function parseSignal(input: unknown): Signal {
  if (!validate(input)) throw new Error('invalid_signal: schema validation failed');
  const s = input as Signal;
  if (BigInt(s.agent_id) >= 2n ** 256n || s.target_time <= s.issued_at) throw new Error('invalid_signal: identifier or timing');
  return { ...s, request_id: s.request_id.toLowerCase() as Hex };
}

export function encodeSignal(signal: Signal, salt: Hex): Hex {
  const s = parseSignal(signal);
  if (!/^0x[0-9a-fA-F]{64}$/.test(salt)) throw new Error('invalid_signal: salt');
  return encodeAbiParameters(
    parseAbiParameters('bytes32, bytes32, uint256, bytes32, uint64, uint64, int32, bytes32, uint8, bytes32'),
    [SCHEMA_ID, s.request_id, BigInt(s.agent_id), s.price_feed_id, BigInt(s.issued_at), BigInt(s.target_time), s.predicted_return_bps, keccak256(stringToHex(s.model_version)), 1, salt],
  );
}

export const hashSignal = (s: Signal, salt: Hex): Hex => keccak256(encodeSignal(s, salt));
export const randomId = (): Hex => `0x${randomBytes(32).toString('hex')}`;

export function assertCommitTiming(s: Signal, now: number): void {
  parseSignal(s);
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('invalid_signal: consensus time');
  const lead = s.target_time - now;
  if (Math.abs(s.issued_at - now) > POLICY.issueTolerance || lead < POLICY.minLead || lead > POLICY.maxLead) {
    throw new Error('invalid_signal: commitment timing');
  }
}
