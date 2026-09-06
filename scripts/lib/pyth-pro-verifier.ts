import { getAddress, hexToBytes, keccak256, type Address, type Hex } from 'viem';
import type { Config } from '../../src/adapters/config.ts';
import { publicClient } from '../../src/adapters/hedera.ts';
import { historicalPrice } from '../../src/adapters/pyth.ts';
import { corruptAccumulatorSignature, isInvalidWormholeVaa, maskRuntimeImmutables } from '../../src/protocol/pyth-deployment.ts';
import { ETH_USD, POLICY, SCHEMA_ID } from '../../src/protocol/signal.ts';
import { pythProManifest, sha256, type ImmutableRange, type PythProArtifact, type PythProInputs } from './pyth-pro-source.ts';

const HEDERA_WORMHOLE_CHAIN_ID = 50_048;
const VALID_TIME_PERIOD_SECONDS = 60n;
const HISTORICAL_PROOF_TIME = 1_788_652_441;
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as Hex;

const asHex = (value: string): Hex => `0x${value.replace(/^0x/, '')}`;
const now = () => Math.floor(Date.now() / 1_000);

function proxyImplementation(storage: Hex | undefined) {
  if (!storage || storage.length !== 66) throw new Error('invalid_implementation_slot');
  return getAddress(`0x${storage.slice(-40)}`);
}

async function verifyRuntime(config: Config, address: Address, artifact: PythProArtifact) {
  const code = await publicClient(config).getCode({ address });
  if (!code) throw new Error(`deployed_runtime_missing:${address}`);
  const actual = hexToBytes(code);
  const expected = hexToBytes(artifact.deployedBytecode);
  if (
    actual.length !== expected.length ||
    keccak256(maskRuntimeImmutables(actual, artifact.immutableRanges)) !== keccak256(maskRuntimeImmutables(expected, artifact.immutableRanges))
  ) {
    throw new Error(`deployed_runtime_mismatch:${address}`);
  }
  return { code, hash: keccak256(code) };
}

function verifyImmutableAddress(code: Hex, ranges: ImmutableRange[], address: Address) {
  const runtime = hexToBytes(code);
  const expected = address.toLowerCase().slice(2).padStart(64, '0');
  if (ranges.some((range) => range.length !== 32 || Buffer.from(runtime.subarray(range.start, range.start + range.length)).toString('hex') !== expected)) {
    throw new Error('implementation_self_reference_mismatch');
  }
}

export async function verifyPythProStack(
  config: Config,
  artifacts: Record<string, PythProArtifact>,
  inputs: PythProInputs,
  addresses: Record<string, Address>,
  anchorSequence: string,
) {
  const chain = publicClient(config);
  const runtimeHashes: Record<string, Hex> = {};
  for (const name of ['ReceiverSetup', 'ReceiverImplementationHalf', 'WormholeReceiver', 'PythUpgradable', 'ERC1967Proxy', 'SignalLedger']) {
    const address = addresses[name];
    if (!address) throw new Error(`missing_address:${name}`);
    const runtime = await verifyRuntime(config, address, artifacts[name]!);
    runtimeHashes[name] = runtime.hash;
    if (name === 'PythUpgradable') verifyImmutableAddress(runtime.code, artifacts[name]!.immutableRanges, address);
  }
  const receiverImpl = proxyImplementation(await chain.getStorageAt({ address: addresses.WormholeReceiver!, slot: IMPLEMENTATION_SLOT }));
  const pythImpl = proxyImplementation(await chain.getStorageAt({ address: addresses.ERC1967Proxy!, slot: IMPLEMENTATION_SLOT }));
  if (receiverImpl !== addresses.ReceiverImplementationHalf || pythImpl !== addresses.PythUpgradable) throw new Error('proxy_implementation_mismatch');
  const receiverAbi = artifacts.ReceiverImplementationHalf!.abi;
  const pythAddress = addresses.ERC1967Proxy!;
  const [
    chainId,
    receiverGovChain,
    receiverGovContract,
    setIndex,
    guardianSet0,
    guardianSet,
    owner,
    version,
    watermark,
    wormhole,
    sources,
    governanceSource,
    validPeriod,
    updateFee,
  ] = (await Promise.all([
    chain.readContract({ address: addresses.WormholeReceiver!, abi: receiverAbi, functionName: 'chainId' }),
    chain.readContract({ address: addresses.WormholeReceiver!, abi: receiverAbi, functionName: 'governanceChainId' }),
    chain.readContract({ address: addresses.WormholeReceiver!, abi: receiverAbi, functionName: 'governanceContract' }),
    chain.readContract({ address: addresses.WormholeReceiver!, abi: receiverAbi, functionName: 'getCurrentGuardianSetIndex' }),
    chain.readContract({ address: addresses.WormholeReceiver!, abi: receiverAbi, functionName: 'getGuardianSet', args: [0] }),
    chain.readContract({ address: addresses.WormholeReceiver!, abi: receiverAbi, functionName: 'getGuardianSet', args: [1] }),
    chain.readContract({ address: pythAddress, abi: artifacts.PythUpgradable!.abi, functionName: 'owner' }),
    chain.readContract({ address: pythAddress, abi: artifacts.PythUpgradable!.abi, functionName: 'version' }),
    chain.readContract({ address: pythAddress, abi: artifacts.PythUpgradable!.abi, functionName: 'lastExecutedGovernanceSequence' }),
    chain.readContract({ address: pythAddress, abi: artifacts.PythUpgradable!.abi, functionName: 'wormhole' }),
    chain.readContract({ address: pythAddress, abi: artifacts.PythUpgradable!.abi, functionName: 'validDataSources' }),
    chain.readContract({ address: pythAddress, abi: artifacts.PythUpgradable!.abi, functionName: 'governanceDataSource' }),
    chain.readContract({ address: pythAddress, abi: artifacts.PythUpgradable!.abi, functionName: 'validTimePeriodSeconds' }),
    chain.readContract({ address: pythAddress, abi: artifacts.PythUpgradable!.abi, functionName: 'singleUpdateFeeInWei' }),
  ])) as readonly any[];
  const keys = (guardianSet.keys ?? guardianSet[0]) as string[];
  const set0Keys = (guardianSet0.keys ?? guardianSet0[0]) as string[];
  if (!Array.isArray(keys) || !Array.isArray(set0Keys)) throw new Error('invalid_guardian_set_shape');
  const guardianDigests = pythProManifest(artifacts, inputs).guardian_digests;
  const digest = keccak256(asHex(keys.map((key) => key.replace(/^0x/, '')).join('')));
  const set0Digest = keccak256(asHex(set0Keys.map((key) => key.replace(/^0x/, '')).join('')));
  if (
    Number(chainId) !== HEDERA_WORMHOLE_CHAIN_ID ||
    Number(receiverGovChain) !== inputs.config.wormholeConfig.governanceChainId ||
    String(receiverGovContract).toLowerCase() !== asHex(inputs.config.wormholeConfig.governanceContract).toLowerCase() ||
    Number(setIndex) !== 1 ||
    set0Keys.length !== 5 ||
    set0Digest !== guardianDigests[0] ||
    keys.length !== 5 ||
    digest !== guardianDigests[1]
  )
    throw new Error('receiver_configuration_mismatch');
  if (String(owner) !== '0x0000000000000000000000000000000000000000' || version !== '1.4.6' || getAddress(wormhole) !== addresses.WormholeReceiver)
    throw new Error('pyth_configuration_mismatch');
  const expectedSource = inputs.config.dataSources[0]!;
  const actualSource = sources[0];
  if (
    BigInt(watermark) !== BigInt(anchorSequence) ||
    sources.length !== 1 ||
    Number(actualSource.chainId ?? actualSource[0]) !== expectedSource.emitterChain ||
    String(actualSource.emitterAddress ?? actualSource[1]).toLowerCase() !== asHex(expectedSource.emitterAddress).toLowerCase() ||
    Number(governanceSource.chainId ?? governanceSource[0]) !== inputs.config.governanceDataSource.emitterChain ||
    String(governanceSource.emitterAddress ?? governanceSource[1]).toLowerCase() !== asHex(inputs.config.governanceDataSource.emitterAddress).toLowerCase() ||
    BigInt(validPeriod) !== VALID_TIME_PERIOD_SECONDS ||
    BigInt(updateFee) !== 0n
  )
    throw new Error('pyth_source_or_watermark_mismatch');
  const ledgerConfig = await Promise.all(
    ['registry', 'pyth', 'schemaId', 'minTargetLead', 'maxTargetLead', 'issuanceTolerance', 'oracleWindow', 'maxConfidenceBps', 'neutralBandBps'].map((functionName) =>
      chain.readContract({ address: addresses.SignalLedger!, abi: artifacts.SignalLedger!.abi, functionName }),
    ),
  );
  const expectedLedgerConfig = [
    config.registryAddress,
    pythAddress,
    SCHEMA_ID,
    BigInt(POLICY.minLead),
    BigInt(POLICY.maxLead),
    BigInt(POLICY.issueTolerance),
    BigInt(POLICY.oracleWindow),
    100n,
    5n,
  ];
  if (ledgerConfig.some((value, index) => String(value).toLowerCase() !== String(expectedLedgerConfig[index]).toLowerCase())) {
    throw new Error('ledger_immutable_configuration_mismatch');
  }
  return runtimeHashes;
}

export async function verifyPythProProof(config: Config, artifacts: Record<string, PythProArtifact>, pythAddress: Address) {
  const update = await historicalPrice(config, HISTORICAL_PROOF_TIME);
  const data = update.updates[0]!;
  const chain = publicClient(config);
  const args = [[data], [ETH_USD], BigInt(HISTORICAL_PROOF_TIME), BigInt(HISTORICAL_PROOF_TIME + 60)] as const;
  const abi = artifacts.PythUpgradable!.abi;
  const authentic = (await chain.simulateContract({ address: pythAddress, abi, functionName: 'parsePriceFeedUpdatesUnique', args, value: 0n })) as {
    result: readonly unknown[];
  };
  if (authentic.result.length !== 1) throw new Error('authentic_price_proof_failed');
  const corrupted = asHex(Buffer.from(corruptAccumulatorSignature(hexToBytes(data))).toString('hex'));
  try {
    await chain.simulateContract({
      address: pythAddress,
      abi,
      functionName: 'parsePriceFeedUpdatesUnique',
      args: [[corrupted], [ETH_USD], BigInt(HISTORICAL_PROOF_TIME), BigInt(HISTORICAL_PROOF_TIME + 60)],
      value: 0n,
    });
    throw new Error('corrupted_price_proof_accepted');
  } catch (error) {
    if (error instanceof Error && error.message === 'corrupted_price_proof_accepted') throw error;
    if (!isInvalidWormholeVaa(error)) throw error;
  }
  return {
    verified_at: now(),
    publish_time: update.publishTime,
    update_sha256: sha256(hexToBytes(data)),
    authentic: true as const,
    corrupted_rejected: true as const,
  };
}
