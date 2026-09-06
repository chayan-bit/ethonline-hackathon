import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddress } from "viem";
import { assertSubscriptionToken } from "../../src/protocol/subscription-token.ts";

const expected = {
  id: "0.0.2000",
  address: getAddress("0x00000000000000000000000000000000000007D0"),
  symbol: "SMTT",
  decimals: 6,
};
const valid = {
  name: "SignalMarketTestToken",
  token_id: "0.0.2000",
  symbol: "SMTT",
  decimals: "6",
  type: "FUNGIBLE_COMMON",
  deleted: false,
  pause_status: "NOT_APPLICABLE",
  freeze_default: false,
  supply_type: "FINITE",
  initial_supply: "1000000",
  max_supply: "1000000",
  admin_key: null,
  fee_schedule_key: null,
  pause_key: null,
  freeze_key: null,
  kyc_key: null,
  wipe_key: null,
  custom_fees: { fixed_fees: [], fractional_fees: [] },
};

test("accepts only the configured fungible HTS token with permanently absent custom fees", () => {
  assert.deepEqual(assertSubscriptionToken(valid, expected), {
    ...expected,
    custom_fees: "none_immutable",
  });
});

test("rejects fee-bearing, fee-mutable, mismatched, deleted, paused, or non-fungible tokens", () => {
  for (const input of [
    { ...valid, fee_schedule_key: { key: "public" } },
    { ...valid, admin_key: { key: "public" } },
    { ...valid, pause_key: { key: "public" } },
    { ...valid, freeze_key: { key: "public" } },
    { ...valid, kyc_key: { key: "public" } },
    { ...valid, wipe_key: { key: "public" } },
    {
      ...valid,
      custom_fees: { fixed_fees: [{ amount: 1 }], fractional_fees: [] },
    },
    {
      ...valid,
      custom_fees: { fixed_fees: [], fractional_fees: [{ numerator: 1 }] },
    },
    { ...valid, token_id: "0.0.2001" },
    { ...valid, symbol: "USD" },
    { ...valid, name: "USD Coin" },
    { ...valid, decimals: "8" },
    { ...valid, deleted: true },
    { ...valid, pause_status: "PAUSED" },
    { ...valid, freeze_default: true },
    { ...valid, supply_type: "INFINITE" },
    { ...valid, max_supply: "0" },
    { ...valid, type: "NON_FUNGIBLE_UNIQUE" },
  ])
    assert.throws(
      () => assertSubscriptionToken(input, expected),
      /invalid_subscription_token/,
    );
});
