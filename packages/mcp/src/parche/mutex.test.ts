import { describe, expect, it } from 'vitest';
import { withVaultLock } from './mutex.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('withVaultLock', () => {
  it("'wait' never lets two holders run at once, even with several waiters", async () => {
    const mutex = new Map<string, Promise<void>>();
    let running = 0;
    let maxRunning = 0;
    const gate = deferred();

    const task = (hold: Promise<void> | null) =>
      withVaultLock(mutex, 'srv|team', { onBusy: 'wait' }, async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        if (hold) await hold;
        await Promise.resolve();
        running -= 1;
      });

    // The first holder blocks until `gate` opens; three waiters queue behind it.
    const runs = [task(gate.promise), task(null), task(null), task(null)];
    await Promise.resolve();
    gate.resolve();
    await Promise.all(runs);

    expect(maxRunning).toBe(1);
    expect(mutex.has('srv|team')).toBe(false);
  });

  it("'skip' returns immediately while the lock is held", async () => {
    const mutex = new Map<string, Promise<void>>();
    const gate = deferred();
    const first = withVaultLock(mutex, 'k', { onBusy: 'skip' }, () => gate.promise);

    const second = await withVaultLock(mutex, 'k', { onBusy: 'skip' }, async () => 'ran');
    expect(second).toEqual({ skipped: true });

    gate.resolve();
    expect((await first).skipped).toBe(false);
  });
});
