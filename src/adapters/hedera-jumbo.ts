import {
  AccountCreateTransaction,
  AccountInfoQuery,
  Client,
  EthereumTransaction,
  FeeEstimateQuery,
  Hbar,
  NetworkVersionInfoQuery,
  PrivateKey,
  type Transaction,
} from '@hiero-ledger/sdk';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getAddress, getContractAddress, hexToBytes, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const HEDERA_TESTNET_CHAIN_ID = 296;
const MINIMUM_JUMBO_VERSION = Object.freeze({ major: 0, minor: 76, patch: 1 });

export type JumboDeployer = Readonly<{
  privateKey: PrivateKey;
  publicKey: string;
  evmAddress: Address;
}>;

type StoredDeployer = {
  version: 1;
  private_key: string;
  public_key: string;
  evm_address: Address;
};

const toDeployer = (privateKey: PrivateKey): JumboDeployer => {
  const evmAddress = privateKeyToAccount(`0x${privateKey.toStringRaw()}`).address;
  return Object.freeze({
    privateKey,
    publicKey: privateKey.publicKey.toString(),
    evmAddress: getAddress(evmAddress),
  });
};

function validateStoredDeployer(value: unknown): StoredDeployer {
  if (!value || typeof value !== 'object') throw new Error('invalid_jumbo_deployer_secret');
  const item = value as Record<string, unknown>;
  if (item.version !== 1 || typeof item.private_key !== 'string' || typeof item.public_key !== 'string' || typeof item.evm_address !== 'string')
    throw new Error('invalid_jumbo_deployer_secret');
  return item as StoredDeployer;
}

export function generateJumboDeployer(): JumboDeployer {
  return toDeployer(PrivateKey.generateECDSA());
}

export function loadOrCreateJumboDeployer(path: string): JumboDeployer {
  if (existsSync(path)) {
    if ((statSync(path).mode & 0o077) !== 0) throw new Error('insecure_jumbo_deployer_secret_permissions');
    const stored = validateStoredDeployer(JSON.parse(readFileSync(path, 'utf8')));
    const deployer = toDeployer(PrivateKey.fromStringECDSA(stored.private_key));
    if (deployer.publicKey !== stored.public_key || deployer.evmAddress !== getAddress(stored.evm_address)) {
      throw new Error('jumbo_deployer_secret_identity_mismatch');
    }
    return deployer;
  }
  const deployer = generateJumboDeployer();
  const stored: StoredDeployer = {
    version: 1,
    private_key: deployer.privateKey.toStringRaw(),
    public_key: deployer.publicKey,
    evm_address: deployer.evmAddress,
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(stored, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  return deployer;
}

export function createJumboDeployerAccountTransaction(deployer: JumboDeployer): AccountCreateTransaction {
  return new AccountCreateTransaction().setECDSAKeyWithAlias(deployer.privateKey.publicKey).setInitialBalance(Hbar.fromTinybars(0));
}

export async function verifyJumboDeployerAccount(input: { client: Client; deployer: JumboDeployer; accountId: string; minimumNonce: number; maximumNonce?: number }) {
  const info = await new AccountInfoQuery().setAccountId(input.accountId).execute(input.client);
  const nonce = Number(info.ethereumNonce);
  const maximumNonce = input.maximumNonce ?? input.minimumNonce;
  if (
    !Number.isSafeInteger(input.minimumNonce) ||
    !Number.isSafeInteger(maximumNonce) ||
    input.minimumNonce < 0 ||
    maximumNonce < input.minimumNonce ||
    info.accountId.toString() !== input.accountId ||
    info.key?.toString() !== input.deployer.publicKey ||
    info.contractAccountId?.toLowerCase() !== input.deployer.evmAddress.slice(2).toLowerCase() ||
    !Number.isSafeInteger(nonce) ||
    nonce < input.minimumNonce ||
    nonce > maximumNonce
  ) {
    throw new Error('jumbo_deployer_account_identity_or_nonce_mismatch');
  }
  return Object.freeze({ accountId: info.accountId.toString(), ethereumNonce: nonce });
}

export async function buildJumboCreateTransaction(input: { deployer: JumboDeployer; nonce: number; initCode: Hex; gasLimit: bigint; maxGasAllowanceTinybars: bigint }): Promise<{
  transaction: EthereumTransaction;
  evmAddress: Address;
  rawEthereumData: Hex;
}> {
  if (!Number.isSafeInteger(input.nonce) || input.nonce < 0 || input.gasLimit <= 0n || input.maxGasAllowanceTinybars <= 0n) {
    throw new Error('invalid_jumbo_deployment_parameters');
  }
  const account = privateKeyToAccount(`0x${input.deployer.privateKey.toStringRaw()}`);
  const rawEthereumData = await account.signTransaction({
    chainId: HEDERA_TESTNET_CHAIN_ID,
    type: 'eip1559',
    nonce: input.nonce,
    gas: input.gasLimit,
    maxFeePerGas: 0n,
    maxPriorityFeePerGas: 0n,
    data: input.initCode,
  });
  const evmAddress = getContractAddress({
    from: input.deployer.evmAddress,
    nonce: BigInt(input.nonce),
  });
  const transaction = new EthereumTransaction().setEthereumData(hexToBytes(rawEthereumData)).setMaxGasAllowanceHbar(Hbar.fromTinybars(input.maxGasAllowanceTinybars.toString()));
  return { transaction, evmAddress, rawEthereumData };
}

export async function estimateTransactionFee(client: Client, transaction: Transaction): Promise<bigint> {
  const estimate = await new FeeEstimateQuery().setTransaction(transaction).execute(client);
  return BigInt(estimate.total.toString());
}

export async function verifyJumboNetworkVersion(client: Client) {
  const info = await new NetworkVersionInfoQuery().execute(client);
  const services = {
    major: Number(info.servicesVersion.major),
    minor: Number(info.servicesVersion.minor),
    patch: Number(info.servicesVersion.patch),
  };
  const current = services.major * 1_000_000 + services.minor * 1_000 + services.patch;
  const minimum = MINIMUM_JUMBO_VERSION.major * 1_000_000 + MINIMUM_JUMBO_VERSION.minor * 1_000 + MINIMUM_JUMBO_VERSION.patch;
  if (current < minimum) throw new Error('hedera_jumbo_transactions_not_supported');
  return Object.freeze({
    services: `${services.major}.${services.minor}.${services.patch}`,
    minimum: `${MINIMUM_JUMBO_VERSION.major}.${MINIMUM_JUMBO_VERSION.minor}.${MINIMUM_JUMBO_VERSION.patch}`,
  });
}

export async function verifyJumboContractMapping(input: { mirrorUrl: string; evmAddress: Address; nativeContractId: string }): Promise<void> {
  const response = await fetch(`${input.mirrorUrl}/contracts/${input.evmAddress}`);
  if (!response.ok) throw new Error(`jumbo_contract_mapping_http_${response.status}`);
  const body = (await response.json()) as Record<string, unknown>;
  if (body.contract_id !== input.nativeContractId || typeof body.evm_address !== 'string' || getAddress(body.evm_address) !== input.evmAddress)
    throw new Error('jumbo_contract_mapping_mismatch');
}
