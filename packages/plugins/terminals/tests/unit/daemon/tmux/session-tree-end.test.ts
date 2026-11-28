import { describe, expect, test } from 'bun:test';
import { endDoomed, nameDoomed } from '../../../../daemon/adapters/tmux/session-tree-end.ts';
import type { PaneProcessHost } from '../../../../daemon/adapters/tmux/tmux-runner.ts';

/** A machine of `table` (pid → start); a signal in `immune` does nothing to that pid, any other removes it. */
function machine(
  table: Record<number, number>,
  options: {
    readonly tree?: Record<number, readonly number[]>;
    /** A row's parent when it is not the root it was listed under (pid → ppid). */
    readonly parents?: Record<number, number>;
    /** The pids of the owned scope each root sits in (root → members); a root absent here sits in no scope. */
    readonly scopes?: Record<number, readonly number[]>;
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
            rows: (options.tree?.[root] ?? []).map(
              pid => ({ pid, ppid: options.parents?.[pid] ?? root, start: live.get(pid) ?? 0 }) as never,
            ),
          },
    signal: (pid, signal) => {
      signals.push(`${signal}:${String(pid)}`);
      const refused = options.refuse?.[pid];
      if (refused === 'ESRCH') live.delete(pid);
      if (refused !== undefined) throw Object.assign(new Error(refused), { code: refused });
      if (options.immune?.[pid]?.includes(signal) !== true) live.delete(pid);
    },
    protectedPids: async () => options.protectedPids ?? [],
    scopeMembers: async () =>
      Object.values(options.scopes ?? {})
        .flat()
        .filter(pid => pid > 1 && live.has(pid))
        .map(pid => ({ pid, start: live.get(pid) ?? 0 })),
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
      { pid: 10, start: 1, root: 10 },
      { pid: 11, start: 2, root: 10 },
      { pid: 12, start: 3, root: 10 },
    ]);
  });

  test('names a root alone when its tree cannot be read', async () => {
    const { host } = machine({ 10: 1 }, { unreadable: true });
    expect(await nameDoomed(host, [10])).toEqual([{ pid: 10, start: 1, root: 10 }]);
  });
});

describe('nameDoomed under a protected process (E-310)', () => {
  test('never names what runs beneath a protected pid, however deep', async () => {
    // 10 → 99 (this daemon) → 100 → 101: the daemon's own children must not be eligible.
    const { host } = machine(
      { 10: 1, 11: 2, 99: 4, 100: 5, 101: 6 },
      { tree: { 10: [11, 99, 100, 101] }, parents: { 100: 99, 101: 100 }, protectedPids: [99] },
    );
    expect(await nameDoomed(host, [10])).toEqual([
      { pid: 10, start: 1, root: 10 },
      { pid: 11, start: 2, root: 10 },
    ]);
  });
});

describe('nameDoomed over the owned scope (E-309)', () => {
  test('names a helper that was reparented out of the tree but still sits in the pane scope', async () => {
    const { host } = machine({ 10: 1, 11: 2, 77: 7 }, { tree: { 10: [11] }, scopes: { 10: [10, 11, 77] } });
    expect(await nameDoomed(host, [10], 'owned')).toEqual([
      { pid: 10, start: 1, root: 10 },
      { pid: 11, start: 2, root: 10 },
      { pid: 77, start: 7 },
    ]);
  });

  test('a stop then ends the reparented helper too, so it does not outlive the ferret', async () => {
    const { host, live } = machine({ 10: 1, 77: 7 }, { scopes: { 10: [10, 77] } });
    await endDoomed(host, await nameDoomed(host, [10], 'owned'), 'fy-x', sleep, quick);
    expect(live.size).toBe(0);
  });

  test("leaves the scope alone when this daemon itself sits in it: nothing of it can be told from the daemon's own", async () => {
    const { host } = machine({ 10: 1, 77: 7, 99: 4 }, { scopes: { 10: [10, 77, 99] }, protectedPids: [99] });
    expect(await nameDoomed(host, [10], 'owned')).toEqual([]);
  });

  test('skips a scope member that is gone, or init', async () => {
    const { host } = machine({ 10: 1 }, { scopes: { 10: [10, 1, 5000] } });
    expect(await nameDoomed(host, [10], 'owned')).toEqual([{ pid: 10, start: 1, root: 10 }]);
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
