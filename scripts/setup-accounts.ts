import { AccountCreateTransaction, AccountId, Client, Hbar, PrivateKey, TransactionId, TransactionReceiptQuery } from '@hiero-ledger/sdk';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

type AccountRecord = { key: string; transaction: string; account?: string };
const STATE_PATH = 'data/account-setup.json';
const ENV_PATH = '.env';

function saveState(state: Record<string, AccountRecord>): void {
  writeFileSync(`${STATE_PATH}.tmp`, JSON.stringify(state), { mode: 0o600 });
  renameSync(`${STATE_PATH}.tmp`, STATE_PATH);
}

function saveEnv(values: Record<string, string>): void {
  const old = readFileSync(ENV_PATH, 'utf8').split('\n').filter(line => !Object.keys(values).some(k => line.startsWith(`${k}=`)));
  const content = [...old.filter(Boolean), ...Object.entries(values).map(([k, v]) => `${k}=${v}`), ''].join('\n');
  writeFileSync(`${ENV_PATH}.next`, content, { mode: 0o600 });
  renameSync(`${ENV_PATH}.next`, ENV_PATH);
  chmodSync(ENV_PATH, 0o600);
}

async function main() {
  const operator = process.env.HEDERA_OPERATOR_ID;
  const key = process.env.HEDERA_OPERATOR_KEY;
  if (!operator || !key || process.env.HEDERA_NETWORK !== 'hedera:testnet') throw new Error('Testnet operator configuration required');
  mkdirSync('data', { recursive: true, mode: 0o700 });
  const state: Record<string, AccountRecord> = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : {};
  const client = Client.forTestnet().setOperator(operator, PrivateKey.fromStringECDSA(key));
  client.setMaxAttempts(3);
  client.setRequestTimeout(30000);
  try {
    for (const [role, balance] of [['OPERATOR', 50], ['BUYER', 5]] as const) {
      const prior = state[role];
      if (prior?.account) continue;
      if (prior) {
        const receipt = await new TransactionReceiptQuery().setTransactionId(TransactionId.fromString(prior.transaction)).execute(client);
        if (!receipt.accountId) throw new Error('Pending account creation requires reconciliation');
        state[role] = { ...prior, account: receipt.accountId.toString() };
        saveState(state);
        continue;
      }
      const privateKey = PrivateKey.generateECDSA();
      const txId = TransactionId.generate(AccountId.fromString(operator));
      const tx = new AccountCreateTransaction().setKeyWithoutAlias(privateKey.publicKey).setInitialBalance(new Hbar(balance))
        .setTransactionId(txId).setMaxTransactionFee(new Hbar(2));
      // Persist the generated key and transaction ID before funding so interruptions never lose ownership.
      state[role] = { key: privateKey.toStringRaw(), transaction: txId.toString() };
      saveState(state);
      const receipt = await (await tx.execute(client)).getReceipt(client);
      if (!receipt.accountId) throw new Error('Missing created account ID');
      state[role] = { ...state[role], account: receipt.accountId.toString() };
      saveState(state);
    }
    saveEnv(Object.fromEntries(Object.entries(state).flatMap(([role, value]) => [
      [`HEDERA_${role}_ID`, value.account!], [`HEDERA_${role}_KEY`, value.key],
    ])));
    console.info(JSON.stringify({ network: 'hedera:testnet', operator: state.OPERATOR.account, operator_initial_hbar: 50, buyer: state.BUYER.account, buyer_initial_hbar: 5, private_keys: 'saved locally, never printed' }));
  } finally { client.close(); }
}

main().catch(error => { console.error(`Account setup stopped (${error instanceof Error ? error.name : 'unknown error'}); saved transaction IDs and keys remain in private data/account-setup.json for recovery.`); process.exitCode = 1; });
