import {
  getAddress,
  getContractAddress,
  isAddress,
  zeroAddress,
  type Address,
} from "viem";
import { ETH_USD, POLICY, SCHEMA_ID } from "./signal.ts";
import { SUBSCRIPTION_HORIZON_SECONDS } from "./subscription.ts";
import {
  SUBSCRIPTION_TOKEN_NAME,
  SUBSCRIPTION_TOKEN_SYMBOL,
} from "./subscription-token.ts";

const TINYBARS_PER_HBAR = 100_000_000n;
const WEIBARS_PER_TINYBAR = 10_000_000_000n;
// Fixed service charges cover two jumbo creates, token setup/funding,
// registration, HSS scheduling, HCS evidence, and the one-shot lifecycle.
const DEPLOYER_SERVICE_USD_CENTS = 331n;
const BUYER_SERVICE_USD_CENTS = 20n;
// Gas covers deploys plus checkpoint/commit/reveal/grade for the operator and
// allowance/create/schedule/manual-close for the buyer.
const DEPLOYER_GAS_LIMIT = 8_000_000n;
const BUYER_GAS_LIMIT = 4_000_000n;
const DEMO_AUTOMATION_RESERVE_TINYBARS = 100_000_000n;

export const P1_DEPLOYER_CAP_TINYBARS = 52n * TINYBARS_PER_HBAR;
export const P1_BUYER_CAP_TINYBARS = 8n * TINYBARS_PER_HBAR;
export const P1_BUYER_TOPUP_TINYBARS = 5n * TINYBARS_PER_HBAR;
export const SMTT_TOKEN = Object.freeze({
  name: SUBSCRIPTION_TOKEN_NAME,
  symbol: SUBSCRIPTION_TOKEN_SYMBOL,
  decimals: 6,
  initialSupply: 100_000_000n,
  maxSupply: 100_000_000n,
  buyerFundingTarget: 10_000_000n,
});

const P0_REQUIRED_JUMBO_STEPS = Object.freeze([
  "contract.ReceiverSetup",
  "contract.ReceiverImplementationHalf",
  "contract.WormholeReceiver",
  "contract.PythUpgradable",
  "contract.ERC1967Proxy",
  "contract.SignalLedger",
]);
const ACCOUNT_ID = /^0\.0\.[1-9][0-9]{0,18}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const HEX_SHA256 = /^0x[0-9a-f]{64}$/;
const P0_SOURCE_COMMIT = "859113ec53e59a3abaeeb3333ae71ef1fa09615e";
const P0_MANIFEST_HASH =
  "282c5851e4aee85fc071ab0a4a45e4ea5f86766c16c83d68c4f207e3094c3dab";

export type P1JumboHandoff = Readonly<{
  accountId: string;
  deployerPublicKey: string;
  deployerEvmAddress: Address;
  operatorId: string;
  operatorKeySha256: string;
  registryAddress: Address;
  pythAddress: Address;
  p0ManifestHash: string;
  nextNonce: number;
  subscriptionVaultNonce: number;
  subscriptionLedgerNonce: number;
}>;

const object = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export function deriveP1JumboHandoff(value: unknown): P1JumboHandoff {
  const state = object(value);
  const identity = object(state?.identity);
  const addresses = object(state?.addresses);
  const steps = object(state?.steps);
  const proof = object(state?.proof);
  const anchor = object(state?.anchor);
  const finalizedAnchor = object(state?.finalized_anchor);
  const runtimeHashes = object(state?.deployed_runtime_hashes);
  const contractSteps = Object.entries(steps ?? {}).filter(([id]) =>
    id.startsWith("contract."),
  );
  const latest = (id: string) => {
    const attempts = object(steps?.[id])?.attempts;
    return Array.isArray(attempts) ? object(attempts.at(-1)) : null;
  };
  const accountAttempt = latest("account.deployer");
  const rotationAttempt = latest("receiver.rotate");
  const isComplete =
    state?.version === 2 &&
    state.network === "hedera:testnet" &&
    state.source_commit === P0_SOURCE_COMMIT &&
    state.manifest_hash === P0_MANIFEST_HASH &&
    P0_REQUIRED_JUMBO_STEPS.every((id) => steps?.[id] !== undefined) &&
    contractSteps.every(([, step]) => {
      const attempts = object(step)?.attempts;
      const latest = Array.isArray(attempts) ? object(attempts.at(-1)) : null;
      return (
        latest?.status === "consensus" &&
        ACCOUNT_ID.test(String(latest.entity_id))
      );
    }) &&
    accountAttempt?.status === "consensus" &&
    ACCOUNT_ID.test(String(accountAttempt.entity_id)) &&
    rotationAttempt?.status === "consensus" &&
    proof?.authentic === true &&
    proof.corrupted_rejected === true &&
    typeof anchor?.latest_sequence === "string" &&
    anchor.latest_sequence === finalizedAnchor?.latest_sequence;
  if (!isComplete || !identity || !addresses)
    throw new Error("p0_handoff_incomplete");
  const strings = {
    accountId: identity.deployer_account_id,
    deployerPublicKey: identity.deployer_public_key,
    operatorId: identity.operator_id,
    operatorKeySha256: identity.operator_key_sha256,
    p0ManifestHash: state.manifest_hash,
  };
  if (
    !ACCOUNT_ID.test(String(strings.accountId)) ||
    strings.accountId !== accountAttempt?.entity_id ||
    !ACCOUNT_ID.test(String(strings.operatorId)) ||
    typeof strings.deployerPublicKey !== "string" ||
    !SHA256.test(String(strings.operatorKeySha256)) ||
    !SHA256.test(String(strings.p0ManifestHash)) ||
    !P0_REQUIRED_JUMBO_STEPS.map((id) => id.slice("contract.".length)).every(
      (name) => HEX_SHA256.test(String(runtimeHashes?.[name])),
    ) ||
    typeof identity.deployer_evm_address !== "string" ||
    typeof identity.registry_address !== "string" ||
    typeof addresses.ERC1967Proxy !== "string" ||
    typeof addresses.SignalLedger !== "string" ||
    !isAddress(identity.deployer_evm_address) ||
    !isAddress(identity.registry_address) ||
    !isAddress(addresses.ERC1967Proxy) ||
    !isAddress(addresses.SignalLedger) ||
    [
      identity.deployer_evm_address,
      identity.registry_address,
      addresses.ERC1967Proxy,
      addresses.SignalLedger,
    ].some((address) => getAddress(address as string) === zeroAddress)
  )
    throw new Error("p0_handoff_invalid");
  const nextNonce = contractSteps.length;
  return Object.freeze({
    accountId: String(strings.accountId),
    deployerPublicKey: strings.deployerPublicKey,
    deployerEvmAddress: getAddress(identity.deployer_evm_address),
    operatorId: String(strings.operatorId),
    operatorKeySha256: String(strings.operatorKeySha256),
    registryAddress: getAddress(identity.registry_address),
    pythAddress: getAddress(addresses.ERC1967Proxy),
    p0ManifestHash: String(strings.p0ManifestHash),
    nextNonce,
    subscriptionVaultNonce: nextNonce,
    subscriptionLedgerNonce: nextNonce + 1,
  });
}

export function completedP1JumboNonce(
  value: unknown,
  handoff: P1JumboHandoff,
): number {
  const fail = (): never => {
    throw new Error("p1_successor_journal_incomplete");
  };
  const state = object(value);
  const identity = object(state?.identity);
  const nonces = object(state?.nonces);
  const steps = object(state?.steps);
  const addresses = object(state?.addresses);
  const contractIds = object(state?.contract_ids);
  if (
    state?.version !== 1 ||
    state.network !== "hedera:testnet" ||
    state.p0_manifest_hash !== handoff.p0ManifestHash ||
    !identity ||
    !nonces ||
    !steps ||
    !addresses ||
    !contractIds
  )
    return fail();
  const expectedIdentity = {
    operator_id: handoff.operatorId,
    operator_key_sha256: handoff.operatorKeySha256,
    registry_address: handoff.registryAddress,
    deployer_public_key: handoff.deployerPublicKey,
    deployer_evm_address: handoff.deployerEvmAddress,
    deployer_account_id: handoff.accountId,
  };
  if (
    Object.keys(identity).length !== Object.keys(expectedIdentity).length ||
    Object.entries(expectedIdentity).some(
      ([key, expected]) => identity[key] !== expected,
    ) ||
    nonces.subscription_vault !== handoff.subscriptionVaultNonce ||
    nonces.subscription_ledger !== handoff.subscriptionLedgerNonce
  )
    return fail();
  const contracts = [
    ["SubscriptionVault", handoff.subscriptionVaultNonce],
    ["SubscriptionLedger", handoff.subscriptionLedgerNonce],
  ] as const;
  const knownSteps = new Set(contracts.map(([name]) => `contract.${name}`));
  if (
    Object.keys(steps).some(
      (id) => id.startsWith("contract.") && !knownSteps.has(id),
    )
  )
    return fail();
  for (const [name, nonce] of contracts) {
    const attempts = object(steps[`contract.${name}`])?.attempts;
    const latest = Array.isArray(attempts) ? object(attempts.at(-1)) : null;
    const entityId = String(latest?.entity_id ?? "");
    const expectedAddress = getContractAddress({
      from: handoff.deployerEvmAddress,
      nonce: BigInt(nonce),
    });
    if (
      latest?.status !== "consensus" ||
      !ACCOUNT_ID.test(entityId) ||
      typeof addresses[name] !== "string" ||
      !isAddress(addresses[name] as string) ||
      getAddress(addresses[name] as string) !== expectedAddress ||
      contractIds[name] !== entityId
    )
      return fail();
  }
  return handoff.subscriptionLedgerNonce + 1;
}

type ExchangeRate = { cent_equivalent: bigint; hbar_equivalent: bigint };
export type P1BootstrapEstimate = {
  deployerGasTinybars: bigint;
  buyerGasTinybars: bigint;
  deployerServiceTinybars: bigint;
  buyerServiceTinybars: bigint;
  reserveTinybars: bigint;
  deployerTotalTinybars: bigint;
  buyerTotalTinybars: bigint;
  totalTinybars: bigint;
};

const divideCeil = (value: bigint, divisor: bigint) =>
  (value + divisor - 1n) / divisor;

export function estimateP1BootstrapTinybars(
  gasPriceWeibars: bigint,
  rate: ExchangeRate,
): P1BootstrapEstimate {
  if (
    gasPriceWeibars <= 0n ||
    rate.cent_equivalent <= 0n ||
    rate.hbar_equivalent <= 0n
  ) {
    throw new Error("invalid_p1_fee_quote");
  }
  const deployerGasTinybars = divideCeil(
    DEPLOYER_GAS_LIMIT * gasPriceWeibars,
    WEIBARS_PER_TINYBAR,
  );
  const buyerGasTinybars = divideCeil(
    BUYER_GAS_LIMIT * gasPriceWeibars,
    WEIBARS_PER_TINYBAR,
  );
  const deployerServiceTinybars = divideCeil(
    DEPLOYER_SERVICE_USD_CENTS * rate.hbar_equivalent * TINYBARS_PER_HBAR,
    rate.cent_equivalent,
  );
  const buyerServiceTinybars = divideCeil(
    BUYER_SERVICE_USD_CENTS * rate.hbar_equivalent * TINYBARS_PER_HBAR,
    rate.cent_equivalent,
  );
  const deployerTotalTinybars = deployerGasTinybars + deployerServiceTinybars;
  const buyerTotalTinybars =
    buyerGasTinybars + buyerServiceTinybars + DEMO_AUTOMATION_RESERVE_TINYBARS;
  return {
    deployerGasTinybars,
    buyerGasTinybars,
    deployerServiceTinybars,
    buyerServiceTinybars,
    reserveTinybars: DEMO_AUTOMATION_RESERVE_TINYBARS,
    deployerTotalTinybars,
    buyerTotalTinybars,
    totalTinybars: deployerTotalTinybars + buyerTotalTinybars,
  };
}

export function requireP1BootstrapBudget(
  estimate: P1BootstrapEstimate,
  deployerBalanceTinybars: bigint,
  buyerBalanceTinybars: bigint,
) {
  requireP1ResumeBudget(
    estimate,
    deployerBalanceTinybars,
    buyerBalanceTinybars,
    {
      deployer: 0n,
      buyer: 0n,
    },
  );
}

export function requireP1ResumeBudget(
  estimate: P1BootstrapEstimate,
  deployerBalanceTinybars: bigint,
  buyerBalanceTinybars: bigint,
  confirmed: { deployer: bigint; buyer: bigint },
) {
  if (estimate.deployerTotalTinybars > P1_DEPLOYER_CAP_TINYBARS) {
    throw new Error("p1_deployer_cap_exceeded");
  }
  if (estimate.buyerTotalTinybars > P1_BUYER_CAP_TINYBARS) {
    throw new Error("p1_buyer_cap_exceeded");
  }
  if (confirmed.deployer < 0n || confirmed.deployer > P1_DEPLOYER_CAP_TINYBARS)
    throw new Error("invalid_p1_deployer_spend");
  if (confirmed.buyer < 0n || confirmed.buyer > P1_BUYER_CAP_TINYBARS)
    throw new Error("invalid_p1_buyer_spend");
  if (deployerBalanceTinybars < P1_DEPLOYER_CAP_TINYBARS - confirmed.deployer) {
    throw new Error("p1_deployer_balance_insufficient");
  }
  if (buyerBalanceTinybars < P1_BUYER_CAP_TINYBARS - confirmed.buyer) {
    throw new Error("p1_buyer_balance_insufficient");
  }
}

export function requireP1PreTopupBudget(
  deployerBalanceTinybars: bigint,
  buyerBalanceTinybars: bigint,
  confirmedFees: { deployer: bigint; buyer: bigint },
  isTopupComplete: boolean,
) {
  if (
    confirmedFees.deployer < 0n ||
    confirmedFees.deployer > P1_DEPLOYER_CAP_TINYBARS ||
    confirmedFees.buyer < 0n ||
    confirmedFees.buyer > P1_BUYER_CAP_TINYBARS
  )
    throw new Error("invalid_p1_spend");
  const topup = isTopupComplete ? 0n : P1_BUYER_TOPUP_TINYBARS;
  if (
    deployerBalanceTinybars <
    P1_DEPLOYER_CAP_TINYBARS - confirmedFees.deployer + topup
  )
    throw new Error("p1_deployer_balance_insufficient");
  if (
    buyerBalanceTinybars + topup <
    P1_BUYER_CAP_TINYBARS - confirmedFees.buyer
  )
    throw new Error("p1_buyer_balance_insufficient");
}

export const HTS_SYSTEM_ADDRESS = getAddress(
  "0x0000000000000000000000000000000000000167",
);
export const HSS_SYSTEM_ADDRESS = getAddress(
  "0x000000000000000000000000000000000000016b",
);

type VaultDependencies = {
  registryAddress: Address;
  tokenAddress: Address;
  adminAddress: Address;
};

type LedgerDependencies = {
  registryAddress: Address;
  pythAddress: Address;
  vaultAddress: Address;
};

function assertDependencies(dependencies: Record<string, Address>) {
  if (
    Object.values(dependencies).some(
      (value) => !isAddress(value) || value === zeroAddress,
    )
  ) {
    throw new Error("invalid_subscription_deployment_dependency");
  }
}

export function subscriptionVaultDeploymentArguments(
  dependencies: VaultDependencies,
) {
  assertDependencies(dependencies);
  return [
    dependencies.registryAddress,
    HTS_SYSTEM_ADDRESS,
    HSS_SYSTEM_ADDRESS,
    dependencies.tokenAddress,
    dependencies.adminAddress,
    SCHEMA_ID,
  ] as const;
}

export function subscriptionLedgerDeploymentArguments(
  dependencies: LedgerDependencies,
) {
  assertDependencies(dependencies);
  return [
    dependencies.registryAddress,
    dependencies.vaultAddress,
    dependencies.pythAddress,
    SCHEMA_ID,
    ETH_USD,
    BigInt(SUBSCRIPTION_HORIZON_SECONDS),
    BigInt(POLICY.issueTolerance),
    BigInt(POLICY.oracleWindow),
    100,
    5,
  ] as const;
}

export function subscriptionDeploymentArguments(
  dependencies: VaultDependencies & LedgerDependencies,
) {
  return {
    vault: subscriptionVaultDeploymentArguments(dependencies),
    ledger: subscriptionLedgerDeploymentArguments(dependencies),
  };
}
