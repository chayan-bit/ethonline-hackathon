import { ContractCreateFlow, TopicCreateTransaction, Hbar } from '@hiero-ledger/sdk';
import { encodeDeployData, keccak256, stringToHex, zeroAddress, type Address } from 'viem';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { loadConfig } from '../src/adapters/config.ts';
import { artifact, operatorClient, accountAddress, executeContract, publicClient } from '../src/adapters/hedera.ts';
import { ETH_USD, POLICY, SCHEMA_ID } from '../src/protocol/signal.ts';
import { providerMetadata } from '../src/service/metadata.ts';

type Deployment = { network: string; registry?: { address: Address; transaction_id: string }; ledger?: { address: Address; transaction_id: string; block?: number }; topic_id?: string; agent_transaction_id?: string };
const path = 'deployments/testnet.json';
function save(value: Deployment) {
  mkdirSync('deployments', { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2) + '\n');
  renameSync(`${path}.tmp`, path);
}

async function main() {
  const config = loadConfig();
  if (!config.operatorId) throw new Error('Operator account required');
  let state: Deployment = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { network: config.network };
  const client = operatorClient(config);
  // File uploads are billed separately under Hedera's current fee schedule.
  client.setDefaultMaxTransactionFee(new Hbar(20));
  const deploy = async (name: 'AgentRegistry' | 'SignalLedger', args: unknown[]) => {
    const data = artifact(name);
    const tx = new ContractCreateFlow().setGas(3_000_000).setBytecode(encodeDeployData({ ...data, args }).slice(2));
    const response = await tx.execute(client);
    const receipt = await response.getReceipt(client);
    if (!receipt.contractId) throw new Error('Missing contract receipt');
    return { address: `0x${receipt.contractId.toSolidityAddress()}` as Address, transaction_id: response.transactionId.toString() };
  };
  try {
    if (!state.registry) { state = { ...state, registry: await deploy('AgentRegistry', []) }; save(state); }
    if (!state.ledger) {
      const ledger = await deploy('SignalLedger', [state.registry!.address, config.pythAddress, SCHEMA_ID, ETH_USD, POLICY.minLead, POLICY.maxLead, POLICY.issueTolerance, POLICY.oracleWindow, 100, 5]);
      state = { ...state, ledger: { ...ledger, block: Number(await publicClient(config).getBlockNumber()) } };
      save(state);
    }
    if (!state.topic_id) {
      const response = await new TopicCreateTransaction().setTopicMemo('Verifiable Signal Market: public commitment receipts').execute(client);
      const receipt = await response.getReceipt(client);
      if (!receipt.topicId) throw new Error('Missing HCS topic receipt');
      state = { ...state, topic_id: receipt.topicId.toString() }; save(state);
    }
    const metadata = providerMetadata(config);
    const metadataHash = keccak256(stringToHex(JSON.stringify(metadata)));
    const registryAbi = artifact('AgentRegistry').abi;
    if (!state.agent_transaction_id) {
      const result = await executeContract(config, state.registry!.address, registryAbi, 'registerAgent', [
        BigInt(config.agentId), zeroAddress, accountAddress(config.payeeId!), `${config.baseUrl}/v1/metadata/${config.agentId}`, metadataHash, SCHEMA_ID, 1,
      ]);
      state = { ...state, agent_transaction_id: result.transaction_id }; save(state);
    } else if (process.argv.includes('--update-metadata')) {
      await executeContract(config, state.registry!.address, registryAbi, 'setMetadata', [BigInt(config.agentId), `${config.baseUrl}/v1/metadata/${config.agentId}`, metadataHash]);
    }
    const chain = publicClient(config);
    if ((await chain.getCode({ address: state.ledger!.address })) === '0x') throw new Error('Deployed ledger code not visible');
    console.info(JSON.stringify({ ...state, oracle: config.pythAddress, feed: ETH_USD, source_verification: 'pending' }));
  } finally { client.close(); }
}

main().catch(error => {
  const status = error && typeof error === 'object' && 'status' in error ? String(error.status) : 'no status';
  console.error(`Deployment stopped: ${error instanceof Error ? error.name : 'unknown error'} (${status}). Check the saved public deployment record before retrying.`);
  process.exitCode = 1;
});
