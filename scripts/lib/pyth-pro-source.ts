import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { keccak256, type Abi, type Hex } from 'viem';
import { artifact } from '../../src/adapters/hedera.ts';

export const PYTH_PRO_SOURCE_COMMIT = '859113ec53e59a3abaeeb3333ae71ef1fa09615e';

export const EXPECTED_SIGNAL_LEDGER_BUILD = Object.freeze({
  build_info_id: 'solc-0_8_28-f98db93cd158bd78078fef8dd1d5db9c649f1c22',
  source_sha256: '1155d69beea4e7d0ccea5395068110392db6dfc2b1d63a4e38121ee7822c00ac',
  creation_hash: '0x6bd0de7afedd7bfd9ae2a68affe900f8020a44c299dfd02b66439d8ca055b91e',
  runtime_template_hash: '0x8595cbdc0449b13b067090daf9e34bf1aa12168f58b4610167c579ba724b51a8',
  solc_long_version: '0.8.28+commit.7893614a',
  settings_sha256: '394fa363ffb39a1a3e7241dcfec3401f167b43745459d46b6938c62c40fcd175',
});

const EXPECTED_RUNTIME_HASHES = Object.freeze({
  ReceiverSetup: '0xe86e3296c090557bd046e9e43846238894e412f63bf91788e01181b529d7938f',
  ReceiverImplementationHalf: '0x672c872ab76094a205608519efb1f34a50662ced3410fdcfd45965bf41f6bef1',
  WormholeReceiver: '0xdc3e90fa531e085a7df6e3fce1322f2ae67b47716d606097959e5d80afa764c6',
  PythUpgradable: '0x7190f97e629ac8b731b8475c7819d77423b53215deaca6ed07fb89e414da135a',
  ERC1967Proxy: '0x7e693eea60500e1d5c5984a4cc54ec0b371d9ad29e8bb09c543cb7be447963df',
});

export type ImmutableRange = { start: number; length: number };
export type PythProArtifact = { abi: Abi; bytecode: Hex; deployedBytecode: Hex; immutableRanges: ImmutableRange[] };
export type PythProConfig = {
  dataSources: { emitterAddress: string; emitterChain: number }[];
  governanceDataSource: { emitterAddress: string; emitterChain: number };
  wormholeConfig: { governanceChainId: number; governanceContract: string; initialGuardianSet: string[]; quorum: string };
};
export type PythProInputs = { config: PythProConfig; rotation: Uint8Array; rotatedKeys: string[] };

export const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const asHex = (value: string): Hex => `0x${value.replace(/^0x/, '')}`;

function loadFoundryArtifact(path: string): PythProArtifact {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
  const bytecode = asHex(typeof raw.bytecode === 'string' ? raw.bytecode : (raw.bytecode?.object ?? ''));
  const deployedBytecode = asHex(typeof raw.deployedBytecode === 'string' ? raw.deployedBytecode : (raw.deployedBytecode?.object ?? ''));
  if (bytecode === '0x' || deployedBytecode === '0x' || !Array.isArray(raw.abi)) throw new Error(`invalid_artifact:${path}`);
  const references = raw.deployedBytecode?.immutableReferences ?? raw.immutableReferences ?? {};
  return { abi: raw.abi as Abi, bytecode, deployedBytecode, immutableRanges: Object.values(references).flat() as ImmutableRange[] };
}

export function loadPythProArtifacts(source: string) {
  execFileSync('npm', ['run', 'compile'], { encoding: 'utf8' });
  const output = `${source}/target_chains/ethereum/contracts/out`;
  const names = ['ReceiverSetup', 'ReceiverImplementationHalf', 'WormholeReceiver', 'PythUpgradable', 'ERC1967Proxy'] as const;
  const entries = names.map((name) => [name, loadFoundryArtifact(`${output}/${name}.sol/${name}.json`)] as const);
  const local = artifact('SignalLedger') as { abi: Abi; bytecode: Hex; deployedBytecode?: Hex };
  const localRaw = JSON.parse(readFileSync('artifacts/contracts/SignalLedger.sol/SignalLedger.json', 'utf8')) as Record<string, any>;
  const buildInfo = JSON.parse(readFileSync(`artifacts/build-info/${String(localRaw.buildInfoId)}.json`, 'utf8')) as Record<string, any>;
  const buildSource = buildInfo.input?.sources?.['project/contracts/SignalLedger.sol']?.content;
  const sourceContents = readFileSync('contracts/SignalLedger.sol', 'utf8');
  const buildChecks = {
    build_info_id: String(localRaw.buildInfoId),
    source_sha256: sha256(sourceContents),
    creation_hash: keccak256(asHex(localRaw.bytecode)),
    runtime_template_hash: keccak256(asHex(localRaw.deployedBytecode)),
    solc_long_version: String(buildInfo.solcLongVersion),
    settings_sha256: sha256(JSON.stringify(buildInfo.input?.settings)),
  };
  if (buildSource !== sourceContents || Object.entries(EXPECTED_SIGNAL_LEDGER_BUILD).some(([key, expected]) => buildChecks[key as keyof typeof buildChecks] !== expected)) {
    throw new Error('signal_ledger_build_mismatch_run_compile_and_review');
  }
  const localRanges = Object.values(localRaw.immutableReferences ?? {}).flat() as ImmutableRange[];
  return Object.fromEntries([...entries, ['SignalLedger', { ...local, deployedBytecode: asHex(localRaw.deployedBytecode), immutableRanges: localRanges }]]) as Record<
    string,
    PythProArtifact
  >;
}

export async function loadPythProInputs(source: string): Promise<PythProInputs> {
  const loader = `
    import { pathToFileURL } from 'node:url';
    const source = process.argv[1];
    const base = await import(pathToFileURL(source + '/contract_manager/src/core/base.ts').href);
    const sets = await import(pathToFileURL(source + '/contract_manager/src/core/pro_guardian_sets.ts').href);
    const config = base.getDefaultDeploymentConfig('pro-compatible-production');
    const upgrades = sets.getProGuardianSetUpgrades('pro-compatible-production');
    process.stdout.write(JSON.stringify({ config, upgrades: upgrades.map(value => ({ guardianSetIndex: value.guardianSetIndex, keys: value.keys, vaa: Buffer.from(value.vaa).toString('base64') })) }));
  `;
  const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', loader, source], { encoding: 'utf8' });
  const loaded = JSON.parse(output.trim().split('\n').at(-1) ?? '') as {
    config: PythProConfig;
    upgrades: { guardianSetIndex: number; keys: string[]; vaa: string }[];
  };
  const upgrades = loaded.upgrades.map((value) => ({ ...value, vaa: Buffer.from(value.vaa, 'base64') }));
  if (loaded.config.wormholeConfig.quorum !== 'half' || loaded.config.dataSources.length !== 1 || upgrades.length !== 1 || upgrades[0]?.guardianSetIndex !== 1) {
    throw new Error('unexpected_upstream_pro_configuration');
  }
  return { config: loaded.config, rotation: Uint8Array.from(upgrades[0].vaa), rotatedKeys: [...upgrades[0].keys] };
}

export function verifyPythProSource(source: string, artifacts: Record<string, PythProArtifact>) {
  const commit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (commit !== PYTH_PRO_SOURCE_COMMIT) throw new Error('pyth_source_commit_mismatch');
  if (execFileSync('git', ['-C', source, 'status', '--porcelain'], { encoding: 'utf8' }).trim()) throw new Error('pyth_source_not_clean');
  for (const [name, expected] of Object.entries(EXPECTED_RUNTIME_HASHES)) {
    if (keccak256(artifacts[name]!.deployedBytecode) !== expected) throw new Error(`runtime_hash_mismatch:${name}`);
  }
}

export function pythProManifest(artifacts: Record<string, PythProArtifact>, inputs: PythProInputs) {
  const artifactHashes = Object.fromEntries(
    Object.entries(artifacts).map(([name, item]) => [name, { creation: keccak256(item.bytecode), runtime: keccak256(item.deployedBytecode) }]),
  );
  const guardianDigests = [inputs.config.wormholeConfig.initialGuardianSet, inputs.rotatedKeys].map((keys) => keccak256(asHex(keys.map((key) => key.replace(/^0x/, '')).join(''))));
  const value = {
    source_commit: PYTH_PRO_SOURCE_COMMIT,
    artifact_hashes: artifactHashes,
    guardian_digests: guardianDigests,
    rotation_sha256: sha256(inputs.rotation),
    compiler: '0.8.29',
    evm: 'paris',
    optimizer_runs: 200,
  };
  return { ...value, manifest_hash: sha256(JSON.stringify(value)) };
}
