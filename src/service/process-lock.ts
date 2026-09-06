import { openSync, closeSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function acquireProcessLock(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const owner = randomUUID();
  const acquire = () => {
    const fd = openSync(path, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify({ project: 'signal-market', pid: process.pid, owner })); } finally { closeSync(fd); }
  };
  try { acquire(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const previous = JSON.parse(readFileSync(path, 'utf8'));
    if (previous.project !== 'signal-market' || !Number.isSafeInteger(previous.pid) || previous.pid <= 1) throw new Error('Invalid server lock; inspect it manually');
    try { process.kill(previous.pid, 0); throw new Error('Another signal-market server owns this database'); }
    catch (check) {
      if ((check as NodeJS.ErrnoException).code !== 'ESRCH') throw check;
      unlinkSync(path); acquire();
    }
  }
  return () => {
    try { if (JSON.parse(readFileSync(path, 'utf8')).owner === owner) unlinkSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  };
}
