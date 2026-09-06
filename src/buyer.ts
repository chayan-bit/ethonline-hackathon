import { parseArgs } from 'node:util';
import { createClientHederaSigner, PrivateKey } from '@x402/hedera';
import { ExactHederaScheme } from '@x402/hedera/exact/client';
import { loadConfig } from './adapters/config.ts';
import { facilitator, inspectPayment, paymentReference } from './adapters/payment.ts';
import { accountAddress } from './adapters/hedera.ts';
import { fetchJson, record } from './adapters/http.ts';
import { Ledger } from './adapters/ledger.ts';
import { Store } from './service/store.ts';
import { bodyHash, type AuthScope } from './service/auth.ts';
import { DEFAULT_POLICY, parseProviders, selectProvider } from './protocol/discovery.ts';
import { ETH_USD, SCHEMA, hashSignal, randomId } from './protocol/signal.ts';
import type { BuyRequest, Purchase, Quote } from './service/gateway.ts';
import type { PaymentPayload } from '@x402/core/types';
import { confirmCommitment, validateAndReconcilePurchase, validateQuote } from './protocol/verification.ts';

const { values } = parseArgs({ options: { 'allow-unproven': { type: 'boolean' }, resume: { type: 'string' }, kill: { type: 'boolean' }, enable: { type: 'boolean' }, status: { type: 'boolean' }, 'min-reveal': { type: 'string' } } });
const config = loadConfig();
const store = new Store('data/buyer.db');
const caps = {
  request: BigInt(process.env.BUYER_REQUEST_CAP ?? '1000000'),
  provider: BigInt(process.env.BUYER_PROVIDER_DAILY_CAP ?? '10000000'), global: BigInt(process.env.BUYER_GLOBAL_DAILY_CAP ?? '20000000'),
};
if (Object.values(caps).some(n => n <= 0n || n > 1_000_000_000n)) throw new Error('Invalid buyer cap');

async function proof(scope: AuthScope, key: PrivateKey) {
  const c = record(await fetchJson(`${config.baseUrl}/v1/auth/challenges`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scope) }));
  if (typeof c.message !== 'string' || typeof c.id !== 'string') throw new Error('invalid_auth_challenge');
  const expected = JSON.stringify({ purpose: 'Signal Market request authorization', domain: config.baseUrl, network: 'hedera:testnet', ...scope, nonce: c.id, expires_at: c.expires_at });
  const now = Math.floor(Date.now() / 1000);
  if (expected !== c.message || !/^0x[0-9a-f]{64}$/.test(c.id) || !Number.isSafeInteger(c.expires_at) || Number(c.expires_at) <= now || Number(c.expires_at) > now + 120) throw new Error('unsafe_auth_challenge');
  return Buffer.from(JSON.stringify({ challenge_id: c.id, signature: Buffer.from(key.sign(Buffer.from(c.message))).toString('hex') })).toString('base64');
}

async function recover(id: string, key: PrivateKey) {
  const path = `/v1/purchases/${id}`;
  const auth = await proof({ buyer: config.buyerId!, request_id: id, method: 'GET', path, body_hash: bodyHash('') }, key);
  return { expectedId: id, result: await fetchJson(`${config.baseUrl}${path}`, { headers: { 'X-Wallet-Proof': auth } }) };
}

async function verifyResult(input: unknown, expectedId: string) {
  const saved = store.get<{ quote: Quote; request: BuyRequest; payment: PaymentPayload }>('requests', expectedId);
  if (!saved) throw new Error('invalid_purchase_response');
  const paymentRef = inspectPayment(saved.payment, saved.quote.requirements, config.buyerId!);
  const result = validateAndReconcilePurchase(input, expectedId, saved, paymentRef, store);
  if (result.status !== 'delivered') return result;
  const prepared = result.prepared;
  if (!prepared || hashSignal(prepared.signal, prepared.salt) !== prepared.hash) throw new Error('invalid_signal_response');
  const s = prepared.signal;
  if (s.request_id !== saved.request.request_id || s.agent_id !== saved.request.agent_id || s.price_feed_id !== saved.request.price_feed_id || s.target_time !== saved.request.target_time) throw new Error('invalid_signal_response');
  store.put('responses_unverified', expectedId, result);
  const ledger = new Ledger(config, store);
  const commitment = await confirmCommitment(expectedId, prepared.hash, id => ledger.commitment(id));
  if (commitment.agent_id !== s.agent_id || commitment.price_feed_id !== s.price_feed_id || commitment.target_time !== s.target_time
    || commitment.payment_ref !== paymentReference(result.payment_ref) || commitment.amount !== result.quote.requirements.amount
    || commitment.payer.toLowerCase() !== accountAddress(config.buyerId!).toLowerCase() || commitment.payee.toLowerCase() !== accountAddress(result.quote.requirements.payTo).toLowerCase()) throw new Error('commitment_verification_failed');
  store.put('responses', expectedId, result);
  store.settleReservation(expectedId);
  return result;
}

async function purchase(key: PrivateKey) {
  if (store.get<boolean>('buyer', 'kill')) throw new Error('buyer_kill_switch_enabled');
  const policy = { ...DEFAULT_POLICY, allow_unproven: values['allow-unproven'] === true,
    min_reveal_pct: Number(values['min-reveal'] ?? DEFAULT_POLICY.min_reveal_pct), max_price: caps.request.toString(), feed: ETH_USD };
  const url = new URL(`${config.baseUrl}/v1/agents`);
  url.searchParams.set('allow_unproven', String(policy.allow_unproven)); url.searchParams.set('min_reveal_pct', String(policy.min_reveal_pct));
  const discovery = record(await fetchJson(url));
  const selection = selectProvider(parseProviders(discovery.agents), policy);
  console.info(JSON.stringify({ event: 'selection', selected: selection.selected?.agent_id, exploration: policy.allow_unproven,
    decisions: selection.decisions.map(d => ({ agent_id: d.provider.agent_id, reveal_pct: d.provider.metrics.reveal_pct, eligible_samples: d.provider.metrics.eligible_paid_count, reasons: d.reasons })) }));
  if (!selection.selected) throw new Error('no_eligible_provider');
  const request: BuyRequest = { request_id: randomId(), buyer: config.buyerId!, agent_id: selection.selected.agent_id, schema: SCHEMA, price_feed_id: ETH_USD, target_time: Math.floor(Date.now() / 1000) + 360 };
  const raw = JSON.stringify(request);
  const response = await fetch(`${config.baseUrl}/v1/signals`, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: raw, signal: AbortSignal.timeout(20000) });
  if (response.status !== 402) throw new Error('expected_x402_quote');
  const quoteResponse = record(await response.json()).quote;
  const feePayer = await facilitator(config).feePayer();
  const quote = validateQuote(quoteResponse, request, selection.selected, feePayer, Math.floor(Date.now() / 1000));
  store.reserve(request.request_id, request.agent_id, new Date().toISOString().slice(0, 10), BigInt(quote.requirements.amount), caps.provider, caps.global);
  let payment: PaymentPayload;
  let authorization: string;
  try {
    const created = await new ExactHederaScheme(createClientHederaSigner(config.buyerId!, key, { network: 'hedera:testnet' })).createPaymentPayload(2, quote.requirements);
    payment = { ...created, accepted: quote.requirements };
    inspectPayment(payment, quote.requirements, config.buyerId!);
    store.put('requests', request.request_id, { request, quote, payment });
    authorization = await proof({ buyer: request.buyer, request_id: request.request_id, method: 'POST', path: '/v1/signals', body_hash: bodyHash(raw) }, key);
    if (store.get<boolean>('buyer', 'kill')) throw new Error('buyer_kill_switch_enabled');
  } catch (error) {
    store.releaseReservation(request.request_id);
    throw error;
  }
  const paid = await fetch(`${config.baseUrl}/v1/signals`, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', 'PAYMENT-SIGNATURE': Buffer.from(JSON.stringify(payment)).toString('base64'), 'X-Wallet-Proof': authorization }, body: raw, signal: AbortSignal.timeout(60000) });
  if (!paid.ok) throw new Error(`paid_http_${paid.status}; resume saved request ${request.request_id}`);
  return { expectedId: request.request_id, result: await paid.json() };
}

async function main() {
  if (values.kill || values.enable) store.put('buyer', 'kill', Boolean(values.kill));
  if (values.kill || values.enable || values.status) {
    console.info(JSON.stringify({ kill_switch: store.get('buyer', 'kill') ?? false, reservations: store.reservations() })); return;
  }
  if (!config.buyerId || !config.buyerKey) throw new Error('Buyer credentials required');
  const key = PrivateKey.fromStringECDSA(config.buyerKey);
  const operation = values.resume ? await recover(values.resume, key) : await purchase(key);
  const result = await verifyResult(operation.result, operation.expectedId);
  console.info(JSON.stringify({ request_id: result.quote.request.request_id, status: result.status, payment_ref: result.payment_ref,
    commitment_transaction_id: result.commitment?.transaction_id, verified: result.status === 'delivered', private_response: 'stored in local buyer database' }));
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'buyer_failed'); process.exitCode = 1; }).finally(() => store.close());
