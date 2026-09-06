import { parseArgs } from 'node:util';
import { keccak256, stringToHex, zeroAddress } from 'viem';
import { loadConfig } from '../src/adapters/config.ts';
import { accountAddress, artifact, executeContract, publicClient } from '../src/adapters/hedera.ts';
import { providerMetadata } from '../src/service/metadata.ts';

const { values } = parseArgs({ options: {
  'agent-id': { type: 'string' }, active: { type: 'string' }, gateway: { type: 'string' },
  payee: { type: 'string' }, metadata: { type: 'boolean' }, status: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
} });
const actions = [values.active !== undefined, values.gateway !== undefined, values.payee !== undefined, values.metadata === true, values.status === true].filter(Boolean);
if (actions.length !== 1) throw new Error('Choose exactly one of --status, --active, --gateway, --payee, or --metadata');

const config = loadConfig();
if (!config.registryAddress) throw new Error('Registry configuration required');
const agentId = values['agent-id'] ?? config.agentId;
if (!/^[1-9][0-9]{0,77}$/.test(agentId) || BigInt(agentId) >= 2n ** 256n) throw new Error('Invalid agent ID');
const registryAbi = artifact('AgentRegistry').abi;

if (values.status) {
  const result = await publicClient(config).readContract({ address: config.registryAddress, abi: registryAbi, functionName: 'getAgent', args: [BigInt(agentId)] }) as readonly unknown[];
  console.info(JSON.stringify({ agent_id: agentId, owner: result[0], gateway: result[1], payee: result[2], active: result[3],
    metadata_hash: result[4], metadata_uri: result[5], schema_id: result[6], payment_modes: String(result[7]), registered_at: Number(result[8]) }));
  process.exit(0);
}
if (!config.operatorId || !config.operatorKey) throw new Error('Operator configuration required');

let functionName: string;
let args: readonly unknown[];
let action: string;
if (values.active !== undefined) {
  if (!['true', 'false'].includes(values.active)) throw new Error('--active must be true or false');
  functionName = 'setActive'; args = [BigInt(agentId), values.active === 'true']; action = values.active === 'true' ? 'activated' : 'deactivated';
} else if (values.gateway !== undefined) {
  functionName = 'setGateway'; args = [BigInt(agentId), values.gateway === 'none' ? zeroAddress : accountAddress(values.gateway)]; action = 'gateway_updated';
} else if (values.payee !== undefined) {
  functionName = 'setPayee'; args = [BigInt(agentId), accountAddress(values.payee)]; action = 'payee_updated';
} else {
  if (agentId !== config.agentId) throw new Error('--metadata is available only for the configured provider');
  const metadata = providerMetadata(config);
  functionName = 'setMetadata';
  args = [BigInt(agentId), `${config.baseUrl}/v1/metadata/${agentId}`, keccak256(stringToHex(JSON.stringify(metadata)))];
  action = 'metadata_updated';
}

if (values['dry-run']) {
  console.info(JSON.stringify({ agent_id: agentId, action, dry_run: true }));
  process.exit(0);
}
const result = await executeContract(config, config.registryAddress, registryAbi, functionName, args);
console.info(JSON.stringify({ agent_id: agentId, action, transaction_id: result.transaction_id }));
