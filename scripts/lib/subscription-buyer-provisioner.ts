import {
  Hbar,
  TokenAssociateTransaction,
  TokenId,
  TransferTransaction,
  type Client,
  type PrivateKey,
} from "@hiero-ledger/sdk";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Config } from "../../src/adapters/config.ts";
import { fetchJson } from "../../src/adapters/http.ts";
import {
  mirrorTransactionId,
  normalizeTransactionId,
} from "../../src/adapters/payment.ts";
import {
  ResumableTransactionRunner,
  type TransactionStep,
} from "../../src/adapters/hedera-resumable.ts";
import type { P1JumboHandoff } from "../../src/protocol/subscription-deployment.ts";
import { P1_BUYER_TOPUP_TINYBARS } from "../../src/protocol/subscription-deployment.ts";
import type { NativeSubscriptionTokenRecord } from "./subscription-token-deployer.ts";

export const SUBSCRIPTION_TOKEN_FUNDING_MAX_FEE_TINYBARS = 100_000_000n;
export const SUBSCRIPTION_BUYER_ASSOCIATION_MAX_FEE_TINYBARS = 100_000_000n;
export const SUBSCRIPTION_BUYER_TOPUP_MAX_FEE_TINYBARS = 10_000_000n;
const P1_OPERATOR_ID = "0.0.10384424";
const P1_BUYER_ID = "0.0.10384426";

type Phase = "operator" | "buyer";
type State = {
  version: 1;
  network: "hedera:testnet";
  p0_manifest_hash: string;
  operator_id: string;
  operator_key_sha256: string;
  buyer_id: string;
  buyer_key_sha256: string;
  token_id: string;
  steps: Record<string, TransactionStep<Phase>>;
};

type LiquidityState = Omit<State, "token_id">;

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function save(path: string, state: State | LiquidityState) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, path);
}

function load(input: {
  path: string;
  config: Config;
  handoff: P1JumboHandoff;
  buyerKey: PrivateKey;
  tokenId: string;
}) {
  const expected = {
    version: 1 as const,
    network: "hedera:testnet" as const,
    p0_manifest_hash: input.handoff.p0ManifestHash,
    operator_id: input.handoff.operatorId,
    operator_key_sha256: input.handoff.operatorKeySha256,
    buyer_id: input.config.buyerId!,
    buyer_key_sha256: sha256(input.buyerKey.publicKey.toString()),
    token_id: input.tokenId,
  };
  if (!existsSync(input.path)) return { ...expected, steps: {} };
  const state = JSON.parse(readFileSync(input.path, "utf8")) as State;
  const { steps, ...identity } = state;
  if (JSON.stringify(identity) !== JSON.stringify(expected) || !steps)
    throw new Error("subscription_buyer_journal_mismatch");
  return state;
}

function loadLiquidity(
  path: string,
  config: Config,
  handoff: P1JumboHandoff,
): LiquidityState {
  if (
    config.operatorId !== P1_OPERATOR_ID ||
    config.buyerId !== P1_BUYER_ID ||
    handoff.operatorId !== P1_OPERATOR_ID
  )
    throw new Error("p1_liquidity_account_mismatch");
  const expected = {
    version: 1 as const,
    network: "hedera:testnet" as const,
    p0_manifest_hash: handoff.p0ManifestHash,
    operator_id: P1_OPERATOR_ID,
    operator_key_sha256: handoff.operatorKeySha256,
    buyer_id: P1_BUYER_ID,
    buyer_key_sha256: "operator-funded",
  };
  if (!existsSync(path)) return { ...expected, steps: {} };
  const state = JSON.parse(readFileSync(path, "utf8")) as LiquidityState;
  const { steps, ...identity } = state;
  if (JSON.stringify(identity) !== JSON.stringify(expected) || !steps)
    throw new Error("subscription_liquidity_journal_mismatch");
  return state;
}

export function isSubscriptionBuyerTopupComplete(
  path: string,
  config: Config,
  handoff: P1JumboHandoff,
) {
  const state = loadLiquidity(path, config, handoff);
  return (
    state.steps["buyer.hbar_topup"]?.attempts.at(-1)?.status === "consensus"
  );
}

export async function topUpSubscriptionBuyer(input: {
  operator: Client;
  operatorKey: PrivateKey;
  config: Config;
  handoff: P1JumboHandoff;
  statePath: string;
}) {
  let current = loadLiquidity(input.statePath, input.config, input.handoff);
  const runner = new ResumableTransactionRunner({
    client: input.operator,
    key: input.operatorKey,
    mirrorUrl: input.config.mirrorUrl,
    getSteps: () => current.steps,
    saveSteps: (steps) => {
      current = { ...current, steps };
      save(input.statePath, current);
    },
    capFor: () => SUBSCRIPTION_BUYER_TOPUP_MAX_FEE_TINYBARS,
    budgetFor: () => ({
      total: SUBSCRIPTION_BUYER_TOPUP_MAX_FEE_TINYBARS,
      gas: 0n,
    }),
    requiresEntity: () => false,
    isNonReplannable: () => true,
  });
  const result = await runner.run("buyer.hbar_topup", "operator", () =>
    new TransferTransaction()
      .addHbarTransfer(
        P1_OPERATOR_ID,
        Hbar.fromTinybars((-P1_BUYER_TOPUP_TINYBARS).toString()),
      )
      .addHbarTransfer(
        P1_BUYER_ID,
        Hbar.fromTinybars(P1_BUYER_TOPUP_TINYBARS.toString()),
      ),
  );
  return {
    from: P1_OPERATOR_ID,
    to: P1_BUYER_ID,
    amount_tinybars: P1_BUYER_TOPUP_TINYBARS.toString(),
    transaction_id: result.transaction_id,
    fee_tinybars: result.fee_tinybars!,
  };
}

async function tokenBalance(
  config: Config,
  accountId: string,
  tokenId: TokenId,
  waitForRelationship = false,
) {
  for (let attempt = 0; attempt < (waitForRelationship ? 10 : 1); attempt++) {
    const url = new URL(`${config.mirrorUrl}/accounts/${accountId}/tokens`);
    url.searchParams.set("token.id", tokenId.toString());
    url.searchParams.set("limit", "2");
    const body = (await fetchJson(url)) as {
      tokens?: { token_id?: string; balance?: number }[];
    };
    const relationships = (body.tokens ?? []).filter(
      (token) => token.token_id === tokenId.toString(),
    );
    if (relationships.length > 1) throw new Error("ambiguous_token_relationship");
    if (relationships.length === 1) {
      const amount = relationships[0]!.balance;
      if (!Number.isSafeInteger(amount) || amount! < 0)
        throw new Error("invalid_token_relationship");
      return { isAssociated: true, amount: BigInt(amount!) };
    }
    if (attempt < 9) await delay(1_000);
  }
  return { isAssociated: false, amount: 0n };
}

export async function provisionSubscriptionBuyer(input: {
  operator: Client;
  operatorKey: PrivateKey;
  buyer: Client;
  buyerKey: PrivateKey;
  config: Config;
  handoff: P1JumboHandoff;
  token: NativeSubscriptionTokenRecord;
  treasuryAccountId: string;
  statePath: string;
}) {
  if (!input.config.operatorId || !input.config.buyerId)
    throw new Error("subscription_buyer_credentials_required");
  if (input.treasuryAccountId !== input.config.operatorId)
    throw new Error("subscription_token_treasury_mismatch");
  const tokenId = TokenId.fromString(input.token.id);
  let current = load({
    path: input.statePath,
    config: input.config,
    handoff: input.handoff,
    buyerKey: input.buyerKey,
    tokenId: input.token.id,
  });
  const baseCap = (phase: Phase) =>
    phase === "operator"
      ? SUBSCRIPTION_TOKEN_FUNDING_MAX_FEE_TINYBARS
      : SUBSCRIPTION_BUYER_ASSOCIATION_MAX_FEE_TINYBARS;
  const failedFees = (phase: Phase) =>
    Object.values(current.steps)
      .filter((step) => step.phase === phase)
      .flatMap((step) => step.attempts)
      .filter((attempt) => attempt.status === "abandoned")
      .reduce(
        (sum, attempt) => sum + BigInt(attempt.fee_tinybars ?? "0"),
        0n,
      );
  const runner = (phase: Phase, client: Client, key: PrivateKey) =>
    new ResumableTransactionRunner({
      client,
      key,
      mirrorUrl: input.config.mirrorUrl,
      getSteps: () => current.steps,
      saveSteps: (steps) => {
        current = { ...current, steps };
        save(input.statePath, current);
      },
      capFor: () => baseCap(phase) - failedFees(phase),
      budgetFor: () => ({
        total: baseCap(phase) - failedFees(phase),
        gas: 0n,
      }),
      requiresEntity: () => false,
      isNonReplannable: () => true,
    });
  let balance = await tokenBalance(input.config, input.config.buyerId, tokenId);
  const pendingFunding = current.steps["token.fund"]?.attempts.at(-1);
  if (
    !balance.isAssociated &&
    pendingFunding &&
    ["planned", "submitted"].includes(pendingFunding.status)
  ) {
    const body = (await fetchJson(
      `${input.config.mirrorUrl}/transactions/${mirrorTransactionId(pendingFunding.transaction_id)}`,
    )) as { transactions?: Record<string, unknown>[] };
    const matches = (body.transactions ?? []).filter(
      (transaction) =>
        Number(transaction.nonce) === 0 &&
        typeof transaction.transaction_id === "string" &&
        normalizeTransactionId(transaction.transaction_id) ===
          normalizeTransactionId(pendingFunding.transaction_id),
    );
    if (
      matches.length !== 1 ||
      matches[0]!.result !== "TOKEN_NOT_ASSOCIATED_TO_ACCOUNT" ||
      !/^\d+$/.test(String(matches[0]!.charged_tx_fee))
    )
      throw new Error("subscription_funding_outcome_unknown");
    const attempts = current.steps["token.fund"]!.attempts.map(
      (attempt, index, values) =>
        index === values.length - 1
          ? {
              ...attempt,
              status: "abandoned" as const,
              signed_transaction: "",
              fee_tinybars: String(matches[0]!.charged_tx_fee),
            }
          : attempt,
    );
    current = {
      ...current,
      steps: {
        ...current.steps,
        "token.fund": { phase: "operator", attempts },
      },
    };
    save(input.statePath, current);
  }
  const associationAttempt = current.steps["token.associate"]?.attempts.at(-1);
  let associationId =
    input.token.buyer_association_transaction_id ??
    (associationAttempt?.status === "consensus"
      ? associationAttempt.transaction_id
      : undefined);
  if (
    !balance.isAssociated ||
    (associationAttempt && associationAttempt.status !== "consensus")
  ) {
    const result = await runner("buyer", input.buyer, input.buyerKey).run(
      "token.associate",
      "buyer",
      () =>
        new TokenAssociateTransaction()
          .setAccountId(input.config.buyerId!)
          .setTokenIds([tokenId]),
    );
    associationId = result.transaction_id;
    balance = await tokenBalance(
      input.config,
      input.config.buyerId,
      tokenId,
      true,
    );
    if (!balance.isAssociated)
      throw new Error("subscription_token_association_missing");
  }
  const target = BigInt(input.token.buyer_funding_target_atomic);
  const fundingAttempt = current.steps["token.fund"]?.attempts.at(-1);
  let fundingId =
    input.token.buyer_funding_transaction_id ??
    (fundingAttempt?.status === "consensus"
      ? fundingAttempt.transaction_id
      : undefined);
  if (
    balance.amount < target ||
    (fundingAttempt && fundingAttempt.status !== "consensus")
  ) {
    const amount = target - balance.amount;
    const result = await runner(
      "operator",
      input.operator,
      input.operatorKey,
    ).run("token.fund", "operator", () =>
      new TransferTransaction()
        .addTokenTransfer(tokenId, input.config.operatorId!, -amount)
        .addTokenTransfer(tokenId, input.config.buyerId!, amount),
    );
    fundingId = result.transaction_id;
    balance = await tokenBalance(
      input.config,
      input.config.buyerId,
      tokenId,
      true,
    );
    if (balance.amount !== target)
      throw new Error("subscription_token_funding_mismatch");
  }
  return {
    ...input.token,
    ...(associationId
      ? { buyer_association_transaction_id: associationId }
      : {}),
    ...(fundingId ? { buyer_funding_transaction_id: fundingId } : {}),
  };
}
