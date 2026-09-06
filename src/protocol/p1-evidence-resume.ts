export type EvidenceAttempt = Readonly<{
  transaction_id: string;
  planned_at: number;
  signed_transaction: string;
  transaction_hash: string;
  status: "planned" | "submitted" | "consensus" | "abandoned";
  fee_tinybars?: string;
  allocation_tinybars?: string;
}>;
export type EvidenceStep = Readonly<{
  phase: string;
  attempts: readonly EvidenceAttempt[];
}>;

const TRANSACTION_ID = /^0\.0\.[1-9][0-9]{0,18}@\d+\.\d{9}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function validateEvidenceStep(
  expectedPhase: string,
  step: EvidenceStep,
  budget: bigint,
) {
  if (
    step.phase !== expectedPhase ||
    !Array.isArray(step.attempts) ||
    step.attempts.length === 0 ||
    budget <= 0n
  )
    return false;
  const consensus = step.attempts.filter(
    (attempt) => attempt.status === "consensus",
  );
  if (
    consensus.length > 1 ||
    (consensus.length === 1 && step.attempts.at(-1)?.status !== "consensus") ||
    step.attempts.at(-1)?.status === "abandoned" ||
    new Set(step.attempts.map((attempt) => attempt.transaction_id)).size !==
      step.attempts.length
  )
    return false;
  return step.attempts.every((attempt) => {
    if (
      !TRANSACTION_ID.test(attempt.transaction_id) ||
      !Number.isSafeInteger(attempt.planned_at) ||
      attempt.planned_at <= 0 ||
      !SHA256.test(attempt.transaction_hash) ||
      !/^\d+$/.test(attempt.allocation_tinybars ?? "") ||
      BigInt(attempt.allocation_tinybars!) > budget
    )
      return false;
    if (attempt.status === "planned" || attempt.status === "submitted")
      return BASE64.test(attempt.signed_transaction) &&
        attempt.signed_transaction.length > 0;
    if (attempt.status === "consensus")
      return (
        attempt.signed_transaction === "" &&
        /^\d+$/.test(attempt.fee_tinybars ?? "") &&
        BigInt(attempt.fee_tinybars!) <= budget
      );
    return attempt.signed_transaction === "";
  });
}

export function shouldEnterTemporaryPayeeStage(
  steps: Readonly<Record<string, EvidenceStep>>,
) {
  return !steps["operator.payee.restore"]?.attempts.length;
}

export function canRefreshUncreatedTimeline(
  steps: Readonly<Record<string, EvidenceStep>>,
) {
  const keys = Object.keys(steps).sort();
  return (
    JSON.stringify(keys) ===
      JSON.stringify([
        "operator.cancelled.allowance",
        "operator.payee.to_buyer",
      ]) &&
    keys.every(
      (id) => steps[id]?.attempts.at(-1)?.status === "consensus",
    )
  );
}
