import {
  P1_BUYER_CAP_TINYBARS,
  P1_DEPLOYER_CAP_TINYBARS,
} from "./subscription-deployment.ts";

export type P1Spend = Readonly<{ operator: bigint; buyer: bigint }>;

export function p1EvidenceFeeCaps(
  bootstrap: P1Spend,
  reservedValue: P1Spend,
): P1Spend {
  const values = [
    bootstrap.operator,
    bootstrap.buyer,
    reservedValue.operator,
    reservedValue.buyer,
  ];
  if (values.some((value) => value < 0n)) throw new Error("invalid_p1_spend");
  const operator =
    P1_DEPLOYER_CAP_TINYBARS - bootstrap.operator - reservedValue.operator;
  const buyer = P1_BUYER_CAP_TINYBARS - bootstrap.buyer - reservedValue.buyer;
  if (operator <= 0n || buyer <= 0n)
    throw new Error("p1_evidence_cap_exhausted");
  return Object.freeze({ operator, buyer });
}

export function assertP1TotalSpend(fees: P1Spend, values: P1Spend) {
  if (
    fees.operator < 0n ||
    fees.buyer < 0n ||
    values.operator < 0n ||
    values.buyer < 0n ||
    fees.operator + values.operator > P1_DEPLOYER_CAP_TINYBARS ||
    fees.buyer + values.buyer > P1_BUYER_CAP_TINYBARS
  )
    throw new Error("p1_total_cap_exceeded");
}

export function assertP1PlannedSpend(
  priorFees: P1Spend,
  values: P1Spend,
  feeCeilings: P1Spend,
) {
  assertP1TotalSpend(
    {
      operator: priorFees.operator + feeCeilings.operator,
      buyer: priorFees.buyer + feeCeilings.buyer,
    },
    values,
  );
}

export function requireP1EvidenceBalances(
  balances: P1Spend,
  fees: P1Spend,
  values: P1Spend,
) {
  const remaining = p1EvidenceFeeCaps(fees, values);
  if (balances.operator < remaining.operator)
    throw new Error("p1_evidence_operator_balance_insufficient");
  if (balances.buyer < remaining.buyer)
    throw new Error("p1_evidence_buyer_balance_insufficient");
}
