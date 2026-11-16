import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { protectedPidsOf } from '../../../../daemon/adapters/tmux/pane-process-host.ts';

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
