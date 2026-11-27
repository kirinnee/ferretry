import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ok } from '@ferretry/std';
import type { FerretId } from '@ferretry/kernel/contract';
import type { ForkPlan, StartRequest } from '../../../../contract/index.ts';
import { forkPortFor, forkWorktrees } from '../../../../daemon/features/forks.feature.ts';
import { ForkService } from '../../../../daemon/lib/forks/fork-service.ts';
import { worktreeRouteWorld } from '../../../support/daemon/worktree-world.ts';
import { cleanupTempDirectories, setupGit } from '../support/repository.ts';

/**
 * THE FORK JOURNEY over a REAL Git repository and the real managed-worktree service: a synthetic harness cuts a
 * conversation, a synthetic start records what it was asked, and the checkout a `worktree: 'new'` fork makes is read back
 * from Git itself.
 */

afterAll(cleanupTempDirectories);

const SOURCE = 'F1' as FerretId;
const NEW = 'F9' as FerretId;

async function journey(label: string) {
  const world = await worktreeRouteWorld(label);
  // The source stands on its own branch, two commits past `main`, in a sub-folder of the checkout.
  await setup(world.repository.root, ['checkout', '--quiet', '-b', 'topic']);
  await mkdir(path.join(world.repository.root, 'pkg'), { recursive: true });
  await Bun.write(path.join(world.repository.root, 'pkg', 'a.txt'), 'a\n');
  await setup(world.repository.root, ['add', 'pkg/a.txt']);
  await setup(world.repository.root, ['commit', '--quiet', '-m', 'feat: a']);
  await setup(world.repository.root, ['commit', '--quiet', '--allow-empty', '-m', 'feat: b']);
  const sourceFolder = path.join(world.repository.root, 'pkg');
  const head = (await setupGit(world.repository.root, 'rev-parse', 'HEAD')).trim();
  const mainHead = (await setupGit(world.repository.root, 'rev-parse', 'main')).trim();
  const cuts: { folder: string }[] = [];
  const starts: StartRequest[] = [];
  const service = new ForkService({
    source: ferret =>
      ferret === SOURCE
        ? { name: 'Quick Otter', harness: 'claude-code', folder: sourceFolder, running: false }
        : undefined,
    mayTouch: () => true,
    harness: () => ({
      fork: async (from, at, into): Promise<ForkPlan> => {
        cuts.push(into);
        return { from, ...(at === undefined ? {} : { at }), harnessConversation: 'conv-new' };
      },
    }),
    start: async request => {
      starts.push(request);
      return ok(NEW);
    },
    worktrees: () => forkWorktrees(world.built),
    newId: () => '0123456789abcdef',
  });
  return { world, service, cuts, starts, sourceFolder, head, mainHead };
}

const setup = async (cwd: string, args: string[]) => await setupGit(cwd, ...args);

describe('the fork journey over real Git', () => {
  test('should branch a new worktree from the source head, not the default branch, and start the new ferret in it', async () => {
    // Arrange
    const { world, service, cuts, starts, sourceFolder, head, mainHead } = await journey('fork-new');
    expect(head).not.toBe(mainHead);

    // Act
    const forked = await service.fork(SOURCE, { turn: 2 }, { worktree: 'new' }, { kind: 'person' });

    // Assert
    expect(forked.ok).toBe(true);
    if (!forked.ok) return;
    const made = forked.value.worktree;
    expect(made?.branch).toBe('fork/quick-otter-01234567');
    const created = await world.built.service.list();
    const row = created.worktrees.find(entry => entry.path === made?.path);
    expect(row?.initialHead).toBe(head);
    expect(row?.branchPreexisted).toBe(false);
    // Git itself agrees: the new branch is on the source's HEAD and the new checkout has the source's file.
    expect((await setupGit(world.repository.root, 'rev-parse', 'fork/quick-otter-01234567')).trim()).toBe(head);
    // The sub-folder the fork was taken from is kept: the ferret works where the source worked, in the new checkout.
    expect(forked.value.folder).toBe(path.join(made?.path ?? '', 'pkg'));
    expect(await Bun.file(path.join(forked.value.folder, 'a.txt')).text()).toBe('a\n');
    expect(cuts).toEqual([{ folder: forked.value.folder }]);
    expect(starts[0]?.folder).toBe(forked.value.folder);
    // The source checkout was only read: same branch, same head, clean.
    expect((await setupGit(world.repository.root, 'rev-parse', 'HEAD')).trim()).toBe(head);
    expect((await setupGit(world.repository.root, 'status', '--porcelain')).trim()).toBe('');
    expect(sourceFolder).not.toBe(forked.value.folder);
  });

  test('should leave no worktree and no branch behind when the harness refuses the cut', async () => {
    // Arrange: a harness that refuses the cut as Codex does for a writer version it has not tested.
    const { world, cuts, starts, sourceFolder } = await journey('fork-refused-cut');
    const service = new ForkService({
      source: () => ({ name: 'Quick Otter', harness: 'codex', folder: sourceFolder, running: false }),
      mayTouch: () => true,
      harness: () => ({
        fork: async (): Promise<ForkPlan> => {
          throw new Error('the conversation was written by Codex 0.1, a rollout format Ferretry has not tested');
        },
      }),
      start: async request => {
        starts.push(request);
        return ok(NEW);
      },
      worktrees: () => forkWorktrees(world.built),
      newId: () => '0123456789abcdef',
    });

    // Act
    const forked = await service.fork(SOURCE, { turn: 1 }, { worktree: 'new' }, { kind: 'person' });

    // Assert: the refusal is the harness's own sentence, and Git itself holds nothing of the fork.
    expect(forked.ok).toBe(false);
    if (!forked.ok) {
      expect(forked.error.code).toBe('cut');
      expect(forked.error.reason).toContain('has not tested');
      expect(forked.error.reason).not.toContain('left in place');
    }
    expect(cuts).toEqual([]);
    expect(starts).toEqual([]);
    expect((await setupGit(world.repository.root, 'branch', '--list', 'fork/*')).trim()).toBe('');
    expect(await setupGit(world.repository.root, 'worktree', 'list', '--porcelain')).not.toContain('fork/');
    const rows = (await world.built.service.list()).worktrees.filter(entry => entry.branch.startsWith('fork/'));
    expect(rows.every(row => row.removedAt !== undefined)).toBe(true);
  });

  test('should refuse a new worktree for a source that is not in a Git checkout, before the cut', async () => {
    // Arrange
    const { world, cuts, starts } = await journey('fork-not-git');
    const outside = await mkdirOutside(world.parent);
    const service = new ForkService({
      source: () => ({ name: 'Quick Otter', harness: 'claude-code', folder: outside, running: false }),
      mayTouch: () => true,
      harness: () => ({
        fork: async (from): Promise<ForkPlan> => {
          cuts.push({ folder: outside });
          return { from, harnessConversation: 'x' };
        },
      }),
      start: async request => {
        starts.push(request);
        return ok(NEW);
      },
      worktrees: () => forkWorktrees(world.built),
      newId: () => '0123456789abcdef',
    });
    cuts.length = 0;
    starts.length = 0;

    // Act
    const forked = await service.fork(SOURCE, { turn: 1 }, { worktree: 'new' }, { kind: 'person' });

    // Assert
    expect(forked.ok).toBe(false);
    if (!forked.ok) expect(forked.error.code).toBe('worktree');
    expect(cuts).toEqual([]);
    expect(starts).toEqual([]);
  });

  test('should hand the forks port to Conversation and to nobody else', () => {
    // Arrange
    const forks = { fork: async () => ok({ ferret: NEW, harnessConversation: 'c', folder: '/x' }) };

    // Act
    const conversation = forkPortFor('conversation', { forks });
    const others = ['mailbox', 'warden', 'tidy', 'terminals'].map(needer => forkPortFor(needer, { forks }));

    // Assert
    expect(conversation.forks).toBe(forks);
    for (const port of others) expect(port.forks).toBeUndefined();
  });
});

async function mkdirOutside(parent: string): Promise<string> {
  const folder = path.join(parent, 'not-a-repo');
  await mkdir(folder, { recursive: true });
  return folder;
}
