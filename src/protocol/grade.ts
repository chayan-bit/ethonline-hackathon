export type Price = { price: bigint; expo: number; conf: bigint };
export type Grade = { actual_return_bps: number; absolute_error_bps: number; direction_correct: boolean };
const direction = (n: number) => n < -5 ? -1 : n > 5 ? 1 : 0;

function validatePrice(p: Price): void {
  if (p.price <= 0n || p.price > (2n ** 63n - 1n) || p.conf < 0n || p.conf * 10000n > p.price * 100n) {
    throw new Error('oracle_excluded: price or confidence');
  }
  if (!Number.isInteger(p.expo) || Math.abs(p.expo) > 18) throw new Error('oracle_unavailable: exponent range');
}

export function calculateGrade(predicted: number, issue: Price, target: Price): Grade {
  validatePrice(issue);
  validatePrice(target);
  if (!Number.isInteger(predicted) || predicted < -10000 || predicted > 100000) throw new Error('invalid_signal');
  const exponent = Math.min(issue.expo, target.expo);
  const p0 = issue.price * 10n ** BigInt(issue.expo - exponent);
  const p1 = target.price * 10n ** BigInt(target.expo - exponent);
  const actual = ((p1 - p0) * 10000n) / p0;
  if (actual > BigInt(Number.MAX_SAFE_INTEGER) || actual < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('oracle_unavailable: return range');
  const difference = BigInt(predicted) - actual;
  const error = difference < 0n ? -difference : difference;
  if (error > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('oracle_unavailable: error range');
  return { actual_return_bps: Number(actual), absolute_error_bps: Number(error), direction_correct: direction(predicted) === direction(Number(actual)) };
}
