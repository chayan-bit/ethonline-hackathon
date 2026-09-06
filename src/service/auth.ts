import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import type { PublicKey } from '@hiero-ledger/sdk';
import { randomId } from '../protocol/signal.ts';
import type { Store } from './store.ts';

export type AuthScope = { buyer: string; request_id: string; method: string; path: string; body_hash: string };
export type AuthProof = { challenge_id: string; signature: string };
export const bodyHash = (body: string) => createHash('sha256').update(body).digest('hex');

export class Auth {
  constructor(private readonly store: Store, private readonly domain: string,
    private readonly accountKey: (buyer: string) => Promise<PublicKey>, private readonly now = () => Math.floor(Date.now() / 1000)) {}

  issue(scope: AuthScope) {
    if (!scope || typeof scope !== 'object' || !/^[0-9a-f]{64}$/.test(scope.body_hash) || typeof scope.path !== 'string'
      || !/^0\.0\.[1-9][0-9]{0,18}$/.test(scope.buyer) || !/^0x[0-9a-f]{64}$/.test(scope.request_id)
      || !['GET', 'POST'].includes(scope.method) || scope.path.length > 256 || !scope.path.startsWith('/v1/')) throw new Error('invalid_auth_scope');
    const id = randomId();
    const expires_at = this.now() + 120;
    const message = JSON.stringify({ purpose: 'Signal Market request authorization', domain: this.domain, network: 'hedera:testnet', ...scope, nonce: id, expires_at });
    this.store.challenge(id, message, scope.buyer, expires_at);
    return { id, message, expires_at };
  }

  async verify(proof: AuthProof, scope: AuthScope): Promise<void> {
    if (!proof || !/^0x[0-9a-f]{64}$/.test(proof.challenge_id) || !/^[0-9a-f]{128}$/i.test(proof.signature)) throw new Error('invalid_auth');
    const challenge = this.store.readChallenge(proof.challenge_id);
    if (!challenge || challenge.used || challenge.expires <= this.now() || challenge.buyer !== scope.buyer) throw new Error('invalid_auth');
    const { purpose: _, domain, network, nonce: __, expires_at: ___, ...boundScope } = JSON.parse(challenge.message);
    if (domain !== this.domain || network !== 'hedera:testnet' || !isDeepStrictEqual(boundScope, scope)) throw new Error('invalid_auth');
    const key = await this.accountKey(scope.buyer);
    if (!key.verify(Buffer.from(challenge.message), Buffer.from(proof.signature, 'hex'))) throw new Error('invalid_auth');
    if (!this.store.consumeChallenge(proof.challenge_id, this.now())) throw new Error('invalid_auth');
  }
}
