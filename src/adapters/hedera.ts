import { AccountId, Client, ContractExecuteTransaction, ContractId, Hbar, PrivateKey } from '@hiero-ledger/sdk';
import { createPublicClient, encodeFunctionData, http, type Abi, type Address, type Hex } from 'viem';
import { hederaTestnet } from 'viem/chains';
import { readFileSync } from 'node:fs';
import type { Config } from './config.ts';

export function artifact(name: 'AgentRegistry' | 'SignalLedger') {
  return JSON.parse(readFileSync(`artifacts/contracts/${name}.sol/${name}.json`, 'utf8')) as { abi: Abi; bytecode: Hex };
}
export const accountAddress = (id: string): Address => `0x${AccountId.fromString(id).toSolidityAddress()}`;
export const publicClient = (config: Config) => createPublicClient({ chain: hederaTestnet, transport: http(config.rpcUrl, { timeout: 20000, retryCount: 1 }) });

export function operatorClient(config: Config) {
  if (!config.operatorId || !config.operatorKey) throw new Error('Operator credentials required');
  const client = Client.forTestnet().setOperator(config.operatorId, PrivateKey.fromStringECDSA(config.operatorKey));
  client.setDefaultMaxTransactionFee(new Hbar(3));
  client.setMaxAttempts(3);
  client.setRequestTimeout(30000);
  return client;
}

export async function executeContract(config: Config, address: Address, abi: Abi, name: string, args: readonly unknown[], valueTinybars = 0n) {
  const client = operatorClient(config);
  try {
    const data = encodeFunctionData({ abi, functionName: name, args });
    const transaction = new ContractExecuteTransaction().setContractId(ContractId.fromEvmAddress(0, 0, address))
      .setGas(2_000_000).setFunctionParameters(Buffer.from(data.slice(2), 'hex'))
      .setPayableAmount(Hbar.fromTinybars(valueTinybars.toString()));
    const response = await transaction.execute(client);
    await response.getReceipt(client);
    return { transaction_id: response.transactionId.toString() };
  } finally { client.close(); }
}
