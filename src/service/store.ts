import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Purchase } from './gateway.ts';
import { isDeepStrictEqual } from 'node:util';

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS purchases (
        id TEXT PRIMARY KEY, buyer TEXT NOT NULL, settlement_ref TEXT UNIQUE, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS records (
        namespace TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(namespace,id)
      );
      CREATE TABLE IF NOT EXISTS challenges (
        id TEXT PRIMARY KEY, message TEXT NOT NULL, buyer TEXT NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS reservations (
        id TEXT PRIMARY KEY, agent TEXT NOT NULL, day TEXT NOT NULL, amount TEXT NOT NULL, state TEXT NOT NULL
      );
    `);
  }

  close(): void { this.db.close(); }

  purchase(id: string): Purchase | null {
    const row = this.db.prepare('SELECT data FROM purchases WHERE id=?').get(id);
    return row ? JSON.parse(String(row.data)) : null;
  }

  savePurchase(p: Purchase): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.purchase(p.quote.request.request_id);
      if (current && (!isDeepStrictEqual(current.quote, p.quote)
        || (current.prepared && !isDeepStrictEqual(current.prepared, p.prepared))
        || (current.payment_ref && current.payment_ref !== p.payment_ref)
        || (current.payment && !isDeepStrictEqual(current.payment, p.payment))
        || (current.status === 'delivered' && p.status !== 'delivered'))) throw new Error('immutable_purchase_conflict');
      this.db.prepare(`INSERT INTO purchases(id,buyer,settlement_ref,data) VALUES(?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET settlement_ref=excluded.settlement_ref,data=excluded.data`)
        .run(p.quote.request.request_id, p.quote.request.buyer, p.payment_ref ?? null, JSON.stringify(p));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  purchases(): Purchase[] {
    return this.db.prepare('SELECT data FROM purchases ORDER BY rowid DESC').all().map(r => JSON.parse(String(r.data)));
  }

  put(namespace: string, id: string, value: unknown): void {
    this.db.prepare('INSERT INTO records VALUES(?,?,?) ON CONFLICT(namespace,id) DO UPDATE SET data=excluded.data').run(namespace, id, JSON.stringify(value));
  }

  get<T>(namespace: string, id: string): T | null {
    const row = this.db.prepare('SELECT data FROM records WHERE namespace=? AND id=?').get(namespace, id);
    return row ? JSON.parse(String(row.data)) : null;
  }

  list<T>(namespace: string): T[] {
    return this.db.prepare('SELECT data FROM records WHERE namespace=? ORDER BY id').all(namespace).map(r => JSON.parse(String(r.data)));
  }

  challenge(id: string, message: string, buyer: string, expires: number): void {
    this.db.prepare('DELETE FROM challenges WHERE expires<?').run(expires - 120);
    this.db.prepare('INSERT INTO challenges(id,message,buyer,expires) VALUES(?,?,?,?)').run(id, message, buyer, expires);
  }

  readChallenge(id: string) {
    const row = this.db.prepare('SELECT message,buyer,expires,used FROM challenges WHERE id=?').get(id);
    return row ? { message: String(row.message), buyer: String(row.buyer), expires: Number(row.expires), used: Number(row.used) } : null;
  }

  consumeChallenge(id: string, now: number): boolean {
    return this.db.prepare('UPDATE challenges SET used=1 WHERE id=? AND used=0 AND expires>?').run(id, now).changes === 1;
  }

  reserve(id: string, agent: string, day: string, amount: bigint, providerCap: bigint, globalCap: bigint): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT agent,day,amount,state FROM reservations WHERE id=?').get(id);
      if (existing) {
        if (existing.agent !== agent || existing.day !== day || existing.amount !== amount.toString()) throw new Error('reservation_conflict');
        this.db.exec('COMMIT');
        return;
      }
      const rows = this.db.prepare("SELECT agent,amount FROM reservations WHERE day=? AND state != 'released'").all(day);
      const total = rows.reduce((n, r) => n + BigInt(String(r.amount)), 0n);
      const provider = rows.filter(r => r.agent === agent).reduce((n, r) => n + BigInt(String(r.amount)), 0n);
      if (amount <= 0n || total + amount > globalCap || provider + amount > providerCap) throw new Error('budget_exceeded');
      this.db.prepare("INSERT INTO reservations VALUES(?,?,?,?,'reserved')").run(id, agent, day, amount.toString());
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  settleReservation(id: string): void {
    this.db.prepare("UPDATE reservations SET state='settled' WHERE id=? AND state='reserved'").run(id);
  }

  releaseReservation(id: string): void {
    this.db.prepare("UPDATE reservations SET state='released' WHERE id=? AND state='reserved'").run(id);
  }

  reservations() { return this.db.prepare('SELECT * FROM reservations ORDER BY rowid DESC').all(); }

  quoteCapacity(now: number): boolean {
    this.db.prepare("DELETE FROM purchases WHERE json_extract(data,'$.status')='quoted' AND json_extract(data,'$.quote.expires_at')<?").run(now - 86400);
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM purchases WHERE json_extract(data,'$.status')='quoted'").get();
    return Number(row?.count ?? 0) < 1000;
  }
}
