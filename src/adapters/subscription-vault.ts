import { AccountId } from "@hiero-ledger/sdk";
import { isAddress, zeroAddress, type Address, type Hex } from "viem";
import type { Config } from "./config.ts";
import {
  accountAddress,
  artifact,
  executeContract,
  publicClient,
} from "./hedera.ts";
import type { SubscriptionTerms } from "../protocol/subscription.ts";
import { assertSubscriptionToken } from "../protocol/subscription-token.ts";
import { fetchJson } from "./http.ts";

const subscriptionIdPattern = /^0x[0-9a-f]{64}$/;
const MAX_DURATION_SECONDS = 30n * 86_400n;
const MAX_DEPOSIT = 9_223_372_036_854_775_807n;
const MAX_RESERVE_TINYBARS = 100_000_000n;
const CREATE_MAX_FEE_TINYBARS = 500_000_000n;
const ESCROW_CALL_MAX_FEE_TINYBARS = 300_000_000n;

export type CreateSubscriptionInput = {
  subscriptionId: Hex;
  agentId: bigint;
  start: bigint;
  end: bigint;
  ratePerSecond: bigint;
  deposit: bigint;
  scheduleInterval: bigint;
  scheduledGasLimit: bigint;
  reserveTinybars: bigint;
};

function safeNumber(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0)
    throw new Error(`invalid_subscription_${field}`);
  return number;
}

function accountId(value: unknown): string {
  if (typeof value !== "string" || !isAddress(value))
    throw new Error("invalid_subscription_account");
  try {
    return AccountId.fromSolidityAddress(value).toString();
  } catch {
    throw new Error("invalid_subscription_account");
  }
}

export class SubscriptionVaultAdapter {
  private readonly factoryAbi = artifact("SubscriptionVault").abi;
  private readonly escrowAbi = artifact("SubscriptionEscrow").abi;
  private readonly client;

  constructor(
    private readonly config: Config,
    private readonly execute: typeof executeContract = executeContract,
  ) {
    this.client = publicClient(config);
  }

  private get factoryAddress(): Address {
    if (!this.config.subscriptionVaultAddress)
      throw new Error("subscription_vault_not_configured");
    return this.config.subscriptionVaultAddress;
  }

  private get agentId(): bigint {
    if (!this.config.subscriptionAgentId)
      throw new Error("subscription_agent_not_configured");
    return BigInt(this.config.subscriptionAgentId);
  }

  private tokenMetadata() {
    const {
      subscriptionTokenAddress: address,
      subscriptionTokenSymbol: symbol,
      subscriptionTokenDecimals: decimals,
    } = this.config;
    if (!address || !symbol || !Number.isSafeInteger(decimals))
      throw new Error("subscription_token_not_configured");
    return { address, symbol, decimals } as const;
  }

  async verifyTokenPolicy() {
    const token = this.tokenMetadata();
    if (!this.config.subscriptionTokenId)
      throw new Error("subscription_token_not_configured");
    const response = await fetchJson(
      `${this.config.mirrorUrl}/tokens/${this.config.subscriptionTokenId}`,
    );
    return assertSubscriptionToken(response, {
      id: this.config.subscriptionTokenId,
      ...token,
    });
  }

  async escrowAddress(subscriptionId: string): Promise<Address> {
    if (!subscriptionIdPattern.test(subscriptionId))
      throw new Error("invalid_subscription_id");
    const address = (await this.client.readContract({
      address: this.factoryAddress,
      abi: this.factoryAbi,
      functionName: "subscriptionEscrow",
      args: [subscriptionId as Hex],
    })) as Address;
    if (!isAddress(address) || address === zeroAddress)
      throw new Error("unknown_subscription");
    return address;
  }

  async subscription(subscriptionId: string): Promise<SubscriptionTerms> {
    const escrow = await this.escrowAddress(subscriptionId);
    const tokenMetadata = this.tokenMetadata();
    const [values, initial, current, spent, nextScheduledAt, scheduleAddress] =
      await Promise.all([
        this.client.readContract({
          address: escrow,
          abi: this.escrowAbi,
          functionName: "terms",
        }) as Promise<readonly unknown[]>,
        this.client.readContract({
          address: escrow,
          abi: this.escrowAbi,
          functionName: "automationReserveInitial",
        }) as Promise<bigint>,
        this.client.readContract({
          address: escrow,
          abi: this.escrowAbi,
          functionName: "automationReserve",
        }) as Promise<bigint>,
        this.client.readContract({
          address: escrow,
          abi: this.escrowAbi,
          functionName: "automationSpent",
        }) as Promise<bigint>,
        this.client.readContract({
          address: escrow,
          abi: this.escrowAbi,
          functionName: "nextScheduledAt",
        }) as Promise<bigint>,
        this.client.readContract({
          address: escrow,
          abi: this.escrowAbi,
          functionName: "scheduleAddress",
        }) as Promise<Address>,
      ]);
    const reserveInitial = BigInt(initial);
    const reserveCurrent = BigInt(current);
    const reserveSpent = BigInt(spent);
    if (
      reserveCurrent + reserveSpent > reserveInitial ||
      values.length !== 13 ||
      String(values[2]).toLowerCase() !== tokenMetadata.address.toLowerCase()
    ) {
      throw new Error("invalid_subscription_evidence");
    }
    return {
      subscription_id: subscriptionId,
      escrow,
      buyer: accountId(values[0]),
      provider: accountId(values[1]),
      token: tokenMetadata.address,
      agent_id: String(values[3]),
      start: safeNumber(values[4], "start"),
      end: safeNumber(values[5], "end"),
      rate_per_second: String(values[6]),
      deposit: String(values[7]),
      paid: String(values[8]),
      cancelled_at: safeNumber(values[9], "cancelled_at"),
      closed: values[10] === true,
      schedule_interval: safeNumber(values[11], "schedule_interval"),
      scheduled_gas_limit: safeNumber(values[12], "scheduled_gas_limit"),
      next_scheduled_at: safeNumber(nextScheduledAt, "next_scheduled_at"),
      schedule_address:
        scheduleAddress === zeroAddress ? null : scheduleAddress,
      token_symbol: tokenMetadata.symbol,
      token_decimals: tokenMetadata.decimals,
      automation_reserve_initial_tinybars: reserveInitial.toString(),
      automation_reserve_tinybars: reserveCurrent.toString(),
      automation_spent_tinybars: reserveSpent.toString(),
    };
  }

  async isEntitled(subscriptionId: string, buyer: string): Promise<boolean> {
    const escrow = await this.escrowAddress(subscriptionId);
    if (!/^0\.0\.[1-9][0-9]{0,18}$/.test(buyer))
      throw new Error("invalid_subscription_buyer");
    return (
      (await this.client.readContract({
        address: escrow,
        abi: this.escrowAbi,
        functionName: "isEntitled",
        args: [`0x${AccountId.fromString(buyer).toSolidityAddress()}`],
      })) === true
    );
  }

  async create(input: CreateSubscriptionInput) {
    const duration = input.end - input.start;
    if (
      !subscriptionIdPattern.test(input.subscriptionId) ||
      input.agentId !== this.agentId ||
      input.start < 0n ||
      duration <= 0n ||
      duration > MAX_DURATION_SECONDS ||
      input.ratePerSecond <= 0n ||
      input.deposit <= 0n ||
      input.deposit > MAX_DEPOSIT ||
      input.ratePerSecond > MAX_DEPOSIT / duration ||
      input.ratePerSecond * duration !== input.deposit ||
      input.scheduleInterval <= 0n ||
      input.scheduledGasLimit <= 0n ||
      input.scheduledGasLimit > 2_000_000n ||
      input.reserveTinybars < 0n ||
      input.reserveTinybars > MAX_RESERVE_TINYBARS
    )
      throw new Error("invalid_subscription_terms");
    return this.execute(
      this.buyerConfig(),
      this.factoryAddress,
      this.factoryAbi,
      "createSubscription",
      [
        input.subscriptionId,
        input.agentId,
        input.start,
        input.end,
        input.ratePerSecond,
        input.deposit,
        input.scheduleInterval,
        input.scheduledGasLimit,
      ],
      input.reserveTinybars,
      CREATE_MAX_FEE_TINYBARS,
    );
  }

  checkpoint(subscriptionId: string) {
    return this.writeEscrow(subscriptionId, "checkpoint", [], this.config);
  }
  claim(subscriptionId: string) {
    return this.writeEscrow(subscriptionId, "claim", [], this.config);
  }
  requestSchedule(subscriptionId: string) {
    return this.writeEscrow(
      subscriptionId,
      "requestSchedule",
      [],
      this.buyerConfig(),
    );
  }
  close(subscriptionId: string) {
    return this.writeEscrow(subscriptionId, "close", [], this.config);
  }
  cancelTo(subscriptionId: string, reserveRecipient: string) {
    if (!/^0\.0\.[1-9][0-9]{0,18}$/.test(reserveRecipient))
      throw new Error("invalid_reserve_recipient");
    return this.writeEscrow(
      subscriptionId,
      "cancelTo",
      [accountAddress(reserveRecipient)],
      this.buyerConfig(),
    );
  }
  closeTo(subscriptionId: string, reserveRecipient: string) {
    if (!/^0\.0\.[1-9][0-9]{0,18}$/.test(reserveRecipient))
      throw new Error("invalid_reserve_recipient");
    return this.writeEscrow(
      subscriptionId,
      "closeTo",
      [accountAddress(reserveRecipient)],
      this.buyerConfig(),
    );
  }

  private buyerConfig(): Config {
    if (!this.config.buyerId || !this.config.buyerKey)
      throw new Error("buyer_credentials_required");
    return {
      ...this.config,
      operatorId: this.config.buyerId,
      operatorKey: this.config.buyerKey,
    };
  }

  private async writeEscrow(
    subscriptionId: string,
    name: string,
    args: readonly unknown[],
    config: Config,
  ) {
    return this.execute(
      config,
      await this.escrowAddress(subscriptionId),
      this.escrowAbi,
      name,
      args,
      0n,
      ESCROW_CALL_MAX_FEE_TINYBARS,
    );
  }
}
