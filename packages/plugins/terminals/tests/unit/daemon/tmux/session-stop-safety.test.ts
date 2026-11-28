import { expect, test } from 'bun:test';
import { endDoomed, nameDoomed } from '../../../../daemon/adapters/tmux/session-tree-end.ts';
import type { PaneProcessHost } from '../../../../daemon/adapters/tmux/tmux-runner.ts';

const owned = 'ferretry-agent-own-1.scope';
const other = 'ferretry-agent-other-1.scope';
const path = (scope: string) => `/fleet/${scope}`;
type Row = { pid: number; start: number; ppid: number; scope: string };

function world(rows: Row[], children: number[] = []) {
  const live = new Map(rows.map(row => [row.pid, row]));
  const signals: string[] = [];
  let protectedPids = [99];
  const host = {
    startOf: async (pid: number) => live.get(pid)?.start,
    processOf: async (pid: number) => live.get(pid),
    ownedProcess: async (pid: number, ferret: string) => {
      const current = live.get(pid);
      return ferret === 'own' && current?.scope === path(owned) ? { ...current } : undefined;
    },
    tree: async (root: number) => ({ kind: 'read', rows: root === 10 ? children.map(pid => live.get(pid)) : [] }),
    protectedPids: async () => protectedPids,
    // The number branch reproduces the old host's unsafe inference from a live pane PID.
    scopeMembers: async (scope: string | number) => {
      const placement = typeof scope === 'number' ? live.get(scope)?.scope : path(scope);
      const members = [...live.values()].filter(row => row.scope === placement).map(row => ({ ...row }));
      return typeof scope === 'number' ? members.map(row => row.pid) : members;
    },
    signal: (pid: number, signal: string) => {
      signals.push(`${signal}:${pid}`);
      live.delete(pid);
    },
  } as unknown as PaneProcessHost;
  const name = () => nameDoomed(host, [10], owned);
  const end = async (named: Awaited<ReturnType<typeof name>>) =>
    await endDoomed(host, named, 'fy-own', async () => {}, { stepMs: 0, pollMs: 1 });
  return {
    host,
    live,
    signals,
    name,
    end,
    protect: (pids: number[]) => {
      protectedPids = pids;
    },
  };
}
const row = (pid: number, ppid = 10, scope = owned): Row => ({ pid, ppid, start: pid, scope: path(scope) });

test('MUST 1: a scope sweep cannot re-add descendants pruned under a protected parent outside that scope', async () => {
  const w = world([row(10, 1), row(99, 10, other), row(100, 99), row(101, 100)], [99, 100, 101]);
  await w.end(await w.name());
  expect(w.signals).toEqual(['SIGTERM:10']);
});

test('MUST 1: protection that changes after discovery is checked again before each TERM and KILL', async () => {
  const w = world([row(10, 1), row(11)], [11]);
  const named = await w.name();
  w.protect([11]);
  await w.end(named);
  expect(w.signals).toEqual(['SIGTERM:10']);
  expect(w.live.has(11)).toBe(true);
});

test('MUST 2: a child in another ferret scope is never signalled', async () => {
  const w = world([row(10, 1), row(11, 10, other), row(77, 1)], [11]);
  await w.end(await w.name());
  expect(w.signals).toEqual(['SIGTERM:10', 'SIGTERM:77']);
  expect(w.live.has(11)).toBe(true);
});

test('MUST 2: a recycled pane PID cannot select a second ferret scope', async () => {
  const w = world([row(10, 1, other), row(11, 10, other), row(77, 1)], [11]);
  await w.end(await w.name());
  expect(w.signals).toEqual(['SIGTERM:77']);
  expect(w.live.has(10) && w.live.has(11)).toBe(true);
});

test('MUST 1: a subtree becoming protected after TERM receives no KILL', async () => {
  const w = world([row(10, 1), row(11)], [11]);
  w.host.signal = (pid, signal) => {
    w.signals.push(`${signal}:${pid}`);
    if (pid === 10) {
      w.live.delete(pid);
      w.live.set(11, row(11, 1));
    }
    if (pid === 11 && signal === 'SIGTERM') w.protect([11]);
  };
  await w.end(await w.name());
  expect(w.signals).toEqual(['SIGTERM:10', 'SIGTERM:11']);
  expect(w.live.has(11)).toBe(true);
});

test('MUST 2: moving to another scope after discovery prevents both signals', async () => {
  const w = world([row(10, 1), row(77, 1)]);
  const named = await w.name();
  w.live.set(77, row(77, 1, other));
  await w.end(named);
  expect(w.signals).toEqual(['SIGTERM:10']);
});

test('MUST 3: reuse after scope enumeration never adopts the replacement start', async () => {
  const w = world([row(10, 1), row(77, 1)]);
  const members = w.host.scopeMembers?.bind(w.host);
  if (members === undefined) throw new Error('fixture has no scope reader');
  w.host.scopeMembers = async scope => {
    const captured = await members(scope);
    w.live.set(77, { ...row(77, 1), start: 999 });
    return captured;
  };
  await w.end(await w.name());
  expect(w.signals).toEqual(['SIGTERM:10']);
});

test('MUST 3: reading a later target cannot stale an earlier target before its signal', async () => {
  const w = world([row(10, 1), row(77, 1)]);
  const named = await w.name();
  const startOf = w.host.startOf.bind(w.host);
  w.host.startOf = async pid => {
    if (pid === 77) w.live.set(10, { ...row(10, 1), start: 999 });
    return await startOf(pid);
  };
  const processOf = w.host.processOf?.bind(w.host);
  if (processOf === undefined) throw new Error('fixture has no process reader');
  w.host.processOf = async pid => {
    if (pid === 77) w.live.set(10, { ...row(10, 1), start: 999 });
    return await processOf(pid);
  };
  await w.end(named);
  expect(w.signals).toEqual(['SIGTERM:77']);
});

test('R3-1: descendant proof alone never sweeps an orphan or includes a foreign child or protected subtree', async () => {
  const w = world([row(10, 1), row(11, 10, other), row(77, 1), row(99), row(100, 99)], [11, 99, 100]);
  await w.end(await nameDoomed(w.host, [10], undefined, 'own'));
  expect(w.signals).toEqual(['SIGTERM:10']);
  expect([...w.live.keys()]).toEqual([11, 77, 99, 100]);
});

test('R3-1: a descendant recycled between the tree read and its ownership read is never adopted', async () => {
  const w = world([row(10, 1), row(11)], [11]);
  const tree = w.host.tree.bind(w.host);
  w.host.tree = async root => {
    const captured = await tree(root);
    w.live.set(11, { ...row(11), start: 999 });
    return captured;
  };
  await w.end(await nameDoomed(w.host, [10], undefined, 'own'));
  expect(w.signals).toEqual(['SIGTERM:10']);
});

test('R3-1: moving to a foreign scope or replacing a named descendant prevents its signal', async () => {
  for (const replacement of [row(11, 1, other), { ...row(11, 1), start: 999 }]) {
    const w = world([row(10, 1), row(11)], [11]);
    const named = await nameDoomed(w.host, [10], undefined, 'own');
    w.live.set(11, replacement);
    await w.end(named);
    expect(w.signals).toEqual(['SIGTERM:10']);
  }
});

test('R3-1: losing manager ownership prevents escalation and refuses to report a live process stopped', async () => {
  const w = world([row(10, 1), row(11)], [11]);
  const named = await nameDoomed(w.host, [10], undefined, 'own');
  w.host.signal = (pid, signal) => {
    w.signals.push(`${signal}:${pid}`);
    if (pid === 10) {
      w.live.delete(pid);
      w.live.set(11, row(11, 1));
    }
    if (pid === 11) w.host.ownedProcess = async () => undefined;
  };
  await expect(w.end(named)).rejects.toThrow('not stopped');
  expect(w.signals).toEqual(['SIGTERM:10', 'SIGTERM:11']);
});
