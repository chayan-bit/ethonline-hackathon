import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getAddress, isAddress, zeroAddress, type Address, type Hex } from "viem";
import type { Config } from "../../src/adapters/config.ts";
import { artifact, publicClient } from "../../src/adapters/hedera.ts";
import { fetchJson } from "../../src/adapters/http.ts";
import { mirrorTransactionId, normalizeTransactionId } from "../../src/adapters/payment.ts";
import { completedP1JumboNonce, deriveP1JumboHandoff } from "../../src/protocol/subscription-deployment.ts";
import type { P1Spend } from "../../src/protocol/p1-evidence-budget.ts";

export type P1EvidenceDeployment = {
  network: string;
  topic_id?: string;
  subscription_token?: { id: string; address: Address };
  subscription_vault?: { address: Address; native_id: string };
  subscription_ledger?: { address: Address; native_id: string };
  subscription_agent?: { id: string };
};

export function atomicWrite(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

const object = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function readDeployment(): P1EvidenceDeployment {
  const value = JSON.parse(readFileSync("deployments/testnet.json", "utf8")) as P1EvidenceDeployment;
  const addresses = [
    value.subscription_token?.address,
    value.subscription_vault?.address,
    value.subscription_ledger?.address,
  ];
  const entity = /^0\.0\.[1-9][0-9]{0,18}$/;
  if (
    value.network !== "hedera:testnet" ||
    !entity.test(value.topic_id ?? "") ||
    !entity.test(value.subscription_token?.id ?? "") ||
    !entity.test(value.subscription_vault?.native_id ?? "") ||
    !entity.test(value.subscription_ledger?.native_id ?? "") ||
    !/^[1-9][0-9]{0,77}$/.test(value.subscription_agent?.id ?? "") ||
    addresses.some(
      (address) =>
        !address || !isAddress(address) || getAddress(address) === zeroAddress,
    )
  )
    throw new Error("p1_not_deployed");
  return value;
}

export function journalFees(path: string, phase?: string): bigint {
  if (!existsSync(path)) return 0n;
  const state = object(JSON.parse(readFileSync(path, "utf8")));
  const steps = object(state?.steps);
  return Object.values(steps ?? {}).reduce<bigint>((total, raw) => {
    const step = object(raw);
    if (phase && step?.phase !== phase) return total;
    const attempts = Array.isArray(step?.attempts) ? step.attempts : [];
    return attempts.reduce<bigint>((sum, attempt) => {
      const fee = object(attempt)?.fee_tinybars;
      if (fee === undefined) return sum;
      if (!/^\d+$/.test(String(fee))) throw new Error("invalid_p1_fee_journal");
      return sum + BigInt(String(fee));
    }, total);
  }, 0n);
}

export async function mirrorTransaction(config: Config, transactionId: string) {
  const body = (await fetchJson(
    `${config.mirrorUrl}/transactions/${mirrorTransactionId(transactionId)}`,
  )) as { transactions?: Record<string, unknown>[] };
  const matches = (body.transactions ?? []).filter(
    (transaction) =>
      Number(transaction.nonce) === 0 &&
      typeof transaction.transaction_id === "string" &&
      normalizeTransactionId(transaction.transaction_id) ===
        normalizeTransactionId(transactionId),
  );
  if (
    matches.length !== 1 ||
    !/^\d+$/.test(String(matches[0]!.charged_tx_fee))
  )
    throw new Error("p1_transaction_receipt_mismatch");
  return matches[0]!;
}

async function validateFailedCreate(config: Config, transactionId: string) {
  const receipt = await mirrorTransaction(config, transactionId);
  const result = (await fetchJson(
    `${config.mirrorUrl}/contracts/results/${mirrorTransactionId(transactionId)}`,
  )) as Record<string, unknown>;
  const gasUsed = BigInt(String(result.gas_used ?? "0"));
  const gasLimit = BigInt(String(result.gas_limit ?? "0"));
  if (
    receipt.result !== "CONTRACT_REVERT_EXECUTED" ||
    result.result !== "CONTRACT_REVERT_EXECUTED" ||
    gasLimit !== 2_000_000n ||
    gasUsed < 1_900_000n ||
    !Array.isArray(result.created_contract_ids) ||
    result.created_contract_ids.length !== 0
  )
    throw new Error("p1_buyer_create_failure_mismatch");
  return String(receipt.charged_tx_fee);
}

async function reconcileBuyerFailure(
  config: Config,
  deploy: P1EvidenceDeployment,
  path: string,
): Promise<bigint> {
  const state = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
  const allowance = state.steps?.["buyer.allowance"]?.attempts;
  const create = state.steps?.["buyer.create"]?.attempts;
  if (
    state.identity?.buyer_id !== config.buyerId ||
    state.identity?.vault_native_id !== deploy.subscription_vault!.native_id ||
    state.identity?.token_id !== deploy.subscription_token!.id ||
    !Array.isArray(allowance) ||
    allowance.length !== 2 ||
    allowance[0]?.status !== "abandoned" ||
    allowance[1]?.status !== "consensus" ||
    !Array.isArray(create) ||
    create.length !== 1 ||
    !["submitted", "abandoned"].includes(create[0]?.status)
  )
    throw new Error("p1_buyer_failure_state_mismatch");
  const failureFee = await validateFailedCreate(
    config,
    create[0].transaction_id,
  );
  if (create[0].status === "submitted") {
    state.steps = {
      ...state.steps,
      "buyer.create": {
        ...state.steps["buyer.create"],
        attempts: [
          {
            ...create[0],
            status: "abandoned",
            signed_transaction: "",
            fee_tinybars: failureFee,
          },
        ],
      },
    };
    atomicWrite(path, state);
  } else if (create[0].fee_tinybars !== failureFee) {
    throw new Error("p1_buyer_failure_fee_mismatch");
  }
  for (const [index, expected] of [
    "INVALID_ALLOWANCE_SPENDER_ID",
    "SUCCESS",
  ].entries()) {
    const receipt = await mirrorTransaction(
      config,
      allowance[index].transaction_id,
    );
    if (
      receipt.result !== expected ||
      String(receipt.charged_tx_fee) !== allowance[index].fee_tinybars
    )
      throw new Error("p1_buyer_allowance_receipt_mismatch");
  }
  const escrow = await publicClient(config).readContract({
    address: deploy.subscription_vault!.address,
    abi: artifact("SubscriptionVault").abi,
    functionName: "subscriptionEscrow",
    args: [state.subscription_id as Hex],
  });
  if (String(escrow).toLowerCase() !== zeroAddress.toLowerCase())
    throw new Error("p1_buyer_failure_created_subscription");
  return journalFees(path, "buyer");
}

export async function loadP1EvidenceContext(
  config: Config,
  options: {
    p0StatePath: string;
    deployStatePath: string;
    buyerFailureStatePath: string;
  },
): Promise<{
  deploy: P1EvidenceDeployment;
  handoff: ReturnType<typeof deriveP1JumboHandoff>;
  p1: Record<string, any>;
  priorFees: P1Spend;
}> {
  const deploy = readDeployment();
  const p0 = JSON.parse(readFileSync(options.p0StatePath, "utf8"));
  const handoff = deriveP1JumboHandoff(p0);
  const p1 = JSON.parse(readFileSync(options.deployStatePath, "utf8"));
  completedP1JumboNonce(p1, handoff);
  if (
    config.operatorId !== handoff.operatorId ||
    config.subscriptionAgentId !== deploy.subscription_agent!.id ||
    config.subscriptionTokenId !== deploy.subscription_token!.id ||
    config.subscriptionVaultAddress?.toLowerCase() !==
      deploy.subscription_vault!.address.toLowerCase() ||
    config.subscriptionLedgerAddress?.toLowerCase() !==
      deploy.subscription_ledger!.address.toLowerCase()
  )
    throw new Error("p1_evidence_config_mismatch");
  const buyerFailureFees = await reconcileBuyerFailure(
    config,
    deploy,
    options.buyerFailureStatePath,
  );
  return {
    deploy,
    handoff,
    p1,
    priorFees: {
      operator:
        journalFees(`${options.deployStatePath}.liquidity`, "operator") +
        journalFees(`${options.deployStatePath}.token`, "operator") +
        journalFees(`${options.deployStatePath}.buyer`, "operator") +
        journalFees(options.deployStatePath, "deployer"),
      buyer:
        journalFees(`${options.deployStatePath}.buyer`, "buyer") +
        buyerFailureFees,
    },
  };
}
