import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { protectedPidsOf, scopeMembersOf } from '../../../../daemon/adapters/tmux/pane-process-host.ts';

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

describe('scopeMembersOf (E-309)', () => {
  const SCOPE = 'ferretry-agent-s1-9f.scope';
  const PLACEMENT = `0::/user.slice/user-1000.slice/user@1000.service/ferretry_fleet.slice/ferretry_fleet-s1.slice/${SCOPE}\n`;

  /** A fake procfs and cgroup tree: pid 10 sits in `placement`, and `procs` is that cgroup's `cgroup.procs`. */
  async function world(placement: string, procs: string | undefined, directory = PLACEMENT.slice(3, -1)) {
    const proc = await mkdtemp(join(tmpdir(), 'fy-scope-proc-'));
    const cgroup = await mkdtemp(join(tmpdir(), 'fy-scope-cg-'));
    roots.push(proc, cgroup);
    await mkdir(join(proc, '10'), { recursive: true });
    await writeFile(join(proc, '10', 'cgroup'), placement);
    if (procs !== undefined) {
      await mkdir(join(cgroup, directory), { recursive: true });
      await writeFile(join(cgroup, directory, 'cgroup.procs'), procs);
    }
    return { proc, cgroup };
  }

  test('is every pid of the agent scope the pid sits in, a reparented helper included', async () => {
    const { proc, cgroup } = await world(PLACEMENT, '10\n11\n77\n');
    expect(await scopeMembersOf(10, proc, cgroup)).toEqual([10, 11, 77]);
  });

  test('is nothing for a pid outside every product scope (a plain service or another unit)', async () => {
    const { proc, cgroup } = await world('0::/user.slice/user@1000.service/app.slice/x.service\n', '10\n99\n');
    expect(await scopeMembersOf(10, proc, cgroup)).toEqual([]);
  });

  test('is nothing when the placement or the scope cannot be read', async () => {
    const { proc, cgroup } = await world(PLACEMENT, undefined);
    expect(await scopeMembersOf(10, proc, cgroup)).toEqual([]);
    expect(await scopeMembersOf(404, proc, cgroup)).toEqual([]);
  });

  test('reads a scope of this product only, never a path that climbs out of the cgroup tree', async () => {
    const { proc, cgroup } = await world(`0::/../../etc/${SCOPE}\n`, '10\n');
    expect(await scopeMembersOf(10, proc, cgroup)).toEqual([]);
  });
});
