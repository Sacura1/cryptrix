import { randomBytes, randomUUID } from 'node:crypto';
import { getAddress, verifyMessage, type Hex } from 'viem';
import { digest, requireThat } from './domain.js';
import type { ChainGateway } from './chain.js';
import type { Store } from './store.js';

export const newToken = () => randomBytes(32).toString('base64url');
export class Auth {
  constructor(private store: Store, private origin: string, private now: () => number, private chain?: ChainGateway) {}
  challenge(address: string, scope: 'signin' | 'link-wallet' = 'signin', owner = '') {
    const wallet = getAddress(address).toLowerCase();
    const id = randomUUID();
    const expiresAt = this.now() + 5 * 60_000;
    const message = `Cryptrix ${scope === 'signin' ? 'sign in' : 'link agent wallet'}\nOrigin: ${this.origin}\nWallet: ${wallet}\nOwner: ${owner || wallet}\nChain: ${this.chain?.chainId ?? 'practice'}\nNonce: ${id}\nExpires: ${new Date(expiresAt).toISOString()}\nThis signature grants no spending permission.`;
    this.store.db.prepare('DELETE FROM challenges WHERE expires_at < ?').run(this.now() - 60_000);
    this.store.db.prepare('INSERT INTO challenges VALUES(?,?,?,?,0,?,?)').run(id, wallet, message, expiresAt, scope, owner || wallet);
    return { challengeId: id, message, expiresAt };
  }
  async consume(id: string, signature: Hex, scope: string, owner?: string): Promise<string> {
    const row = this.store.db.prepare('SELECT * FROM challenges WHERE id=?').get(id) as { wallet: string; message: string; expires_at: number; used: number; scope: string; owner: string } | undefined;
    requireThat(row && !row.used && row.expires_at > this.now() && row.scope === scope && (!owner || row.owner === owner), 'INVALID_CHALLENGE', 'Challenge expired, already used or for a different purpose.', 401);
    let valid = false;
    try { valid = this.chain ? await this.chain.verifySignature(row.wallet, row.message, signature) : await verifyMessage({ address: getAddress(row.wallet), message: row.message, signature }); } catch { /* Invalid signature or unsupported wallet. */ }
    requireThat(valid, 'INVALID_SIGNATURE', 'Wallet signature verification failed.', 401);
    this.store.transaction(() => {
      const result = this.store.db.prepare('UPDATE challenges SET used=1 WHERE id=? AND used=0 AND expires_at>?').run(id, this.now());
      requireThat(Number(result.changes) === 1, 'INVALID_CHALLENGE', 'Challenge expired or already used.', 401);
    });
    return row.wallet;
  }
  async signIn(id: string, signature: Hex) {
    const owner = await this.consume(id, signature, 'signin');
    const token = newToken();
    const expiresAt = this.now() + 8 * 3600_000;
    this.store.db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(this.now());
    this.store.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(token), owner, expiresAt);
    return { token, owner, expiresAt };
  }
  owner(token: string): string {
    const row = this.store.db.prepare('SELECT owner FROM sessions WHERE hash=? AND expires_at>?').get(digest(token), this.now()) as { owner: string } | undefined;
    requireThat(row, 'UNAUTHORISED', 'Sign in with an owner wallet.', 401);
    return row.owner;
  }
  agent(token: string) {
    const hash = digest(token);
    const agent = this.store.agents().find(a => a.tokenHash === hash);
    requireThat(agent, 'UNAUTHORISED', 'Agent runtime token is invalid.', 401);
    return agent;
  }
  logout(token: string) { this.store.db.prepare('DELETE FROM sessions WHERE hash=?').run(digest(token)); }
}
