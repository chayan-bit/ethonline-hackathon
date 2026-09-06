import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireProcessLock } from '../../src/service/process-lock.ts';

test('process lock rejects a live owner and safely replaces only a stale owner', () => {
  const dir = mkdtempSync(join(tmpdir(), 'signal-lock-'));
  const path = join(dir, 'market.db.lock');
  try {
    const release = acquireProcessLock(path);
    assert.throws(() => acquireProcessLock(path), /Another signal-market server/);
    release();

    writeFileSync(path, JSON.stringify({ project: 'signal-market', pid: 2_147_483_647, owner: 'stale' }), { mode: 0o600 });
    const releaseRecovered = acquireProcessLock(path);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).pid, process.pid);
    releaseRecovered();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
