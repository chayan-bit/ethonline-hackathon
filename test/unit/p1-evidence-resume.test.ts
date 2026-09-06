import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canRefreshUncreatedTimeline,
  shouldEnterTemporaryPayeeStage,
  validateEvidenceStep,
} from "../../src/protocol/p1-evidence-resume.ts";

const signed = {
  transaction_id: "0.0.1001@1788671000.000000001",
  planned_at: 1788671000,
  signed_transaction: "AQID",
  transaction_hash: "ab".repeat(32),
  allocation_tinybars: "100000000",
};

test("P1 evidence resume accepts exact signed pending steps and consensus receipts", () => {
  assert.equal(
    validateEvidenceStep(
      "operator",
      { phase: "operator", attempts: [{ ...signed, status: "planned" }] },
      100_000_000n,
    ),
    true,
  );
  assert.equal(
    validateEvidenceStep(
      "operator",
      { phase: "operator", attempts: [{ ...signed, status: "submitted" }] },
      100_000_000n,
    ),
    true,
  );
  assert.equal(
    validateEvidenceStep(
      "operator",
      {
        phase: "operator",
        attempts: [
          {
            ...signed,
            status: "consensus",
            signed_transaction: "",
            fee_tinybars: "1234",
          },
        ],
      },
      100_000_000n,
    ),
    true,
  );
  assert.equal(
    validateEvidenceStep(
      "operator",
      { phase: "operator", attempts: [{ ...signed, status: "planned", signed_transaction: "" }] },
      100_000_000n,
    ),
    false,
  );
});

test("P1 timeline refresh permits only the completed payee switch and reusable exact allowance", () => {
  const consensus = {
    phase: "operator",
    attempts: [
      {
        ...signed,
        status: "consensus" as const,
        signed_transaction: "",
        fee_tinybars: "1",
      },
    ],
  };
  assert.equal(
    canRefreshUncreatedTimeline({
      "operator.payee.to_buyer": consensus,
      "operator.cancelled.allowance": consensus,
    }),
    true,
  );
  assert.equal(
    canRefreshUncreatedTimeline({
      "operator.payee.to_buyer": consensus,
      "operator.cancelled.allowance": consensus,
      "operator.cancelled.create": consensus,
    }),
    false,
  );
});

test("P1 payee resume never re-enters the temporary stage after restore starts", () => {
  assert.equal(shouldEnterTemporaryPayeeStage({}), true);
  assert.equal(
    shouldEnterTemporaryPayeeStage({
      "operator.payee.to_buyer": {
        phase: "operator",
        attempts: [{ ...signed, status: "consensus", signed_transaction: "", fee_tinybars: "1" }],
      },
    }),
    true,
  );
  for (const status of ["planned", "submitted", "consensus"] as const) {
    assert.equal(
      shouldEnterTemporaryPayeeStage({
        "operator.payee.restore": {
          phase: "operator",
          attempts: [{
            ...signed,
            status,
            signed_transaction: status === "consensus" ? "" : signed.signed_transaction,
            ...(status === "consensus" ? { fee_tinybars: "1" } : {}),
          }],
        },
      }),
      false,
    );
  }
});
