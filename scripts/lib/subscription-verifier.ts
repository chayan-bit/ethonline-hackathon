import { hexToBytes, keccak256, type Address } from "viem";
import type { Config } from "../../src/adapters/config.ts";
import {
  accountAddress,
  artifact,
  publicClient,
} from "../../src/adapters/hedera.ts";
import {
  HSS_SYSTEM_ADDRESS,
  HTS_SYSTEM_ADDRESS,
} from "../../src/protocol/subscription-deployment.ts";
import { ETH_USD, POLICY, SCHEMA_ID } from "../../src/protocol/signal.ts";
import { maskRuntimeImmutables } from "../../src/protocol/pyth-deployment.ts";
import { loadSubscriptionArtifacts } from "./subscription-source.ts";

export async function verifySubscriptionContracts(
  config: Config,
  vaultAddress: Address,
  ledgerAddress: Address,
  tokenAddress: Address,
  pythAddress: Address,
) {
  if (!config.registryAddress || !config.operatorId)
    throw new Error("subscription_verification_config_missing");
  const chain = publicClient(config);
  const artifacts = loadSubscriptionArtifacts();
  const vaultAbi = artifacts.SubscriptionVault.abi;
  const ledgerAbi = artifacts.SubscriptionLedger.abi;
  const read = (address: Address, abi: typeof vaultAbi, functionName: string) =>
    chain.readContract({ address, abi, functionName });
  const [vaultCode, ledgerCode, ...values] = await Promise.all([
    chain.getCode({ address: vaultAddress }),
    chain.getCode({ address: ledgerAddress }),
    ...["registry", "hts", "scheduler", "token", "admin", "schemaId"].map(
      (name) => read(vaultAddress, vaultAbi, name),
    ),
    ...[
      "registry",
      "subscriptionVault",
      "pyth",
      "schemaId",
      "allowedPriceFeedId",
      "horizon",
      "issuanceTolerance",
      "oracleWindow",
      "maxConfidenceBps",
      "neutralBandBps",
    ].map((name) => read(ledgerAddress, ledgerAbi, name)),
  ]);
  const expected = [
    config.registryAddress,
    HTS_SYSTEM_ADDRESS,
    HSS_SYSTEM_ADDRESS,
    tokenAddress,
    accountAddress(config.operatorId),
    SCHEMA_ID,
    config.registryAddress,
    vaultAddress,
    pythAddress,
    SCHEMA_ID,
    ETH_USD,
    900n,
    BigInt(POLICY.issueTolerance),
    BigInt(POLICY.oracleWindow),
    100n,
    5n,
  ];
  if (
    !vaultCode ||
    !ledgerCode ||
    !runtimeMatches(vaultCode, artifacts.SubscriptionVault) ||
    !runtimeMatches(ledgerCode, artifacts.SubscriptionLedger) ||
    values.some(
      (value, index) =>
        String(value).toLowerCase() !== String(expected[index]).toLowerCase(),
    )
  )
    throw new Error("subscription_deployed_configuration_mismatch");
  return {
    subscription_vault: keccak256(vaultCode),
    subscription_ledger: keccak256(ledgerCode),
  };
}

function runtimeMatches(
  runtime: `0x${string}`,
  artifact: ReturnType<typeof loadSubscriptionArtifacts>["SubscriptionVault"],
) {
  const actual = hexToBytes(runtime);
  const expected = hexToBytes(artifact.deployedBytecode);
  return (
    actual.length === expected.length &&
    keccak256(maskRuntimeImmutables(actual, artifact.immutableRanges)) ===
      keccak256(maskRuntimeImmutables(expected, artifact.immutableRanges))
  );
}
