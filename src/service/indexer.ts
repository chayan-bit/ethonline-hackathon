import { AccountId } from '@hiero-ledger/sdk';
import { decodeEventLog, type Address, type Hex } from 'viem';
import type { Config, LedgerCohort } from '../adapters/config.ts';
import { fetchJson, record } from '../adapters/http.ts';
import { artifact, publicClient } from '../adapters/hedera.ts';
import { getPaymentEvidence, paymentReference, normalizeTransactionId, facilitator } from '../adapters/payment.ts';
import { SCHEMA } from '../protocol/signal.ts';
import type { Sample } from '../protocol/metrics.ts';
import type { Store } from './store.ts';
import type { Quote } from './gateway.ts';

type Event = {
  eventName: string;
  args: Record<string, unknown>;
  transaction_hash: string;
  index: number;
  timestamp: string;
};
type SampleEvidence = Sample & {
  ledger_address: Address;
  payment_ref: string;
  quote: Quote;
  commitment_hash: string;
  transaction_hash: string;
  native_payment_id: string;
  reveal?: unknown;
  grade_evidence?: unknown;
};
const serializable = (value: unknown) => JSON.parse(JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
const consensusNanos = (value: unknown): bigint => {
  const match = /^(\d+)\.(\d{9})$/.exec(String(value));
  if (!match) throw new Error('invalid_log_timestamp');
  return BigInt(match[1]) * 1_000_000_000n + BigInt(match[2]);
};
type CanonicalSnapshot = { watermark: string; eventKeys: Set<string> };
const eventKey = (abi: ReturnType<typeof artifact>['abi'], data: Hex, topics: readonly Hex[]) => {
  const decoded = decodeEventLog({
    abi,
    data,
    topics: topics as [Hex, ...Hex[]],
  });
  return `${String(decoded.eventName)}/${String((decoded.args as unknown as Record<string, unknown>).requestId)}`;
};

async function canonicalSnapshot(config: Config, abi: ReturnType<typeof artifact>['abi'], cohort: LedgerCohort): Promise<CanonicalSnapshot> {
  const client = publicClient(config);
  const head = await client.getBlock({ blockTag: 'safe' });
  if (head.number === null) throw new Error('canonical_head_unavailable');
  const eventKeys = new Set<string>();
  const first = BigInt(cohort.deploymentBlock);
  for (let from = first; from <= head.number; from += 1_000n) {
    const to = from + 999n < head.number ? from + 999n : head.number;
    const logs = await client.getLogs({
      address: cohort.address,
      fromBlock: from,
      toBlock: to,
    });
    for (const log of logs) eventKeys.add(eventKey(abi, log.data, log.topics));
  }
  return { watermark: `${head.timestamp}.999999999`, eventKeys };
}

export class Indexer {
  private readonly abi = artifact('SignalLedger').abi;
  private isRunning = false;
  constructor(
    private readonly config: Config,
    private readonly store: Store,
    private readonly snapshot = (cohort: LedgerCohort) => canonicalSnapshot(config, this.abi, cohort),
  ) {}

  async sync(): Promise<void> {
    if (this.isRunning || this.config.ledgerCohorts.length === 0) return;
    this.isRunning = true;
    try {
      const statuses: { watermark: string; indexedThrough: number }[] = [];
      for (const cohort of this.config.ledgerCohorts) {
        try {
          statuses.push(await this.syncCohort(cohort));
        } catch (error) {
          const key = `status/${cohort.address}`;
          const previous = this.store.get<Record<string, unknown>>('indexer', key) ?? { ledger_address: cohort.address, indexed_through: 0 };
          this.store.put('indexer', key, {
            ...previous,
            error: error instanceof Error ? error.message.split(':')[0] : 'indexer_error',
          });
          throw error;
        }
      }
      const minimum = statuses.reduce((current, candidate) => (consensusNanos(candidate.watermark) < consensusNanos(current.watermark) ? candidate : current));
      const syncedAt = Math.floor(Date.now() / 1000);
      this.store.put('indexer', 'cursor', minimum.watermark);
      this.store.put('indexer', 'status', {
        indexed_through: minimum.indexedThrough,
        synced_at: syncedAt,
        error: null,
      });
    } catch (error) {
      const previous = this.store.get<Record<string, unknown>>('indexer', 'status') ?? { indexed_through: 0 };
      this.store.put('indexer', 'status', {
        ...previous,
        error: error instanceof Error ? error.message.split(':')[0] : 'indexer_error',
      });
      throw error;
    } finally {
      this.isRunning = false;
    }
  }

  private async syncCohort(cohort: LedgerCohort) {
    const canonical = await this.snapshot(cohort);
    consensusNanos(canonical.watermark);
    const replayFrom = '0.000000000';
    const url = new URL(`${this.config.mirrorUrl}/contracts/${cohort.address}/results/logs`);
    url.searchParams.append('timestamp', `gte:${replayFrom}`);
    url.searchParams.append('timestamp', `lte:${canonical.watermark}`);
    url.searchParams.set('order', 'asc');
    url.searchParams.set('limit', '100');
    const mirror = await this.readPages(url, replayFrom, canonical.watermark);
    if ([...canonical.eventKeys].some((key) => !mirror.eventKeys.has(key)) || [...mirror.eventKeys].some((key) => !canonical.eventKeys.has(key))) {
      throw new Error('mirror_contract_logs_not_canonical');
    }
    for (const raw of mirror.logs) this.ingest(raw, cohort.address);
    await this.verifyPayments(Math.floor(Number(canonical.watermark)), cohort.address);
    const status = {
      ledger_address: cohort.address,
      indexed_through: Math.floor(Number(canonical.watermark)),
      synced_at: Math.floor(Date.now() / 1000),
      error: null,
    };
    this.store.put('indexer', `cursor/${cohort.address}`, canonical.watermark);
    this.store.put('indexer', `status/${cohort.address}`, status);
    return {
      watermark: canonical.watermark,
      indexedThrough: status.indexed_through,
    };
  }

  private async readPages(start: URL, cursor: string, watermark: string) {
    const lower = consensusNanos(cursor);
    const upper = consensusNanos(watermark);
    const eventKeys = new Set<string>();
    const canonicalLogs: Record<string, unknown>[] = [];
    let next: URL | null = start;
    for (let page = 0; next && page < 1000; page++) {
      const response = record(await fetchJson(next));
      if (!Array.isArray(response.logs)) throw new Error('invalid_mirror_logs');
      const logs = response.logs.map(record);
      for (const raw of logs) {
        const timestamp = consensusNanos(raw.timestamp);
        if (timestamp < lower || timestamp > upper) throw new Error('future_log_outside_watermark');
      }
      for (const raw of logs) {
        if (typeof raw.data !== 'string' || !Array.isArray(raw.topics)) throw new Error('invalid_log');
        eventKeys.add(eventKey(this.abi, raw.data as Hex, raw.topics as Hex[]));
        canonicalLogs.push(raw);
      }
      const link = record(response.links).next;
      next = typeof link === 'string' ? new URL(link, this.config.mirrorUrl) : null;
      if (next && (next.origin !== start.origin || !next.pathname.startsWith('/api/v1/contracts/'))) throw new Error('unsafe_mirror_pagination');
    }
    if (next) throw new Error('indexer_page_limit');
    return { eventKeys, logs: canonicalLogs };
  }

  private ingest(raw: Record<string, unknown>, ledgerAddress: Address): string {
    if (typeof raw.data !== 'string' || !Array.isArray(raw.topics) || typeof raw.transaction_hash !== 'string') throw new Error('invalid_log');
    const decoded = decodeEventLog({
      abi: this.abi,
      data: raw.data as Hex,
      topics: raw.topics as [Hex, ...Hex[]],
    });
    if (!decoded.eventName) throw new Error('unknown_contract_event');
    const event: Event = {
      eventName: decoded.eventName,
      args: serializable(decoded.args),
      transaction_hash: raw.transaction_hash,
      index: Number(raw.index),
      timestamp: String(raw.timestamp),
    };
    const key = `${event.eventName}/${String(event.args.requestId)}`;
    const eventId = `${ledgerAddress}/${event.transaction_hash}/${event.index}`;
    if (this.store.get('events', eventId)) return key;
    this.applyEvent(event, ledgerAddress);
    this.store.put('events', eventId, {
      ...event,
      ledger_address: ledgerAddress,
    });
    return key;
  }

  private applyEvent(e: Event, ledgerAddress: Address) {
    const a = e.args;
    const id = String(a.requestId);
    if (e.eventName === 'SignalCommitted') {
      const buyer = AccountId.fromSolidityAddress(String(a.payer)).toString();
      const payTo = AccountId.fromSolidityAddress(String(a.payee)).toString();
      const quote: Quote = {
        created_at: Number(a.committedAt),
        expires_at: Number(a.targetTime),
        ledger_address: ledgerAddress,
        request: {
          request_id: id,
          buyer,
          agent_id: String(a.agentId),
          schema: SCHEMA,
          price_feed_id: String(a.priceFeedId) as Hex,
          target_time: Number(a.targetTime),
        },
        requirements: {
          scheme: 'exact',
          network: 'hedera:testnet',
          asset: '0.0.0',
          amount: String(a.amount),
          payTo,
          maxTimeoutSeconds: 120,
          extra: {
            feePayer: normalizeTransactionId(String(a.nativePaymentId)).split('@')[0],
          },
        },
      };
      const fresh: SampleEvidence = {
        request_id: id,
        ledger_address: ledgerAddress,
        agent_id: String(a.agentId),
        schema: SCHEMA,
        price_feed_id: String(a.priceFeedId),
        payment_mode: 'x402',
        payment_status: 'pending',
        payment_verified_at: null,
        payer: buyer,
        committed_at: Number(a.committedAt),
        target_time: Number(a.targetTime),
        revealed_at: null,
        grade: null,
        oracle_status: 'pending',
        oracle_status_at: null,
        payment_ref: String(a.paymentRef),
        quote,
        commitment_hash: String(a.signalHash),
        transaction_hash: e.transaction_hash,
        native_payment_id: String(a.nativePaymentId),
      };
      const existing = this.store.get<SampleEvidence>('samples', id);
      const existingLedger = existing?.ledger_address ?? this.config.legacyLedgerAddress;
      if (existing && (!existingLedger || existingLedger.toLowerCase() !== ledgerAddress.toLowerCase())) throw new Error('cross_ledger_request_collision');
      const paymentOwner = this.store.get<{
        request_id: string;
        ledger_address: Address;
      }>('indexed_payment_refs', fresh.native_payment_id);
      if (paymentOwner && (paymentOwner.request_id !== id || paymentOwner.ledger_address.toLowerCase() !== ledgerAddress.toLowerCase()))
        throw new Error('cross_ledger_payment_reuse');
      const sample: SampleEvidence = existing
        ? {
            ...fresh,
            ...(existing.payment_status === undefined ? {} : { payment_status: existing.payment_status }),
            ...(existing.payment_verified_at === undefined ? {} : { payment_verified_at: existing.payment_verified_at }),
            ...(existing.revealed_at === undefined ? {} : { revealed_at: existing.revealed_at }),
            ...(existing.grade === undefined ? {} : { grade: existing.grade }),
            ...(existing.oracle_status === undefined ? {} : { oracle_status: existing.oracle_status }),
            ...(existing.oracle_status_at === undefined ? {} : { oracle_status_at: existing.oracle_status_at }),
            ...(existing.reveal === undefined ? {} : { reveal: existing.reveal }),
            ...(existing.grade_evidence === undefined ? {} : { grade_evidence: existing.grade_evidence }),
          }
        : fresh;
      this.store.put('samples', id, sample);
      this.store.put('indexed_payment_refs', fresh.native_payment_id, {
        request_id: id,
        ledger_address: ledgerAddress,
      });
      this.store.put('commit_events', id, {
        transaction_hash: e.transaction_hash,
      });
      return;
    }
    const prior = this.store.get<SampleEvidence>('samples', id);
    if (!prior) throw new Error('missing_commitment_event');
    if (e.eventName === 'SignalRevealed')
      this.store.put('samples', id, {
        ...prior,
        revealed_at: Number(a.revealedAt),
        reveal: a,
      });
    if (e.eventName === 'SignalGraded')
      this.store.put('samples', id, {
        ...prior,
        grade: {
          graded_at: Number(a.finalizedAt),
          actual_return_bps: Number(a.actualReturnBps),
          absolute_error_bps: Number(a.absoluteErrorBps),
          direction_correct: a.directionCorrect === true,
        },
        oracle_status: 'pending',
        oracle_status_at: Number(a.finalizedAt),
        grade_evidence: a,
      });
    if (e.eventName === 'SignalOracleExcluded')
      this.store.put('samples', id, {
        ...prior,
        oracle_status: 'excluded',
        oracle_status_at: Number(a.finalizedAt),
        grade_evidence: a,
      });
  }

  private async verifyPayments(watermark: number, ledgerAddress: Address) {
    const activeFeePayer = await facilitator(this.config).feePayer();
    this.store.put('verified_facilitators', activeFeePayer, {
      account: activeFeePayer,
    });
    for (const sample of this.store
      .list<SampleEvidence>('samples')
      .filter((s) => s.payment_status === 'pending' && s.ledger_address.toLowerCase() === ledgerAddress.toLowerCase())) {
      if (sample.payment_ref !== paymentReference(sample.native_payment_id)) {
        this.store.put('samples', sample.request_id, {
          ...sample,
          payment_status: 'invalid',
        });
        continue;
      }
      if (!this.store.get('verified_facilitators', String(sample.quote.requirements.extra.feePayer))) continue;
      const result = await getPaymentEvidence(this.config, sample.native_payment_id, sample.quote);
      if (result.status === 'verified' && (result.consensus_time! > watermark || result.consensus_time! > sample.committed_at)) continue;
      if (result.status !== 'pending')
        this.store.put('samples', sample.request_id, {
          ...sample,
          payment_status: result.status,
          payment_verified_at: result.status === 'verified' ? result.consensus_time! : null,
        });
    }
  }
}
export type { SampleEvidence };
