import { encodeDeployData, encodeFunctionData, getAddress, type Address, type Hex } from 'viem';
import type { Config } from '../../src/adapters/config.ts';
import { ETH_USD, POLICY, SCHEMA_ID } from '../../src/protocol/signal.ts';
import type { PythProArtifact, PythProInputs } from './pyth-pro-source.ts';

const HEDERA_WORMHOLE_CHAIN_ID = 50_048;
const VALID_TIME_PERIOD_SECONDS = 60n;
const asHex = (value: string): Hex => `0x${value.replace(/^0x/, '')}`;

export function receiverSetupCalldata(artifact: PythProArtifact, implementation: Address, inputs: PythProInputs) {
  return encodeFunctionData({
    abi: artifact.abi,
    functionName: 'setup',
    args: [
      implementation,
      inputs.config.wormholeConfig.initialGuardianSet.map((key) => getAddress(asHex(key))),
      HEDERA_WORMHOLE_CHAIN_ID,
      inputs.config.wormholeConfig.governanceChainId,
      asHex(inputs.config.wormholeConfig.governanceContract),
    ],
  });
}

export function wormholeReceiverInitCode(artifact: PythProArtifact, setup: Address, setupData: Hex) {
  return encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args: [setup, setupData] });
}

export function receiverRotationCalldata(artifact: PythProArtifact, rotation: Uint8Array) {
  return encodeFunctionData({
    abi: artifact.abi,
    functionName: 'submitNewGuardianSet',
    args: [asHex(Buffer.from(rotation).toString('hex'))],
  });
}

export function pythInitializerCalldata(artifact: PythProArtifact, receiver: Address, inputs: PythProInputs, anchorSequence: string) {
  return encodeFunctionData({
    abi: artifact.abi,
    functionName: 'initialize',
    args: [
      receiver,
      inputs.config.dataSources.map((source) => source.emitterChain),
      inputs.config.dataSources.map((source) => asHex(source.emitterAddress)),
      inputs.config.governanceDataSource.emitterChain,
      asHex(inputs.config.governanceDataSource.emitterAddress),
      BigInt(anchorSequence),
      VALID_TIME_PERIOD_SECONDS,
      0n,
    ],
  });
}

export function pythProxyInitCode(artifact: PythProArtifact, implementation: Address, initializer: Hex) {
  return encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args: [implementation, initializer] });
}

export function signalLedgerInitCode(artifact: PythProArtifact, config: Config, pyth: Address) {
  if (!config.registryAddress) throw new Error('registry_address_required');
  return encodeDeployData({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: [config.registryAddress, pyth, SCHEMA_ID, ETH_USD, POLICY.minLead, POLICY.maxLead, POLICY.issueTolerance, POLICY.oracleWindow, 100, 5],
  });
}
