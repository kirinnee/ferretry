import { describe, it } from 'bun:test';
import should from 'should';
import { SessionLock } from '../../../src/lib/input-requests/session-lock.ts';

describe('SessionLock', () => {
  it('should run one key’s work strictly in turn, even when an earlier one throws', async () => {
    const lock = new SessionLock();
    const order: string[] = [];
    let release: () => void = () => undefined;
    const first = lock.run('s1', async () => {
      order.push('first:start');
      await new Promise<void>(resolve => (release = resolve));
      order.push('first:end');
      throw new Error('boom');
    });
    const second = lock.run('s1', async () => void order.push('second'));
    const other = lock.run('s2', async () => void order.push('other'));
    await other;

    should(order).eql(['first:start', 'other']);
    release();
    await first.catch(() => undefined);
    await second;
    should(order).eql(['first:start', 'other', 'first:end', 'second']);
    should(await lock.run('s1', async () => 7)).equal(7);
  });

  it('should hand the work’s own failure to its caller', async () => {
    const lock = new SessionLock();
    const error = await lock.run('s1', async () => Promise.reject(new Error('nope'))).catch((e: unknown) => e);

    should((error as Error).message).equal('nope');
  });
});
