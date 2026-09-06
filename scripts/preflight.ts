import { loadConfig } from '../src/adapters/config.ts';
import { facilitator } from '../src/adapters/payment.ts';
import { publicClient } from '../src/adapters/hedera.ts';
import { historicalPrice, pythAbi } from '../src/adapters/pyth.ts';
import { ETH_USD } from '../src/protocol/signal.ts';
import { mkdirSync, writeFileSync } from 'node:fs';

const config = loadConfig();
const client = publicClient(config);
const timestamp = Math.floor(Date.now() / 1000) - 120;
const [feePayer, chainId, code, update] = await Promise.all([
  facilitator(config).feePayer(), client.getChainId(), client.getCode({ address: config.pythAddress }), historicalPrice(config, timestamp),
]);
if (chainId !== 296 || !code || code === '0x') throw new Error('Testnet/Pyth configuration mismatch');
const fee = await client.readContract({ address: config.pythAddress, abi: pythAbi, functionName: 'getUpdateFee', args: [update.updates] });
// Hedera's EVM uses tinybars internally; JSON-RPC transaction value uses 18-decimal weibars.
let oracleStatus: { compatible: boolean; result: string };
try {
  const simulation = await client.simulateContract({ address: config.pythAddress, abi: pythAbi, functionName: 'parsePriceFeedUpdatesUnique',
    args: [update.updates, [ETH_USD], BigInt(timestamp), BigInt(timestamp + 60)], value: fee * 10_000_000_000n });
  oracleStatus = { compatible: simulation.result.length === 1, result: 'passed_readonly_simulation' };
} catch (error) {
  const message = error && typeof error === 'object' && 'shortMessage' in error ? String(error.shortMessage) : '';
  oracleStatus = { compatible: false, result: message.includes('0x2acbe915') ? 'InvalidWormholeVaa' : 'oracle_simulation_failed' };
  process.exitCode = 2;
}
const result = { checked_at: new Date().toISOString(), network: config.network, chain_id: chainId, fee_payer: feePayer,
  pyth_address: config.pythAddress, feed_id: ETH_USD, historical_publish_time: update.publishTime, pyth_fee_tinybars: fee.toString(),
  historical_parse: oracleStatus.result, oracle_compatible: oracleStatus.compatible, scope: 'read-only integration preflight' };
mkdirSync('docs/evidence', { recursive: true });
writeFileSync('docs/evidence/preflight.json', JSON.stringify(result, null, 2) + '\n');
console.info(JSON.stringify(result));
