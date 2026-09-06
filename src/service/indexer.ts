import { AccountId } from '@hiero-ledger/sdk';
import { decodeEventLog, type Hex } from 'viem';
import type { Config } from '../adapters/config.ts';
import { fetchJson, record } from '../adapters/http.ts';
import { artifact, publicClient } from '../adapters/hedera.ts';
import { getPaymentEvidence, paymentReference, normalizeTransactionId, facilitator } from '../adapters/payment.ts';
import { SCHEMA } from '../protocol/signal.ts';
import type { Sample } from '../protocol/metrics.ts';
import type { Store } from './store.ts';
import type { Quote } from './gateway.ts';

type Event = { eventName: string; args: Record<string, unknown>; transaction_hash: string; index: number; timestamp: string };
type SampleEvidence = Sample & { payment_ref: string; quote: Quote; commitment_hash: string; transaction_hash: string; native_payment_id: string; reveal?: unknown; grade_evidence?: unknown };
const serializable = (value: unknown) => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v));
const consensusNanos = (value: unknown): bigint => {
  const match = /^(\d+)\.(\d{9})$/.exec(String(value));
  if (!match) throw new Error('invalid_log_timestamp');
  return BigInt(match[1]) * 1_000_000_000n + BigInt(match[2]);
};
type CanonicalSnapshot = { watermark: string; eventKeys: Set<string> };
const eventKey = (abi: ReturnType<typeof artifact>['abi'], data: Hex, topics: readonly Hex[]) => {
  const decoded = decodeEventLog({ abi, data, topics: topics as [Hex, ...Hex[]] });
  return `${String(decoded.eventName)}/${String((decoded.args as unknown as Record<string, unknown>).requestId)}`;
};

async function canonicalSnapshot(config: Config, abi: ReturnType<typeof artifact>['abi']): Promise<CanonicalSnapshot> {
  if (!config.ledgerAddress || !Number.isSafeInteger(config.ledgerDeploymentBlock)) throw new Error('ledger_deployment_block_required');
  const client = publicClient(config);
  const head = await client.getBlock({ blockTag: 'safe' });
  if (head.number === null) throw new Error('canonical_head_unavailable');
  const eventKeys = new Set<string>();
  const first = BigInt(config.ledgerDeploymentBlock);
  for (let from = first; from <= head.number; from += 1_000n) {
    const to = from + 999n < head.number ? from + 999n : head.number;
    const logs = await client.getLogs({ address: config.ledgerAddress, fromBlock: from, toBlock: to });
    for (const log of logs) eventKeys.add(eventKey(abi, log.data, log.topics));
  }
  return { watermark: `${head.timestamp}.999999999`, eventKeys };
}

export class Indexer {
  private readonly abi = artifact('SignalLedger').abi;
  private isRunning = false;
  constructor(private readonly config: Config, private readonly store: Store,
    private readonly snapshot = () => canonicalSnapshot(config, this.abi)) {}

  async sync(): Promise<void> {
    if (this.isRunning || !this.config.ledgerAddress) return;
    this.isRunning = true;
    try {
      const canonical = await this.snapshot();
      const watermark = canonical.watermark;
      consensusNanos(watermark);
      // ponytail: replay all contract logs so Mirror endpoint lag cannot strand an event below a network-wide cursor; checkpoint once volume makes replay material.
      const replayFrom = '0.000000000';
      const url = new URL(`${this.config.mirrorUrl}/contracts/${this.config.ledgerAddress}/results/logs`);
      url.searchParams.append('timestamp', `gte:${replayFrom}`);
      url.searchParams.append('timestamp', `lte:${watermark}`);
      url.searchParams.set('order', 'asc'); url.searchParams.set('limit', '100');
      const mirrorEventKeys = await this.readPages(url, replayFrom, watermark);
      if ([...canonical.eventKeys].some(key => !mirrorEventKeys.has(key))) throw new Error('mirror_contract_logs_incomplete');
      await this.verifyPayments(Math.floor(Number(watermark)));
      this.store.put('indexer', 'cursor', watermark);
      this.store.put('indexer', 'status', { indexed_through: Math.floor(Number(watermark)), synced_at: Math.floor(Date.now() / 1000), error: null });
    } catch (error) {
      const previous = this.store.get<Record<string, unknown>>('indexer', 'status') ?? { indexed_through: 0 };
      this.store.put('indexer', 'status', { ...previous, error: error instanceof Error ? error.message.split(':')[0] : 'indexer_error' });
      throw error;
    } finally { this.isRunning = false; }
  }

  private async readPages(start: URL, cursor: string, watermark: string) {
    const lower = consensusNanos(cursor);
    const upper = consensusNanos(watermark);
    const eventKeys = new Set<string>();
    let next: URL | null = start;
    for (let page = 0; next && page < 1000; page++) {
      const response = record(await fetchJson(next));
      if (!Array.isArray(response.logs)) throw new Error('invalid_mirror_logs');
      const logs = response.logs.map(record);
      for (const raw of logs) {
        const timestamp = consensusNanos(raw.timestamp);
        if (timestamp < lower || timestamp > upper) throw new Error('future_log_outside_watermark');
      }
      for (const raw of logs) eventKeys.add(this.ingest(raw));
      const link = record(response.links).next;
      next = typeof link === 'string' ? new URL(link, this.config.mirrorUrl) : null;
      if (next && (next.origin !== start.origin || !next.pathname.startsWith('/api/v1/contracts/'))) throw new Error('unsafe_mirror_pagination');
    }
    if (next) throw new Error('indexer_page_limit');
    return eventKeys;
  }

  private ingest(raw: Record<string, unknown>): string {
    if (typeof raw.data !== 'string' || !Array.isArray(raw.topics) || typeof raw.transaction_hash !== 'string') throw new Error('invalid_log');
    const decoded = decodeEventLog({ abi: this.abi, data: raw.data as Hex, topics: raw.topics as [Hex, ...Hex[]] });
    if (!decoded.eventName) throw new Error('unknown_contract_event');
    const event: Event = { eventName: decoded.eventName, args: serializable(decoded.args), transaction_hash: raw.transaction_hash, index: Number(raw.index), timestamp: String(raw.timestamp) };
    const key = `${event.eventName}/${String(event.args.requestId)}`;
    const eventId = `${event.transaction_hash}/${event.index}`;
    if (this.store.get('events', eventId)) return key;
    this.applyEvent(event);
    this.store.put('events', eventId, event);
    return key;
  }

  private applyEvent(e: Event) {
    const a = e.args;
    const id = String(a.requestId);
    if (e.eventName === 'SignalCommitted') {
      const buyer = AccountId.fromSolidityAddress(String(a.payer)).toString();
      const payTo = AccountId.fromSolidityAddress(String(a.payee)).toString();
      const quote: Quote = { created_at: Number(a.committedAt), expires_at: Number(a.targetTime),
        request: { request_id: id, buyer, agent_id: String(a.agentId), schema: SCHEMA, price_feed_id: String(a.priceFeedId) as Hex, target_time: Number(a.targetTime) },
        requirements: { scheme: 'exact', network: 'hedera:testnet', asset: '0.0.0', amount: String(a.amount), payTo, maxTimeoutSeconds: 120, extra: { feePayer: normalizeTransactionId(String(a.nativePaymentId)).split('@')[0] } },
      };
      const sample: SampleEvidence = { request_id: id, agent_id: String(a.agentId), schema: SCHEMA, price_feed_id: String(a.priceFeedId),
        payment_mode: 'x402', payment_status: 'pending', payment_verified_at: null, payer: buyer, committed_at: Number(a.committedAt), target_time: Number(a.targetTime),
        revealed_at: null, grade: null, oracle_status: 'pending', oracle_status_at: null, payment_ref: String(a.paymentRef),
        quote, commitment_hash: String(a.signalHash), transaction_hash: e.transaction_hash, native_payment_id: String(a.nativePaymentId) };
      this.store.put('samples', id, sample);
      this.store.put('commit_events', id, { transaction_hash: e.transaction_hash });
      return;
    }
    const prior = this.store.get<SampleEvidence>('samples', id);
    if (!prior) throw new Error('missing_commitment_event');
    if (e.eventName === 'SignalRevealed') this.store.put('samples', id, { ...prior, revealed_at: Number(a.revealedAt), reveal: a });
    if (e.eventName === 'SignalGraded') this.store.put('samples', id, { ...prior, grade: {
      graded_at: Number(a.finalizedAt), actual_return_bps: Number(a.actualReturnBps), absolute_error_bps: Number(a.absoluteErrorBps), direction_correct: a.directionCorrect === true,
    }, oracle_status: 'pending', oracle_status_at: Number(a.finalizedAt), grade_evidence: a });
    if (e.eventName === 'SignalOracleExcluded') this.store.put('samples', id, { ...prior, oracle_status: 'excluded', oracle_status_at: Number(a.finalizedAt), grade_evidence: a });
  }

  private async verifyPayments(watermark: number) {
    const activeFeePayer = await facilitator(this.config).feePayer();
    this.store.put('verified_facilitators', activeFeePayer, { account: activeFeePayer });
    for (const sample of this.store.list<SampleEvidence>('samples').filter(s => s.payment_status === 'pending')) {
      if (sample.payment_ref !== paymentReference(sample.native_payment_id)) {
        this.store.put('samples', sample.request_id, { ...sample, payment_status: 'invalid' });
        continue;
      }
      if (!this.store.get('verified_facilitators', String(sample.quote.requirements.extra.feePayer))) continue;
      const result = await getPaymentEvidence(this.config, sample.native_payment_id, sample.quote);
      if (result.status === 'verified' && (result.consensus_time! > watermark || result.consensus_time! > sample.committed_at)) continue;
      if (result.status !== 'pending') this.store.put('samples', sample.request_id, { ...sample, payment_status: result.status, payment_verified_at: result.status === 'verified' ? result.consensus_time! : null });
    }
  }
}
export type { SampleEvidence };
