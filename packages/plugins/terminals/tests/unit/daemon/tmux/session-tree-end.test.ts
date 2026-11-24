import { describe, expect, test } from 'bun:test';
import { endDoomed, nameDoomed } from '../../../../daemon/adapters/tmux/session-tree-end.ts';
import type { PaneProcessHost } from '../../../../daemon/adapters/tmux/tmux-runner.ts';

/** A machine of `table` (pid → start); a signal in `immune` does nothing to that pid, any other removes it. */
function machine(
  table: Record<number, number>,
  options: {
    readonly tree?: Record<number, readonly number[]>;
    readonly immune?: Record<number, readonly ('SIGTERM' | 'SIGKILL')[]>;
    readonly refuse?: Record<number, string>;
    readonly protectedPids?: readonly number[];
    readonly unreadable?: boolean;
  } = {},
) {
  const live = new Map(Object.entries(table).map(([pid, start]) => [Number(pid), start]));
  const signals: string[] = [];
  const host: PaneProcessHost = {
    startOf: async pid => live.get(pid),
    tree: async root =>
      options.unreadable === true
        ? { kind: 'unavailable', reason: 'no procfs' }
        : {
            kind: 'read',
            rows: (options.tree?.[root] ?? []).map(pid => ({ pid, ppid: root, start: live.get(pid) ?? 0 }) as never),
          },
    signal: (pid, signal) => {
      signals.push(`${signal}:${String(pid)}`);
      const refused = options.refuse?.[pid];
      if (refused === 'ESRCH') live.delete(pid);
      if (refused !== undefined) throw Object.assign(new Error(refused), { code: refused });
      if (options.immune?.[pid]?.includes(signal) !== true) live.delete(pid);
    },
    protectedPids: async () => options.protectedPids ?? [],
  };
  return { host, signals, live };
}

const quick = { stepMs: 10, pollMs: 5 };
const sleep = async (ms: number): Promise<void> => {
  await new Promise<void>(resolve => setTimeout(resolve, ms));
};

describe('nameDoomed', () => {
  test('names each root and everything below it, and never the daemon or its parents', async () => {
    const { host } = machine({ 10: 1, 11: 2, 12: 3, 99: 4 }, { tree: { 10: [11, 12, 99] }, protectedPids: [99] });
    expect(await nameDoomed(host, [10, 10, 1, 99, 500])).toEqual([
      { pid: 10, start: 1 },
      { pid: 11, start: 2 },
      { pid: 12, start: 3 },
    ]);
  });

  test('names a root alone when its tree cannot be read', async () => {
    const { host } = machine({ 10: 1 }, { unreadable: true });
    expect(await nameDoomed(host, [10])).toEqual([{ pid: 10, start: 1 }]);
  });
});

describe('endDoomed', () => {
  test('signals nothing to processes that left by themselves', async () => {
    const { host, signals } = machine({});
    await endDoomed(host, [{ pid: 10, start: 1 }], 'fy-x', sleep, quick);
    expect(signals).toEqual([]);
  });

  test('is SIGTERM first, and SIGKILL only to what ignored it', async () => {
    const { host, signals, live } = machine({ 10: 1, 11: 2 }, { immune: { 10: ['SIGTERM'] } });
    await endDoomed(
      host,
      [
        { pid: 10, start: 1 },
        { pid: 11, start: 2 },
      ],
      'fy-x',
      sleep,
      quick,
    );
    expect(signals).toEqual(['SIGTERM:10', 'SIGTERM:11', 'SIGKILL:10']);
    expect(live.size).toBe(0);
  });

  test('is not fooled by a reused pid: a process with another start is not the one named', async () => {
    const { host, signals } = machine({ 10: 777 });
    await endDoomed(host, [{ pid: 10, start: 1 }], 'fy-x', sleep, quick);
    expect(signals).toEqual([]);
  });

  test('throws, naming the session and the pid, when one survives SIGKILL: the ferret must not be called stopped', async () => {
    const { host } = machine({ 10: 1 }, { immune: { 10: ['SIGTERM', 'SIGKILL'] } });
    await expect(endDoomed(host, [{ pid: 10, start: 1 }], 'fy-x', sleep, quick)).rejects.toThrow(
      /could not end every process of fy-x \(pid 10 still runs\), so it was not stopped; it may still be running/u,
    );
  });

  test('a refused signal (EPERM) leaves the process running, and that is said', async () => {
    const { host } = machine({ 10: 1 }, { refuse: { 10: 'EPERM' } });
    await expect(endDoomed(host, [{ pid: 10, start: 1 }], 'fy-x', sleep, quick)).rejects.toThrow(/pid 10 still runs/u);
  });

  test('a process that exits before the signal (ESRCH) is the stop already made', async () => {
    const { host, live } = machine({ 10: 1 }, { refuse: { 10: 'ESRCH' } });
    await endDoomed(host, [{ pid: 10, start: 1 }], 'fy-x', sleep, quick);
    expect(live.size).toBe(0);
  });

  test('any other signal failure is thrown as it is', async () => {
    const { host } = machine({ 10: 1 }, { refuse: { 10: 'EINVAL' } });
    await expect(endDoomed(host, [{ pid: 10, start: 1 }], 'fy-x', sleep, quick)).rejects.toThrow('EINVAL');
  });
});
