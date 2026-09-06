import { HTTPFacilitatorClient } from '@x402/core/server';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { AccountId, Transaction, TransferTransaction } from '@x402/hedera';
import { keccak256, stringToHex } from 'viem';
import { fetchJson, record } from './http.ts';
import type { Config } from './config.ts';
import type { Quote } from '../service/gateway.ts';

export function normalizeTransactionId(value: string): string {
  const match = /^(0\.0\.[1-9][0-9]{0,18})[@-]([0-9]{1,12})[.-]([0-9]{1,9})$/.exec(value);
  if (!match) throw new Error('invalid_transaction_id');
  return `${match[1]}@${BigInt(match[2])}.${match[3].padStart(9, '0')}`;
}
export const paymentReference = (id: string) => keccak256(stringToHex(`hedera:testnet/${normalizeTransactionId(id)}`));
export const mirrorTransactionId = (id: string) => normalizeTransactionId(id).replace('@', '-').replace(/\.(\d{9})$/, '-$1');

export function inspectPayment(payload: PaymentPayload, requirements: PaymentRequirements, buyer: string): string {
  const encoded = payload.payload?.transaction;
  if (typeof encoded !== 'string' || encoded.length > 100_000 || !/^[A-Za-z0-9+/]+=*$/.test(encoded)) throw new Error('invalid_payment_payload');
  const tx = Transaction.fromBytes(Buffer.from(encoded, 'base64'));
  if (!(tx instanceof TransferTransaction) || !tx.transactionId) throw new Error('invalid_payment_transaction');
  const entries = [...tx.hbarTransfers].map(([account, hbar]) => ({ account: account.toString(), amount: BigInt(hbar.toTinybars().toString()) }));
  const amount = BigInt(requirements.amount);
  if (buyer === requirements.payTo || entries.length !== 2 || tx.tokenTransfers.size !== 0 || tx.nftTransfers.size !== 0
    || !entries.some(e => e.account === buyer && e.amount === -amount)
    || !entries.some(e => e.account === requirements.payTo && e.amount === amount)
    || tx.transactionId.accountId?.toString() !== requirements.extra.feePayer) throw new Error('unsafe_payment_transfers');
  return normalizeTransactionId(tx.transactionId.toString());
}

export function facilitator(config: Config) {
  const client = new HTTPFacilitatorClient({ url: config.facilitatorUrl, timeoutMs: 20000 });
  return {
    verify: (payload: PaymentPayload, requirements: PaymentRequirements) => client.verify(payload, requirements),
    settle: async (payload: PaymentPayload, requirements: PaymentRequirements) => {
      const result = await client.settle(payload, requirements);
      return { ...result, transaction: result.transaction ? normalizeTransactionId(result.transaction) : undefined };
    },
    feePayer: async () => {
      const supported = await client.getSupported();
      const kind = supported.kinds.find(k => k.network === 'hedera:testnet' && k.scheme === 'exact' && k.x402Version === 2);
      const feePayer = kind?.extra?.feePayer;
      if (typeof feePayer !== 'string') throw new Error('facilitator_unsupported');
      return AccountId.fromString(feePayer).toString();
    },
  };
}

type PaymentEvidence = { status: 'pending' | 'verified' | 'invalid'; consensus_time?: number };
const atomicInteger = (value: unknown): bigint => {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?(0|[1-9][0-9]{0,18})$/.test(value)) return BigInt(value);
  throw new Error('unsafe_transfer_amount');
};

export function verifyPaymentTransaction(tx: Record<string, unknown>, id: string, quote: Quote): PaymentEvidence {
  const invalid: PaymentEvidence = { status: 'invalid' };
  if (typeof tx.transaction_id !== 'string' || normalizeTransactionId(tx.transaction_id) !== normalizeTransactionId(id)
    || tx.result !== 'SUCCESS' || tx.name !== 'CRYPTOTRANSFER' || tx.nonce !== 0) return invalid;
  if (!Array.isArray(tx.transfers) || !Array.isArray(tx.token_transfers) || !Array.isArray(tx.nft_transfers)) throw new Error('invalid_transfer_evidence');
  if (tx.token_transfers.length || tx.nft_transfers.length) return invalid;
  const feePayer = normalizeTransactionId(id).split('@')[0];
  const buyer = quote.request.buyer;
  const payTo = quote.requirements.payTo;
  if (feePayer === buyer || feePayer === payTo || buyer === payTo || quote.requirements.extra.feePayer !== feePayer) return invalid;
  const transfers = tx.transfers.map(record);
  const net = (account: string) => transfers.filter(t => t.account === account).reduce((sum, t) => sum + atomicInteger(t.amount), 0n);
  const amount = BigInt(quote.requirements.amount);
  const fee = atomicInteger(tx.charged_tx_fee);
  const otherAccounts = [...new Set(transfers.map(t => String(t.account)))].filter(a => ![buyer, payTo, feePayer].includes(a));
  const remainder = otherAccounts.map(net);
  if (net(buyer) !== -amount || net(payTo) !== amount || net(feePayer) !== -fee || fee < 0n
    || remainder.some(n => n < 0n) || remainder.reduce((a, b) => a + b, 0n) !== fee
    || quote.requirements.asset !== '0.0.0' || quote.requirements.network !== 'hedera:testnet') return invalid;
  if (typeof tx.consensus_timestamp !== 'string' || !/^\d+\.\d{9}$/.test(tx.consensus_timestamp)) throw new Error('invalid_payment_time');
  return { status: 'verified', consensus_time: Math.floor(Number(tx.consensus_timestamp)) };
}

export async function getPaymentEvidence(config: Config, id: string, quote: Quote): Promise<PaymentEvidence> {
  let response: Record<string, unknown>;
  try { response = record(await fetchJson(`${config.mirrorUrl}/transactions/${mirrorTransactionId(id)}`)); }
  catch (error) { if (error instanceof Error && error.message === 'upstream_http_404') return { status: 'pending' }; throw error; }
  if (!Array.isArray(response.transactions)) throw new Error('invalid_payment_evidence');
  const successes = response.transactions.map(record).filter(t => t.result === 'SUCCESS' && t.name === 'CRYPTOTRANSFER' && t.nonce === 0);
  if (successes.length === 0) return { status: response.transactions.length ? 'invalid' : 'pending' };
  if (successes.length !== 1) throw new Error('ambiguous_payment_evidence');
  return verifyPaymentTransaction(successes[0], id, quote);
}

export const lookupPayment = async (config: Config, id: string, quote: Quote) => (await getPaymentEvidence(config, id, quote)).status;
