import { PrivateKey, type Client, type Transaction } from "@hiero-ledger/sdk";
import { encodeDeployData, keccak256, type Address, type Hex } from "viem";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { loadConfig, type Config } from "../src/adapters/config.ts";
import {
  accountAddress,
  operatorClient,
  publicClient,
} from "../src/adapters/hedera.ts";
import { assertSubscriptionToken } from "../src/protocol/subscription-token.ts";
import {
  buildJumboCreateTransaction,
  loadOrCreateJumboDeployer,
  verifyJumboContractMapping,
  verifyJumboDeployerAccount,
  verifyJumboNetworkVersion,
  type JumboDeployer,
} from "../src/adapters/hedera-jumbo.ts";
import {
  ResumableTransactionRunner,
  type TransactionStep,
} from "../src/adapters/hedera-resumable.ts";
import {
  HSS_SYSTEM_ADDRESS,
  HTS_SYSTEM_ADDRESS,
  P1_BUYER_CAP_TINYBARS,
  P1_BUYER_TOPUP_TINYBARS,
  P1_DEPLOYER_CAP_TINYBARS,
  SMTT_TOKEN,
  deriveP1JumboHandoff,
  estimateP1BootstrapTinybars,
  requireP1PreTopupBudget,
  requireP1ResumeBudget,
  subscriptionLedgerDeploymentArguments,
  subscriptionVaultDeploymentArguments,
} from "../src/protocol/subscription-deployment.ts";
import { fetchJson } from "../src/adapters/http.ts";
import {
  mirrorTransactionId,
  normalizeTransactionId,
} from "../src/adapters/payment.ts";
import { verifySubscriptionContracts } from "./lib/subscription-verifier.ts";
import {
  availableSubscriptionAgentId,
  prepareSubscriptionAgent,
  SUBSCRIPTION_AGENT_REGISTRATION_MAX_FEE_TINYBARS,
  verifySubscriptionAgent,
  type SubscriptionAgentRecord,
} from "./lib/subscription-agent.ts";
import {
  createSubscriptionToken,
  SUBSCRIPTION_TOKEN_CREATE_MAX_FEE_TINYBARS,
  type NativeSubscriptionTokenRecord,
} from "./lib/subscription-token-deployer.ts";
import { loadSubscriptionArtifacts } from "./lib/subscription-source.ts";
import {
  provisionSubscriptionBuyer,
  isSubscriptionBuyerTopupComplete,
  topUpSubscriptionBuyer,
  SUBSCRIPTION_BUYER_ASSOCIATION_MAX_FEE_TINYBARS,
  SUBSCRIPTION_BUYER_TOPUP_MAX_FEE_TINYBARS,
  SUBSCRIPTION_TOKEN_FUNDING_MAX_FEE_TINYBARS,
} from "./lib/subscription-buyer-provisioner.ts";

const DEPLOYMENT_PATH = "deployments/testnet.json";
const DEFAULT_P0_STATE = "data/pyth-pro-deployment.json";
const DEFAULT_P1_STATE = "data/subscription-deployment.json";
const DEFAULT_DEPLOYER_KEY = "data/pyth-pro-deployer.json";
const WEIBARS_PER_TINYBAR = 10_000_000_000n;
const HBAR_TINYBARS = 100_000_000n;
const DEPLOYMENT_BUDGETS = Object.freeze({
  "contract.SubscriptionVault": {
    total: 16n * HBAR_TINYBARS,
    gas: 4n * HBAR_TINYBARS,
  },
  "contract.SubscriptionLedger": {
    total: 16n * HBAR_TINYBARS,
    gas: 4n * HBAR_TINYBARS,
  },
  "agent.register": {
    total: SUBSCRIPTION_AGENT_REGISTRATION_MAX_FEE_TINYBARS,
    gas: 0n,
  },
});
const OPERATOR_TRANSACTION_FEE_CEILING =
  SUBSCRIPTION_TOKEN_CREATE_MAX_FEE_TINYBARS +
  SUBSCRIPTION_TOKEN_FUNDING_MAX_FEE_TINYBARS +
  Object.values(DEPLOYMENT_BUDGETS).reduce(
    (sum, budget) => sum + budget.total,
    0n,
  );

type ContractRecord = {
  address: Address;
  native_id: string;
  transaction_id: string;
  block?: number;
};
type TokenRecord = NativeSubscriptionTokenRecord;
type Deployment = Record<string, unknown> & {
  network: string;
  registry?: ContractRecord;
  subscription_token?: TokenRecord;
  subscription_vault?: ContractRecord & {
    hts_address: Address;
    schedule_service_address: Address;
  };
  subscription_ledger?: ContractRecord;
  subscription_agent?: SubscriptionAgentRecord;
  subscription_buyer_topup?: {
    from: string;
    to: string;
    amount_tinybars: string;
    transaction_id: string;
    fee_tinybars: string;
  };
};

type P1Phase = "deployer";
type P1State = {
  version: 1;
  network: "hedera:testnet";
  manifest_hash: Hex;
  p0_manifest_hash: string;
  identity: {
    operator_id: string;
    operator_key_sha256: string;
    registry_address: Address;
    deployer_public_key: string;
    deployer_evm_address: Address;
    deployer_account_id: string;
  };
  nonces: { subscription_vault: number; subscription_ledger: number };
  steps: Record<string, TransactionStep<P1Phase>>;
  addresses: Record<string, Address>;
  contract_ids: Record<string, string>;
  agent_id?: string;
};

function readDeployment(): Deployment {
  if (!existsSync(DEPLOYMENT_PATH)) return { network: "hedera:testnet" };
  const deployment = JSON.parse(
    readFileSync(DEPLOYMENT_PATH, "utf8"),
  ) as Deployment;
  if (deployment.network !== "hedera:testnet")
    throw new Error("subscription_deployment_network_mismatch");
  return deployment;
}

function saveDeployment(value: Deployment) {
  mkdirSync(dirname(DEPLOYMENT_PATH), { recursive: true });
  const temporary = `${DEPLOYMENT_PATH}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, DEPLOYMENT_PATH);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const value = (name: string, fallback: string) => {
    const index = args.indexOf(name);
    return resolve(index < 0 ? fallback : (args[index + 1] ?? ""));
  };
  return {
    execute: args.includes("--execute"),
    p0StatePath: value("--pyth-state", DEFAULT_P0_STATE),
    statePath: value("--state", DEFAULT_P1_STATE),
    deployerKeyPath: value("--deployer-key", DEFAULT_DEPLOYER_KEY),
  };
}

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function readP0Handoff(path: string) {
  if (!existsSync(path)) throw new Error("p0_handoff_missing");
  return deriveP1JumboHandoff(JSON.parse(readFileSync(path, "utf8")));
}

function p1Identity(
  config: Config,
  deployer: JumboDeployer,
  handoff: ReturnType<typeof deriveP1JumboHandoff>,
) {
  if (!config.operatorId || !config.operatorKey || !config.registryAddress)
    throw new Error("subscription_deployment_credentials_required");
  const operatorKey = PrivateKey.fromStringECDSA(config.operatorKey);
  if (
    handoff.operatorId !== config.operatorId ||
    handoff.operatorKeySha256 !== sha256(operatorKey.publicKey.toString()) ||
    handoff.registryAddress.toLowerCase() !==
      config.registryAddress.toLowerCase() ||
    handoff.deployerPublicKey !== deployer.publicKey ||
    handoff.deployerEvmAddress.toLowerCase() !==
      deployer.evmAddress.toLowerCase()
  )
    throw new Error("p1_p0_identity_mismatch");
  return {
    operatorKey,
    identity: {
      operator_id: config.operatorId,
      operator_key_sha256: handoff.operatorKeySha256,
      registry_address: handoff.registryAddress,
      deployer_public_key: deployer.publicKey,
      deployer_evm_address: deployer.evmAddress,
      deployer_account_id: handoff.accountId,
    },
  };
}

function saveP1State(path: string, state: P1State) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, path);
}

function readP1State(
  path: string,
  expected: Omit<P1State, "steps" | "addresses" | "contract_ids" | "agent_id">,
): P1State {
  if (!existsSync(path))
    return { ...expected, steps: {}, addresses: {}, contract_ids: {} };
  const state = JSON.parse(readFileSync(path, "utf8")) as P1State;
  const same =
    state.version === expected.version &&
    state.network === expected.network &&
    state.manifest_hash === expected.manifest_hash &&
    state.p0_manifest_hash === expected.p0_manifest_hash &&
    JSON.stringify(state.identity) === JSON.stringify(expected.identity) &&
    JSON.stringify(state.nonces) === JSON.stringify(expected.nonces);
  if (!same || !state.steps || !state.addresses || !state.contract_ids)
    throw new Error("p1_deployment_state_mismatch");
  return state;
}

async function plan(config: Config) {
  if (!config.operatorId || !config.buyerId)
    throw new Error("subscription_accounts_required");
  if (OPERATOR_TRANSACTION_FEE_CEILING > P1_DEPLOYER_CAP_TINYBARS)
    throw new Error("p1_operator_transaction_fee_ceiling_exceeded");
  const chain = publicClient(config);
  const [gasPrice, deployerBalanceWeibars, buyerBalanceWeibars, exchange] =
    await Promise.all([
      chain.getGasPrice(),
      chain.getBalance({ address: accountAddress(config.operatorId) }),
      chain.getBalance({ address: accountAddress(config.buyerId) }),
      fetchJson(`${config.mirrorUrl}/network/exchangerate`),
    ]);
  const current = (exchange as { current_rate?: Record<string, unknown> })
    .current_rate;
  const estimate = estimateP1BootstrapTinybars(gasPrice, {
    cent_equivalent: BigInt(String(current?.cent_equivalent ?? "0")),
    hbar_equivalent: BigInt(String(current?.hbar_equivalent ?? "0")),
  });
  return {
    gas_price_weibars: gasPrice.toString(),
    estimate,
    deployerBalanceTinybars: deployerBalanceWeibars / WEIBARS_PER_TINYBAR,
    buyerBalanceTinybars: buyerBalanceWeibars / WEIBARS_PER_TINYBAR,
  };
}

function effectiveTokenConfig(
  config: Config,
  token: TokenRecord,
  deployment: Deployment,
): Config {
  return {
    ...config,
    subscriptionTokenId: token.id,
    subscriptionTokenAddress: token.address,
    subscriptionTokenSymbol: token.symbol,
    subscriptionTokenDecimals: token.decimals,
    subscriptionVaultAddress: deployment.subscription_vault?.address,
    subscriptionLedgerAddress: deployment.subscription_ledger?.address,
    subscriptionAgentId: deployment.subscription_agent?.id,
  };
}

async function verifiedToken(config: Config, token: TokenRecord) {
  const metadata = await fetchJson(`${config.mirrorUrl}/tokens/${token.id}`);
  assertSubscriptionToken(metadata, {
    id: token.id,
    address: token.address,
    symbol: token.symbol,
    decimals: token.decimals,
  });
  return metadata as Record<string, unknown>;
}

type PreparedContract = Awaited<ReturnType<typeof buildJumboCreateTransaction>>;

async function prepareContracts(input: {
  deployer: JumboDeployer;
  registryAddress: Address;
  tokenAddress: Address;
  adminAddress: Address;
  pythAddress: Address;
  vaultNonce: number;
  ledgerNonce: number;
}) {
  const artifacts = loadSubscriptionArtifacts();
  const vaultArtifact = artifacts.SubscriptionVault;
  const vaultInit = encodeDeployData({
    ...vaultArtifact,
    args: subscriptionVaultDeploymentArguments({
      registryAddress: input.registryAddress,
      tokenAddress: input.tokenAddress,
      adminAddress: input.adminAddress,
    }),
  });
  const vault = await buildJumboCreateTransaction({
    deployer: input.deployer,
    nonce: input.vaultNonce,
    initCode: vaultInit,
    gasLimit: 3_000_000n,
    maxGasAllowanceTinybars:
      DEPLOYMENT_BUDGETS["contract.SubscriptionVault"].gas,
  });
  const ledgerArtifact = artifacts.SubscriptionLedger;
  const ledgerInit = encodeDeployData({
    ...ledgerArtifact,
    args: subscriptionLedgerDeploymentArguments({
      registryAddress: input.registryAddress,
      vaultAddress: vault.evmAddress,
      pythAddress: input.pythAddress,
    }),
  });
  const ledger = await buildJumboCreateTransaction({
    deployer: input.deployer,
    nonce: input.ledgerNonce,
    initCode: ledgerInit,
    gasLimit: 3_000_000n,
    maxGasAllowanceTinybars:
      DEPLOYMENT_BUDGETS["contract.SubscriptionLedger"].gas,
  });
  return {
    vault,
    ledger,
    manifestHash: keccak256(`0x${vaultInit.slice(2)}${ledgerInit.slice(2)}`),
  };
}

class P1ContractRunner {
  private readonly journal: ResumableTransactionRunner<P1Phase>;

  constructor(
    private state: P1State,
    private readonly statePath: string,
    client: Client,
    key: PrivateKey,
    private readonly mirrorUrl: string,
    private readonly priorOperatorFees: bigint,
  ) {
    this.journal = new ResumableTransactionRunner({
      client,
      key,
      mirrorUrl,
      getSteps: () => this.state.steps,
      saveSteps: (steps) => this.save({ ...this.state, steps }),
      capFor: () =>
        P1_DEPLOYER_CAP_TINYBARS -
        this.priorOperatorFees -
        Object.values(this.state.steps)
          .flatMap((step) => step.attempts)
          .filter((attempt) => attempt.status === "abandoned")
          .reduce(
            (sum, attempt) => sum + BigInt(attempt.fee_tinybars ?? "0"),
            0n,
          ),
      budgetFor: (id) => {
        const budget =
          DEPLOYMENT_BUDGETS[id as keyof typeof DEPLOYMENT_BUDGETS];
        if (!budget) throw new Error(`missing_p1_contract_budget:${id}`);
        return budget;
      },
      requiresEntity: (id) => id.startsWith("contract."),
      isNonReplannable: () => true,
    });
  }

  snapshot() {
    return this.state;
  }

  reserveAgentId(agentId: string) {
    if (this.state.agent_id && this.state.agent_id !== agentId)
      throw new Error("subscription_agent_id_conflict");
    this.save({ ...this.state, agent_id: agentId });
  }

  run(id: "agent.register", transaction: Transaction) {
    return this.journal.run(id, "deployer", () => transaction);
  }

  private save(state: P1State) {
    this.state = state;
    saveP1State(this.statePath, state);
  }

  async deploy(
    name: "SubscriptionVault" | "SubscriptionLedger",
    prepared: PreparedContract,
  ): Promise<ContractRecord> {
    const id = `contract.${name}`;
    await this.abandonInsufficientFee(id);
    const result = await this.journal.run(
      id,
      "deployer",
      () => prepared.transaction,
    );
    if (!result.entity_id) throw new Error(`missing_contract_id:${name}`);
    await verifyJumboContractMapping({
      mirrorUrl: this.mirrorUrl,
      evmAddress: prepared.evmAddress,
      nativeContractId: result.entity_id,
    });
    this.save({
      ...this.state,
      addresses: { ...this.state.addresses, [name]: prepared.evmAddress },
      contract_ids: { ...this.state.contract_ids, [name]: result.entity_id },
    });
    return {
      address: prepared.evmAddress,
      native_id: result.entity_id,
      transaction_id: result.transaction_id,
    };
  }

  private async abandonInsufficientFee(id: string) {
    const step = this.state.steps[id];
    const latest = step?.attempts.at(-1);
    if (!latest || !["planned", "submitted"].includes(latest.status)) return;
    const body = (await fetchJson(
      `${this.mirrorUrl}/transactions/${mirrorTransactionId(latest.transaction_id)}`,
    )) as { transactions?: Record<string, unknown>[] };
    const matches = (body.transactions ?? []).filter(
      (transaction) =>
        Number(transaction.nonce) === 0 &&
        typeof transaction.transaction_id === "string" &&
        normalizeTransactionId(transaction.transaction_id) ===
          normalizeTransactionId(latest.transaction_id),
    );
    if (matches.length === 0) return;
    if (
      matches.length !== 1 ||
      matches[0]!.result !== "INSUFFICIENT_TX_FEE" ||
      !/^\d+$/.test(String(matches[0]!.charged_tx_fee))
    )
      throw new Error(`p1_contract_outcome_unknown:${id}`);
    const attempts = step!.attempts.map((attempt, index, values) =>
      index === values.length - 1
        ? {
            ...attempt,
            status: "abandoned" as const,
            signed_transaction: "",
            fee_tinybars: String(matches[0]!.charged_tx_fee),
          }
        : attempt,
    );
    this.save({
      ...this.state,
      steps: { ...this.state.steps, [id]: { ...step!, attempts } },
    });
  }
}

function nonceRange(state: P1State, firstNonce: number) {
  const latest = ["SubscriptionVault", "SubscriptionLedger"].map((name) =>
    state.steps[`contract.${name}`]?.attempts.at(-1),
  );
  if (latest[1] && latest[0]?.status !== "consensus")
    throw new Error("p1_nonce_journal_out_of_order");
  const consensus = latest.filter(
    (attempt) => attempt?.status === "consensus",
  ).length;
  const unresolved = latest.filter(
    (attempt) =>
      attempt?.status === "planned" || attempt?.status === "submitted",
  ).length;
  return {
    minimum: firstNonce + consensus,
    maximum: firstNonce + consensus + unresolved,
  };
}

function preflightNonceRange(
  path: string,
  handoff: ReturnType<typeof deriveP1JumboHandoff>,
  identity: P1State["identity"],
) {
  if (!existsSync(path))
    return { minimum: handoff.nextNonce, maximum: handoff.nextNonce };
  const state = JSON.parse(readFileSync(path, "utf8")) as P1State;
  if (
    state.version !== 1 ||
    state.network !== "hedera:testnet" ||
    state.p0_manifest_hash !== handoff.p0ManifestHash ||
    JSON.stringify(state.identity) !== JSON.stringify(identity) ||
    state.nonces?.subscription_vault !== handoff.subscriptionVaultNonce ||
    state.nonces?.subscription_ledger !== handoff.subscriptionLedgerNonce ||
    !state.steps
  )
    throw new Error("p1_deployment_state_mismatch");
  return nonceRange(state, handoff.nextNonce);
}

async function verifyP1Nonce(
  client: Client,
  deployer: JumboDeployer,
  handoff: ReturnType<typeof deriveP1JumboHandoff>,
  state: P1State,
) {
  const range = nonceRange(state, handoff.nextNonce);
  await verifyJumboDeployerAccount({
    client,
    deployer,
    accountId: handoff.accountId,
    minimumNonce: range.minimum,
    maximumNonce: range.maximum,
  });
}

function journalNetworkFees(path: string, phase?: string) {
  if (!existsSync(path)) return 0n;
  const state = JSON.parse(readFileSync(path, "utf8")) as {
    steps?: Record<string, TransactionStep<string>>;
  };
  return Object.values(state.steps ?? {})
    .filter((step) => !phase || step.phase === phase)
    .flatMap((step) => step.attempts)
    .filter((attempt) => /^\d+$/.test(attempt.fee_tinybars ?? ""))
    .reduce((sum, attempt) => sum + BigInt(attempt.fee_tinybars!), 0n);
}

async function executeP1(
  options: ReturnType<typeof parseArgs>,
  config: Config,
  feePlan: Awaited<ReturnType<typeof plan>>,
) {
  if (
    !config.operatorId ||
    !config.operatorKey ||
    !config.buyerId ||
    !config.buyerKey
  )
    throw new Error("subscription_deployment_credentials_required");
  let deployment = readDeployment();
  if (!deployment.registry?.address) throw new Error("registry_not_deployed");
  const registryAddress = deployment.registry.address;
  const handoff = readP0Handoff(options.p0StatePath);
  if (registryAddress.toLowerCase() !== handoff.registryAddress.toLowerCase())
    throw new Error("p1_deployment_registry_mismatch");
  const deployer = loadOrCreateJumboDeployer(options.deployerKeyPath);
  const { operatorKey, identity } = p1Identity(config, deployer, handoff);
  const operator = operatorClient(config);
  const buyerKey = PrivateKey.fromStringECDSA(config.buyerKey);
  const buyer = operatorClient({
    ...config,
    operatorId: config.buyerId,
    operatorKey: config.buyerKey,
  });
  try {
    if (
      !existsSync(options.statePath) &&
      (deployment.subscription_vault || deployment.subscription_ledger)
    )
      throw new Error("p1_contract_record_without_journal");
    const preflightRange = preflightNonceRange(
      options.statePath,
      handoff,
      identity,
    );
    await verifyJumboNetworkVersion(operator);
    await verifyJumboDeployerAccount({
      client: operator,
      deployer,
      accountId: handoff.accountId,
      minimumNonce: preflightRange.minimum,
      maximumNonce: preflightRange.maximum,
    });
    const liquidityPath = `${options.statePath}.liquidity`;
    if (deployment.subscription_buyer_topup && !existsSync(liquidityPath))
      throw new Error("p1_topup_record_without_journal");
    let preparedFromExistingState:
      | Awaited<ReturnType<typeof prepareContracts>>
      | undefined;
    if (existsSync(options.statePath)) {
      const existingToken = deployment.subscription_token;
      if (!existingToken) throw new Error("p1_state_exists_without_token_record");
      await verifiedToken(
        effectiveTokenConfig(config, existingToken, deployment),
        existingToken,
      );
      preparedFromExistingState = await prepareContracts({
        deployer,
        registryAddress,
        tokenAddress: existingToken.address,
        adminAddress: accountAddress(config.operatorId),
        pythAddress: handoff.pythAddress,
        vaultNonce: handoff.subscriptionVaultNonce,
        ledgerNonce: handoff.subscriptionLedgerNonce,
      });
      readP1State(options.statePath, {
        version: 1,
        network: "hedera:testnet",
        manifest_hash: preparedFromExistingState.manifestHash,
        p0_manifest_hash: handoff.p0ManifestHash,
        identity,
        nonces: {
          subscription_vault: handoff.subscriptionVaultNonce,
          subscription_ledger: handoff.subscriptionLedgerNonce,
        },
      });
    }
    const confirmed = {
      deployer:
        journalNetworkFees(`${options.statePath}.token`) +
        journalNetworkFees(options.statePath) +
        journalNetworkFees(`${options.statePath}.buyer`, "operator") +
        journalNetworkFees(liquidityPath, "operator"),
      buyer: journalNetworkFees(`${options.statePath}.buyer`, "buyer"),
    };
    const isTopupComplete = isSubscriptionBuyerTopupComplete(
      liquidityPath,
      config,
      handoff,
    );
    requireP1PreTopupBudget(
      feePlan.deployerBalanceTinybars,
      feePlan.buyerBalanceTinybars,
      confirmed,
      isTopupComplete,
    );
    const topup = await topUpSubscriptionBuyer({
      operator,
      operatorKey,
      config,
      handoff,
      statePath: liquidityPath,
    });
    deployment = { ...deployment, subscription_buyer_topup: topup };
    saveDeployment(deployment);
    const fundedPlan = await plan(config);
    requireP1ResumeBudget(
      fundedPlan.estimate,
      fundedPlan.deployerBalanceTinybars,
      fundedPlan.buyerBalanceTinybars,
      {
        deployer:
          journalNetworkFees(`${options.statePath}.token`) +
          journalNetworkFees(options.statePath) +
          journalNetworkFees(`${options.statePath}.buyer`, "operator") +
          journalNetworkFees(liquidityPath, "operator"),
        buyer: journalNetworkFees(`${options.statePath}.buyer`, "buyer"),
      },
    );
    let token = deployment.subscription_token;
    if (!token) {
      if (existsSync(options.statePath))
        throw new Error("p1_state_exists_without_token_record");
      if (
        config.subscriptionTokenId &&
        config.subscriptionTokenAddress &&
        config.subscriptionTokenSymbol &&
        Number.isSafeInteger(config.subscriptionTokenDecimals)
      ) {
        token = {
          id: config.subscriptionTokenId,
          address: config.subscriptionTokenAddress,
          name: SMTT_TOKEN.name,
          symbol: config.subscriptionTokenSymbol,
          decimals: config.subscriptionTokenDecimals,
          initial_supply_atomic: "unknown",
          max_supply_atomic: "unknown",
          buyer_funding_target_atomic: SMTT_TOKEN.buyerFundingTarget.toString(),
        };
        await verifiedToken(config, token);
      } else {
        token = await createSubscriptionToken({
          client: operator,
          config,
          operatorKey,
          handoff,
          statePath: `${options.statePath}.token`,
        });
      }
      deployment = { ...deployment, subscription_token: token };
      saveDeployment(deployment);
    }
    const tokenConfig = effectiveTokenConfig(config, token, deployment);
    const tokenMetadata = await verifiedToken(tokenConfig, token);
    token = await provisionSubscriptionBuyer({
      operator,
      operatorKey,
      buyer,
      buyerKey,
      config: tokenConfig,
      handoff,
      token,
      treasuryAccountId: String(tokenMetadata.treasury_account_id),
      statePath: `${options.statePath}.buyer`,
    });
    deployment = { ...deployment, subscription_token: token };
    saveDeployment(deployment);
    const prepared =
      preparedFromExistingState ??
      (await prepareContracts({
        deployer,
        registryAddress,
        tokenAddress: token.address,
        adminAddress: accountAddress(config.operatorId),
        pythAddress: handoff.pythAddress,
        vaultNonce: handoff.subscriptionVaultNonce,
        ledgerNonce: handoff.subscriptionLedgerNonce,
      }));
    const initial = readP1State(options.statePath, {
      version: 1,
      network: "hedera:testnet",
      manifest_hash: prepared.manifestHash,
      p0_manifest_hash: handoff.p0ManifestHash,
      identity,
      nonces: {
        subscription_vault: handoff.subscriptionVaultNonce,
        subscription_ledger: handoff.subscriptionLedgerNonce,
      },
    });
    await verifyJumboNetworkVersion(operator);
    await verifyP1Nonce(operator, deployer, handoff, initial);
    const contracts = new P1ContractRunner(
      initial,
      options.statePath,
      operator,
      operatorKey,
      config.mirrorUrl,
      journalNetworkFees(`${options.statePath}.token`) +
        journalNetworkFees(`${options.statePath}.buyer`, "operator") +
        journalNetworkFees(liquidityPath, "operator"),
    );
    if (!deployment.subscription_vault) {
      const vault = await contracts.deploy("SubscriptionVault", prepared.vault);
      deployment = {
        ...deployment,
        subscription_vault: {
          ...vault,
          hts_address: HTS_SYSTEM_ADDRESS,
          schedule_service_address: HSS_SYSTEM_ADDRESS,
        },
      };
      saveDeployment(deployment);
    }
    const vaultAddress = deployment.subscription_vault?.address;
    if (!vaultAddress) throw new Error("subscription_vault_not_deployed");
    if (vaultAddress.toLowerCase() !== prepared.vault.evmAddress.toLowerCase())
      throw new Error("subscription_vault_address_mismatch");
    if (!deployment.subscription_vault?.native_id)
      throw new Error("subscription_vault_native_id_missing");
    await verifyJumboContractMapping({
      mirrorUrl: config.mirrorUrl,
      evmAddress: vaultAddress,
      nativeContractId: deployment.subscription_vault.native_id,
    });
    await verifyP1Nonce(operator, deployer, handoff, contracts.snapshot());
    if (!deployment.subscription_ledger) {
      const ledger = await contracts.deploy(
        "SubscriptionLedger",
        prepared.ledger,
      );
      deployment = {
        ...deployment,
        subscription_ledger: {
          ...ledger,
          block: Number(await publicClient(config).getBlockNumber()),
        },
      };
      saveDeployment(deployment);
    }
    if (
      deployment.subscription_ledger?.address.toLowerCase() !==
      prepared.ledger.evmAddress.toLowerCase()
    )
      throw new Error("subscription_ledger_address_mismatch");
    if (!deployment.subscription_ledger?.native_id)
      throw new Error("subscription_ledger_native_id_missing");
    await verifyJumboContractMapping({
      mirrorUrl: config.mirrorUrl,
      evmAddress: deployment.subscription_ledger.address,
      nativeContractId: deployment.subscription_ledger.native_id,
    });
    await verifyP1Nonce(operator, deployer, handoff, contracts.snapshot());
    const runtimeHashes = await verifySubscriptionContracts(
      config,
      vaultAddress,
      deployment.subscription_ledger.address,
      token.address,
      handoff.pythAddress,
    );
    if (!deployment.subscription_agent) {
      const agentId =
        contracts.snapshot().agent_id ??
        (await availableSubscriptionAgentId(config));
      contracts.reserveAgentId(agentId);
      const registrationConfig = {
        ...effectiveTokenConfig(config, token, deployment),
        subscriptionAgentId: agentId,
      };
      const preparedAgent = prepareSubscriptionAgent(
        registrationConfig,
        agentId,
      );
      const result = await contracts.run(
        "agent.register",
        preparedAgent.transaction,
      );
      const subscriptionAgent = await verifySubscriptionAgent(
        registrationConfig,
        agentId,
        preparedAgent.metadataUri,
        preparedAgent.metadataHash,
        result.transaction_id,
      );
      deployment = { ...deployment, subscription_agent: subscriptionAgent };
      saveDeployment(deployment);
    }
    const deployedAgent = deployment.subscription_agent;
    if (!deployedAgent) throw new Error("subscription_agent_not_deployed");
    const agentId = deployedAgent.id;
    contracts.reserveAgentId(agentId);
    const registrationConfig = {
      ...effectiveTokenConfig(config, token, deployment),
      subscriptionAgentId: agentId,
    };
    const preparedAgent = prepareSubscriptionAgent(registrationConfig, agentId);
    await verifySubscriptionAgent(
      registrationConfig,
      agentId,
      preparedAgent.metadataUri,
      preparedAgent.metadataHash,
      deployedAgent.registration_transaction_id,
    );
    console.info(
      JSON.stringify({
        execution_authorized: true,
        deployment,
        p0_manifest_hash: handoff.p0ManifestHash,
        p1_manifest_hash: contracts.snapshot().manifest_hash,
        jumbo_deployer_account_id: handoff.accountId,
        jumbo_nonces: contracts.snapshot().nonces,
        runtime_hashes: runtimeHashes,
        gross_cash_movement_tinybars: topup.amount_tinybars,
        topup_network_fee_tinybars: topup.fee_tinybars,
      }),
    );
  } finally {
    operator.close();
    buyer.close();
  }
}

async function main() {
  const options = parseArgs();
  const config = loadConfig();
  const feePlan = await plan(config);
  const publicPlan = {
    execution_authorized: options.execute,
    deployer_cap_tinybars: P1_DEPLOYER_CAP_TINYBARS.toString(),
    buyer_cap_tinybars: P1_BUYER_CAP_TINYBARS.toString(),
    estimated_total_tinybars: (
      feePlan.estimate.totalTinybars + SUBSCRIPTION_BUYER_TOPUP_MAX_FEE_TINYBARS
    ).toString(),
    estimated_deployer_tinybars: (
      feePlan.estimate.deployerTotalTinybars +
      SUBSCRIPTION_BUYER_TOPUP_MAX_FEE_TINYBARS
    ).toString(),
    estimated_buyer_tinybars: feePlan.estimate.buyerTotalTinybars.toString(),
    reserve_tinybars: feePlan.estimate.reserveTinybars.toString(),
    deployer_balance_tinybars: feePlan.deployerBalanceTinybars.toString(),
    buyer_balance_tinybars: feePlan.buyerBalanceTinybars.toString(),
    contract_transport: "HIP-1086 jumbo EthereumTransaction",
    transaction_fee_ceilings: {
      operator_bootstrap_tinybars: OPERATOR_TRANSACTION_FEE_CEILING.toString(),
      buyer_bootstrap_tinybars:
        SUBSCRIPTION_BUYER_ASSOCIATION_MAX_FEE_TINYBARS.toString(),
      buyer_topup_operator_fee_tinybars:
        SUBSCRIPTION_BUYER_TOPUP_MAX_FEE_TINYBARS.toString(),
    },
    gross_cash_movement_tinybars: P1_BUYER_TOPUP_TINYBARS.toString(),
    budget_scope: {
      operator: [
        "token_create_and_funding",
        "vault_and_ledger_deploy",
        "agent_registration",
        "checkpoint_commit_reveal_grade_and_hcs",
      ],
      buyer: [
        "association_and_allowance",
        "subscription_create_and_schedule",
        "manual_cancel",
        "automation_reserve",
      ],
    },
    p0_handoff_required: options.p0StatePath,
    token: {
      ...SMTT_TOKEN,
      initialSupply: SMTT_TOKEN.initialSupply.toString(),
      maxSupply: SMTT_TOKEN.maxSupply.toString(),
      buyerFundingTarget: SMTT_TOKEN.buyerFundingTarget.toString(),
    },
    hts_address: HTS_SYSTEM_ADDRESS,
    schedule_service_address: HSS_SYSTEM_ADDRESS,
  };
  if (!options.execute) return console.info(JSON.stringify(publicPlan));
  await executeP1(options, config, feePlan);
}

main().catch((error) => {
  console.error(
    error instanceof Error
      ? error.message.split(":")[0]
      : "subscription_deployment_failed",
  );
  process.exitCode = 1;
});
