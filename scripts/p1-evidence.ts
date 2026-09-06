import {
  AccountAllowanceApproveTransaction,
  AccountBalanceQuery,
  ContractExecuteTransaction,
  ContractId,
  Hbar,
  PrivateKey,
  ScheduleId,
  TokenId,
  TopicMessageSubmitTransaction,
  type Client,
  type Transaction,
} from "@hiero-ledger/sdk";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  encodeFunctionData,
  getAddress,
  hexToBytes,
  isAddress,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { loadConfig, type Config } from "../src/adapters/config.ts";
import { accountAddress, artifact, operatorClient, publicClient } from "../src/adapters/hedera.ts";
import { ResumableTransactionRunner, type TransactionStep } from "../src/adapters/hedera-resumable.ts";
import { fetchJson } from "../src/adapters/http.ts";
import { signalTuple } from "../src/adapters/ledger.ts";
import { mirrorTransactionId, normalizeTransactionId } from "../src/adapters/payment.ts";
import { historicalPrice, pythAbi } from "../src/adapters/pyth.ts";
import { generateSubscriptionForecast } from "../src/adapters/subscription-forecast.ts";
import { assertP1PlannedSpend, assertP1TotalSpend, p1EvidenceFeeCaps, requireP1EvidenceBalances, type P1Spend } from "../src/protocol/p1-evidence-budget.ts";
import { completedP1JumboNonce, deriveP1JumboHandoff } from "../src/protocol/subscription-deployment.ts";
import { ETH_USD, SCHEMA, SCHEMA_ID, hashSignal, parseSignal, randomId } from "../src/protocol/signal.ts";
import {
  canRefreshUncreatedTimeline,
  shouldEnterTemporaryPayeeStage,
  validateEvidenceStep,
} from "../src/protocol/p1-evidence-resume.ts";
import { atomicWrite, loadP1EvidenceContext, mirrorTransaction } from "./lib/p1-evidence-context.ts";

const DEFAULT_STATE = "data/p1-operator-evidence.json";
const DEFAULT_BUYER_FAILURE_STATE = "data/p1-evidence.json";
const DEFAULT_DEPLOY_STATE = "data/subscription-deployment.json";
const DEFAULT_P0_STATE = "data/pyth-pro-deployment.json";
const CANCELLED_DURATION = 120;
const CANCEL_AFTER = 90;
const SCHEDULED_DURATION = 90;
const SCHEDULE_INTERVAL = 60;
const HORIZON = 900;
const RATE = 100n;
const CANCELLED_RESERVE = 50_000_000n;
const SCHEDULED_RESERVE = 100_000_000n;
const MAX_ORACLE_FEE = 50_000_000n;
const CREATE_GAS_LIMIT = 5_000_000;
const CREATE_ESTIMATE_LIMIT = 4_500_000n;
const WEIBARS_PER_TINYBAR = 10_000_000_000n;
const TOKEN_BALANCE_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
]);
const HTS_ADDRESS = getAddress(
  "0x0000000000000000000000000000000000000167",
);
const ALLOWANCE_ABI = parseAbi([
  "function allowance(address token,address owner,address spender) returns (int64 responseCode,uint256 amount)",
]);
const STEP_BUDGETS = Object.freeze({
  "operator.payee.to_buyer": 100_000_000n,
  "operator.payee.restore": 100_000_000n,
  "operator.cancelled.allowance": 100_000_000n,
  "operator.cancelled.create": 600_000_000n,
  "operator.cancelled.commit": 300_000_000n,
  "operator.cancelled.hcs": 50_000_000n,
  "operator.cancelled.cancel": 300_000_000n,
  "operator.cancelled.reveal": 300_000_000n,
  "operator.cancelled.grade": 300_000_000n,
  "operator.cancelled.checkpoint": 100_000_000n,
  "operator.scheduled.allowance": 100_000_000n,
  "operator.scheduled.create": 600_000_000n,
  "buyer.scheduled.close": 300_000_000n,
});

type Phase = "operator" | "buyer";
type Prepared = Awaited<ReturnType<typeof generateSubscriptionForecast>>;
type Lifecycle = {
  subscription_id: Hex;
  start: number;
  end: number;
  rate: string;
  deposit: string;
  reserve_tinybars: string;
  schedule_interval: number;
  escrow?: Address;
  token_balance_before?: string;
  provider_token_balance_before?: string;
  schedule_address?: Address;
  schedule_id?: string;
};
type State = {
  version: 2;
  network: "hedera:testnet";
  identity: {
    operator_id: string;
    dedicated_buyer_id: string;
    subscriber_id: string;
    subscriber_control: "operator-controlled";
    provider_id: string;
    permissionless_close_caller_id: string;
    p0_manifest_hash: string;
    p1_manifest_hash: Hex;
    token_id: string;
    token: Address;
    vault: Address;
    vault_native_id: string;
    ledger: Address;
    ledger_native_id: string;
    agent_id: string;
    topic_id: string;
  };
  prior_fees: { operator: string; buyer: string };
  oracle_fee_tinybars: string;
  cancelled: Lifecycle & {
    cancel_at: number;
    request_id: Hex;
    target: number;
    prepared?: Prepared;
    committed_at?: number;
  };
  scheduled: Lifecycle & {
    callback_transaction_id?: string;
    callback_consensus_timestamp?: string;
  };
  steps: Record<string, TransactionStep<Phase>>;
};

const parseArgs = () => {
  const args = process.argv.slice(2);
  const value = (name: string, fallback: string) => {
    const index = args.indexOf(name);
    return resolve(index < 0 ? fallback : (args[index + 1] ?? ""));
  };
  return {
    execute: args.includes("--execute"),
    statePath: value("--state", DEFAULT_STATE),
    buyerFailureStatePath: value("--buyer-failure-state", DEFAULT_BUYER_FAILURE_STATE),
    deployStatePath: value("--deploy-state", DEFAULT_DEPLOY_STATE),
    p0StatePath: value("--pyth-state", DEFAULT_P0_STATE),
  };
};

function identity(config: Config, context: Awaited<ReturnType<typeof loadP1EvidenceContext>>) {
  const { deploy, handoff, p1 } = context;
  return {
    operator_id: config.operatorId!,
    dedicated_buyer_id: config.buyerId!,
    subscriber_id: config.operatorId!,
    subscriber_control: "operator-controlled" as const,
    provider_id: config.buyerId!,
    permissionless_close_caller_id: config.buyerId!,
    p0_manifest_hash: handoff.p0ManifestHash,
    p1_manifest_hash: p1.manifest_hash as Hex,
    token_id: deploy.subscription_token!.id,
    token: deploy.subscription_token!.address,
    vault: deploy.subscription_vault!.address,
    vault_native_id: deploy.subscription_vault!.native_id,
    ledger: deploy.subscription_ledger!.address,
    ledger_native_id: deploy.subscription_ledger!.native_id,
    agent_id: deploy.subscription_agent!.id,
    topic_id: deploy.topic_id!,
  };
}

function lifecycle(start: number, duration: number, reserve: bigint, interval: number): Lifecycle {
  return {
    subscription_id: randomId(),
    start,
    end: start + duration,
    rate: RATE.toString(),
    deposit: (RATE * BigInt(duration)).toString(),
    reserve_tinybars: reserve.toString(),
    schedule_interval: interval,
  };
}

function initialState(config: Config, context: Awaited<ReturnType<typeof loadP1EvidenceContext>>): State {
  const start = Math.floor(Date.now() / 1_000) + 120;
  const cancelled = lifecycle(start, CANCELLED_DURATION, CANCELLED_RESERVE, 300);
  return {
    version: 2,
    network: "hedera:testnet",
    identity: identity(config, context),
    prior_fees: {
      operator: context.priorFees.operator.toString(),
      buyer: context.priorFees.buyer.toString(),
    },
    oracle_fee_tinybars: "0",
    cancelled: {
      ...cancelled,
      cancel_at: start + CANCEL_AFTER,
      request_id: randomId(),
      target: start + HORIZON,
    },
    scheduled: lifecycle(start, SCHEDULED_DURATION, SCHEDULED_RESERVE, SCHEDULE_INTERVAL),
    steps: {},
  };
}

function validateLifecycle(value: Lifecycle, expected: { duration: number; reserve: bigint; interval: number }) {
  return (
    /^0x[0-9a-f]{64}$/.test(value.subscription_id) &&
    Number.isSafeInteger(value.start) &&
    value.end === value.start + expected.duration &&
    value.rate === RATE.toString() &&
    value.deposit === (RATE * BigInt(expected.duration)).toString() &&
    value.reserve_tinybars === expected.reserve.toString() &&
    value.schedule_interval === expected.interval &&
    (value.escrow === undefined || (isAddress(value.escrow) && getAddress(value.escrow) !== zeroAddress))
  );
}

function readState(path: string, expected: State) {
  if (!existsSync(path)) return expected;
  const state = JSON.parse(readFileSync(path, "utf8")) as State;
  const validPrepared = (() => {
    if (!state.cancelled.prepared) return true;
    try {
      const signal = parseSignal(state.cancelled.prepared.signal);
      return (
        signal.request_id === state.cancelled.request_id &&
        signal.agent_id === state.identity.agent_id &&
        signal.issued_at === state.cancelled.start &&
        signal.target_time === state.cancelled.target &&
        state.cancelled.prepared.hash === hashSignal(signal, state.cancelled.prepared.salt)
      );
    } catch { return false; }
  })();
  const validSteps =
    state.steps &&
    Object.entries(state.steps).every(([id, step]) => {
      const budget = STEP_BUDGETS[id as keyof typeof STEP_BUDGETS];
      return (
        budget !== undefined &&
        validateEvidenceStep(
          id.startsWith("buyer.") ? "buyer" : "operator",
          step,
          budget,
        )
      );
    });
  if (
    state.version !== 2 ||
    state.network !== "hedera:testnet" ||
    JSON.stringify(state.identity) !== JSON.stringify(expected.identity) ||
    JSON.stringify(state.prior_fees) !== JSON.stringify(expected.prior_fees) ||
    !/^\d+$/.test(state.oracle_fee_tinybars) ||
    !validateLifecycle(state.cancelled, { duration: CANCELLED_DURATION, reserve: CANCELLED_RESERVE, interval: 300 }) ||
    state.cancelled.cancel_at !== state.cancelled.start + CANCEL_AFTER ||
    state.cancelled.target !== state.cancelled.start + HORIZON ||
    !/^0x[0-9a-f]{64}$/.test(state.cancelled.request_id) ||
    !validateLifecycle(state.scheduled, { duration: SCHEDULED_DURATION, reserve: SCHEDULED_RESERVE, interval: SCHEDULE_INTERVAL }) ||
    state.scheduled.start !== state.cancelled.start ||
    !validPrepared ||
    !validSteps
  ) throw new Error("p1_operator_evidence_state_mismatch");
  return state;
}

function values(state: State): P1Spend {
  return {
    operator: CANCELLED_RESERVE + SCHEDULED_RESERVE + BigInt(state.oracle_fee_tinybars),
    buyer: 0n,
  };
}
function futureFeeCeilings(): P1Spend {
  return Object.entries(STEP_BUDGETS).reduce(
    (totals, [id, fee]) =>
      id.startsWith("buyer.")
        ? { ...totals, buyer: totals.buyer + fee }
        : { ...totals, operator: totals.operator + fee },
    { operator: 0n, buyer: 0n },
  );
}
function totalFees(state: State): P1Spend {
  const by = (phase: Phase) =>
    Object.values(state.steps)
      .filter((step) => step.phase === phase)
      .flatMap((step) => step.attempts)
      .filter((attempt) => attempt.status === "consensus")
      .reduce((sum, attempt) => sum + BigInt(attempt.fee_tinybars ?? "0"), 0n);
  return {
    operator: BigInt(state.prior_fees.operator) + by("operator"),
    buyer: BigInt(state.prior_fees.buyer) + by("buyer"),
  };
}

class Runner {
  private state: State;
  private readonly operator: ResumableTransactionRunner<Phase>;
  private readonly buyer: ResumableTransactionRunner<Phase>;
  constructor(state: State, private readonly path: string, config: Config, operator: Client, operatorKey: PrivateKey, buyer: Client, buyerKey: PrivateKey) {
    this.state = state;
    const create = (phase: Phase, client: Client, key: PrivateKey) => new ResumableTransactionRunner({
      client,
      key,
      mirrorUrl: config.mirrorUrl,
      getSteps: () => this.state.steps,
      saveSteps: (steps) => this.update({ ...this.state, steps }),
      capFor: () => p1EvidenceFeeCaps(
        { operator: BigInt(this.state.prior_fees.operator), buyer: BigInt(this.state.prior_fees.buyer) },
        values(this.state),
      )[phase],
      budgetFor: (id) => ({ total: STEP_BUDGETS[id as keyof typeof STEP_BUDGETS], gas: 0n }),
      requiresEntity: () => false,
      isNonReplannable: () => true,
    });
    this.operator = create("operator", operator, operatorKey);
    this.buyer = create("buyer", buyer, buyerKey);
  }
  snapshot() { return this.state; }
  update(state: State) { this.state = state; atomicWrite(this.path, state); }
  run(phase: Phase, id: keyof typeof STEP_BUDGETS, build: () => Transaction) {
    return (phase === "operator" ? this.operator : this.buyer).run(id, phase, build);
  }
}

async function verifyReceipts(config: Config, state: State) {
  for (const step of Object.values(state.steps)) {
    const attempt = step.attempts.at(-1);
    if (attempt?.status !== "consensus") continue;
    const receipt = await mirrorTransaction(config, attempt.transaction_id);
    if (receipt.result !== "SUCCESS" || String(receipt.charged_tx_fee) !== attempt.fee_tinybars)
      throw new Error("p1_operator_evidence_receipt_mismatch");
  }
}

function contractTransaction(address: Address, name: string, args: readonly unknown[], valueTinybars = 0n, gas = 2_000_000) {
  const data = encodeFunctionData({ abi: artifact(name.startsWith("createSubscription") ? "SubscriptionVault" : "SubscriptionEscrow").abi, functionName: name, args });
  return new ContractExecuteTransaction()
    .setContractId(ContractId.fromEvmAddress(0, 0, address))
    .setGas(gas)
    .setFunctionParameters(hexToBytes(data))
    .setPayableAmount(Hbar.fromTinybars(valueTinybars.toString()));
}

async function tokenBalance(config: Config, token: Address, account: Address): Promise<bigint> {
  return publicClient(config).readContract({
    address: token,
    abi: TOKEN_BALANCE_ABI,
    functionName: "balanceOf",
    args: [account],
  });
}

async function registryPayee(config: Config, state: State) {
  if (!config.registryAddress) throw new Error("p1_registry_missing");
  const record = (await publicClient(config).readContract({
    address: config.registryAddress,
    abi: artifact("AgentRegistry").abi,
    functionName: "getAgent",
    args: [BigInt(state.identity.agent_id)],
  })) as readonly unknown[];
  if (
    String(record[0]).toLowerCase() !==
      accountAddress(state.identity.operator_id).toLowerCase() ||
    record[3] !== true
  )
    throw new Error("p1_registry_authority_mismatch");
  return String(record[2]).toLowerCase();
}

async function setEvidencePayee(
  config: Config,
  runner: Runner,
  direction: "to_buyer" | "restore",
) {
  const state = runner.snapshot();
  const target =
    direction === "to_buyer"
      ? state.identity.provider_id
      : state.identity.operator_id;
  const expectedCurrent =
    direction === "to_buyer"
      ? state.identity.operator_id
      : state.identity.provider_id;
  const id = `operator.payee.${direction}` as keyof typeof STEP_BUDGETS;
  const latest = state.steps[id]?.attempts.at(-1);
  const completed = latest?.status === "consensus";
  const current = await registryPayee(config, state);
  if (!latest && current !== accountAddress(expectedCurrent).toLowerCase())
    throw new Error(`p1_payee_precondition_mismatch:${direction}`);
  if (!completed) {
    const data = encodeFunctionData({
      abi: artifact("AgentRegistry").abi,
      functionName: "setPayee",
      args: [BigInt(state.identity.agent_id), accountAddress(target)],
    });
    await runner.run("operator", id, () =>
      new ContractExecuteTransaction()
        .setContractId(ContractId.fromEvmAddress(0, 0, config.registryAddress!))
        .setGas(500_000)
        .setFunctionParameters(hexToBytes(data)),
    );
  }
  if (
    (await registryPayee(config, runner.snapshot())) !==
    accountAddress(target).toLowerCase()
  )
    throw new Error(`p1_payee_verification_failed:${direction}`);
}

async function refreshTimelineIfExpired(config: Config, runner: Runner) {
  const state = runner.snapshot();
  if (state.cancelled.escrow && state.scheduled.escrow) return;
  if (state.cancelled.escrow || state.scheduled.escrow)
    throw new Error("p1_operator_evidence_partial_timeline_locked");
  if (state.cancelled.start > Math.floor(Date.now() / 1_000) + 60) return;
  if (
    !canRefreshUncreatedTimeline(state.steps) ||
    state.cancelled.prepared ||
    state.cancelled.committed_at ||
    state.scheduled.callback_transaction_id
  )
    throw new Error("p1_operator_evidence_timeline_locked");
  const chain = publicClient(config);
  const [cancelledEscrow, scheduledEscrow, allowance] = await Promise.all([
    chain.readContract({
      address: state.identity.vault,
      abi: artifact("SubscriptionVault").abi,
      functionName: "subscriptionEscrow",
      args: [state.cancelled.subscription_id],
    }),
    chain.readContract({
      address: state.identity.vault,
      abi: artifact("SubscriptionVault").abi,
      functionName: "subscriptionEscrow",
      args: [state.scheduled.subscription_id],
    }),
    chain.readContract({
      address: HTS_ADDRESS,
      abi: ALLOWANCE_ABI,
      functionName: "allowance",
      args: [
        state.identity.token,
        accountAddress(state.identity.subscriber_id),
        state.identity.vault,
      ],
    }),
  ]);
  if (
    String(cancelledEscrow).toLowerCase() !== zeroAddress.toLowerCase() ||
    String(scheduledEscrow).toLowerCase() !== zeroAddress.toLowerCase() ||
    allowance[0] !== 22n ||
    allowance[1] !== BigInt(state.cancelled.deposit) ||
    (await registryPayee(config, state)) !==
      accountAddress(state.identity.provider_id).toLowerCase()
  )
    throw new Error("p1_operator_evidence_refresh_precondition_failed");
  const start = Math.floor(Date.now() / 1_000) + 120;
  runner.update({
    ...state,
    cancelled: {
      ...lifecycle(start, CANCELLED_DURATION, CANCELLED_RESERVE, 300),
      cancel_at: start + CANCEL_AFTER,
      request_id: randomId(),
      target: start + HORIZON,
    },
    scheduled: lifecycle(
      start,
      SCHEDULED_DURATION,
      SCHEDULED_RESERVE,
      SCHEDULE_INTERVAL,
    ),
  });
}

async function verifyLifecycle(config: Config, state: State, lifecycle: Lifecycle) {
  if (!lifecycle.escrow) throw new Error("p1_escrow_missing");
  const chain = publicClient(config);
  const [terms, reserve, spent, refunded, escrowTokens] = await Promise.all([
    chain.readContract({ address: lifecycle.escrow, abi: artifact("SubscriptionEscrow").abi, functionName: "terms" }) as Promise<readonly unknown[]>,
    chain.readContract({ address: lifecycle.escrow, abi: artifact("SubscriptionEscrow").abi, functionName: "automationReserve" }) as Promise<bigint>,
    chain.readContract({ address: lifecycle.escrow, abi: artifact("SubscriptionEscrow").abi, functionName: "automationSpent" }) as Promise<bigint>,
    chain.readContract({ address: lifecycle.escrow, abi: artifact("SubscriptionEscrow").abi, functionName: "automationRefunded" }) as Promise<bigint>,
    tokenBalance(config, state.identity.token, lifecycle.escrow),
  ]);
  if (
    String(terms[0]).toLowerCase() !== accountAddress(state.identity.subscriber_id).toLowerCase() ||
    String(terms[1]).toLowerCase() !== accountAddress(state.identity.provider_id).toLowerCase() ||
    String(terms[3]) !== state.identity.agent_id ||
    Number(terms[4]) !== lifecycle.start ||
    Number(terms[5]) !== lifecycle.end ||
    String(terms[7]) !== lifecycle.deposit ||
    (terms[10] === true
      ? escrowTokens !== 0n || BigInt(terms[8] as bigint) > BigInt(lifecycle.deposit)
      : escrowTokens + BigInt(terms[8] as bigint) !== BigInt(lifecycle.deposit)) ||
    reserve + spent + refunded !== BigInt(lifecycle.reserve_tinybars)
  ) throw new Error("p1_lifecycle_conservation_failed");
  return { terms, reserve, spent, refunded, escrowTokens };
}

async function ensureLifecycle(config: Config, runner: Runner, kind: "cancelled" | "scheduled") {
  const state = runner.snapshot();
  const lifecycle = state[kind];
  if (lifecycle.escrow) return verifyLifecycle(config, state, lifecycle);
  const prefix = `operator.${kind}` as const;
  const operatorAddress = accountAddress(state.identity.operator_id);
  await runner.run("operator", `${prefix}.allowance` as keyof typeof STEP_BUDGETS, () =>
    new AccountAllowanceApproveTransaction().approveTokenAllowance(
      TokenId.fromString(state.identity.token_id),
      state.identity.operator_id,
      ContractId.fromString(state.identity.vault_native_id),
      BigInt(lifecycle.deposit),
    ),
  );
  const args = [
    lifecycle.subscription_id,
    BigInt(state.identity.agent_id),
    BigInt(lifecycle.start),
    BigInt(lifecycle.end),
    BigInt(lifecycle.rate),
    BigInt(lifecycle.deposit),
    BigInt(lifecycle.schedule_interval),
    500_000n,
  ] as const;
  const chain = publicClient(config);
  const estimate = await chain.estimateContractGas({
    address: state.identity.vault,
    abi: artifact("SubscriptionVault").abi,
    functionName: "createSubscription",
    args,
    account: operatorAddress,
    value: BigInt(lifecycle.reserve_tinybars) * WEIBARS_PER_TINYBAR,
  });
  if (estimate > CREATE_ESTIMATE_LIMIT) throw new Error(`p1_create_gas_estimate_exceeded:${kind}:${estimate}`);
  const [balanceBefore, providerBalanceBefore] = await Promise.all([
    tokenBalance(config, state.identity.token, operatorAddress),
    tokenBalance(
      config,
      state.identity.token,
      accountAddress(state.identity.provider_id),
    ),
  ]);
  await runner.run("operator", `${prefix}.create` as keyof typeof STEP_BUDGETS, () =>
    contractTransaction(state.identity.vault, "createSubscription", args, BigInt(lifecycle.reserve_tinybars), CREATE_GAS_LIMIT),
  );
  const escrow = (await chain.readContract({
    address: state.identity.vault,
    abi: artifact("SubscriptionVault").abi,
    functionName: "subscriptionEscrow",
    args: [lifecycle.subscription_id],
  })) as Address;
  if (!isAddress(escrow) || getAddress(escrow) === zeroAddress) throw new Error("p1_subscription_missing");
  const scheduleAddress = (await chain.readContract({
    address: escrow,
    abi: artifact("SubscriptionEscrow").abi,
    functionName: "scheduleAddress",
  })) as Address;
  if (!isAddress(scheduleAddress) || getAddress(scheduleAddress) === zeroAddress) throw new Error("p1_schedule_missing");
  const updated = {
    ...lifecycle,
    escrow,
    token_balance_before: balanceBefore.toString(),
    provider_token_balance_before: providerBalanceBefore.toString(),
    schedule_address: scheduleAddress,
    schedule_id: ScheduleId.fromSolidityAddress(scheduleAddress).toString(),
  };
  runner.update({ ...runner.snapshot(), [kind]: updated });
  return verifyLifecycle(config, runner.snapshot(), updated);
}

async function ensureForecast(config: Config, runner: Runner) {
  let state = runner.snapshot();
  if (Math.floor(Date.now() / 1_000) < state.cancelled.start) throw new Error(`p1_wait_until_start:${state.cancelled.start}`);
  let prepared = state.cancelled.prepared;
  if (!prepared) {
    prepared = await generateSubscriptionForecast(config, {
      request_id: state.cancelled.request_id,
      buyer: state.identity.subscriber_id,
      agent_id: state.identity.agent_id,
      schema: SCHEMA,
      price_feed_id: ETH_USD,
      target_time: state.cancelled.target,
    });
    runner.update({ ...state, cancelled: { ...state.cancelled, prepared } });
    state = runner.snapshot();
  }
  const data = encodeFunctionData({
    abi: artifact("SubscriptionLedger").abi,
    functionName: "commit",
    args: [
      state.cancelled.subscription_id,
      state.cancelled.request_id,
      BigInt(state.identity.agent_id),
      prepared.hash,
      SCHEMA_ID,
      BigInt(prepared.signal.issued_at),
      BigInt(prepared.signal.target_time),
      prepared.signal.price_feed_id,
    ],
  });
  await runner.run("operator", "operator.cancelled.commit", () =>
    new ContractExecuteTransaction().setContractId(ContractId.fromString(state.identity.ledger_native_id)).setGas(2_000_000).setFunctionParameters(hexToBytes(data)),
  );
  const commitment = (await publicClient(config).readContract({
    address: state.identity.ledger,
    abi: artifact("SubscriptionLedger").abi,
    functionName: "getCommitment",
    args: [state.cancelled.request_id],
  })) as readonly unknown[];
  const committedAt = Number(commitment[4]);
  if (commitment[0] !== true || commitment[1] !== state.cancelled.subscription_id || commitment[3] !== prepared.hash)
    throw new Error("p1_commitment_mismatch");
  runner.update({ ...runner.snapshot(), cancelled: { ...runner.snapshot().cancelled, committed_at: committedAt } });
  await runner.run("operator", "operator.cancelled.hcs", () =>
    new TopicMessageSubmitTransaction().setTopicId(state.identity.topic_id).setMessage(JSON.stringify({
      version: 1,
      event_type: "subscription.signal.committed",
      subscription_id: state.cancelled.subscription_id,
      request_id: state.cancelled.request_id,
      agent_id: state.identity.agent_id,
      subscriber: state.identity.subscriber_id,
      subscriber_control: state.identity.subscriber_control,
      payment_mode: "subscription",
      ledger_address: state.identity.ledger,
      commitment_hash: prepared.hash,
      target_time: state.cancelled.target,
    })),
  );
}

async function verifyScheduledCallback(config: Config, runner: Runner) {
  let state = runner.snapshot();
  if (!state.scheduled.schedule_id || !state.scheduled.schedule_address) throw new Error("p1_schedule_missing");
  if (Math.floor(Date.now() / 1_000) < state.scheduled.start + SCHEDULE_INTERVAL)
    throw new Error(`p1_wait_until_scheduled_callback:${state.scheduled.start + SCHEDULE_INTERVAL}`);
  if (!state.scheduled.callback_transaction_id) {
    const schedule = (await fetchJson(`${config.mirrorUrl}/schedules/${state.scheduled.schedule_id}`)) as Record<string, unknown>;
    const timestamp = String(schedule.executed_timestamp ?? "");
    if (!/^\d+\.\d{9}$/.test(timestamp)) throw new Error("p1_schedule_not_executed");
    const url = new URL(`${config.mirrorUrl}/transactions`);
    url.searchParams.set("timestamp", `eq:${timestamp}`);
    url.searchParams.set("scheduled", "true");
    const body = (await fetchJson(url)) as { transactions?: Record<string, unknown>[] };
    const matches = (body.transactions ?? []).filter((transaction) => transaction.result === "SUCCESS" && transaction.scheduled === true);
    if (matches.length !== 1 || typeof matches[0]!.transaction_id !== "string") throw new Error("p1_scheduled_receipt_missing");
    state = {
      ...state,
      scheduled: {
        ...state.scheduled,
        callback_transaction_id: normalizeTransactionId(matches[0]!.transaction_id),
        callback_consensus_timestamp: timestamp,
      },
    };
    runner.update(state);
  }
  const verified = await verifyLifecycle(config, state, state.scheduled);
  const paid = BigInt(verified.terms[8] as bigint);
  const [subscriberTokens, providerTokens] = await Promise.all([
    tokenBalance(
      config,
      state.identity.token,
      accountAddress(state.identity.subscriber_id),
    ),
    tokenBalance(
      config,
      state.identity.token,
      accountAddress(state.identity.provider_id),
    ),
  ]);
  if (
    paid <= 0n ||
    paid > BigInt(state.scheduled.deposit) ||
    subscriberTokens !==
      BigInt(state.scheduled.token_balance_before!) -
        BigInt(state.scheduled.deposit) ||
    providerTokens !==
      BigInt(state.scheduled.provider_token_balance_before!) + paid
  )
    throw new Error("p1_scheduled_checkpoint_missing");
}

async function cancelForecast(config: Config, runner: Runner) {
  const state = runner.snapshot();
  if (Math.floor(Date.now() / 1_000) < state.cancelled.cancel_at)
    throw new Error(`p1_wait_until_cancel:${state.cancelled.cancel_at}`);
  await runner.run("operator", "operator.cancelled.cancel", () =>
    contractTransaction(state.cancelled.escrow!, "cancelTo", [accountAddress(state.identity.operator_id)]),
  );
  const verified = await verifyLifecycle(config, runner.snapshot(), runner.snapshot().cancelled);
  const paid = BigInt(verified.terms[8] as bigint);
  const scheduled = await verifyLifecycle(
    config,
    runner.snapshot(),
    runner.snapshot().scheduled,
  );
  const scheduledPaid = BigInt(scheduled.terms[8] as bigint);
  const [subscriberTokens, providerTokens] = await Promise.all([
    tokenBalance(
      config,
      state.identity.token,
      accountAddress(state.identity.subscriber_id),
    ),
    tokenBalance(
      config,
      state.identity.token,
      accountAddress(state.identity.provider_id),
    ),
  ]);
  if (
    verified.terms[10] !== true ||
    Number(verified.terms[9]) < state.cancelled.cancel_at ||
    Number(verified.terms[9]) > state.cancelled.end ||
    verified.escrowTokens !== 0n ||
    verified.reserve !== 0n ||
    subscriberTokens !==
      BigInt(state.cancelled.token_balance_before!) -
        paid -
        BigInt(state.scheduled.deposit) ||
    providerTokens !==
      BigInt(state.cancelled.provider_token_balance_before!) +
        paid +
        scheduledPaid
  )
    throw new Error("p1_cancel_verification_failed");
}

async function closeScheduled(config: Config, runner: Runner) {
  const state = runner.snapshot();
  if (Math.floor(Date.now() / 1_000) < state.scheduled.end)
    throw new Error(`p1_wait_until_natural_close:${state.scheduled.end}`);
  await runner.run("buyer", "buyer.scheduled.close", () =>
    contractTransaction(state.scheduled.escrow!, "close", []),
  );
  const verified = await verifyLifecycle(config, runner.snapshot(), runner.snapshot().scheduled);
  const cancelled = await verifyLifecycle(
    config,
    runner.snapshot(),
    runner.snapshot().cancelled,
  );
  const cancelledPaid = BigInt(cancelled.terms[8] as bigint);
  const [finalOperatorTokens, finalProviderTokens] = await Promise.all([
    tokenBalance(
      config,
      state.identity.token,
      accountAddress(state.identity.operator_id),
    ),
    tokenBalance(
      config,
      state.identity.token,
      accountAddress(state.identity.provider_id),
    ),
  ]);
  if (
    verified.terms[10] !== true ||
    Number(verified.terms[9]) !== 0 ||
    String(verified.terms[8]) !== state.scheduled.deposit ||
    verified.escrowTokens !== 0n ||
    finalOperatorTokens !==
      BigInt(state.cancelled.token_balance_before!) -
        cancelledPaid -
        BigInt(state.scheduled.deposit) ||
    finalProviderTokens !==
      BigInt(state.cancelled.provider_token_balance_before!) +
        cancelledPaid +
        BigInt(state.scheduled.deposit) ||
    verified.reserve !== 0n
  ) throw new Error("p1_natural_close_conservation_failed");
}

async function revealAndGrade(config: Config, runner: Runner) {
  let state = runner.snapshot();
  const prepared = state.cancelled.prepared;
  if (!prepared || !state.cancelled.committed_at) throw new Error("p1_forecast_missing");
  if (Math.floor(Date.now() / 1_000) < state.cancelled.target)
    throw new Error(`p1_wait_until_target:${state.cancelled.target}`);
  const revealData = encodeFunctionData({
    abi: artifact("SubscriptionLedger").abi,
    functionName: "reveal",
    args: [state.cancelled.request_id, signalTuple(prepared.signal), prepared.salt],
  });
  await runner.run("operator", "operator.cancelled.reveal", () =>
    new ContractExecuteTransaction().setContractId(ContractId.fromString(state.identity.ledger_native_id)).setGas(2_000_000).setFunctionParameters(hexToBytes(revealData)),
  );
  const [issue, target] = await Promise.all([
    historicalPrice(config, state.cancelled.committed_at),
    historicalPrice(config, state.cancelled.target),
  ]);
  const chain = publicClient(config);
  const pythAddress = (await chain.readContract({ address: state.identity.ledger, abi: artifact("SubscriptionLedger").abi, functionName: "pyth" })) as Address;
  const fees = await Promise.all([issue.updates, target.updates].map((updates) =>
    chain.readContract({ address: pythAddress, abi: pythAbi, functionName: "getUpdateFee", args: [updates] }),
  ));
  const feeTinybars = (fees[0] + fees[1] + WEIBARS_PER_TINYBAR - 1n) / WEIBARS_PER_TINYBAR;
  if (feeTinybars > MAX_ORACLE_FEE) throw new Error("p1_oracle_fee_cap_exceeded");
  state = { ...runner.snapshot(), oracle_fee_tinybars: feeTinybars.toString() };
  runner.update(state);
  await chain.simulateContract({
    address: state.identity.ledger,
    abi: artifact("SubscriptionLedger").abi,
    functionName: "grade",
    args: [state.cancelled.request_id, issue.updates, target.updates],
    value: feeTinybars * WEIBARS_PER_TINYBAR,
  });
  const gradeData = encodeFunctionData({
    abi: artifact("SubscriptionLedger").abi,
    functionName: "grade",
    args: [state.cancelled.request_id, issue.updates, target.updates],
  });
  await runner.run("operator", "operator.cancelled.grade", () =>
    new ContractExecuteTransaction().setContractId(ContractId.fromString(state.identity.ledger_native_id)).setGas(2_000_000)
      .setFunctionParameters(hexToBytes(gradeData)).setPayableAmount(Hbar.fromTinybars(feeTinybars.toString())),
  );
  const grade = (await chain.readContract({
    address: state.identity.ledger,
    abi: artifact("SubscriptionLedger").abi,
    functionName: "getGrade",
    args: [state.cancelled.request_id],
  })) as readonly unknown[];
  if ((grade[0] !== true && grade[1] !== true) || Number(grade[8]) <= 0) throw new Error("p1_grade_verification_failed");
  await runner.run("operator", "operator.cancelled.checkpoint", () =>
    contractTransaction(state.cancelled.escrow!, "checkpoint", []),
  );
}

async function balances(operator: Client, buyer: Client, state: State) {
  const query = async (client: Client, id: string) => {
    const result = await new AccountBalanceQuery().setAccountId(id).execute(client);
    return BigInt(result.hbars.toTinybars().toString());
  };
  const current = await Promise.all([
    query(operator, state.identity.operator_id),
    query(buyer, state.identity.dedicated_buyer_id),
  ]);
  requireP1EvidenceBalances(
    { operator: current[0], buyer: current[1] },
    totalFees(state),
    values(state),
  );
}

async function execute(options: ReturnType<typeof parseArgs>) {
  const config = loadConfig();
  if (!config.operatorId || !config.operatorKey || !config.buyerId || !config.buyerKey)
    throw new Error("p1_evidence_credentials_missing");
  const context = await loadP1EvidenceContext(config, options);
  const expected = initialState(config, context);
  const state = readState(options.statePath, expected);
  assertP1PlannedSpend(
    context.priorFees,
    {
      operator: CANCELLED_RESERVE + SCHEDULED_RESERVE + MAX_ORACLE_FEE,
      buyer: 0n,
    },
    futureFeeCeilings(),
  );
  const operatorKey = PrivateKey.fromStringECDSA(config.operatorKey);
  const buyerKey = PrivateKey.fromStringECDSA(config.buyerKey);
  const operator = operatorClient(config);
  const buyer = operatorClient({ ...config, operatorId: config.buyerId, operatorKey: config.buyerKey });
  try {
    await verifyReceipts(config, state);
    await balances(operator, buyer, state);
    const runner = new Runner(state, options.statePath, config, operator, operatorKey, buyer, buyerKey);
    if (shouldEnterTemporaryPayeeStage(runner.snapshot().steps))
      await setEvidencePayee(config, runner, "to_buyer");
    await refreshTimelineIfExpired(config, runner);
    await ensureLifecycle(config, runner, "cancelled");
    await ensureLifecycle(config, runner, "scheduled");
    await setEvidencePayee(config, runner, "restore");
    const canCommitForecast =
      Boolean(runner.snapshot().cancelled.prepared) ||
      Math.floor(Date.now() / 1_000) <= runner.snapshot().cancelled.start + 30;
    if (canCommitForecast) await ensureForecast(config, runner);
    let scheduleFailure: Error | undefined;
    try {
      await verifyScheduledCallback(config, runner);
    } catch (error) {
      scheduleFailure =
        error instanceof Error ? error : new Error("p1_schedule_verification_failed");
    }
    await cancelForecast(config, runner);
    await closeScheduled(config, runner);
    if (scheduleFailure) throw scheduleFailure;
    if (runner.snapshot().cancelled.prepared)
      await revealAndGrade(config, runner);
    else
      throw new Error("p1_forecast_commit_window_missed");
    const fees = totalFees(runner.snapshot());
    const reserved = values(runner.snapshot());
    assertP1TotalSpend(fees, reserved);
    console.info(JSON.stringify({
      status: "complete",
      subscriber: { account_id: config.operatorId, control: "operator-controlled" },
      provider: { account_id: config.buyerId, control: "dedicated-buyer payout recipient" },
      permissionless_close_caller: config.buyerId,
      dedicated_buyer_successful_subscription_claim: false,
      cancelled: runner.snapshot().cancelled,
      scheduled: runner.snapshot().scheduled,
      fees: { operator: fees.operator.toString(), buyer: fees.buyer.toString() },
      values: { operator: reserved.operator.toString(), buyer: reserved.buyer.toString() },
      state: options.statePath,
    }));
  } finally {
    operator.close();
    buyer.close();
  }
}

async function main() {
  const options = parseArgs();
  const ceilings = futureFeeCeilings();
  if (!options.execute) {
    const config = loadConfig();
    const context = await loadP1EvidenceContext(config, options);
    const maximumValues = {
      operator: CANCELLED_RESERVE + SCHEDULED_RESERVE + MAX_ORACLE_FEE,
      buyer: 0n,
    };
    assertP1PlannedSpend(context.priorFees, maximumValues, ceilings);
    const chain = publicClient(config);
    const liveBalances = await Promise.all([
      chain.getBalance({ address: accountAddress(config.operatorId!) }),
      chain.getBalance({ address: accountAddress(config.buyerId!) }),
    ]);
    const projectedFees = {
      operator: context.priorFees.operator + ceilings.operator,
      buyer: context.priorFees.buyer + ceilings.buyer,
    };
    console.info(JSON.stringify({
      execution_authorized: false,
      only_authorized_lifecycle_path: "npm run evidence:p1 -- --execute",
      subscriber: { role: "operator-controlled" },
      provider: { role: "dedicated-buyer payout recipient" },
      permissionless_close_caller: "dedicated buyer",
      dedicated_buyer_successful_subscription_claim: false,
      lifecycles: {
        cancelled_forecast: { duration_seconds: CANCELLED_DURATION, cancel_after_seconds: CANCEL_AFTER, horizon_seconds: HORIZON, reserve_tinybars: CANCELLED_RESERVE.toString() },
        scheduled_natural_close: { duration_seconds: SCHEDULED_DURATION, interval_seconds: SCHEDULE_INTERVAL, reserve_tinybars: SCHEDULED_RESERVE.toString() },
      },
      future_fee_ceilings_tinybars: { operator: ceilings.operator.toString(), buyer: ceilings.buyer.toString() },
      oracle_fee_reserve_tinybars: MAX_ORACLE_FEE.toString(),
      prior_fees_tinybars: {
        operator: context.priorFees.operator.toString(),
        buyer: context.priorFees.buyer.toString(),
      },
      worst_case_tinybars: {
        operator: (projectedFees.operator + maximumValues.operator).toString(),
        buyer: projectedFees.buyer.toString(),
        total: (
          projectedFees.operator +
          projectedFees.buyer +
          maximumValues.operator
        ).toString(),
      },
      live_balances_tinybars: {
        operator: (liveBalances[0] / WEIBARS_PER_TINYBAR).toString(),
        buyer: (liveBalances[1] / WEIBARS_PER_TINYBAR).toString(),
      },
      state: options.statePath,
      prior_buyer_failure_state: options.buyerFailureStatePath,
    }));
    return;
  }
  await execute(options);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message.split("\n")[0] : "p1_evidence_failed");
  process.exitCode = 1;
});
