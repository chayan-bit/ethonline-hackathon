export const PYTH_STACK_CAP_TINYBARS = 80n * 100_000_000n;
export const FULL_RECOVERY_CAP_TINYBARS = 100n * 100_000_000n;
export const FEE_QUOTE_MAX_AGE_SECONDS = 3_600;

export const PYTH_GAS_LIMITS = Object.freeze({
  receiverSetup: 400_000n,
  receiverImplementation: 2_500_000n,
  receiverProxy: 500_000n,
  rotation: 500_000n,
  pythImplementation: 6_500_000n,
  pythProxy: 500_000n,
});

const CONTRACT_CREATE_COUNT = 5n;
const FULL_RECOVERY_CREATE_COUNT = 6n;
const SIGNAL_LEDGER_AND_LIFECYCLE_GAS = 8_000_000n;
const CONTRACT_CREATE_USD_CENTS = 100n;
const TINYBARS_PER_HBAR = 100_000_000n;
const WEIBARS_PER_TINYBAR = 10_000_000_000n;

type ExchangeRate = { cent_equivalent: bigint; hbar_equivalent: bigint };
export type PythStackEstimate = {
  gasTinybars: bigint;
  createTinybars: bigint;
  totalTinybars: bigint;
};

const divideCeil = (value: bigint, divisor: bigint) => (value + divisor - 1n) / divisor;

export function estimatePythStackTinybars(gasPriceWeibars: bigint, rate: ExchangeRate): PythStackEstimate {
  if (gasPriceWeibars <= 0n || rate.cent_equivalent <= 0n || rate.hbar_equivalent <= 0n) throw new Error('invalid_fee_quote');
  const totalGas = Object.values(PYTH_GAS_LIMITS).reduce((sum, value) => sum + value, 0n);
  const gasTinybars = divideCeil(totalGas * gasPriceWeibars, WEIBARS_PER_TINYBAR);
  const createTinybars = divideCeil(CONTRACT_CREATE_COUNT * CONTRACT_CREATE_USD_CENTS * rate.hbar_equivalent * TINYBARS_PER_HBAR, rate.cent_equivalent);
  return {
    gasTinybars,
    createTinybars,
    totalTinybars: gasTinybars + createTinybars,
  };
}

export function estimateFullRecoveryTinybars(gasPriceWeibars: bigint, rate: ExchangeRate): PythStackEstimate {
  if (gasPriceWeibars <= 0n || rate.cent_equivalent <= 0n || rate.hbar_equivalent <= 0n) throw new Error('invalid_fee_quote');
  const pythGas = Object.values(PYTH_GAS_LIMITS).reduce((sum, value) => sum + value, 0n);
  const gasTinybars = divideCeil((pythGas + SIGNAL_LEDGER_AND_LIFECYCLE_GAS) * gasPriceWeibars, WEIBARS_PER_TINYBAR);
  const createTinybars = divideCeil(FULL_RECOVERY_CREATE_COUNT * CONTRACT_CREATE_USD_CENTS * rate.hbar_equivalent * TINYBARS_PER_HBAR, rate.cent_equivalent);
  return {
    gasTinybars,
    createTinybars,
    totalTinybars: gasTinybars + createTinybars,
  };
}

export function requireDeploymentBudget(estimate: PythStackEstimate, balanceTinybars: bigint, quoteAgeSeconds: number): void {
  if (!Number.isSafeInteger(quoteAgeSeconds) || quoteAgeSeconds < 0 || quoteAgeSeconds > FEE_QUOTE_MAX_AGE_SECONDS) {
    throw new Error('stale_fee_quote');
  }
  if (estimate.totalTinybars > PYTH_STACK_CAP_TINYBARS) throw new Error('pyth_stack_cap_exceeded');
  if (balanceTinybars < FULL_RECOVERY_CAP_TINYBARS) throw new Error('recovery_balance_insufficient');
}

export function remainingDeploymentBudget(capTinybars: bigint, confirmedFees: readonly bigint[]): bigint {
  if (capTinybars <= 0n || confirmedFees.some((fee) => fee < 0n)) throw new Error('invalid_deployment_spend');
  const confirmed = confirmedFees.reduce((sum, fee) => sum + fee, 0n);
  if (confirmed >= capTinybars) throw new Error('deployment_cap_exhausted');
  return capTinybars - confirmed;
}

export function deploymentNonces(first: number) {
  if (!Number.isSafeInteger(first) || first < 0) throw new Error('invalid_deployment_nonce');
  return Object.freeze({
    receiverSetup: first,
    receiverImplementation: first + 1,
    receiverProxy: first + 2,
    pythImplementation: first + 3,
    pythProxy: first + 4,
    signalLedger: first + 5,
  });
}

export function splitFileContents(contents: Uint8Array, chunkSize: number): Uint8Array[] {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) throw new Error('invalid_file_chunk_size');
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < contents.length; offset += chunkSize) chunks.push(Uint8Array.from(contents.subarray(offset, offset + chunkSize)));
  return chunks;
}

export function maskRuntimeImmutables(runtime: Uint8Array, ranges: readonly { start: number; length: number }[]): Uint8Array {
  const masked = Uint8Array.from(runtime);
  for (const range of ranges) {
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.length) || range.start < 0 || range.length < 1 || range.start + range.length > masked.length)
      throw new Error('invalid_immutable_range');
    masked.fill(0, range.start, range.start + range.length);
  }
  return masked;
}

export type VaaMetadata = {
  version: number;
  guardianSetIndex: number;
  signatureCount: number;
  emitterChain: number;
  emitterAddress: `0x${string}`;
  sequence: bigint;
};

export function parseVaaMetadata(input: Uint8Array): VaaMetadata {
  const vaa = Buffer.from(input);
  if (vaa.length < 6) throw new Error('invalid_vaa');
  const signatureCount = vaa.readUInt8(5);
  const bodyOffset = 6 + signatureCount * 66;
  if (vaa.length < bodyOffset + 51) throw new Error('invalid_vaa');
  return {
    version: vaa.readUInt8(0),
    guardianSetIndex: vaa.readUInt32BE(1),
    signatureCount,
    emitterChain: vaa.readUInt16BE(bodyOffset + 8),
    emitterAddress: `0x${vaa.subarray(bodyOffset + 10, bodyOffset + 42).toString('hex')}`,
    sequence: vaa.readBigUInt64BE(bodyOffset + 42),
  };
}

export function corruptAccumulatorSignature(input: Uint8Array): Uint8Array {
  const update = Buffer.from(input);
  if (update.length < 18 || update.readUInt32BE(0) !== 0x504e4155 || update.readUInt8(4) !== 1 || update.readUInt8(5) !== 0) {
    throw new Error('invalid_accumulator_update');
  }
  const proofTypeOffset = 7 + update.readUInt8(6);
  const vaaLengthOffset = proofTypeOffset + 1;
  if (update.length < vaaLengthOffset + 2 || update.readUInt8(proofTypeOffset) !== 0) throw new Error('invalid_accumulator_update');
  const vaaLength = update.readUInt16BE(vaaLengthOffset);
  const vaaOffset = vaaLengthOffset + 2;
  if (vaaLength < 72 || update.length < vaaOffset + vaaLength || update.readUInt8(vaaOffset + 5) < 1) throw new Error('invalid_accumulator_update');
  const corrupted = Buffer.from(update);
  corrupted[vaaOffset + 7] ^= 1;
  return corrupted;
}

const INVALID_WORMHOLE_VAA_SELECTOR = '0x2acbe915';

export function isInvalidWormholeVaa(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth++) {
    const value = current as Record<string, unknown>;
    const data = value.data;
    if (typeof data === 'string' && data.slice(0, 10).toLowerCase() === INVALID_WORMHOLE_VAA_SELECTOR) return true;
    if (data && typeof data === 'object' && (data as Record<string, unknown>).errorName === 'InvalidWormholeVaa') return true;
    current = value.cause;
  }
  return false;
}
