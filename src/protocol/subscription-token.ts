import { TokenId } from "@hiero-ledger/sdk";
import { getAddress, type Address } from "viem";

export type SubscriptionTokenConfig = {
  id: string;
  address: Address;
  symbol: string;
  decimals: number;
};

export const SUBSCRIPTION_TOKEN_NAME = "SignalMarketTestToken";
export const SUBSCRIPTION_TOKEN_SYMBOL = "SMTT";

export function assertSubscriptionToken(
  input: unknown,
  expected: SubscriptionTokenConfig,
) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("invalid_subscription_token");
  const token = input as Record<string, unknown>;
  const fees = token.custom_fees;
  if (!fees || typeof fees !== "object" || Array.isArray(fees))
    throw new Error("invalid_subscription_token");
  const feeValues = Object.entries(fees)
    .filter(([name]) => name.endsWith("_fees"))
    .map(([, value]) => value);
  let derivedAddress: Address;
  try {
    derivedAddress = getAddress(
      `0x${TokenId.fromString(expected.id).toSolidityAddress()}`,
    );
  } catch {
    throw new Error("invalid_subscription_token");
  }
  if (
    token.name !== SUBSCRIPTION_TOKEN_NAME ||
    expected.symbol !== SUBSCRIPTION_TOKEN_SYMBOL ||
    token.token_id !== expected.id ||
    token.symbol !== expected.symbol ||
    Number(token.decimals) !== expected.decimals ||
    derivedAddress.toLowerCase() !== expected.address.toLowerCase() ||
    token.type !== "FUNGIBLE_COMMON" ||
    token.deleted !== false ||
    token.pause_status !== "NOT_APPLICABLE" ||
    token.freeze_default !== false ||
    token.supply_type !== "FINITE" ||
    !/^[1-9][0-9]*$/.test(String(token.initial_supply)) ||
    !/^[1-9][0-9]*$/.test(String(token.max_supply)) ||
    BigInt(String(token.initial_supply)) > BigInt(String(token.max_supply)) ||
    BigInt(String(token.max_supply)) > 9_223_372_036_854_775_807n ||
    [
      "admin_key",
      "fee_schedule_key",
      "pause_key",
      "freeze_key",
      "kyc_key",
      "wipe_key",
    ].some((name) => token[name] !== null) ||
    feeValues.length < 2 ||
    feeValues.some((value) => !Array.isArray(value) || value.length !== 0)
  ) {
    throw new Error("invalid_subscription_token");
  }
  return { ...expected, custom_fees: "none_immutable" as const };
}
