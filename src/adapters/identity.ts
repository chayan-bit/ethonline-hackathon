import { PublicKey } from '@hiero-ledger/sdk';
import { fetchJson, record } from './http.ts';
import type { Config } from './config.ts';

export async function accountKey(config: Config, buyer: string): Promise<PublicKey> {
  if (!/^0\.0\.[1-9][0-9]{0,18}$/.test(buyer)) throw new Error('invalid_account');
  const account = record(await fetchJson(`${config.mirrorUrl}/accounts/${buyer}`));
  const key = record(account.key);
  if (typeof key.key !== 'string' || !/^[a-f0-9]{64,176}$/i.test(key.key)) throw new Error('unsupported_account_key');
  if (key._type === 'ECDSA_SECP256K1') return PublicKey.fromStringECDSA(key.key);
  if (key._type === 'ED25519') return PublicKey.fromStringED25519(key.key);
  throw new Error('unsupported_account_key: P0 request authentication supports single-key accounts');
}
