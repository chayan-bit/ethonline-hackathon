import { existsSync, readFileSync } from 'node:fs';
import { isAddress, type Address } from 'viem';

export type Config = ReturnType<typeof loadConfig>;
const DEFAULTS = {
  HEDERA_RPC_URL: 'https://testnet.hashio.io/api', MIRROR_URL: 'https://testnet.mirrornode.hedera.com/api/v1',
  FACILITATOR_URL: 'https://api.testnet.blocky402.com', HERMES_URL: 'https://hermes.pyth.network',
  PYTH_ADDRESS: '0xA2aa501b19aff244D90cc15a4Cf739D2725B5729',
};

export function loadConfig(env = process.env) {
  if ((env.HEDERA_NETWORK ?? 'hedera:testnet') !== 'hedera:testnet') throw new Error('Only Hedera testnet is supported');
  const deployment = existsSync('deployments/testnet.json') ? JSON.parse(readFileSync('deployments/testnet.json', 'utf8')) : {};
  const url = (name: keyof typeof DEFAULTS) => {
    const result = new URL(env[name] ?? DEFAULTS[name]);
    if (result.protocol !== 'https:' || result.username || result.password) throw new Error(`Invalid ${name}`);
    return result.href.replace(/\/$/, '');
  };
  const address = (name: string, fallback?: string): Address | undefined => {
    const value = env[name] || fallback;
    if (value && !isAddress(value)) throw new Error(`Invalid ${name}`);
    return value as Address | undefined;
  };
  const account = (name: string, value?: string) => {
    if (value && !/^0\.0\.[1-9][0-9]{0,18}$/.test(value)) throw new Error(`Invalid ${name}`);
    return value;
  };
  const baseUrl = new URL(env.PUBLIC_BASE_URL ?? 'http://localhost:3000');
  if (baseUrl.protocol !== 'https:' && !(baseUrl.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(baseUrl.hostname))) throw new Error('Public service requires HTTPS');
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const price = env.PRICE_TINYBARS ?? '100000';
  if (!/^[1-9][0-9]{0,17}$/.test(price)) throw new Error('Invalid PRICE_TINYBARS');
  const ledgerDeploymentBlock = Number(env.LEDGER_DEPLOYMENT_BLOCK || deployment.ledger?.block);
  if (address('LEDGER_ADDRESS', deployment.ledger?.address) && (!Number.isSafeInteger(ledgerDeploymentBlock) || ledgerDeploymentBlock < 0)) throw new Error('Invalid LEDGER_DEPLOYMENT_BLOCK');
  return {
    network: 'hedera:testnet' as const, rpcUrl: url('HEDERA_RPC_URL'), mirrorUrl: url('MIRROR_URL'),
    facilitatorUrl: url('FACILITATOR_URL'), hermesUrl: url('HERMES_URL'), pythApiKey: env.PYTH_API_KEY, pythAddress: address('PYTH_ADDRESS', DEFAULTS.PYTH_ADDRESS)!,
    operatorId: account('HEDERA_OPERATOR_ID', env.HEDERA_OPERATOR_ID), operatorKey: env.HEDERA_OPERATOR_KEY,
    payeeId: account('HEDERA_PAYEE_ID', env.HEDERA_PAYEE_ID || env.HEDERA_OPERATOR_ID),
    buyerId: account('HEDERA_BUYER_ID', env.HEDERA_BUYER_ID), buyerKey: env.HEDERA_BUYER_KEY,
    registryAddress: address('REGISTRY_ADDRESS', deployment.registry?.address), ledgerAddress: address('LEDGER_ADDRESS', deployment.ledger?.address), ledgerDeploymentBlock,
    topicId: env.HCS_TOPIC_ID || deployment.topic_id, baseUrl: baseUrl.origin, port, price,
    agentId: '1', workerEnabled: env.WORKER_ENABLED !== 'false', databasePath: env.DATABASE_PATH ?? 'data/market.db',
  };
}
