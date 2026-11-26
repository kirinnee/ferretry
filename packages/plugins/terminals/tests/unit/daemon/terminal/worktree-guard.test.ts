import { describe, expect, test } from 'bun:test';
import { WorktreeGuard } from '../../../../daemon/lib/terminal/worktree-guard.ts';

const gate = () => Promise.withResolvers<void>();

describe('worktree launch exclusion', () => {
  test('drains an admitted launch, refuses new descendants, and releases after a removal refusal', async () => {
    const guard = new WorktreeGuard(async path => path);
    const started = gate();
    const finish = gate();
    const events: string[] = [];
    const launch = guard.launch(
      '/checkout/src',
      () => false,
      async () => {
        started.resolve();
        await finish.promise;
        events.push('launched');
        return true;
      },
    );
    await started.promise;
    const removing = guard.withRemoval('/checkout', async () => {
      events.push('sample');
      throw new Error('occupied');
    });
    expect(
      await guard.launch(
        '/checkout/src',
        () => false,
        async () => true,
      ),
    ).toBe(false);
    expect(events).toEqual([]);
    finish.resolve();
    expect(await launch).toBe(true);
    await expect(removing).rejects.toThrow('occupied');
    expect(events).toEqual(['launched', 'sample']);
    expect(
      await guard.launch(
        '/checkout/src',
        () => false,
        async () => true,
      ),
    ).toBe(true);
  });

  test('uses canonical paths, keeps siblings available, and refuses a second removal', async () => {
    const guard = new WorktreeGuard(async path => path.replace('/alias', '/checkout'));
    await guard.withRemoval('/alias', async () => {
      expect(
        await guard.launch(
          '/checkout',
          () => false,
          async () => true,
        ),
      ).toBe(false);
      expect(
        await guard.launch(
          '/alias/src',
          () => false,
          async () => true,
        ),
      ).toBe(false);
      expect(
        await guard.launch(
          '/checkout-sibling',
          () => false,
          async () => true,
        ),
      ).toBe(true);
      await expect(guard.withRemoval('/checkout', async () => true)).rejects.toThrow('already being removed');
    });
    expect(
      await guard.launch(
        '/alias',
        () => false,
        async () => true,
      ),
    ).toBe(true);
  });

  test('releases a failed launch and propagates unreadable identity instead of admitting it', async () => {
    const guard = new WorktreeGuard(async path => path);
    await expect(
      guard.launch(
        '/checkout',
        () => false,
        async () => {
          throw new Error('launch failed');
        },
      ),
    ).rejects.toThrow('launch failed');
    expect(await guard.withRemoval('/checkout', async () => true)).toBe(true);
    const broken = new WorktreeGuard(async () => {
      throw new Error('unreadable');
    });
    await expect(
      broken.launch(
        '/checkout',
        () => false,
        async () => true,
      ),
    ).rejects.toThrow('unreadable');
  });
});
