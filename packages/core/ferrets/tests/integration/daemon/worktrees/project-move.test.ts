import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { CreatedWorktree, ProjectRepository, RepoWorktreeListResponse } from '../../../../contract/index.ts';
import type { WorktreeSessionFact } from '../../../../daemon/lib/worktrees/service.ts';
import { worktreeRouteWorld } from '../../../support/daemon/worktree-world.ts';
import { cleanupTempDirectories, setupGit } from '../support/repository.ts';

afterAll(cleanupTempDirectories);

async function fixture(label: string) {
  const projects = new Map<string, ProjectRepository>();
  let sessions: readonly WorktreeSessionFact[] | undefined = [];
  let terminals: readonly string[] | undefined = [];
  const world = await worktreeRouteWorld(label, async () => terminals, undefined, {
    projects,
    sessions: async () => sessions,
  });
  const root = world.repository.root;
  projects.set('project-1', { folder: root, commonDirectory: path.join(root, '.git'), worktreeGroup: 'project-1' });
  const target = path.join(root, 'old-checkout');
  await setupGit(root, 'worktree', 'add', '-b', 'feature/move', target);
  expect((await world.call('POST /v1/worktrees/adopt', { body: { path: target } })).status).toBe(200);
  const listing = async () => {
    const answer = await world.call('GET /v1/worktrees/repo', { query: { project: 'project-1' } });
    expect(answer.status).toBe(200);
    return answer.json as RepoWorktreeListResponse;
  };
  const offer = async () => {
    const move = (await listing()).worktrees.find(row => row.path === target)?.move;
    if (move === undefined) throw new Error('the daemon did not describe the move');
    return move;
  };
  const apply = async (move: NonNullable<RepoWorktreeListResponse['worktrees'][number]['move']>, extra = {}) =>
    await world.call('POST /v1/worktrees/move', {
      body: { project: 'project-1', worktreeId: move.worktreeId, reviewedIdentity: move.reviewedIdentity, ...extra },
    });
  return {
    ...world,
    projects,
    root,
    target,
    listing,
    offer,
    apply,
    sessions: (value: typeof sessions) => {
      sessions = value;
    },
    terminals: (value: typeof terminals) => {
      terminals = value;
    },
  };
}

describe('ask-first project worktree move through the daemon handlers and real Git', () => {
  for (const active of ['ferret', 'terminal'] as const)
    test(`refuses a live ${active} that arrives during the last status inspection`, async () => {
      const w = await fixture(`project-move-last-${active}`);
      const reviewed = await w.offer();
      const run = w.io.git.runBytes;
      let statuses = 0;
      w.io.git.runBytes = async (program, args, options) => {
        const result = await run(program, args, options);
        if (args.includes('status') && ++statuses === 2) {
          if (active === 'ferret') w.sessions([{ id: 'arrived', cwd: w.target, status: 'running' }]);
          else w.terminals([w.target]);
        }
        return result;
      };
      expect((await w.apply(reviewed)).status).toBe(409);
      expect(await Bun.file(path.join(w.target, 'README.md')).text()).toBe('# fixture\n');
    });
  test('a managed checkout retains its managed record when moved under the same U2 project group', async () => {
    const w = await fixture('project-move-managed');
    const created = await w.call('POST /v1/worktrees', {
      body: { sourcePath: w.root, branch: 'managed/move', sessionId: 'managed-session' },
    });
    expect(created.status).toBe(200);
    const target = (created.json as CreatedWorktree).worktree.path;
    const move = (await w.listing()).worktrees.find(row => row.path === target)?.move;
    if (move?.destination === undefined) throw new Error('no managed move offered');
    expect((await w.apply(move)).status).toBe(200);
    expect((await w.listing()).worktrees.find(row => row.path === move.destination)?.tracked).toBe('managed');
  });
  test('refuses the registered project folder itself, including at apply after registration changes', async () => {
    const w = await fixture('project-move-registered-folder');
    const reviewed = await w.offer();
    w.projects.set('project-1', {
      folder: w.target,
      commonDirectory: path.join(w.root, '.git'),
      worktreeGroup: 'project-1',
    });
    expect((await w.offer()).reason).toContain('registered project folder');
    expect((await w.apply(reviewed)).status).toBe(409);
    expect(await Bun.file(path.join(w.target, 'README.md')).text()).toBe('# fixture\n');
  });

  test('untracked and prunable rows have reasons and can never apply', async () => {
    const w = await fixture('project-move-prunable');
    const reviewed = await w.offer();
    const stray = path.join(w.root, 'stray');
    await setupGit(w.root, 'worktree', 'add', '-b', 'stray', stray);
    expect((await w.listing()).worktrees.find(row => row.path === stray)?.move?.reason).toBe(
      'Adopt it first to move it.',
    );
    await rm(w.target, { recursive: true });
    expect((await w.offer()).reason).toContain('missing');
    expect((await w.apply(reviewed)).status).toBe(409);
  });

  test('a replacement folder with identical Git metadata and HEAD cannot use the reviewed offer', async () => {
    const w = await fixture('project-move-replacement');
    const reviewed = await w.offer();
    await rename(w.target, `${w.target}-original`);
    await mkdir(w.target);
    for (const file of ['.git', 'README.md'])
      await Bun.write(path.join(w.target, file), await Bun.file(path.join(`${w.target}-original`, file)).text());
    expect((await w.apply(reviewed)).status).toBe(409);
    expect(await Bun.file(path.join(w.target, 'README.md')).text()).toBe('# fixture\n');
    expect(await Bun.file(path.join(`${w.target}-original`, 'README.md')).text()).toBe('# fixture\n');
  });

  test('a crash after the move intent is recorded is reconciled without moving any files', async () => {
    const w = await fixture('project-move-intent-crash');
    const reviewed = await w.offer();
    w.state.armCrash();
    await expect(w.apply(reviewed)).rejects.toThrow('simulated crash');
    w.state.revive();
    expect(await Bun.file(path.join(w.target, 'README.md')).text()).toBe('# fixture\n');
    expect((await w.offer()).reviewedIdentity).toBeDefined();
    expect((await w.apply(await w.offer())).status).toBe(200);
  });

  test('a crash after Git moved the checkout recovers its registry row without moving it again', async () => {
    const w = await fixture('project-move-registry-crash');
    const reviewed = await w.offer();
    const run = w.io.git.runBytes;
    w.io.git.runBytes = async (program, args, options) => {
      const result = await run(program, args, options);
      if (args.includes('move')) throw new Error('synthetic crash after Git moved the checkout');
      return result;
    };
    expect((await w.apply(reviewed)).status).toBe(409);
    const listing = await w.listing();
    expect(listing.worktrees.find(row => row.path === reviewed.destination)?.tracked).toBe('adopted');
    expect(await Bun.file(path.join(reviewed.destination!, 'README.md')).text()).toBe('# fixture\n');
  });
  test('a listing changes nothing; a confirmed clean adopted checkout moves with byte-identical Git state', async () => {
    const w = await fixture('project-move-clean');
    const before = await Promise.all([
      setupGit(w.target, 'status', '--porcelain=v1', '-z'),
      setupGit(w.target, 'show-ref'),
      readFile(path.join((await setupGit(w.target, 'rev-parse', '--absolute-git-dir')).trim(), 'HEAD'), 'utf8'),
    ]);
    const move = await w.offer();
    expect(move.reason).toBeUndefined();
    expect(move.destination).toStartWith(path.join(w.io.managedRoot, 'project-1'));
    expect(await Bun.file(path.join(w.target, '.git')).exists()).toBe(true);
    expect((await w.apply(move)).status).toBe(200);
    expect(await Bun.file(path.join(w.target, '.git')).exists()).toBe(false);
    expect(
      await Promise.all([
        setupGit(move.destination!, 'status', '--porcelain=v1', '-z'),
        setupGit(move.destination!, 'show-ref'),
        readFile(
          path.join((await setupGit(move.destination!, 'rev-parse', '--absolute-git-dir')).trim(), 'HEAD'),
          'utf8',
        ),
      ]),
    ).toEqual(before);
    const moved = (await w.listing()).worktrees.find(row => row.path === move.destination);
    expect(moved?.tracked).toBe('adopted');
    expect(moved?.move?.reason).toContain('already');
  });

  for (const kind of [
    'dirty',
    'untracked',
    'locked',
    'live-ferret',
    'live-terminal',
    'unknown-ferrets',
    'unknown-terminals',
  ] as const)
    test(`rechecks ${kind} at apply, keeps the original checkout and explains the absent offer`, async () => {
      const w = await fixture(`project-move-${kind}`);
      const reviewed = await w.offer();
      if (kind === 'dirty') await Bun.write(path.join(w.target, 'README.md'), 'uncommitted work\n');
      if (kind === 'untracked') await Bun.write(path.join(w.target, 'keep.txt'), 'untracked work\n');
      if (kind === 'locked') await setupGit(w.root, 'worktree', 'lock', w.target);
      if (kind === 'live-ferret')
        w.sessions([{ id: 'working', cwd: path.join(w.target, 'nested'), status: 'running' }]);
      if (kind === 'live-terminal') w.terminals([path.join(w.target, 'nested')]);
      if (kind === 'unknown-ferrets') w.sessions(undefined);
      if (kind === 'unknown-terminals') w.terminals(undefined);
      expect((await w.apply(reviewed)).status).toBe(409);
      expect((await w.offer()).reason).toBeTruthy();
      expect((await w.offer()).reviewedIdentity).toBeUndefined();
      expect(await Bun.file(path.join(w.target, '.git')).exists()).toBe(true);
    });

  test('ignored files and stopped ferrets survive a move', async () => {
    const w = await fixture('project-move-ignored');
    await Bun.write(path.join(w.root, '.git/info/exclude'), 'cache/\n');
    await Bun.write(path.join(w.target, 'cache/keep.txt'), 'ignored data kept\n');
    w.sessions([{ id: 'stopped', cwd: w.target, status: 'stopped', finishedAt: '2026-11-16T00:00:00Z' }]);
    const move = await w.offer();
    expect((await w.apply(move)).status).toBe(200);
    expect(await Bun.file(path.join(move.destination!, 'cache/keep.txt')).text()).toBe('ignored data kept\n');
  });

  test('refuses an occupied destination without overwriting it', async () => {
    const w = await fixture('project-move-occupied');
    const move = await w.offer();
    await mkdir(move.destination!, { recursive: true });
    await Bun.write(path.join(move.destination!, 'keep.txt'), 'existing destination\n');
    expect((await w.apply(move)).status).toBe(409);
    expect(await Bun.file(path.join(move.destination!, 'keep.txt')).text()).toBe('existing destination\n');
    expect(await Bun.file(path.join(w.target, '.git')).exists()).toBe(true);
  });

  test('refuses main, unknown ids and any client-supplied path', async () => {
    const w = await fixture('project-move-input');
    const main = (await w.listing()).worktrees.find(row => row.main)!;
    expect(main.move?.reason).toContain('main checkout');
    const move = await w.offer();
    expect((await w.apply({ ...move, worktreeId: main.move!.worktreeId })).status).toBe(409);
    for (const extra of [{ path: w.root }, { destination: '/tmp/client-chosen' }, { worktreeId: 'unknown' }])
      expect((await w.apply(move, extra)).status).not.toBe(200);
    expect(await Bun.file(path.join(w.root, '.git/HEAD')).exists()).toBe(true);
  });

  test('refuses a stale reviewed checkout after a new commit', async () => {
    const w = await fixture('project-move-stale');
    const reviewed = await w.offer();
    await Bun.write(path.join(w.target, 'README.md'), 'new work\n');
    await setupGit(w.target, 'commit', '-am', 'feat: changed after review');
    expect((await w.apply(reviewed)).status).toBe(409);
    expect(await Bun.file(path.join(w.target, 'README.md')).text()).toBe('new work\n');
  });

  test('a failing git worktree move leaves the original tree and registry untouched', async () => {
    const w = await fixture('project-move-failure');
    const move = await w.offer();
    const run = w.io.git.runBytes;
    w.io.git.runBytes = async (program, args, options) =>
      args.includes('move')
        ? {
            exitCode: 1,
            stdout: new Uint8Array(),
            stderr: 'synthetic move refusal',
            stdoutTruncated: false,
            stderrTruncated: false,
            timedOut: false,
          }
        : await run(program, args, options);
    const answer = await w.apply(move);
    expect(answer.status).toBe(409);
    expect(JSON.stringify(answer.json)).toContain('nothing was moved');
    expect(await Bun.file(path.join(w.target, 'README.md')).text()).toBe('# fixture\n');
    expect((await w.listing()).worktrees.find(row => row.path === w.target)?.tracked).toBe('adopted');
  });
});
