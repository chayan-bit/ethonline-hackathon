import { loadConfig } from './adapters/config.ts';
import { Store } from './service/store.ts';
import { Ledger } from './adapters/ledger.ts';
import { facilitator, inspectPayment, lookupPayment, normalizeTransactionId } from './adapters/payment.ts';
import { Transaction } from '@x402/hedera';
import { generateForecast } from './adapters/pyth.ts';
import { Gateway } from './service/gateway.ts';
import { Auth } from './service/auth.ts';
import { accountKey } from './adapters/identity.ts';
import { Indexer } from './service/indexer.ts';
import { Worker } from './service/worker.ts';
import { createApp } from './service/app.ts';
import { acquireProcessLock } from './service/process-lock.ts';

const config = loadConfig();
const releaseLock = acquireProcessLock(`${config.databasePath}.lock`);
process.once('exit', releaseLock);
const store = new Store(config.databasePath);
const ledger = new Ledger(config, store);
const payments = facilitator(config);
const gateway = new Gateway(store, {
  now: () => Math.floor(Date.now() / 1000), seller: () => ledger.seller(), feePayer: payments.feePayer,
  verify: async (payload, requirements) => {
    const result = await payments.verify(payload, requirements);
    if (result.isValid && result.payer) inspectPayment(payload, requirements, result.payer);
    return result;
  },
  paymentId: payload => {
    const tx = Transaction.fromBytes(Buffer.from(String(payload.payload.transaction), 'base64'));
    if (!tx.transactionId) throw new Error('invalid_transaction_id');
    return normalizeTransactionId(tx.transactionId.toString());
  },
  generate: request => generateForecast(config, request), settle: payments.settle,
  lookupPayment: (id, quote) => lookupPayment(config, id, quote), commit: (q, p, id) => ledger.commit(q, p, id),
});
const auth = new Auth(store, config.baseUrl, buyer => accountKey(config, buyer));
const indexer = new Indexer(config, store);
const worker = new Worker(config, store, ledger, gateway);
const app = createApp({ config, store, gateway, auth, seller: () => ledger.seller() });
app.listen(config.port, '127.0.0.1', () => console.info(JSON.stringify({ event: 'listening', port: config.port, network: config.network })));
const tick = async () => {
  try { await indexer.sync(); await worker.tick(); }
  catch (error) { console.error(JSON.stringify({ event: 'background_retry', error: error instanceof Error ? error.name : 'unknown' })); }
};
void tick();
const timer = setInterval(() => void tick(), 15000);
process.once('SIGINT', () => { clearInterval(timer); app.close(() => { store.close(); process.exit(0); }); });
process.once('SIGTERM', () => { clearInterval(timer); app.close(() => { store.close(); process.exit(0); }); });
