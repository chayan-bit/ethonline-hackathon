import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertP1TotalSpend,
  assertP1PlannedSpend,
  p1EvidenceFeeCaps,
  requireP1EvidenceBalances,
} from "../../src/protocol/p1-evidence-budget.ts";

test("P1 evidence caps reserve payable value and prior fees for each actual payer", () => {
  assert.deepEqual(
    p1EvidenceFeeCaps(
      { operator: 1_200_000_000n, buyer: 10_000_000n },
      { operator: 5_000_000n, buyer: 100_000_000n },
    ),
    { operator: 3_995_000_000n, buyer: 690_000_000n },
  );
  assert.doesNotThrow(() =>
    assertP1TotalSpend(
      { operator: 5_195_000_000n, buyer: 700_000_000n },
      { operator: 5_000_000n, buyer: 100_000_000n },
    ),
  );
  assert.throws(
    () =>
      assertP1TotalSpend(
        { operator: 5_200_000_001n, buyer: 0n },
        { operator: 0n, buyer: 0n },
      ),
    /p1_total_cap_exceeded/,
  );
});

test("operator-subscriber evidence reserves both lifecycle ceilings within the original account caps", () => {
  assert.doesNotThrow(() =>
    assertP1PlannedSpend(
      { operator: 1_879_781_249n, buyer: 387_050_047n },
      { operator: 200_000_000n, buyer: 0n },
      { operator: 2_950_000_000n, buyer: 300_000_000n },
    ),
  );
  assert.throws(
    () =>
      assertP1PlannedSpend(
        { operator: 1_879_781_249n, buyer: 387_050_047n },
        { operator: 200_000_000n, buyer: 0n },
        { operator: 3_171_000_000n, buyer: 300_000_000n },
      ),
    /p1_total_cap_exceeded/,
  );
});

test("P1 evidence preflight requires the remaining capped spend from each payer", () => {
  assert.doesNotThrow(() =>
    requireP1EvidenceBalances(
      { operator: 4_000_000_000n, buyer: 700_000_000n },
      { operator: 1_195_000_000n, buyer: 0n },
      { operator: 5_000_000n, buyer: 100_000_000n },
    ),
  );
  assert.throws(
    () =>
      requireP1EvidenceBalances(
        { operator: 3_999_999_999n, buyer: 700_000_000n },
        { operator: 1_195_000_000n, buyer: 0n },
        { operator: 5_000_000n, buyer: 100_000_000n },
      ),
    /p1_evidence_operator_balance_insufficient/,
  );
});
