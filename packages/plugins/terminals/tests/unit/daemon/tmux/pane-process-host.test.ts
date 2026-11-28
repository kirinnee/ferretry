import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnPort } from '@ferretry/kernel/contract';
import {
  paneProcessHost,
  ownedScopePath,
  protectedPidsOf,
  scopeBelongsTo,
  scopeMembersOf,
} from '../../../../daemon/adapters/tmux/pane-process-host.ts';
import { agentScopeCommand, agentScopeInCommand, ferretSliceName } from '../../../../daemon/lib/cgroups/scope.ts';

/** A fake procfs: `/proc/<pid>/stat` with only the fields the parent walk reads (`pid (comm) S ppid …`). */
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function procfs(parents: Readonly<Record<number, number>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fy-protected-'));
  roots.push(root);
  for (const [pid, ppid] of Object.entries(parents)) {
    await mkdir(join(root, pid), { recursive: true });
    await writeFile(join(root, pid, 'stat'), `${pid} (a b) S ${String(ppid)} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n`);
  }
  return root;
}

describe('protectedPidsOf', () => {
  test('is the daemon and every parent of it, up to the first parent procfs cannot show', async () => {
    const root = await procfs({ 300: 200, 200: 100, 100: 1, 1: 0 });
    expect(await protectedPidsOf(300, root, 200)).toEqual([300, 200, 100, 1]);
  });

  test('stops at a cycle instead of walking for ever', async () => {
    const root = await procfs({ 300: 200, 200: 300 });
    expect(await protectedPidsOf(300, root, 200)).toEqual([300, 200]);
  });

  test('an unreadable procfs still protects the direct parent', async () => {
    const root = await procfs({});
    expect(await protectedPidsOf(300, root, 200)).toEqual([300, 200]);
  });

  test('with no procfs at all (macOS) it is the daemon and the parent the runtime reports', async () => {
    expect(await protectedPidsOf(300, null, 200)).toEqual([300, 200]);
  });
});

describe.skipIf(process.platform !== 'linux')('scopeMembersOf (E-309)', () => {
  const own = '/user.slice/fleet.slice/ferretry-agent-own-1.scope';
  const other = '/user.slice/fleet.slice/ferretry-agent-other-1.scope';
  const stat = (pid: number, start: number, state = 'S') =>
    `${pid} (a b) ${state} 1 ${Array(17).fill('0').join(' ')} ${start}\n`;
  async function world() {
    const proc = await mkdtemp(join(tmpdir(), 'fy-scope-proc-'));
    const cgroup = await mkdtemp(join(tmpdir(), 'fy-scope-cg-'));
    roots.push(proc, cgroup);
    for (const path of [own, other]) {
      await mkdir(join(cgroup, path), { recursive: true });
      await writeFile(join(cgroup, path, 'cgroup.procs'), path === own ? '10\n11\n77\n' : '22\n');
    }
    for (const pid of [10, 11, 22, 77]) {
      await mkdir(join(proc, String(pid)), { recursive: true });
      await writeFile(join(proc, String(pid), 'stat'), stat(pid, pid * 10));
      await writeFile(join(proc, String(pid), 'cgroup'), `0::${pid === 22 ? other : own}\n`);
    }
    return { proc, cgroup };
  }

  test('enumerates pid AND start with exact membership in the recorded scope, including reparented helpers', async () => {
    const { proc, cgroup } = await world();
    expect(await scopeMembersOf(own, proc, cgroup)).toEqual([
      { pid: 10, ppid: 1, start: 100, scope: own },
      { pid: 11, ppid: 1, start: 110, scope: own },
      { pid: 77, ppid: 1, start: 770, scope: own },
    ]);
  });

  test('a stale cgroup.procs PID cannot name a replacement in another scope or a nested cgroup', async () => {
    const { proc, cgroup } = await world();
    await writeFile(join(proc, '10', 'cgroup'), `0::${other}\n`);
    await writeFile(join(proc, '11', 'cgroup'), `0::${own}/nested\n`);
    expect((await scopeMembersOf(own, proc, cgroup)).map(row => row.pid)).toEqual([77]);
  });

  test('exited and zombie members are absent, and missing cgroups are empty', async () => {
    const { proc, cgroup } = await world();
    await rm(join(proc, '10'), { recursive: true });
    await writeFile(join(proc, '11', 'stat'), stat(11, 110, 'Z'));
    expect((await scopeMembersOf(own, proc, cgroup)).map(row => row.pid)).toEqual([77]);
    expect(await scopeMembersOf('/fleet/ferretry-agent-gone-1.scope', proc, cgroup)).toEqual([]);
  });

  test('rejects traversal, non-product units and paths below a scope', async () => {
    const { proc, cgroup } = await world();
    for (const path of [
      '/../../etc/ferretry-agent-x-1.scope',
      '/fleet/x.service',
      own + '/nested',
      '/fleet//ferretry-agent-x-1.scope',
    ])
      expect(await scopeMembersOf(path, proc, cgroup)).toEqual([]);
  });
});

test('records only the outer launch wrapper unit, with or without its manager environment', () => {
  const input = { scope: 'ferretry-agent-own-1.scope', slice: 'own.slice', properties: [], command: ['sh'] };
  expect(agentScopeInCommand(agentScopeCommand(input))).toBe(input.scope);
  expect(agentScopeInCommand(agentScopeCommand({ ...input, environment: { XDG_RUNTIME_DIR: '/fake/run' } }))).toBe(
    input.scope,
  );
  expect(agentScopeInCommand(['echo', ...agentScopeCommand(input)])).toBeUndefined();
  expect(
    agentScopeInCommand(['systemd-run', '--user', '--scope', '--', 'echo', '--unit=ferretry-agent-other-1.scope']),
  ).toBeUndefined();
});

test('a refused manager read cannot silently declare an owned scope empty', async () => {
  const host = paneProcessHost(
    { run: async () => ({ exitCode: 1, stdout: '', stderr: 'Failed to connect to bus' }) } as unknown as SpawnPort,
    'linux',
  );
  const read = host.scopeMembers?.('ferretry-agent-own-1.scope', 'own');
  await expect(read).rejects.toThrow('not proved stopped');
});

test('R2-2: a recorded unit must agree with its manager Id, owning Slice and exact ControlGroup', async () => {
  const unit = 'ferretry-agent-own-1.scope';
  const slice = 'ferretry_fleet-own.slice';
  const valid = `Id=${unit}\nSlice=${slice}\nControlGroup=/fleet/${slice}/${unit}\n`;
  expect(ownedScopePath(unit, valid, 'own')).toBe(`/fleet/${slice}/${unit}`);
  for (const metadata of [
    { Id: 'ferretry-agent-other-1.scope', Slice: slice, ControlGroup: `/fleet/${slice}/${unit}` },
    { Id: unit, Slice: 'ferretry_fleet-other.slice', ControlGroup: `/fleet/${slice}/${unit}` },
    { Id: unit, Slice: slice, ControlGroup: `/fleet/ferretry_fleet-other.slice/${unit}` },
    { Id: unit, Slice: slice, ControlGroup: `/fleet/${slice}/${unit}/nested` },
  ]) {
    const text = Object.entries(metadata)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    expect(ownedScopePath(unit, text, 'own')).toBeUndefined();
    const calls: (readonly string[])[] = [];
    const host = paneProcessHost(
      {
        run: async (_command: string, args: readonly string[]) => {
          calls.push(args);
          return {
            exitCode: 0,
            // The old reader asked for only ControlGroup --value and blindly accepted the forged unit.
            stdout: args.includes('--value')
              ? metadata.ControlGroup
              : Object.entries(metadata)
                  .map(([key, value]) => `${key}=${value}`)
                  .join('\n'),
            stderr: '',
          };
        },
      } as unknown as SpawnPort,
      'linux',
    );
    // A forged unit must be rejected before its nonexistent cgroup is ever read.
    expect(await host.scopeMembers?.(unit, 'own')).toEqual([]);
    expect(calls[0]).toContain('--property=Id');
    expect(calls[0]).toContain('--property=Slice');
  }
});

test('a scope name must name the exact ferret, including when another id extends its prefix', () => {
  expect(scopeBelongsTo('ferretry-agent-own-1.scope', 'own')).toBe(true);
  expect(scopeBelongsTo('ferretry-agent-own-other-1.scope', 'own')).toBe(false);
  expect(scopeBelongsTo('ferretry-agent-other-1.scope', 'own')).toBe(false);
});

describe.skipIf(process.platform !== 'linux')('R3-1: individual pane descendant ownership', () => {
  const unit = 'ferretry-agent-own-1.scope';
  const slice = ferretSliceName('own');
  const path = `/fleet/${slice}/${unit}`;
  const metadata = `Id=${unit}\nSlice=${slice}\nControlGroup=${path}\n`;

  async function world() {
    const proc = await procfs({ 77: 10 });
    await writeFile(join(proc, '77', 'stat'), `77 (helper) S 10 ${Array(17).fill('0').join(' ')} 770\n`);
    await writeFile(join(proc, '77', 'cgroup'), `0::${path}\n`);
    const calls: (readonly string[])[] = [];
    let manager = metadata;
    const host = paneProcessHost(
      {
        run: async (_command: string, args: readonly string[]) => {
          calls.push(args);
          return { exitCode: 0, stdout: manager, stderr: '' };
        },
      } as unknown as SpawnPort,
      'linux',
      proc,
    );
    return {
      host,
      proc,
      calls,
      manager: (value: string) => {
        manager = value;
      },
    };
  }

  test('proves pid, start and exact cgroup against the own launch derivation and manager, with no record', async () => {
    const w = await world();
    expect(await w.host.ownedProcess?.(77, 'own')).toEqual({ pid: 77, start: 770, ppid: 10, scope: path });
    expect(w.calls).toEqual([['--user', 'show', unit, '--property=Id', '--property=Slice', '--property=ControlGroup']]);
  });

  test('refuses every mismatched Id, Slice or ControlGroup and missing metadata', async () => {
    const w = await world();
    for (const bad of [
      metadata.replace(`Id=${unit}`, 'Id=ferretry-agent-other-1.scope'),
      metadata.replace(`Slice=${slice}`, 'Slice=ferretry_fleet-other.slice'),
      metadata.replace(`ControlGroup=${path}`, `ControlGroup=${path}/nested`),
      metadata.replace(`ControlGroup=${path}`, `ControlGroup=/another/${slice}/${unit}`),
      '',
    ]) {
      w.manager(bad);
      expect(await w.host.ownedProcess?.(77, 'own')).toBeUndefined();
    }
  });

  test('refuses foreign ids, nested paths and a different exact slice before asking the manager', async () => {
    const w = await world();
    expect(await w.host.ownedProcess?.(77, 'other')).toBeUndefined();
    for (const bad of [path + '/nested', path.replace(slice, ferretSliceName('other'))]) {
      await writeFile(join(w.proc, '77', 'cgroup'), `0::${bad}\n`);
      expect(await w.host.ownedProcess?.(77, 'own')).toBeUndefined();
    }
    expect(w.calls).toEqual([]);
  });

  test('the exact slice uses the original ferret id even when unit sanitisation collides', async () => {
    const w = await world();
    await writeFile(join(w.proc, '77', 'cgroup'), `0::/fleet/${ferretSliceName('a.b')}/ferretry-agent-a-b-1.scope\n`);
    expect(await w.host.ownedProcess?.(77, 'a-b')).toBeUndefined();
    expect(w.calls).toEqual([]);
  });
});
