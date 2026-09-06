import { TopicMessageSubmitTransaction } from '@hiero-ledger/sdk';
import { keccak256, stringToHex } from 'viem';
import type { Config } from '../adapters/config.ts';
import { operatorClient, publicClient } from '../adapters/hedera.ts';
import { historicalPrice, pythAbi } from '../adapters/pyth.ts';
import { Ledger } from '../adapters/ledger.ts';
import { POLICY } from '../protocol/signal.ts';
import type { Store } from './store.ts';
import type { Gateway, Purchase } from './gateway.ts';
import type { SampleEvidence } from './indexer.ts';

type JobState = { attempts: number; next_attempt: number; status: string; transaction_id?: string };
export class Worker {
  private running = false;
  constructor(private readonly config: Config, private readonly store: Store, private readonly ledger: Ledger, private readonly gateway: Gateway) {}

  async tick(): Promise<void> {
    if (this.running || !this.config.workerEnabled) return;
    this.running = true;
    try {
      for (const p of this.store.purchases()) {
        const id = p.quote.request.request_id;
        if (p.payment && ['settlement_pending', 'paid', 'commit_pending'].includes(p.status)) {
          await this.attempt(`recover/${id}`, async () => {
            const result = await this.gateway.purchase(id, p.payment!);
            if (!['delivered','paid_commit_failed','payment_failed'].includes(result.status)) throw new Error('recovery_pending');
          });
        }
        if (p.status !== 'delivered') continue;
        await this.attempt(`audit/${id}`, () => this.audit(p));
        if (p.prepared && Math.floor(Date.now() / 1000) >= p.quote.request.target_time) {
          await this.attempt(`reveal/${id}`, () => this.ledger.reveal(p.prepared!));
          await this.attempt(`grade/${id}`, () => this.grade(p));
        }
      }
    } finally { this.running = false; }
  }

  private async attempt(id: string, action: () => Promise<unknown>) {
    const now = Math.floor(Date.now() / 1000);
    const previous = this.store.get<JobState>('jobs', id) ?? { attempts: 0, next_attempt: 0, status: 'pending' };
    if (previous.status === 'done' || previous.next_attempt > now) return;
    try {
      const result = await action();
      this.store.put('jobs', id, { ...previous, status: 'done', result });
    } catch (error) {
      const attempt = previous.attempts + 1;
      this.store.put('jobs', id, { attempts: attempt, status: 'retrying', next_attempt: now + Math.min(3600, 30 * 2 ** Math.min(attempt, 7)),
        error: id.startsWith('grade/') ? 'oracle_unavailable' : (error instanceof Error ? error.name : 'worker_error') });
      if (id.startsWith('grade/')) {
        const requestId = id.slice(6);
        const sample = this.store.get<SampleEvidence>('samples', requestId);
        if (sample && !sample.grade && sample.oracle_status !== 'excluded') this.store.put('samples', requestId, { ...sample, oracle_status: 'unavailable', oracle_status_at: now });
      }
    }
  }

  private async audit(p: Purchase) {
    if (!this.config.topicId) throw new Error('hcs_not_configured');
    const message = {
      version: 1, event_type: 'signal.committed', event_id: keccak256(stringToHex(p.quote.request.request_id)),
      request_id: p.quote.request.request_id, agent_id: p.quote.request.agent_id, payment_mode: 'x402', payment_ref: p.payment_ref,
      ledger_transaction_id: p.commitment?.transaction_id, commitment_hash: p.prepared?.hash, schema: p.quote.request.schema, target_time: p.quote.request.target_time,
    };
    const client = operatorClient(this.config);
    try {
      const response = await new TopicMessageSubmitTransaction().setTopicId(this.config.topicId).setMessage(JSON.stringify(message)).execute(client);
      await response.getReceipt(client);
      return { transaction_id: response.transactionId.toString(), topic_id: this.config.topicId };
    } finally { client.close(); }
  }

  private async grade(p: Purchase) {
    const commitment = await this.ledger.commitment(p.quote.request.request_id);
    if (!commitment.revealed) throw new Error('not_revealed');
    const [issue, target] = await Promise.all([historicalPrice(this.config, commitment.committed_at), historicalPrice(this.config, commitment.target_time)]);
    const client = publicClient(this.config);
    const fees = await Promise.all([issue, target].map(u => client.readContract({ address: this.config.pythAddress, abi: pythAbi, functionName: 'getUpdateFee', args: [u.updates] })));
    const fee = fees[0] + fees[1];
    // Authenticate in a read-only simulation before spending operating HBAR on a known-invalid oracle payload.
    await client.simulateContract({ address: this.ledger.address, abi: this.ledger.abi, functionName: 'grade',
      args: [p.quote.request.request_id, issue.updates, target.updates], value: fee * 10_000_000_000n });
    if (issue.publishTime > commitment.committed_at + POLICY.oracleWindow || target.publishTime > commitment.target_time + POLICY.oracleWindow) throw new Error('oracle_window');
    return this.ledger.grade(p.quote.request.request_id, issue.updates, target.updates, fee);
  }
}
