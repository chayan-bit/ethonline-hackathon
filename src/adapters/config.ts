import { existsSync, readFileSync } from "node:fs";
import { isAddress, type Address } from "viem";

export type Config = ReturnType<typeof loadConfig>;
export type LedgerCohort = {
  address: Address;
  deploymentBlock: number;
  pythAddress: Address;
};
export type OracleAttestation = {
  verifiedAt: number;
  ledgerAddress: Address;
  pythAddress: Address;
  manifestHash: string;
  proofSha256: string;
};
const DEFAULTS = {
  HEDERA_RPC_URL: "https://testnet.hashio.io/api",
  MIRROR_URL: "https://testnet.mirrornode.hedera.com/api/v1",
  FACILITATOR_URL: "https://api.testnet.blocky402.com",
  HERMES_URL: "https://hermes.pyth.network",
  PYTH_ADDRESS: "0xA2aa501b19aff244D90cc15a4Cf739D2725B5729",
};

function parseLedgerCohorts(value: unknown): LedgerCohort[] {
  if (!Array.isArray(value)) throw new Error("invalid_ledger_cohorts");
  const cohorts = value.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("invalid_ledger_cohort");
    const item = raw as Record<string, unknown>;
    const address = item.address;
    const pythAddress = item.pyth_address;
    const deploymentBlock = item.deployment_block;
    if (
      typeof address !== "string" ||
      !isAddress(address) ||
      typeof pythAddress !== "string" ||
      !isAddress(pythAddress) ||
      !Number.isSafeInteger(deploymentBlock) ||
      Number(deploymentBlock) < 0
    )
      throw new Error("invalid_ledger_cohort");
    return {
      address: address as Address,
      deploymentBlock: Number(deploymentBlock),
      pythAddress: pythAddress as Address,
    };
  });
  if (
    new Set(cohorts.map((cohort) => cohort.address.toLowerCase())).size !==
    cohorts.length
  )
    throw new Error("duplicate_ledger_cohort");
  return cohorts;
}

function loadOracleAttestation(
  path: string | undefined,
  ledgerAddress: Address | undefined,
  cohort: LedgerCohort | undefined,
): OracleAttestation | null {
  if (!path) return null;
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const verifiedAt = Number(raw.verified_at);
  const attestedLedger = raw.ledger_address;
  const attestedPyth = raw.pyth_address;
  if (
    raw.status !== "compatible" ||
    !Number.isSafeInteger(verifiedAt) ||
    verifiedAt <= 0 ||
    verifiedAt > Math.floor(Date.now() / 1000) + 300 ||
    typeof attestedLedger !== "string" ||
    !isAddress(attestedLedger) ||
    typeof attestedPyth !== "string" ||
    !isAddress(attestedPyth) ||
    !ledgerAddress ||
    !cohort ||
    attestedLedger.toLowerCase() !== ledgerAddress.toLowerCase() ||
    attestedPyth.toLowerCase() !== cohort.pythAddress.toLowerCase() ||
    typeof raw.manifest_hash !== "string" ||
    !/^[0-9a-f]{64}$/.test(raw.manifest_hash) ||
    typeof raw.proof_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(raw.proof_sha256)
  )
    throw new Error("invalid_oracle_attestation");
  return {
    verifiedAt,
    ledgerAddress: attestedLedger as Address,
    pythAddress: attestedPyth as Address,
    manifestHash: raw.manifest_hash,
    proofSha256: raw.proof_sha256,
  };
}

export function loadConfig(env = process.env, loadDefaultFiles = true) {
  if ((env.HEDERA_NETWORK ?? "hedera:testnet") !== "hedera:testnet")
    throw new Error("Only Hedera testnet is supported");
  const deployment =
    loadDefaultFiles && existsSync("deployments/testnet.json")
      ? JSON.parse(readFileSync("deployments/testnet.json", "utf8"))
      : {};
  const url = (name: keyof typeof DEFAULTS) => {
    const result = new URL(env[name] ?? DEFAULTS[name]);
    if (result.protocol !== "https:" || result.username || result.password)
      throw new Error(`Invalid ${name}`);
    return result.href.replace(/\/$/, "");
  };
  const address = (name: string, fallback?: string): Address | undefined => {
    const value = env[name] || fallback;
    if (value && !isAddress(value)) throw new Error(`Invalid ${name}`);
    return value as Address | undefined;
  };
  const account = (name: string, value?: string) => {
    if (value && !/^0\.0\.[1-9][0-9]{0,18}$/.test(value))
      throw new Error(`Invalid ${name}`);
    return value;
  };
  const baseUrl = new URL(
    env.PUBLIC_BASE_URL ?? env.RENDER_EXTERNAL_URL ?? "http://localhost:3000",
  );
  if (
    baseUrl.protocol !== "https:" &&
    !(
      baseUrl.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(baseUrl.hostname)
    )
  )
    throw new Error("Public service requires HTTPS");
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PORT");
  const price = env.PRICE_TINYBARS ?? "100000";
  if (!/^[1-9][0-9]{0,17}$/.test(price))
    throw new Error("Invalid PRICE_TINYBARS");
  const subscriptionTokenId = account(
    "SUBSCRIPTION_TOKEN_ID",
    env.SUBSCRIPTION_TOKEN_ID || deployment.subscription_token?.id,
  );
  const subscriptionTokenSymbol =
    env.SUBSCRIPTION_TOKEN_SYMBOL || deployment.subscription_token?.symbol;
  if (
    subscriptionTokenSymbol !== undefined &&
    !/^[A-Z0-9]{1,16}$/.test(subscriptionTokenSymbol)
  )
    throw new Error("Invalid SUBSCRIPTION_TOKEN_SYMBOL");
  const subscriptionTokenDecimals = Number(
    env.SUBSCRIPTION_TOKEN_DECIMALS ?? deployment.subscription_token?.decimals,
  );
  if (
    (env.SUBSCRIPTION_TOKEN_DECIMALS !== undefined ||
      deployment.subscription_token?.decimals !== undefined) &&
    (!Number.isSafeInteger(subscriptionTokenDecimals) ||
      subscriptionTokenDecimals < 0 ||
      subscriptionTokenDecimals > 18)
  ) {
    throw new Error("Invalid SUBSCRIPTION_TOKEN_DECIMALS");
  }
  const subscriptionAgentId =
    env.SUBSCRIPTION_AGENT_ID || deployment.subscription_agent?.id;
  if (
    subscriptionAgentId !== undefined &&
    (!/^[1-9][0-9]{0,77}$/.test(String(subscriptionAgentId)) ||
      BigInt(String(subscriptionAgentId)) >= 2n ** 256n)
  ) {
    throw new Error("Invalid SUBSCRIPTION_AGENT_ID");
  }
  const pythAddress = address("PYTH_ADDRESS", DEFAULTS.PYTH_ADDRESS)!;
  const legacyLedgerAddress = address(
    "LEGACY_LEDGER_ADDRESS",
    env.LEDGER_ADDRESS || deployment.ledger?.address,
  );
  const ledgerAddress = address(
    "ACTIVE_LEDGER_ADDRESS",
    env.LEDGER_ADDRESS ||
      deployment.active_ledger?.address ||
      deployment.ledger?.address,
  );
  const configuredLedgerBlock = Number(
    env.LEDGER_DEPLOYMENT_BLOCK ||
      deployment.active_ledger?.block ||
      deployment.ledger?.block,
  );
  if (
    ledgerAddress &&
    (!Number.isSafeInteger(configuredLedgerBlock) || configuredLedgerBlock < 0)
  )
    throw new Error("Invalid LEDGER_DEPLOYMENT_BLOCK");
  const encodedCohorts = env.LEDGER_COHORTS_JSON
    ? JSON.parse(env.LEDGER_COHORTS_JSON)
    : deployment.ledger_cohorts;
  const ledgerCohorts =
    encodedCohorts === undefined
      ? ledgerAddress
        ? [
            {
              address: ledgerAddress,
              deploymentBlock: configuredLedgerBlock,
              pythAddress,
            },
          ]
        : []
      : parseLedgerCohorts(encodedCohorts);
  const includes = (candidate: Address | undefined) =>
    !candidate ||
    ledgerCohorts.some(
      (cohort) => cohort.address.toLowerCase() === candidate.toLowerCase(),
    );
  if (!includes(ledgerAddress)) throw new Error("active_ledger_not_in_cohorts");
  if (!includes(legacyLedgerAddress))
    throw new Error("legacy_ledger_not_in_cohorts");
  const ledgerDeploymentBlock =
    ledgerCohorts.find(
      (cohort) => cohort.address.toLowerCase() === ledgerAddress?.toLowerCase(),
    )?.deploymentBlock ?? configuredLedgerBlock;
  const activeCohort = ledgerCohorts.find(
    (cohort) => cohort.address.toLowerCase() === ledgerAddress?.toLowerCase(),
  );
  const attestationPath =
    env.ORACLE_ATTESTATION_PATH ||
    (loadDefaultFiles && existsSync("deployments/oracle-attestation.json")
      ? "deployments/oracle-attestation.json"
      : undefined);
  const oracleAttestation = loadOracleAttestation(
    attestationPath,
    ledgerAddress,
    activeCohort,
  );
  const configuredOracleStatus =
    env.ORACLE_GRADING_STATUS ?? "external_preflight_required";
  if (
    !["unavailable", "external_preflight_required"].includes(
      configuredOracleStatus,
    )
  )
    throw new Error("oracle_attestation_required_for_compatible_status");
  const oracleGradingStatus = oracleAttestation
    ? ("compatible" as const)
    : (configuredOracleStatus as "unavailable" | "external_preflight_required");
  return {
    network: "hedera:testnet" as const,
    rpcUrl: url("HEDERA_RPC_URL"),
    mirrorUrl: url("MIRROR_URL"),
    facilitatorUrl: url("FACILITATOR_URL"),
    hermesUrl: url("HERMES_URL"),
    pythApiKey: env.PYTH_API_KEY,
    pythAddress,
    operatorId: account("HEDERA_OPERATOR_ID", env.HEDERA_OPERATOR_ID),
    operatorKey: env.HEDERA_OPERATOR_KEY,
    payeeId: account(
      "HEDERA_PAYEE_ID",
      env.HEDERA_PAYEE_ID || env.HEDERA_OPERATOR_ID,
    ),
    buyerId: account("HEDERA_BUYER_ID", env.HEDERA_BUYER_ID),
    buyerKey: env.HEDERA_BUYER_KEY,
    registryAddress: address("REGISTRY_ADDRESS", deployment.registry?.address),
    ledgerAddress,
    ledgerDeploymentBlock,
    legacyLedgerAddress,
    ledgerCohorts,
    oracleGradingStatus,
    oracleAttestation,
    subscriptionVaultAddress: address(
      "SUBSCRIPTION_VAULT_ADDRESS",
      deployment.subscription_vault?.address,
    ),
    subscriptionLedgerAddress: address(
      "SUBSCRIPTION_LEDGER_ADDRESS",
      deployment.subscription_ledger?.address,
    ),
    subscriptionTokenAddress: address(
      "SUBSCRIPTION_TOKEN_ADDRESS",
      deployment.subscription_token?.address,
    ),
    subscriptionTokenId,
    subscriptionTokenSymbol,
    subscriptionTokenDecimals,
    subscriptionAgentId:
      subscriptionAgentId === undefined
        ? undefined
        : String(subscriptionAgentId),
    subscriptionPayeeId: account(
      "SUBSCRIPTION_PAYEE_ID",
      env.SUBSCRIPTION_PAYEE_ID ||
        env.HEDERA_PAYEE_ID ||
        env.HEDERA_OPERATOR_ID,
    ),
    subscriptionWritesEnabled: env.SUBSCRIPTION_WRITES_ENABLED === "true",
    topicId: env.HCS_TOPIC_ID || deployment.topic_id,
    baseUrl: baseUrl.origin,
    port,
    price,
    agentId: "1",
    workerEnabled: env.WORKER_ENABLED !== "false",
    databasePath: env.DATABASE_PATH ?? "data/market.db",
  };
}
