import { describe, expect, test } from 'bun:test';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { ScratchCollector, type ScratchConfig } from '../../daemon/lib/scratch-collector.ts';
import { scratchEligibility } from '../../daemon/lib/scratch-policy.ts';
import { SCRATCH_DEFAULTS, ScratchPlanListSchema } from '../../contract/index.ts';
import { at, HOUR, MemoryFolders, NOW, ROOT } from './support.ts';

const base = {
  stopped: true,
  stoppedAtMs: NOW - 48 * HOUR,
  newestMtimeMs: NOW - 48 * HOUR,
  nowMs: NOW,
  ttlMs: 24 * HOUR,
  gitWorktree: false,
  sharedWithLive: false,
};

describe('scratch reclamation policy', () => {
  test('reclaims a settled stopped ferret past the wait', () => {
    expect(scratchEligibility(base)).toEqual({ eligible: true });
  });
  test('refuses a ferret that is not stopped', () => {
    expect(scratchEligibility({ ...base, stopped: false }).reason).toBe('not stopped');
  });
  test('refuses one that stopped inside the wait, saying for how long', () => {
    expect(scratchEligibility({ ...base, stoppedAtMs: NOW - 5 * HOUR, newestMtimeMs: NOW - 5 * HOUR })).toEqual({
      eligible: false,
      reason: 'stopped for 5h, under the wait',
    });
  });
  test('refuses one whose files were touched inside the wait', () => {
    expect(scratchEligibility({ ...base, newestMtimeMs: NOW - HOUR }).reason).toBe(
      'a file in the folder changed inside the wait',
    );
  });
  test('refuses a git worktree, and a folder another working ferret shares', () => {
    expect(scratchEligibility({ ...base, gitWorktree: true }).reason).toMatch(/git worktree/u);
    expect(scratchEligibility({ ...base, sharedWithLive: true }).reason).toMatch(/still working/u);
  });
  test('refuses when there is nothing to age from', () => {
    expect(scratchEligibility({ ...base, stoppedAtMs: undefined, newestMtimeMs: undefined }).eligible).toBe(false);
  });
});

function world(config: Partial<ScratchConfig> = {}) {
  const folders = new MemoryFolders();
  const ferrets = new FakeFerrets();
  const recorded: { ferrets: number; bytes: number }[] = [];
  const collector = new ScratchCollector({
    ferrets,
    worktrees: folders,
    nowMs: () => NOW,
    config: () => ({ ...SCRATCH_DEFAULTS, ...config }),
    record: async reclaimed => void recorded.push(reclaimed),
  });
  const stopped = (id: string, folder: string, hoursAgo = 48) =>
    ferrets.add({ id: ferretId(id), state: 'stopped', folder, stateAt: at(NOW - hoursAgo * HOUR) });
  return { folders, ferrets, collector, recorded, stopped };
}

describe('ScratchCollector', () => {
  test('reclaims the direct children of an old stopped ferret’s folder and records the totals', async () => {
    const { folders, collector, recorded, stopped } = world();
    stopped('f1', `${ROOT}/f1`);
    folders.dir(`${ROOT}/f1`).file(`${ROOT}/f1/notes.txt`, 100).dir(`${ROOT}/f1/out`).file(`${ROOT}/f1/out/a.bin`, 900);

    const result = await collector.sweep();

    expect(result).toEqual({ ferrets: 1, bytes: 1000, failures: 0 });
    expect(folders.removed.sort()).toEqual([`${ROOT}/f1/notes.txt`, `${ROOT}/f1/out`]);
    expect(folders.nodes.has(`${ROOT}/f1`)).toBe(true);
    expect(recorded).toEqual([{ ferrets: 1, bytes: 1000 }]);
  });

  test('a plan explains every refusal and parses as the wire', async () => {
    const { folders, collector, stopped, ferrets } = world();
    stopped('young', `${ROOT}/young`, 2);
    folders.dir(`${ROOT}/young`).file(`${ROOT}/young/x`, 1, NOW - 2 * HOUR);
    stopped('git', `${ROOT}/git`);
    folders.dir(`${ROOT}/git`).file(`${ROOT}/git/.git`, 1).file(`${ROOT}/git/src.ts`, 5);
    stopped('shared', `${ROOT}/shared`);
    ferrets.add({ id: ferretId('busy'), state: 'working', folder: `${ROOT}/shared` });
    folders.dir(`${ROOT}/shared`).file(`${ROOT}/shared/y`, 2);

    const plan = await collector.plan();

    expect(ScratchPlanListSchema.safeParse(plan).success).toBe(true);
    expect(plan.map(p => [String(p.ferret), p.eligible])).toEqual([
      ['git', false],
      ['shared', false],
      ['young', false],
    ]);
    expect(plan.find(p => p.ferret === 'git')?.reason).toMatch(/git worktree/u);
  });

  test('never touches a folder outside the worktrees root, or the root itself', async () => {
    const { folders, collector, stopped } = world();
    stopped('mine', '/home/owner/project');
    stopped('rooted', ROOT);
    folders.file(`${ROOT}/keep`, 5);

    expect(await collector.plan()).toEqual([]);
    expect((await collector.sweep()).ferrets).toBe(0);
    expect(folders.removed).toEqual([]);
  });

  test('a link is listed but neither followed nor removed, and counts as a failure', async () => {
    const { folders, collector, stopped } = world();
    stopped('f1', `${ROOT}/f1`);
    folders.dir(`${ROOT}/f1`).link(`${ROOT}/f1/out`).file(`${ROOT}/f1/note`, 10);
    folders.dir(`${ROOT}/other`).file(`${ROOT}/other/precious`, 7);

    const result = await collector.sweep();

    expect(result).toEqual({ ferrets: 1, bytes: 10, failures: 1 });
    expect(folders.nodes.has(`${ROOT}/other/precious`)).toBe(true);
    expect(folders.nodes.has(`${ROOT}/f1/out`)).toBe(true);
  });

  test('a switched-off sweep does nothing unless forced', async () => {
    const { folders, collector, stopped } = world({ enabled: false });
    stopped('f1', `${ROOT}/f1`);
    folders.dir(`${ROOT}/f1`).file(`${ROOT}/f1/n`, 3);

    expect(await collector.sweep()).toEqual({ ferrets: 0, bytes: 0, failures: 0 });
    expect(await collector.sweep(true)).toEqual({ ferrets: 1, bytes: 3, failures: 0 });
  });

  test('one sweep reclaims from at most perSweep ferrets', async () => {
    const { folders, collector, stopped } = world({ perSweep: 2 });
    for (const id of ['a', 'b', 'c']) {
      stopped(id, `${ROOT}/${id}`);
      folders.dir(`${ROOT}/${id}`).file(`${ROOT}/${id}/n`, 1);
    }
    expect((await collector.sweep()).ferrets).toBe(2);
  });

  test('a kernel with no lstat plans and sweeps nothing rather than follow a link', async () => {
    const { folders, collector, stopped } = world();
    folders.noLstat();
    stopped('f1', `${ROOT}/f1`);
    folders.dir(`${ROOT}/f1`).file(`${ROOT}/f1/n`, 3);
    expect(await collector.plan()).toEqual([]);
    expect((await collector.sweep(true)).ferrets).toBe(0);
    expect(folders.removed).toEqual([]);
  });

  test('a ferret folder that cannot be listed is left out of the plan', async () => {
    const { folders, collector, stopped } = world();
    stopped('f1', `${ROOT}/f1`);
    folders.dir(`${ROOT}/f1`).file(`${ROOT}/f1/n`, 3);
    const list = folders.list.bind(folders);
    folders.list = async path => {
      if (path === `${ROOT}/f1`) throw new Error('unreadable');
      return list(path);
    };
    expect(await collector.plan()).toEqual([]);
    expect((await collector.sweep(true)).ferrets).toBe(0);
    expect(folders.removed).toEqual([]);
  });

  test('a child that cannot be measured counts as an empty file, and is still reclaimed', async () => {
    const { folders, collector, stopped } = world();
    stopped('f1', `${ROOT}/f1`);
    folders.dir(`${ROOT}/f1`).file(`${ROOT}/f1/broken`, 50).file(`${ROOT}/f1/fine`, 7);
    const lstat = folders.lstat;
    folders.lstat = async path => {
      if (path === `${ROOT}/f1/broken`) throw new Error('stat failed');
      return lstat?.(path);
    };
    const plan = await collector.plan();
    expect(plan[0]?.entries).toEqual([
      { name: 'fine', bytes: 7, kind: 'file' },
      { name: 'broken', bytes: 0, kind: 'file' },
    ]);
    expect(await collector.sweep()).toEqual({ ferrets: 1, bytes: 7, failures: 0 });
  });

  test('a subfolder that cannot be listed stands on its own size', async () => {
    const { folders, collector, stopped } = world();
    stopped('f1', `${ROOT}/f1`);
    folders.dir(`${ROOT}/f1`).dir(`${ROOT}/f1/out`).file(`${ROOT}/f1/out/a.bin`, 900);
    const list = folders.list.bind(folders);
    folders.list = async path => {
      if (path === `${ROOT}/f1/out`) throw new Error('unreadable');
      return list(path);
    };
    const plan = await collector.plan();
    expect(plan[0]?.entries).toEqual([{ name: 'out', bytes: 0, kind: 'directory' }]);
  });

  test('a name the root no longer resolves at deletion is a failure, and nothing is removed for it', async () => {
    const { folders, collector, stopped } = world();
    stopped('f1', `${ROOT}/f1`);
    folders.dir(`${ROOT}/f1`).file(`${ROOT}/f1/a`, 1).file(`${ROOT}/f1/b`, 2);
    const resolve = folders.resolve.bind(folders);
    const seen = new Set<string>();
    folders.resolve = relative => {
      // the plan resolves each child once; the deletion pass sees the second look at `a` fail
      if (relative === `${ROOT}/f1/a` && seen.has(relative)) return resolve('../escape');
      seen.add(relative);
      return resolve(relative);
    };
    const result = await collector.sweep();
    expect(result).toEqual({ ferrets: 1, bytes: 2, failures: 1 });
    expect(folders.removed).toEqual([`${ROOT}/f1/b`]);
  });

  test('a name that vanished before deletion is a failure, and the sweep carries on', async () => {
    const { folders, collector, stopped } = world();
    stopped('f1', `${ROOT}/f1`);
    folders.dir(`${ROOT}/f1`).file(`${ROOT}/f1/a`, 1).file(`${ROOT}/f1/b`, 2);
    const remove = folders.remove.bind(folders);
    folders.remove = async path => {
      if (path.endsWith('/a')) throw new Error('gone');
      await remove(path);
    };
    expect(await collector.sweep()).toEqual({ ferrets: 1, bytes: 2, failures: 1 });
  });
});

describe('defaults', () => {
  test('are on, a day, twenty ferrets a sweep (today’s)', () => {
    expect(SCRATCH_DEFAULTS).toEqual({ enabled: true, ttlHours: 24, perSweep: 20 });
  });
});
