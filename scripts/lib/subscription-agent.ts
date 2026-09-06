import { ContractExecuteTransaction, ContractId } from "@hiero-ledger/sdk";
import {
  encodeFunctionData,
  hexToBytes,
  keccak256,
  stringToHex,
  zeroAddress,
} from "viem";
import type { Config } from "../../src/adapters/config.ts";
import {
  accountAddress,
  artifact,
  publicClient,
} from "../../src/adapters/hedera.ts";
import { SCHEMA_ID } from "../../src/protocol/signal.ts";
import { subscriptionProviderMetadata } from "../../src/service/subscription-metadata.ts";

const SUBSCRIPTION_PAYMENT_MODE = 2;
export const SUBSCRIPTION_AGENT_REGISTRATION_MAX_FEE_TINYBARS = 300_000_000n;

export type SubscriptionAgentRecord = {
  id: string;
  registration_transaction_id?: string;
  metadata_uri: string;
  metadata_hash: string;
};

function unknownAgent(error: unknown) {
  let current = error;
  while (current && typeof current === "object") {
    const data = (current as { data?: { errorName?: unknown } }).data;
    if (data?.errorName === "UnknownAgent") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

async function agentRecord(config: Config, agentId: string) {
  if (!config.registryAddress) throw new Error("registry_not_configured");
  try {
    return (await publicClient(config).readContract({
      address: config.registryAddress,
      abi: artifact("AgentRegistry").abi,
      functionName: "getAgent",
      args: [BigInt(agentId)],
    })) as readonly unknown[];
  } catch (error) {
    if (unknownAgent(error)) return null;
    throw error;
  }
}

export async function availableSubscriptionAgentId(config: Config) {
  for (let candidate = 2n; candidate < 1_002n; candidate += 1n) {
    if (!(await agentRecord(config, candidate.toString())))
      return candidate.toString();
  }
  throw new Error("subscription_agent_id_range_exhausted");
}

export function prepareSubscriptionAgent(config: Config, agentId: string) {
  if (
    !config.registryAddress ||
    !config.subscriptionPayeeId ||
    !config.operatorId
  )
    throw new Error("subscription_registration_not_configured");
  const metadataUri = `${config.baseUrl}/v1/metadata/${agentId}`;
  const metadataHash = keccak256(
    stringToHex(JSON.stringify(subscriptionProviderMetadata(config))),
  );
  const data = encodeFunctionData({
    abi: artifact("AgentRegistry").abi,
    functionName: "registerAgent",
    args: [
      BigInt(agentId),
      zeroAddress,
      accountAddress(config.subscriptionPayeeId),
      metadataUri,
      metadataHash,
      SCHEMA_ID,
      SUBSCRIPTION_PAYMENT_MODE,
    ],
  });
  const transaction = new ContractExecuteTransaction()
    .setContractId(ContractId.fromEvmAddress(0, 0, config.registryAddress))
    .setGas(2_000_000)
    .setFunctionParameters(hexToBytes(data));
  return { transaction, metadataUri, metadataHash };
}

export async function verifySubscriptionAgent(
  config: Config,
  agentId: string,
  metadataUri: string,
  metadataHash: string,
  transactionId?: string,
): Promise<SubscriptionAgentRecord> {
  if (!config.operatorId || !config.subscriptionPayeeId)
    throw new Error("subscription_agent_receipt_mismatch");
  const registered = await agentRecord(config, agentId);
  if (
    !registered ||
    String(registered[0]).toLowerCase() !==
      accountAddress(config.operatorId).toLowerCase() ||
    String(registered[2]).toLowerCase() !==
      accountAddress(config.subscriptionPayeeId).toLowerCase() ||
    registered[4] !== metadataHash ||
    registered[5] !== metadataUri ||
    registered[6] !== SCHEMA_ID ||
    (Number(registered[7]) & SUBSCRIPTION_PAYMENT_MODE) === 0
  )
    throw new Error("subscription_agent_receipt_mismatch");
  return {
    id: agentId,
    ...(transactionId ? { registration_transaction_id: transactionId } : {}),
    metadata_uri: metadataUri,
    metadata_hash: metadataHash,
  };
}
