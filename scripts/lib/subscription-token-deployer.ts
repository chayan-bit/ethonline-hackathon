import {
  TokenCreateTransaction,
  TokenId,
  TokenSupplyType,
  TokenType,
  type Client,
  type PrivateKey,
} from "@hiero-ledger/sdk";
import { getAddress, type Address } from "viem";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { Config } from "../../src/adapters/config.ts";
import {
  ResumableTransactionRunner,
  type TransactionStep,
} from "../../src/adapters/hedera-resumable.ts";
import {
  SMTT_TOKEN,
  type P1JumboHandoff,
} from "../../src/protocol/subscription-deployment.ts";

export const SUBSCRIPTION_TOKEN_CREATE_MAX_FEE_TINYBARS = 1_400_000_000n;

export type NativeSubscriptionTokenRecord = {
  id: string;
  address: Address;
  name: string;
  symbol: string;
  decimals: number;
  initial_supply_atomic: string;
  max_supply_atomic: string;
  creation_transaction_id?: string;
  buyer_association_transaction_id?: string;
  buyer_funding_transaction_id?: string;
  buyer_funding_target_atomic: string;
};

type State = {
  version: 1;
  network: "hedera:testnet";
  p0_manifest_hash: string;
  operator_id: string;
  operator_key_sha256: string;
  deployer_account_id: string;
  steps: Record<string, TransactionStep<"operator">>;
};

function save(path: string, state: State) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, path);
}

function state(path: string, config: Config, handoff: P1JumboHandoff): State {
  const expected = {
    version: 1 as const,
    network: "hedera:testnet" as const,
    p0_manifest_hash: handoff.p0ManifestHash,
    operator_id: handoff.operatorId,
    operator_key_sha256: handoff.operatorKeySha256,
    deployer_account_id: handoff.accountId,
  };
  if (!existsSync(path)) return { ...expected, steps: {} };
  const stored = JSON.parse(readFileSync(path, "utf8")) as State;
  const { steps, ...identity } = stored;
  if (JSON.stringify(identity) !== JSON.stringify(expected) || !steps)
    throw new Error("subscription_token_journal_mismatch");
  if (config.operatorId !== expected.operator_id)
    throw new Error("subscription_token_operator_mismatch");
  return stored;
}

export async function createSubscriptionToken(input: {
  client: Client;
  config: Config;
  operatorKey: PrivateKey;
  handoff: P1JumboHandoff;
  statePath: string;
}): Promise<NativeSubscriptionTokenRecord> {
  if (!input.config.operatorId) throw new Error("operator_account_required");
  let current = state(input.statePath, input.config, input.handoff);
  const runner = new ResumableTransactionRunner({
    client: input.client,
    key: input.operatorKey,
    mirrorUrl: input.config.mirrorUrl,
    getSteps: () => current.steps,
    saveSteps: (steps) => {
      current = { ...current, steps };
      save(input.statePath, current);
    },
    capFor: () => SUBSCRIPTION_TOKEN_CREATE_MAX_FEE_TINYBARS,
    budgetFor: () => ({
      total: SUBSCRIPTION_TOKEN_CREATE_MAX_FEE_TINYBARS,
      gas: 0n,
    }),
    requiresEntity: () => true,
    isNonReplannable: () => true,
  });
  const result = await runner.run("token.create", "operator", () =>
    new TokenCreateTransaction()
      .setTokenName(SMTT_TOKEN.name)
      .setTokenSymbol(SMTT_TOKEN.symbol)
      .setTokenType(TokenType.FungibleCommon)
      .setDecimals(SMTT_TOKEN.decimals)
      .setInitialSupply(SMTT_TOKEN.initialSupply)
      .setSupplyType(TokenSupplyType.Finite)
      .setMaxSupply(SMTT_TOKEN.maxSupply)
      .setTreasuryAccountId(input.config.operatorId!)
      .setTokenMemo("Signal Market test credit; no monetary claim"),
  );
  if (!result.entity_id) throw new Error("subscription_token_receipt_missing");
  const tokenId = TokenId.fromString(result.entity_id);
  return {
    id: result.entity_id,
    address: getAddress(`0x${tokenId.toSolidityAddress()}`),
    name: SMTT_TOKEN.name,
    symbol: SMTT_TOKEN.symbol,
    decimals: SMTT_TOKEN.decimals,
    initial_supply_atomic: SMTT_TOKEN.initialSupply.toString(),
    max_supply_atomic: SMTT_TOKEN.maxSupply.toString(),
    creation_transaction_id: result.transaction_id,
    buyer_funding_target_atomic: SMTT_TOKEN.buyerFundingTarget.toString(),
  };
}
