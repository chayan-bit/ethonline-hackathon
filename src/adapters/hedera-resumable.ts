import {
  AccountId,
  Client,
  Hbar,
  PrivateKey,
  Status,
  Transaction,
  TransactionId,
  TransactionReceiptQuery,
  TransactionRecordQuery,
  type TransactionReceipt,
} from '@hiero-ledger/sdk';
import { createHash } from 'node:crypto';
import { estimateTransactionFee } from './hedera-jumbo.ts';
import { mirrorTransactionId, normalizeTransactionId } from './payment.ts';

export type TransactionAttempt = {
  transaction_id: string;
  planned_at: number;
  signed_transaction: string;
  transaction_hash: string;
  status: 'planned' | 'submitted' | 'consensus' | 'abandoned';
  entity_id?: string;
  fee_tinybars?: string;
  fee_estimate_tinycents?: string;
  allocation_tinybars?: string;
};

export type TransactionStep<Phase extends string> = {
  phase: Phase;
  attempts: TransactionAttempt[];
};

export type TransactionBudget = Readonly<{ total: bigint; gas: bigint }>;

type Options<Phase extends string> = {
  client: Client;
  key: PrivateKey;
  mirrorUrl: string;
  getSteps: () => Record<string, TransactionStep<Phase>>;
  saveSteps: (steps: Record<string, TransactionStep<Phase>>) => void;
  capFor: (phase: Phase) => bigint;
  budgetFor: (id: string) => TransactionBudget;
  countsToward?: (stepPhase: Phase, capPhase: Phase) => boolean;
  requiresEntity?: (id: string) => boolean;
  isNonReplannable?: (id: string) => boolean;
  replanSeconds?: number;
};

const sha256 = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const now = () => Math.floor(Date.now() / 1_000);
const tinybars = (value: bigint) => Hbar.fromTinybars(value.toString());

export class ResumableTransactionRunner<Phase extends string> {
  constructor(private readonly options: Options<Phase>) {}

  latest(id: string) {
    return this.options.getSteps()[id]?.attempts.at(-1);
  }

  private spent(phase: Phase) {
    return Object.values(this.options.getSteps())
      .filter((step) => this.options.countsToward?.(step.phase, phase) ?? step.phase === phase)
      .flatMap((step) => step.attempts)
      .filter((attempt) => attempt.status === 'consensus')
      .reduce((sum, attempt) => sum + BigInt(attempt.fee_tinybars ?? '0'), 0n);
  }

  private saveAttempt(id: string, phase: Phase, attempt: TransactionAttempt) {
    const steps = this.options.getSteps();
    const prior = steps[id]?.attempts ?? [];
    this.options.saveSteps({ ...steps, [id]: { phase, attempts: [...prior, attempt] } });
  }

  private replaceAttempt(id: string, phase: Phase, index: number, attempt: TransactionAttempt) {
    const steps = this.options.getSteps();
    const attempts = (steps[id]?.attempts ?? []).map((value, position) => (position === index ? attempt : value));
    this.options.saveSteps({ ...steps, [id]: { phase, attempts } });
  }

  private async receipt(transactionId: string) {
    return new TransactionReceiptQuery().setTransactionId(transactionId).setValidateStatus(false).execute(this.options.client);
  }

  private async fee(transactionId: string) {
    const record = await new TransactionRecordQuery().setTransactionId(transactionId).execute(this.options.client);
    return BigInt(record.transactionFee.toTinybars().toString());
  }

  private async mirrorOutcome(transactionId: string) {
    const response = await fetch(`${this.options.mirrorUrl}/transactions/${mirrorTransactionId(transactionId)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`mirror_reconciliation_http_${response.status}`);
    const body = (await response.json()) as { transactions?: Record<string, unknown>[] };
    if (!Array.isArray(body.transactions)) throw new Error('invalid_mirror_reconciliation');
    const matches = body.transactions.filter(
      (item) => Number(item.nonce) === 0 && typeof item.transaction_id === 'string' && normalizeTransactionId(item.transaction_id) === normalizeTransactionId(transactionId),
    );
    if (matches.length > 1) throw new Error('ambiguous_mirror_reconciliation');
    if (matches.length === 0) return null;
    const match = matches[0]!;
    if (match.result !== 'SUCCESS') throw new Error(`transaction_failed:${String(match.result)}`);
    if (!['string', 'number'].includes(typeof match.charged_tx_fee) || !/^\d+$/.test(String(match.charged_tx_fee))) throw new Error('invalid_mirror_transaction_fee');
    return {
      entity_id: typeof match.entity_id === 'string' ? match.entity_id : undefined,
      fee_tinybars: String(match.charged_tx_fee),
    };
  }

  private checkCap(phase: Phase) {
    if (this.spent(phase) > this.options.capFor(phase)) throw new Error(`${phase}_deployment_cap_exceeded`);
  }

  private async finish(id: string, phase: Phase, index: number, attempt: TransactionAttempt, receipt: TransactionReceipt) {
    if (receipt.status !== Status.Success) throw new Error(`transaction_failed:${id}:${receipt.status.toString()}`);
    const entity = receipt.accountId?.toString() ?? receipt.contractId?.toString();
    if (this.options.requiresEntity?.(id) && !entity) {
      const mirror = await this.mirrorOutcome(attempt.transaction_id);
      if (mirror?.entity_id) return this.finishMirror(id, phase, index, attempt, mirror);
      throw new Error(`transaction_entity_pending:${id}`);
    }
    const fee = await this.fee(attempt.transaction_id);
    const complete: TransactionAttempt = { ...attempt, status: 'consensus', entity_id: entity, fee_tinybars: fee.toString(), signed_transaction: '' };
    this.replaceAttempt(id, phase, index, complete);
    this.checkCap(phase);
    return complete;
  }

  private finishMirror(id: string, phase: Phase, index: number, attempt: TransactionAttempt, outcome: { entity_id?: string; fee_tinybars: string }) {
    const complete: TransactionAttempt = { ...attempt, ...outcome, status: 'consensus', signed_transaction: '' };
    this.replaceAttempt(id, phase, index, complete);
    this.checkCap(phase);
    return complete;
  }

  async run(id: string, phase: Phase, build: () => Transaction | Promise<Transaction>): Promise<TransactionAttempt> {
    const attempts = this.options.getSteps()[id]?.attempts ?? [];
    const latest = attempts.at(-1);
    if (latest?.status === 'consensus') return latest;
    if (latest && latest.status !== 'abandoned') {
      const receipt = await this.receipt(latest.transaction_id);
      if (receipt.status !== Status.Unknown && receipt.status !== Status.ReceiptNotFound) return this.finish(id, phase, attempts.length - 1, latest, receipt);
      const mirror = await this.mirrorOutcome(latest.transaction_id);
      if (mirror) {
        if (this.options.requiresEntity?.(id) && !mirror.entity_id) throw new Error(`transaction_entity_pending:${id}`);
        return this.finishMirror(id, phase, attempts.length - 1, latest, mirror);
      }
      if (latest.planned_at + (this.options.replanSeconds ?? 180) >= now()) return this.broadcast(id, phase, attempts.length - 1, latest);
      if (this.options.isNonReplannable?.(id)) throw new Error(`transaction_outcome_unknown:${id}`);
      this.replaceAttempt(id, phase, attempts.length - 1, { ...latest, status: 'abandoned', signed_transaction: '' });
    }
    return this.planAndBroadcast(id, phase, build);
  }

  private async planAndBroadcast(id: string, phase: Phase, build: () => Transaction | Promise<Transaction>) {
    const budget = this.options.budgetFor(id);
    if (this.options.capFor(phase) - this.spent(phase) < budget.total) throw new Error(`${phase}_deployment_cap_exceeded`);
    const transactionId = TransactionId.generate(AccountId.fromString(this.options.client.operatorAccountId!.toString()));
    const transaction = (await build()).setTransactionId(transactionId).setMaxTransactionFee(tinybars(budget.total - budget.gas));
    const signed = await (await transaction.freezeWith(this.options.client)).sign(this.options.key);
    const feeEstimate = await estimateTransactionFee(this.options.client, signed);
    const bytes = signed.toBytes();
    const attempt: TransactionAttempt = {
      transaction_id: transactionId.toString(),
      planned_at: now(),
      signed_transaction: Buffer.from(bytes).toString('base64'),
      transaction_hash: sha256(bytes),
      status: 'planned',
      fee_estimate_tinycents: feeEstimate.toString(),
      allocation_tinybars: budget.total.toString(),
    };
    this.saveAttempt(id, phase, attempt);
    return this.broadcast(id, phase, (this.options.getSteps()[id]?.attempts.length ?? 1) - 1, attempt);
  }

  private async broadcast(id: string, phase: Phase, index: number, attempt: TransactionAttempt) {
    if (!attempt.signed_transaction) throw new Error(`missing_signed_transaction:${id}`);
    const bytes = Buffer.from(attempt.signed_transaction, 'base64');
    if (sha256(bytes) !== attempt.transaction_hash) throw new Error(`signed_transaction_hash_mismatch:${id}`);
    const transaction = Transaction.fromBytes(bytes);
    if (transaction.transactionId?.toString() !== attempt.transaction_id) throw new Error(`signed_transaction_id_mismatch:${id}`);
    const response = await transaction.execute(this.options.client);
    const submitted = { ...attempt, status: 'submitted' as const };
    this.replaceAttempt(id, phase, index, submitted);
    const receipt = await response.getReceipt(this.options.client);
    return this.finish(id, phase, index, submitted, receipt);
  }
}
