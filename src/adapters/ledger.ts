import { keccak256, stringToHex, zeroHash, type Address, type Hex } from 'viem';
import type { Config } from './config.ts';
import { accountAddress, artifact, executeContract, publicClient } from './hedera.ts';
import { normalizeTransactionId, paymentReference } from './payment.ts';
import { assertCommitTiming, SCHEMA_ID, type Signal } from '../protocol/signal.ts';
import type { Prepared, Quote } from '../service/gateway.ts';
import { providerMetadata } from '../service/metadata.ts';
import type { Store } from '../service/store.ts';

export function signalTuple(s: Signal) {
  return { schemaId: SCHEMA_ID, requestId: s.request_id, agentId: BigInt(s.agent_id), priceFeedId: s.price_feed_id,
    issuedAt: BigInt(s.issued_at), targetTime: BigInt(s.target_time), predictedReturnBps: s.predicted_return_bps,
    modelVersionHash: keccak256(stringToHex(s.model_version)), distributionCode: 1 };
}

export class Ledger {
  readonly abi = artifact('SignalLedger').abi;
  private readonly client;
  constructor(private readonly config: Config, private readonly store: Store) { this.client = publicClient(config); }
  get address(): Address { if (!this.config.ledgerAddress) throw new Error('ledger_not_deployed'); return this.config.ledgerAddress; }

  async seller() {
    if (!this.config.registryAddress || !this.config.operatorId) throw new Error('registry_not_configured');
    const values = await this.client.readContract({ address: this.config.registryAddress, abi: artifact('AgentRegistry').abi, functionName: 'getAgent', args: [BigInt(this.config.agentId)] }) as readonly unknown[];
    const expectedHash = keccak256(stringToHex(JSON.stringify(providerMetadata(this.config))));
    if (values[4] !== expectedHash || String(values[2]).toLowerCase() !== accountAddress(this.config.operatorId).toLowerCase()) throw new Error('registry_metadata_mismatch');
    return { agent_id: this.config.agentId, payTo: this.config.operatorId, price: this.config.price, active: values[3] === true };
  }

  async commitment(id: string) {
    const c = await this.client.readContract({ address: this.address, abi: this.abi, functionName: 'getCommitment', args: [id as Hex] }) as readonly unknown[];
    return { exists: c[0] === true, agent_id: String(c[1]), schema_id: c[2] as Hex, hash: c[3] as Hex, committed_at: Number(c[4]), issued_at: Number(c[5]),
      target_time: Number(c[6]), price_feed_id: c[7] as Hex, payment_ref: c[9] as Hex, payer: c[10] as Address, payee: c[11] as Address,
      amount: String(c[13]), revealed: c[15] === true };
  }

  async commit(quote: Quote, prepared: Prepared, reference: string) {
    const id = quote.request.request_id;
    const existing = await this.commitment(id);
    if (existing.exists) {
      if (existing.hash !== prepared.hash) throw new Error('commitment_conflict');
      const saved = this.store.get<{ transaction_id: string }>('commit_receipts', id);
      if (saved) return saved;
      // The indexer recovers the original transaction hash after a crash between consensus and saving its receipt.
      const indexed = this.store.get<{ transaction_hash: string }>('commit_events', id);
      if (!indexed) throw new Error('commit_receipt_pending');
      return { transaction_id: indexed.transaction_hash };
    }
    assertCommitTiming(prepared.signal, Math.floor(Date.now() / 1000));
    const s = prepared.signal;
    const nativeId = normalizeTransactionId(reference);
    const result = await executeContract(this.config, this.address, this.abi, 'commit', [
      s.request_id, BigInt(s.agent_id), prepared.hash, SCHEMA_ID, BigInt(s.issued_at), BigInt(s.target_time), s.price_feed_id,
      1, paymentReference(nativeId), accountAddress(quote.request.buyer), accountAddress(quote.requirements.payTo), zeroHash,
      BigInt(quote.requirements.amount), keccak256(stringToHex('hedera:testnet')), nativeId,
    ]);
    this.store.put('commit_receipts', id, result);
    return result;
  }

  async reveal(prepared: Prepared) {
    const current = await this.commitment(prepared.signal.request_id);
    if (current.revealed) return;
    return executeContract(this.config, this.address, this.abi, 'reveal', [prepared.signal.request_id, signalTuple(prepared.signal), prepared.salt]);
  }

  async grade(id: string, issue: Hex[], target: Hex[], feeTinybars: bigint) {
    return executeContract(this.config, this.address, this.abi, 'grade', [id, issue, target], feeTinybars);
  }
}
