import { AccountBalanceQuery, AccountId, Client, ContractExecuteTransaction, ContractId, Hbar, PrivateKey, Transaction, TransactionId } from '@hiero-ledger/sdk';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { encodeDeployData, getAddress, hexToBytes, keccak256, type Abi, type Address, type Hex } from 'viem';
import { loadConfig, type Config } from '../src/adapters/config.ts';
import { operatorClient, publicClient } from '../src/adapters/hedera.ts';
import {
  buildJumboCreateTransaction,
  createJumboDeployerAccountTransaction,
  estimateTransactionFee,
  generateJumboDeployer,
  loadOrCreateJumboDeployer,
  verifyJumboContractMapping,
  verifyJumboDeployerAccount,
  verifyJumboNetworkVersion,
  type JumboDeployer,
} from '../src/adapters/hedera-jumbo.ts';
import { ResumableTransactionRunner, type TransactionAttempt, type TransactionStep } from '../src/adapters/hedera-resumable.ts';
import { mirrorTransactionId, normalizeTransactionId } from '../src/adapters/payment.ts';
import {
  FULL_RECOVERY_CAP_TINYBARS,
  PYTH_GAS_LIMITS,
  PYTH_STACK_CAP_TINYBARS,
  deploymentNonces,
  estimateFullRecoveryTinybars,
  estimatePythStackTinybars,
  parseVaaMetadata,
  remainingDeploymentBudget,
  requireDeploymentBudget,
} from '../src/protocol/pyth-deployment.ts';
import { completedP1JumboNonce, deriveP1JumboHandoff } from '../src/protocol/subscription-deployment.ts';
import {
  EXPECTED_SIGNAL_LEDGER_BUILD,
  PYTH_PRO_SOURCE_COMMIT as SOURCE_COMMIT,
  loadPythProArtifacts,
  loadPythProInputs,
  pythProManifest,
  sha256,
  verifyPythProSource,
  type PythProArtifact as Artifact,
  type PythProInputs as UpstreamInputs,
} from './lib/pyth-pro-source.ts';
import { verifyPythProProof, verifyPythProStack } from './lib/pyth-pro-verifier.ts';
import {
  pythInitializerCalldata,
  pythProxyInitCode,
  receiverRotationCalldata,
  receiverSetupCalldata,
  signalLedgerInitCode,
  wormholeReceiverInitCode,
} from './lib/pyth-pro-encoding.ts';

const DEFAULT_SOURCE = '/tmp/pyth-crosschain-solcore-20260906';
const DEFAULT_STATE = 'data/pyth-pro-deployment.json';
const DEFAULT_DEPLOYER_KEY = 'data/pyth-pro-deployer.json';
const DEFAULT_SUCCESSOR_STATE = 'data/subscription-deployment.json';
const APPROVAL_PHRASE = 'canonical-self-deployed-pyth-pro';
const TRANSACTION_REPLAN_SECONDS = 180;
const LEGACY_RECEIVER = getAddress('0xb27e5ca259702f209a29225d0eddc131039c9933');
const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
const SOLANA_TRACKER = '7GccwdN94bXnk26UZxLXwUvGAhmEzBNd2k5WiVXjyvkZ';
const SOLANA_WORMHOLE = 'worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth';
const HBAR = 100_000_000n;
const STEP_BUDGETS = Object.freeze({
  'account.deployer': { total: (15n * HBAR) / 10n, gas: 0n },
  'contract.ReceiverSetup': {
    total: (133n * HBAR) / 10n,
    gas: (5n * HBAR) / 10n,
  },
  'contract.ReceiverImplementationHalf': {
    total: (158n * HBAR) / 10n,
    gas: 3n * HBAR,
  },
  'contract.WormholeReceiver': {
    total: (134n * HBAR) / 10n,
    gas: (6n * HBAR) / 10n,
  },
  'receiver.rotate': { total: (8n * HBAR) / 10n, gas: 0n },
  'contract.PythUpgradable': { total: (208n * HBAR) / 10n, gas: 8n * HBAR },
  'contract.ERC1967Proxy': {
    total: (134n * HBAR) / 10n,
    gas: (6n * HBAR) / 10n,
  },
  'contract.SignalLedger': { total: (168n * HBAR) / 10n, gas: 4n * HBAR },
});

type Phase = 'pyth' | 'full';
type Attempt = TransactionAttempt;
type Step = TransactionStep<Phase>;
type Anchor = {
  fetched_at: number;
  finalized_slot: number;
  tracker_next_sequence: string;
  latest_sequence: string;
  guardian_set_index: number;
  signature_count: number;
  vaa_sha256: string;
};
type State = {
  version: 2;
  network: 'hedera:testnet';
  source_commit: string;
  manifest_hash: string;
  steps: Record<string, Step>;
  addresses: Record<string, Address>;
  contract_ids: Record<string, string>;
  identity: DeploymentIdentity;
  calldata_hashes?: { receiver_setup: Hex; pyth_initializer: Hex };
  anchor?: Anchor;
  finalized_anchor?: Anchor;
  first_jumbo_accounting?: {
    transaction_id: string;
    record_fee_tinybars: string;
    mirror_charged_fee_tinybars: string;
    operator_net_debit_tinybars: string;
    reconciled_at: number;
  };
  proof?: {
    verified_at: number;
    publish_time: number;
    update_sha256: string;
    authentic: true;
    corrupted_rejected: true;
  };
  deployed_runtime_hashes?: Record<string, Hex>;
};
type DeploymentIdentity = {
  operator_id: string;
  operator_key_sha256: string;
  registry_address: Address;
  deployer_public_key: string;
  deployer_evm_address: Address;
  deployer_account_id?: string;
};

const asHex = (value: string): Hex => `0x${value.replace(/^0x/, '')}`;
const now = () => Math.floor(Date.now() / 1_000);
const tinybars = (value: bigint) => Hbar.fromTinybars(value.toString());

function parseArgs() {
  const args = process.argv.slice(2);
  const value = (name: string) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  return {
    execute: args.includes('--execute'),
    verifyAnchor: args.includes('--verify-anchor'),
    approval: value('--approval'),
    source: resolve(value('--source') ?? process.env.PYTH_SOURCE_DIR ?? DEFAULT_SOURCE),
    statePath: resolve(value('--state') ?? DEFAULT_STATE),
    deployerKeyPath: resolve(value('--deployer-key') ?? DEFAULT_DEPLOYER_KEY),
    successorStatePath: resolve(value('--successor-state') ?? DEFAULT_SUCCESSOR_STATE),
  };
}

function deploymentIdentity(config: Config, operatorKey: PrivateKey, deployer: JumboDeployer): DeploymentIdentity {
  if (!config.operatorId || !config.registryAddress) throw new Error('deployment_identity_missing');
  return {
    operator_id: config.operatorId,
    operator_key_sha256: sha256(operatorKey.publicKey.toString()),
    registry_address: getAddress(config.registryAddress),
    deployer_public_key: deployer.publicKey,
    deployer_evm_address: deployer.evmAddress,
  };
}

function readState(path: string, manifestHash: string, identity: DeploymentIdentity): State {
  if (!existsSync(path))
    return {
      version: 2,
      network: 'hedera:testnet',
      source_commit: SOURCE_COMMIT,
      manifest_hash: manifestHash,
      steps: {},
      addresses: {},
      contract_ids: {},
      identity,
    };
  const state = JSON.parse(readFileSync(path, 'utf8')) as State;
  const identityMatches =
    state.identity?.operator_id === identity.operator_id &&
    state.identity.operator_key_sha256 === identity.operator_key_sha256 &&
    state.identity.registry_address?.toLowerCase() === identity.registry_address.toLowerCase() &&
    state.identity.deployer_public_key === identity.deployer_public_key &&
    state.identity.deployer_evm_address?.toLowerCase() === identity.deployer_evm_address.toLowerCase();
  if (state.version !== 2 || state.network !== 'hedera:testnet' || state.source_commit !== SOURCE_COMMIT || state.manifest_hash !== manifestHash || !identityMatches) {
    throw new Error('deployment_state_mismatch');
  }
  return state;
}

function writeState(path: string, state: State) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', {
    mode: 0o600,
  });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

class Runner {
  state: State;
  private readonly journal: ResumableTransactionRunner<Phase>;

  constructor(
    client: Client,
    key: PrivateKey,
    private readonly path: string,
    mirrorUrl: string,
    initial: State,
  ) {
    this.state = initial;
    this.journal = new ResumableTransactionRunner({
      client,
      key,
      mirrorUrl,
      getSteps: () => this.state.steps,
      saveSteps: (steps) => this.save({ ...this.state, steps }),
      capFor: (phase) => (phase === 'pyth' ? PYTH_STACK_CAP_TINYBARS : FULL_RECOVERY_CAP_TINYBARS),
      budgetFor: (id) => {
        const budget = STEP_BUDGETS[id as keyof typeof STEP_BUDGETS];
        if (!budget) throw new Error(`missing_step_budget:${id}`);
        return budget;
      },
      countsToward: (stepPhase, capPhase) => capPhase === 'full' || stepPhase === 'pyth',
      requiresEntity: (id) => id === 'account.deployer' || id.startsWith('contract.'),
      isNonReplannable: () => true,
      replanSeconds: TRANSACTION_REPLAN_SECONDS,
    });
  }

  save(next: State) {
    this.state = next;
    writeState(this.path, next);
  }

  setAddress(name: string, address: Address) {
    const existing = this.state.addresses[name];
    if (existing && existing.toLowerCase() !== address.toLowerCase()) throw new Error(`deployment_address_conflict:${name}`);
    this.save({ ...this.state, addresses: { ...this.state.addresses, [name]: address } });
  }

  setContractId(name: string, contractId: string) {
    const existing = this.state.contract_ids[name];
    if (existing && existing !== contractId) throw new Error(`deployment_contract_id_conflict:${name}`);
    this.save({ ...this.state, contract_ids: { ...this.state.contract_ids, [name]: contractId } });
  }

  setDeployerAccountId(accountId: string) {
    const existing = this.state.identity.deployer_account_id;
    if (existing && existing !== accountId) throw new Error('deployment_deployer_account_conflict');
    this.save({ ...this.state, identity: { ...this.state.identity, deployer_account_id: accountId } });
  }

  setAnchor(anchor: Anchor) {
    this.save({ ...this.state, anchor });
  }

  setFinalizedAnchor(anchor: Anchor) {
    this.save({ ...this.state, finalized_anchor: anchor });
  }

  setProof(proof: State['proof']) {
    this.save({ ...this.state, proof });
  }

  setCalldataHashes(calldataHashes: NonNullable<State['calldata_hashes']>) {
    this.save({ ...this.state, calldata_hashes: calldataHashes });
  }

  setRuntimeHashes(hashes: Record<string, Hex>) {
    this.save({ ...this.state, deployed_runtime_hashes: { ...hashes } });
  }

  setFirstJumboAccounting(accounting: NonNullable<State['first_jumbo_accounting']>) {
    this.save({ ...this.state, first_jumbo_accounting: accounting });
  }

  latest(id: string) {
    return this.journal.latest(id);
  }

  run(id: string, phase: Phase, build: () => Transaction | Promise<Transaction>) {
    return this.journal.run(id, phase, build);
  }
}

async function reconcileFirstJumboAccounting(config: Config, runner: Runner) {
  if (!config.operatorId) throw new Error('operator_account_required');
  const attempt = runner.latest('contract.ReceiverSetup');
  if (!attempt?.fee_tinybars || attempt.status !== 'consensus') throw new Error('first_jumbo_receipt_incomplete');
  if (runner.state.first_jumbo_accounting) {
    if (runner.state.first_jumbo_accounting.transaction_id !== attempt.transaction_id || runner.state.first_jumbo_accounting.record_fee_tinybars !== attempt.fee_tinybars)
      throw new Error('first_jumbo_accounting_state_mismatch');
    return;
  }
  const response = await fetch(`${config.mirrorUrl}/transactions/${mirrorTransactionId(attempt.transaction_id)}`);
  if (!response.ok) throw new Error(`first_jumbo_mirror_http_${response.status}`);
  const body = (await response.json()) as { transactions?: Record<string, unknown>[] };
  const matches = (body.transactions ?? []).filter(
    (item) => Number(item.nonce) === 0 && typeof item.transaction_id === 'string' && normalizeTransactionId(item.transaction_id) === normalizeTransactionId(attempt.transaction_id),
  );
  if (matches.length !== 1) throw new Error('first_jumbo_mirror_transaction_mismatch');
  const transaction = matches[0]!;
  if (transaction.result !== 'SUCCESS' || !/^\d+$/.test(String(transaction.charged_tx_fee)) || !Array.isArray(transaction.transfers)) {
    throw new Error('first_jumbo_mirror_evidence_invalid');
  }
  const transfers = transaction.transfers as unknown[];
  if (
    transfers.some(
      (item) =>
        !item || typeof item !== 'object' || typeof (item as Record<string, unknown>).account !== 'string' || !/^-?\d+$/.test(String((item as Record<string, unknown>).amount)),
    )
  ) {
    throw new Error('first_jumbo_mirror_transfers_invalid');
  }
  const operatorNet = (transfers as Record<string, unknown>[]).filter((item) => item.account === config.operatorId).reduce((sum, item) => sum + BigInt(String(item.amount)), 0n);
  const charged = BigInt(String(transaction.charged_tx_fee));
  if (charged !== BigInt(attempt.fee_tinybars) || operatorNet !== -charged) throw new Error('first_jumbo_sponsor_fee_mismatch');
  runner.setFirstJumboAccounting({
    transaction_id: attempt.transaction_id,
    record_fee_tinybars: attempt.fee_tinybars,
    mirror_charged_fee_tinybars: charged.toString(),
    operator_net_debit_tinybars: (-operatorNet).toString(),
    reconciled_at: now(),
  });
}

const NONCES = deploymentNonces(0);
const NONCE_BY_LABEL = Object.freeze({
  ReceiverSetup: NONCES.receiverSetup,
  ReceiverImplementationHalf: NONCES.receiverImplementation,
  WormholeReceiver: NONCES.receiverProxy,
  PythUpgradable: NONCES.pythImplementation,
  ERC1967Proxy: NONCES.pythProxy,
  SignalLedger: NONCES.signalLedger,
});

async function ensureDeployerAccount(runner: Runner, client: Client, deployer: JumboDeployer, successorStatePath: string) {
  const result = await runner.run('account.deployer', 'pyth', () => createJumboDeployerAccountTransaction(deployer));
  if (!result.entity_id) throw new Error('missing_jumbo_deployer_account_id');
  const contractAttempts = Object.entries(runner.state.steps)
    .filter(([id]) => id.startsWith('contract.'))
    .map(([, step]) => step.attempts.at(-1))
    .filter((attempt): attempt is Attempt => Boolean(attempt));
  const consensusCount = contractAttempts.filter((attempt) => attempt.status === 'consensus').length;
  const unresolvedCount = contractAttempts.filter((attempt) => attempt.status === 'planned' || attempt.status === 'submitted').length;
  const successorNonce = existsSync(successorStatePath)
    ? completedP1JumboNonce(JSON.parse(readFileSync(successorStatePath, 'utf8')), deriveP1JumboHandoff(runner.state))
    : undefined;
  await verifyJumboDeployerAccount({
    client,
    deployer,
    accountId: result.entity_id,
    minimumNonce: consensusCount,
    maximumNonce: successorNonce ?? consensusCount + unresolvedCount,
  });
  runner.setDeployerAccountId(result.entity_id);
}

async function deploy(config: Config, runner: Runner, deployer: JumboDeployer, label: keyof typeof NONCE_BY_LABEL, phase: Phase, initCode: Hex, gas: bigint) {
  const id = `contract.${label}`;
  const budget = STEP_BUDGETS[id as keyof typeof STEP_BUDGETS];
  if (!budget || budget.gas <= 0n) throw new Error(`invalid_jumbo_step_budget:${label}`);
  const planned = await buildJumboCreateTransaction({
    deployer,
    nonce: NONCE_BY_LABEL[label],
    initCode,
    gasLimit: gas,
    maxGasAllowanceTinybars: budget.gas,
  });
  runner.setAddress(label, planned.evmAddress);
  const result = await runner.run(id, phase, () => planned.transaction);
  if (!result.entity_id) throw new Error(`missing_contract_id:${label}`);
  runner.setContractId(label, result.entity_id);
  await verifyJumboContractMapping({
    mirrorUrl: config.mirrorUrl,
    evmAddress: planned.evmAddress,
    nativeContractId: result.entity_id,
  });
  return planned.evmAddress;
}

async function governanceAnchor(config: Config, receiverAbi: Abi): Promise<Anchor> {
  const rpc = new URL(process.env.SOLANA_RPC_URL ?? SOLANA_RPC);
  if (rpc.protocol !== 'https:') throw new Error('invalid_solana_rpc');
  const response = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getAccountInfo',
      params: [SOLANA_TRACKER, { commitment: 'finalized', encoding: 'base64' }],
    }),
  });
  const json = (await response.json()) as any;
  const value = json?.result?.value;
  const data = Buffer.from(value?.data?.[0] ?? '', 'base64');
  if (!response.ok || value?.owner !== SOLANA_WORMHOLE || data.length !== 8 || !Number.isSafeInteger(json?.result?.context?.slot)) throw new Error('invalid_governance_tracker');
  const next = data.readBigUInt64LE(0);
  if (next < 1n) throw new Error('invalid_governance_sequence');
  const sequence = next - 1n;
  const emitter = '5635979a221c34931e32620b9293a463065555ea71fe97cd6237ade875b12e9e';
  const vaaResponse = await fetch(`https://api.wormholescan.io/v1/signed_vaa/1/${emitter}/${sequence}`);
  const vaaJson = (await vaaResponse.json()) as any;
  const vaa = Buffer.from(vaaJson?.vaaBytes ?? '', 'base64');
  const metadata = parseVaaMetadata(vaa);
  if (!vaaResponse.ok || metadata.version !== 1 || metadata.sequence !== sequence || metadata.emitterChain !== 1 || metadata.emitterAddress.slice(2) !== emitter)
    throw new Error('invalid_governance_vaa');
  const chain = publicClient(config);
  let parsed: readonly unknown[];
  try {
    parsed = (await chain.readContract({
      address: LEGACY_RECEIVER,
      abi: receiverAbi,
      functionName: 'parseAndVerifyVM',
      args: [asHex(vaa.toString('hex'))],
    })) as readonly unknown[];
  } catch (error) {
    const detail = error && typeof error === 'object' && 'shortMessage' in error ? String(error.shortMessage) : error instanceof Error ? error.message : 'unknown';
    throw new Error(`governance_vaa_authentication_failed:${detail}`);
  }
  if (parsed[1] !== true) throw new Error('governance_vaa_not_authenticated');
  return {
    fetched_at: now(),
    finalized_slot: json.result.context.slot,
    tracker_next_sequence: next.toString(),
    latest_sequence: sequence.toString(),
    guardian_set_index: metadata.guardianSetIndex,
    signature_count: metadata.signatureCount,
    vaa_sha256: sha256(vaa),
  };
}

function confirmedSpend(state: State) {
  return Object.values(state.steps)
    .flatMap((step) => step.attempts)
    .filter((attempt) => attempt.status === 'consensus')
    .reduce((sum, attempt) => sum + BigInt(attempt.fee_tinybars ?? '0'), 0n);
}

async function feeGate(config: Config, state: State) {
  if (!config.operatorId) throw new Error('operator_account_required');
  const client = operatorClient(config);
  try {
    const [gasPrice, rates, balance, jumboVersion] = await Promise.all([
      publicClient(config).getGasPrice(),
      fetch(`${config.mirrorUrl}/network/exchangerate`).then((response) => response.json() as Promise<any>),
      new AccountBalanceQuery().setAccountId(config.operatorId).execute(client),
      verifyJumboNetworkVersion(client),
    ]);
    const rate = rates?.current_rate;
    const exchange = {
      cent_equivalent: BigInt(rate?.cent_equivalent ?? 0),
      hbar_equivalent: BigInt(rate?.hbar_equivalent ?? 0),
    };
    const pyth = estimatePythStackTinybars(gasPrice, exchange);
    const full = estimateFullRecoveryTinybars(gasPrice, exchange);
    const confirmed = confirmedSpend(state);
    const remainingCap = remainingDeploymentBudget(FULL_RECOVERY_CAP_TINYBARS, [confirmed]);
    const balanceTinybars = BigInt(balance.hbars.toTinybars().toString());
    requireDeploymentBudget(pyth, FULL_RECOVERY_CAP_TINYBARS, 0);
    if (full.totalTinybars > FULL_RECOVERY_CAP_TINYBARS) throw new Error('full_recovery_cap_exceeded');
    if (balanceTinybars < remainingCap) throw new Error('recovery_remaining_balance_insufficient');
    return {
      gas_price_weibars: gasPrice.toString(),
      pyth_estimate_tinybars: pyth.totalTinybars.toString(),
      full_estimate_tinybars: full.totalTinybars.toString(),
      balance_tinybars: balanceTinybars.toString(),
      confirmed_spend_tinybars: confirmed.toString(),
      remaining_cap_tinybars: remainingCap.toString(),
      jumbo_version: jumboVersion,
    };
  } finally {
    client.close();
  }
}

async function jumboPlanGate(config: Config, artifacts: Record<string, Artifact>) {
  if (!config.operatorId || !config.operatorKey) throw new Error('operator_credentials_required_for_jumbo_gate');
  const client = operatorClient(config);
  try {
    const deployer = generateJumboDeployer();
    const plan = await buildJumboCreateTransaction({
      deployer,
      nonce: NONCES.pythImplementation,
      initCode: encodeDeployData({
        abi: artifacts.PythUpgradable!.abi,
        bytecode: artifacts.PythUpgradable!.bytecode,
      }),
      gasLimit: PYTH_GAS_LIMITS.pythImplementation,
      maxGasAllowanceTinybars: STEP_BUDGETS['contract.PythUpgradable'].gas,
    });
    plan.transaction
      .setTransactionId(TransactionId.generate(AccountId.fromString(config.operatorId)))
      .setMaxTransactionFee(tinybars(STEP_BUDGETS['contract.PythUpgradable'].total - STEP_BUDGETS['contract.PythUpgradable'].gas));
    const version = await verifyJumboNetworkVersion(client);
    const signed = await (await plan.transaction.freezeWith(client)).sign(PrivateKey.fromStringECDSA(config.operatorKey));
    const estimateTinycents = await estimateTransactionFee(client, signed);
    return {
      ...version,
      raw_ethereum_bytes: hexToBytes(plan.rawEthereumData).length,
      fee_estimate_tinycents: estimateTinycents.toString(),
      fee_estimate_accepted: true,
      outer_signed: true,
    };
  } finally {
    client.close();
  }
}

async function validateDeploymentEncoding(config: Config, artifacts: Record<string, Artifact>, inputs: UpstreamInputs, anchor: Anchor) {
  const deployer = generateJumboDeployer();
  const create = (label: keyof typeof NONCE_BY_LABEL, initCode: Hex, gasLimit: bigint) =>
    buildJumboCreateTransaction({
      deployer,
      nonce: NONCE_BY_LABEL[label],
      initCode,
      gasLimit,
      maxGasAllowanceTinybars: STEP_BUDGETS[`contract.${label}` as keyof typeof STEP_BUDGETS].gas,
    });
  const setup = await create('ReceiverSetup', encodeDeployData({ abi: artifacts.ReceiverSetup!.abi, bytecode: artifacts.ReceiverSetup!.bytecode }), PYTH_GAS_LIMITS.receiverSetup);
  const implementation = await create(
    'ReceiverImplementationHalf',
    encodeDeployData({ abi: artifacts.ReceiverImplementationHalf!.abi, bytecode: artifacts.ReceiverImplementationHalf!.bytecode }),
    PYTH_GAS_LIMITS.receiverImplementation,
  );
  const setupData = receiverSetupCalldata(artifacts.ReceiverSetup!, implementation.evmAddress, inputs);
  const receiver = await create('WormholeReceiver', wormholeReceiverInitCode(artifacts.WormholeReceiver!, setup.evmAddress, setupData), PYTH_GAS_LIMITS.receiverProxy);
  const rotationData = receiverRotationCalldata(artifacts.ReceiverImplementationHalf!, inputs.rotation);
  const pythImplementation = await create(
    'PythUpgradable',
    encodeDeployData({ abi: artifacts.PythUpgradable!.abi, bytecode: artifacts.PythUpgradable!.bytecode }),
    PYTH_GAS_LIMITS.pythImplementation,
  );
  const initializer = pythInitializerCalldata(artifacts.PythUpgradable!, receiver.evmAddress, inputs, anchor.latest_sequence);
  const proxy = await create('ERC1967Proxy', pythProxyInitCode(artifacts.ERC1967Proxy!, pythImplementation.evmAddress, initializer), PYTH_GAS_LIMITS.pythProxy);
  const ledger = await create('SignalLedger', signalLedgerInitCode(artifacts.SignalLedger!, config, proxy.evmAddress), 3_000_000n);
  return {
    all_steps_encoded: true,
    raw_bytes: {
      receiver_setup: hexToBytes(setup.rawEthereumData).length,
      receiver_implementation: hexToBytes(implementation.rawEthereumData).length,
      receiver_proxy: hexToBytes(receiver.rawEthereumData).length,
      receiver_rotation_calldata: hexToBytes(rotationData).length,
      pyth_implementation: hexToBytes(pythImplementation.rawEthereumData).length,
      pyth_proxy: hexToBytes(proxy.rawEthereumData).length,
      signal_ledger: hexToBytes(ledger.rawEthereumData).length,
    },
    calldata_hashes: { receiver_setup: keccak256(setupData), pyth_initializer: keccak256(initializer) },
  };
}

async function deployAll(config: Config, statePath: string, successorStatePath: string, artifacts: Record<string, Artifact>, inputs: UpstreamInputs, key: PrivateKey, deployer: JumboDeployer, initial: State) {
  if (!config.operatorId || !config.operatorKey || !config.registryAddress) throw new Error('deployment_credentials_or_registry_missing');
  if (deployer.publicKey === key.publicKey.toString()) throw new Error('jumbo_deployer_must_be_distinct_from_operator');
  const client = operatorClient(config);
  const runner = new Runner(client, key, statePath, config.mirrorUrl, initial);
  try {
    await verifyJumboNetworkVersion(client);
    await ensureDeployerAccount(runner, client, deployer, successorStatePath);
    const setup = await deploy(
      config,
      runner,
      deployer,
      'ReceiverSetup',
      'pyth',
      encodeDeployData({
        abi: artifacts.ReceiverSetup!.abi,
        bytecode: artifacts.ReceiverSetup!.bytecode,
      }),
      PYTH_GAS_LIMITS.receiverSetup,
    );
    await reconcileFirstJumboAccounting(config, runner);
    const implementation = await deploy(
      config,
      runner,
      deployer,
      'ReceiverImplementationHalf',
      'pyth',
      encodeDeployData({
        abi: artifacts.ReceiverImplementationHalf!.abi,
        bytecode: artifacts.ReceiverImplementationHalf!.bytecode,
      }),
      PYTH_GAS_LIMITS.receiverImplementation,
    );
    const setupData = receiverSetupCalldata(artifacts.ReceiverSetup!, implementation, inputs);
    const receiverInit = wormholeReceiverInitCode(artifacts.WormholeReceiver!, setup, setupData);
    const receiver = await deploy(config, runner, deployer, 'WormholeReceiver', 'pyth', receiverInit, PYTH_GAS_LIMITS.receiverProxy);
    const rotationData = receiverRotationCalldata(artifacts.ReceiverImplementationHalf!, inputs.rotation);
    await runner.run('receiver.rotate', 'pyth', () =>
      new ContractExecuteTransaction()
        .setContractId(ContractId.fromEvmAddress(0, 0, receiver))
        .setGas(Number(PYTH_GAS_LIMITS.rotation))
        .setFunctionParameters(hexToBytes(rotationData)),
    );
    const pythImplementation = await deploy(
      config,
      runner,
      deployer,
      'PythUpgradable',
      'pyth',
      encodeDeployData({
        abi: artifacts.PythUpgradable!.abi,
        bytecode: artifacts.PythUpgradable!.bytecode,
      }),
      PYTH_GAS_LIMITS.pythImplementation,
    );
    const proxyAttempt = runner.latest('contract.ERC1967Proxy');
    let anchor = runner.state.anchor;
    if (proxyAttempt?.status !== 'consensus') {
      const freshAnchor = await governanceAnchor(config, artifacts.ReceiverImplementationHalf!.abi);
      if (
        proxyAttempt &&
        proxyAttempt.status !== 'abandoned' &&
        anchor?.latest_sequence !== freshAnchor.latest_sequence &&
        proxyAttempt.planned_at + TRANSACTION_REPLAN_SECONDS >= now()
      )
        throw new Error('governance_anchor_advanced_wait_for_transaction_expiry');
      anchor = freshAnchor;
      runner.setAnchor(anchor);
    }
    if (!anchor) throw new Error('missing_governance_anchor');
    const initData = pythInitializerCalldata(artifacts.PythUpgradable!, receiver, inputs, anchor.latest_sequence);
    const proxyInit = pythProxyInitCode(artifacts.ERC1967Proxy!, pythImplementation, initData);
    const pythProxy = await deploy(config, runner, deployer, 'ERC1967Proxy', 'pyth', proxyInit, PYTH_GAS_LIMITS.pythProxy);
    const finalizedAnchor = await governanceAnchor(config, artifacts.ReceiverImplementationHalf!.abi);
    if (finalizedAnchor.latest_sequence !== anchor.latest_sequence) throw new Error('governance_anchor_advanced_after_proxy_consensus');
    runner.setFinalizedAnchor(finalizedAnchor);
    runner.setCalldataHashes({
      receiver_setup: keccak256(setupData),
      pyth_initializer: keccak256(initData),
    });
    const ledgerInit = signalLedgerInitCode(artifacts.SignalLedger!, config, pythProxy);
    await deploy(config, runner, deployer, 'SignalLedger', 'full', ledgerInit, 3_000_000n);
    runner.save({
      ...runner.state,
      addresses: { ...runner.state.addresses },
      anchor: { ...anchor },
      steps: { ...runner.state.steps },
      proof: runner.state.proof,
      calldata_hashes: runner.state.calldata_hashes,
      finalized_anchor: { ...finalizedAnchor },
    });
    runner.setRuntimeHashes(await verifyPythProStack(config, artifacts, inputs, runner.state.addresses, anchor.latest_sequence));
    runner.setProof(await verifyPythProProof(config, artifacts, runner.state.addresses.ERC1967Proxy!));
    return runner.state;
  } finally {
    client.close();
  }
}

async function main() {
  const options = parseArgs();
  const artifacts = loadPythProArtifacts(options.source);
  verifyPythProSource(options.source, artifacts);
  const inputs = await loadPythProInputs(options.source);
  const evidence = pythProManifest(artifacts, inputs);
  const plan = {
    mode: options.execute ? 'execute' : 'plan',
    network: 'hedera:testnet',
    state_path: options.statePath,
    source_commit: SOURCE_COMMIT,
    manifest_hash: evidence.manifest_hash,
    runtime_hashes: evidence.artifact_hashes,
    guardian_digests: evidence.guardian_digests,
    rotation_vaa_sha256: evidence.rotation_sha256,
    signal_ledger_build: EXPECTED_SIGNAL_LEDGER_BUILD,
    caps_tinybars: {
      pyth: PYTH_STACK_CAP_TINYBARS.toString(),
      full: FULL_RECOVERY_CAP_TINYBARS.toString(),
    },
    maximum_step_allocations_tinybars: Object.fromEntries(
      Object.entries(STEP_BUDGETS).map(([id, budget]) => [id, { total: budget.total.toString(), gas_allowance: budget.gas.toString() }]),
    ),
    maintenance_limit: 'future Pro-signed governance VAA retrieval is unverified',
    broadcasts: false,
  };
  if (!options.execute) {
    const config = loadConfig();
    const anchor = options.verifyAnchor ? await governanceAnchor(config, artifacts.ReceiverImplementationHalf!.abi) : undefined;
    const [jumboGate, encoding] =
      options.verifyAnchor && anchor
        ? await Promise.all([jumboPlanGate(config, artifacts), validateDeploymentEncoding(config, artifacts, inputs, anchor)])
        : [undefined, undefined];
    console.info(JSON.stringify({ ...plan, anchor, jumbo_gate: jumboGate, encoding_check: encoding }));
    return;
  }
  if (options.approval !== APPROVAL_PHRASE) throw new Error(`execution_requires_--approval_${APPROVAL_PHRASE}`);
  const config = loadConfig();
  if (!config.operatorKey) throw new Error('deployment_operator_key_missing');
  const key = PrivateKey.fromStringECDSA(config.operatorKey);
  const deployer = loadOrCreateJumboDeployer(options.deployerKeyPath);
  const initial = readState(options.statePath, evidence.manifest_hash, deploymentIdentity(config, key, deployer));
  const budget = await feeGate(config, initial);
  const state = await deployAll(config, options.statePath, options.successorStatePath, artifacts, inputs, key, deployer, initial);
  if (!state.finalized_anchor || state.finalized_anchor.latest_sequence !== state.anchor?.latest_sequence) {
    throw new Error('missing_finalized_governance_anchor');
  }
  const attestation = {
    status: 'compatible',
    verified_at: state.proof!.verified_at,
    ledger_address: state.addresses.SignalLedger,
    pyth_address: state.addresses.ERC1967Proxy,
    manifest_hash: evidence.manifest_hash,
    proof_sha256: state.proof!.update_sha256,
  };
  console.info(
    JSON.stringify({
      ...plan,
      broadcasts: true,
      budget,
      addresses: state.addresses,
      contract_ids: state.contract_ids,
      deployer: {
        account_id: state.identity.deployer_account_id,
        evm_address: state.identity.deployer_evm_address,
        public_key_sha256: sha256(state.identity.deployer_public_key),
      },
      anchor: state.anchor,
      finalized_anchor: state.finalized_anchor,
      proof: state.proof,
      calldata_hashes: state.calldata_hashes,
      oracle_attestation: attestation,
      next_step: 'review evidence and configure ledger cohorts; no paid lifecycle was started',
    }),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message.split('\n')[0] : 'pyth_pro_deployment_failed');
  process.exitCode = 1;
});
