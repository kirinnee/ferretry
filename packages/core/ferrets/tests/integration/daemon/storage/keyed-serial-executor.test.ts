import { describe, expect, test } from 'bun:test';
import { KeyedSerialExecutor } from '../../../../daemon/adapters/storage/keyed-serial-executor.ts';

/** Exclusive work that lets keyed work queued ahead of its claim go first, without ever starving. */

const tick = async (): Promise<void> => await new Promise<void>(resolve => setTimeout(resolve, 0));

const gate = (): { readonly open: () => void; readonly opened: Promise<void> } => {
  let open = (): void => undefined;
  const opened = new Promise<void>(resolve => {
    open = resolve;
  });
  return { open, opened };
};

describe('KeyedSerialExecutor.runExclusiveYielding', () => {
  test('runs at once on an idle executor and answers what the work answers', async () => {
    const executor = new KeyedSerialExecutor();
    expect(await executor.runExclusiveYielding(async () => 'done')).toBe('done');
  });

  test('waits for keyed work that is already running, and runs alone after it', async () => {
    const executor = new KeyedSerialExecutor();
    const log: string[] = [];
    const held = gate();
    const keyed = executor.run('a', async () => {
      log.push('a:start');
      await held.opened;
      log.push('a:end');
    });
    await tick();
    const exclusive = executor.runExclusiveYielding(async () => void log.push('exclusive'));
    await tick();
    expect(log).toEqual(['a:start']);
    held.open();
    await Promise.all([keyed, exclusive]);
    expect(log).toEqual(['a:start', 'a:end', 'exclusive']);
  });

  test('lets keyed work that arrives while it waits go first, then claims the barrier', async () => {
    const executor = new KeyedSerialExecutor();
    const log: string[] = [];
    const first = gate();
    const second = gate();
    const a = executor.run('a', async () => {
      await first.opened;
      log.push('a');
    });
    await tick();
    const exclusive = executor.runExclusiveYielding(async () => void log.push('exclusive'));
    await tick();
    const b = executor.run('b', async () => {
      await second.opened;
      log.push('b');
    });
    first.open();
    await tick();
    expect(log).toEqual(['a']);
    second.open();
    await Promise.all([a, b, exclusive]);
    expect(log).toEqual(['a', 'b', 'exclusive']);
  });

  test('queues like plain exclusive work after sixteen yields, and keyed work behind it waits for it', async () => {
    const executor = new KeyedSerialExecutor();
    const log: string[] = [];
    let spawned = 0;
    const chain = (index: number): Promise<void> =>
      executor.run(`key-${index}`, async () => {
        log.push(`keyed ${index}`);
        await tick();
        spawned += 1;
        if (index < 40) void chain(index + 1);
      });
    const first = chain(0);
    await tick();
    const exclusive = executor.runExclusiveYielding(async () => {
      log.push('exclusive:start');
      await tick();
      log.push('exclusive:end');
      return spawned;
    });
    await first;
    const spawnedWhenItRan = await exclusive;
    expect(spawnedWhenItRan).toBeGreaterThan(0);
    const start = log.indexOf('exclusive:start');
    const end = log.indexOf('exclusive:end');
    expect(start).toBeGreaterThan(0);
    expect(end).toBe(start + 1);
    while (spawned < 41) await tick();
  });
});
