import { afterAll, describe, expect, test } from 'bun:test';
import { chmod, mkdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { err, ok } from '@ferretry/std';
import { bindDirectory } from '../../../../../kernel/host/bound-directory.ts';
import { nodeFs } from '../../../../../kernel/host/adapters/node-fs.ts';
import { emptyChildEnvironment, fenced, T0 } from '../../../../contract/testing/index.ts';
import type { CreatedWorktree, ProjectRepository, RepoWorktreeListResponse } from '../../../../contract/index.ts';
import type { WorktreeSessionFact } from '../../../../daemon/lib/worktrees/service.ts';
import { worktreeRouteWorld } from '../../../support/daemon/worktree-world.ts';
import { cleanupTempDirectories, setupGit, tempDirectory } from '../support/repository.ts';
import { waitFor } from '../support/wait-for.ts';
import { IDS, world as ferretWorld } from '../../../support/daemon/deliver-turns-world.ts';
import { PERSON_ORIGIN } from '../../../../contract/index.ts';
import { FerretsService } from '../../../../daemon/lib/ferrets/service.ts';
import { WorktreesFile } from '../../../../contract/index.ts';
import type { ManagedWorktree } from '../../../../daemon/lib/worktrees/types.ts';

afterAll(cleanupTempDirectories);

async function fixture(
  label: string,
  fleet?: FerretsService,
  terminalGuard?: <T>(folder: string, move: () => Promise<T>) => Promise<T>,
) {
  const projects = new Map<string, ProjectRepository>();
  let sessions: readonly WorktreeSessionFact[] | undefined = [];
  let terminals: readonly string[] | undefined = [];
  const options = {
    ferret: true,
    projects,
    sessions: async () => sessions,
    withFerretMove:
      fleet === undefined
        ? undefined
        : async <T>(folder: string, move: () => Promise<T>) => await fleet.withWorktreeMove(folder, move),
  };
  const world = await worktreeRouteWorld(label, async () => terminals, terminalGuard, options);
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
    revokeWriteRoot: () => {
      options.ferret = false;
    },
    restoreWriteRoot: () => {
      options.ferret = true;
    },
    sessions: (value: typeof sessions) => {
      sessions = value;
    },
    terminals: (value: typeof terminals) => {
      terminals = value;
    },
  };
}

function changeRecord(w: Awaited<ReturnType<typeof fixture>>, change: (record: ManagedWorktree) => ManagedWorktree) {
  const state = JSON.parse(w.state.raw(WorktreesFile)!) as { worktrees: ManagedWorktree[] };
  state.worktrees = state.worktrees.map(change);
  w.state.plant(WorktreesFile, JSON.stringify(state));
}

describe('ask-first project worktree move through the daemon handlers and real Git', () => {
  for (const kind of ['start', 'resume'] as const)
    test(`destination ${kind} is refused after Git renames and until reconciliation settles`, async () => {
      const fleet = await ferretWorld();
      const home = await tempDirectory('project-move-bound-home');
      const disk = nodeFs(() => 'fixture');
      let next = 0;
      const service = new FerretsService(fleet.registry, fleet.tokens, {
        now: () => T0,
        newId: () => IDS[next++]! as never,
        newName: () => `destination-${next}`,
        save: async () => {},
        saveTokens: async () => {},
        harness: () => fleet.harness,
        harnessKeys: () => [fleet.harness.key],
        runner: () => fleet.runner,
        decide: async () => ({ allow: true }),
        folder: folder => ok(fenced(folder)),
        bindFolder: async folder => {
          const bound = await bindDirectory(disk, home, { files: [], recheckMs: 0 }, folder);
          if (!bound.ok) return err(bound.error.message);
          return ok({
            ...bound.value,
            verify: async () => {
              const held = await bound.value.verify();
              return held.ok ? ok(undefined) : err(held.error.message);
            },
          });
        },
        changed: () => {},
        launchParts: () => [],
        sitrepSources: () => [],
        instructions: () => [],
        vault: { childEnvironment: async () => ok(emptyChildEnvironment()) },
        asks: { open: async () => [] },
        session: fleet.files.port,
      });
      const w = await fixture(`project-move-destination-${kind}`, service);
      const reviewed = await w.offer();
      const destination = reviewed.destination!;
      let id: string | undefined;
      if (kind === 'resume') {
        // A stopped session may already name this path even though today's destination must be absent.
        await mkdir(destination, { recursive: true });
        const started = await service.start({ folder: destination, by: 'owner' }, PERSON_ORIGIN);
        if (!started.ok) throw new Error(started.error.reason);
        id = started.value;
        await service.stop(started.value, 'now');
        await rm(destination, { recursive: true });
      }
      const scratch = await tempDirectory('project-move-rename-barrier');
      const source = path.join(scratch, 'pause.c');
      const library = path.join(scratch, 'pause.so');
      const entered = path.join(scratch, 'renamed');
      const release = path.join(scratch, 'release');
      // Pause the REAL Git child after rename(2) succeeds, before Git repairs the admin back-pointer.
      await Bun.write(
        source,
        `
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
static int paused_rename(const char *from, const char *to) {
#ifdef __APPLE__
  int result = rename(from, to);
#else
  int (*real_rename)(const char *, const char *) = dlsym(RTLD_NEXT, "rename");
  int result = real_rename(from, to);
#endif
  const char *target = getenv("MOVE_FROM");
  if (result == 0 && target && strcmp(from, target) == 0) {
    int fd = open(getenv("MOVE_ENTERED"), O_WRONLY | O_CREAT, 0600);
    if (fd >= 0) close(fd);
    while (access(getenv("MOVE_RELEASE"), F_OK) != 0) usleep(1000);
  }
  return result;
}
#ifdef __APPLE__
__attribute__((used)) static struct { const void *replacement; const void *original; }
interpose_rename __attribute__((section("__DATA,__interpose"))) = { (void *)paused_rename, (void *)rename };
#else
int rename(const char *from, const char *to) { return paused_rename(from, to); }
#endif
`,
      );
      const mac = process.platform === 'darwin';
      const compiler = Bun.spawn(
        ['cc', ...(mac ? ['-dynamiclib'] : ['-shared', '-fPIC']), source, '-o', library, ...(mac ? [] : ['-ldl'])],
        {
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const diagnostic = await new Response(compiler.stderr).text();
      if ((await compiler.exited) !== 0) throw new Error(`rename barrier compilation failed: ${diagnostic}`);
      const run = w.io.git.runBytes;
      const reconciling = Promise.withResolvers<void>();
      const settle = Promise.withResolvers<void>();
      w.io.git.runBytes = async (program, args, options) => {
        if (args.includes('move'))
          return await run(program, args, {
            ...options,
            env: {
              ...options.env,
              [mac ? 'DYLD_INSERT_LIBRARIES' : 'LD_PRELOAD']: library,
              MOVE_FROM: w.target,
              MOVE_ENTERED: entered,
              MOVE_RELEASE: release,
            },
          });
        if (args.includes('worktree') && args.includes('list') && (await Bun.file(release).exists())) {
          reconciling.resolve();
          await settle.promise;
        }
        return await run(program, args, options);
      };
      const launch = async () =>
        kind === 'start'
          ? await service.start({ folder: destination, by: 'owner' }, PERSON_ORIGIN)
          : await service.resume(id as never, undefined, { origin: PERSON_ORIGIN });
      const starts = fleet.runner.starts;
      const moving = w.apply(reviewed);
      try {
        await waitFor(() => Bun.file(entered).exists(), 'Git to pause after its checkout rename');
        const gitDir = (await readFile(path.join(destination, '.git'), 'utf8')).trim().slice('gitdir: '.length);
        expect((await readFile(path.join(gitDir, 'gitdir'), 'utf8')).trim()).toBe(path.join(w.target, '.git'));
        expect(await launch()).toMatchObject({ ok: false, error: { code: 'refused' } });
        expect(fleet.runner.starts).toBe(starts);
        await Bun.write(release, 'continue');
        await reconciling.promise;
        expect(await launch()).toMatchObject({ ok: false, error: { code: 'refused' } });
        expect(fleet.runner.starts).toBe(starts);
      } finally {
        await Bun.write(release, 'continue');
        settle.resolve();
        await moving;
      }
      expect((await moving).status).toBe(200);
      expect((await launch()).ok).toBe(true);
      expect(fleet.runner.starts).toBe(starts + 1);
      expect(await Bun.file(path.join(destination, 'README.md')).text()).toBe('# fixture\n');
    });

  test('the terminal exclusion stays held through the mutating Git process', async () => {
    let held = false;
    const w = await fixture('project-move-terminal-exclusion', undefined, async (_folder, move) => {
      held = true;
      try {
        return await move();
      } finally {
        held = false;
      }
    });
    const reviewed = await w.offer();
    const run = w.io.git.runBytes;
    let checked = false;
    w.io.git.runBytes = async (program, args, options) => {
      if (args.includes('move')) {
        expect(held).toBe(true);
        checked = true;
      }
      return await run(program, args, options);
    };
    expect((await w.apply(reviewed)).status).toBe(200);
    expect(checked).toBe(true);
    expect(held).toBe(false);
  });

  test('a newly committed HEAD between the two inspections invalidates confirmation', async () => {
    const w = await fixture('project-move-mid-commit');
    const reviewed = await w.offer();
    const run = w.io.git.runBytes;
    let statuses = 0;
    w.io.git.runBytes = async (program, args, options) => {
      const result = await run(program, args, options);
      if (args.includes('status') && ++statuses === 1)
        await setupGit(w.target, 'commit', '--allow-empty', '-m', 'feat: new work after inspection');
      return result;
    };
    const answer = await w.apply(reviewed);
    expect(answer.status).toBe(409);
    expect(JSON.stringify(answer.json)).toContain('reviewed checkout changed');
    expect(await Bun.file(path.join(w.target, 'README.md')).text()).toBe('# fixture\n');
  });

  test('a destination parent identity change immediately before Git refuses the move', async () => {
    const w = await fixture('project-move-parent-change');
    const reviewed = await w.offer();
    const realPath = w.io.fileSystem.realPath;
    let reads = 0;
    w.io.fileSystem.realPath = async folder => {
      const real = await realPath(folder);
      return folder === path.dirname(reviewed.destination!) && ++reads === 2 ? `${real}-changed` : real;
    };
    const answer = await w.apply(reviewed);
    expect(answer.status).toBe(409);
    expect(JSON.stringify(answer.json)).toContain('destination parent changed');
    expect(await Bun.file(path.join(w.target, 'README.md')).text()).toBe('# fixture\n');
  });

  test('even a tracked record incorrectly naming the main checkout cannot move it', async () => {
    const w = await fixture('project-move-tracked-main');
    const reviewed = await w.offer();
    changeRecord(w, record => ({ ...record, path: w.root }));
    expect((await w.apply(reviewed)).status).toBe(409);
    expect(await Bun.file(path.join(w.root, 'README.md')).text()).toBe('# fixture\n');
  });

  test('an interrupted intent with a replaced source keeps listing every other checkout', async () => {
    const w = await fixture('project-move-interrupted-replaced');
    const reviewed = await w.offer();
    w.state.armCrash();
    await expect(w.apply(reviewed)).rejects.toThrow('simulated crash');
    w.state.revive();
    changeRecord(w, record => ({
      ...record,
      pendingMove: {
        ...record.pendingMove!,
        identity: {
          ...record.pendingMove!.identity,
          checkout: '0:0',
        },
      },
    }));
    expect((await w.listing()).worktrees.find(row => row.path === w.target)?.move?.reason).toContain('needs repair');
    expect(await Bun.file(path.join(w.target, 'README.md')).text()).toBe('# fixture\n');
  });

  for (const changed of ['identity', 'owner', 'original', 'late-identity', 'late-owner'] as const)
    test(`recovery preserves both checkouts when the ${changed} changes`, async () => {
      const w = await fixture(`project-move-repair-${changed}`);
      const reviewed = await w.offer();
      const gitDir = (await setupGit(w.target, 'rev-parse', '--absolute-git-dir')).trim();
      const run = w.io.git.runBytes;
      w.io.git.runBytes = async (program, args, options) => {
        const result = await run(program, args, options);
        if (args.includes('move')) throw new Error('interrupted after rename');
        return result;
      };
      expect((await w.apply(reviewed)).status).toBe(409);
      const change = async () => {
        if (changed.includes('identity')) {
          await rename(reviewed.destination!, `${reviewed.destination!}-kept`);
          await mkdir(reviewed.destination!);
          for (const name of ['.git', 'README.md'])
            await Bun.write(
              path.join(reviewed.destination!, name),
              await Bun.file(path.join(`${reviewed.destination!}-kept`, name)).text(),
            );
        } else if (changed.includes('owner')) await Bun.write(path.join(gitDir, 'worktree-owner'), 'another-owner');
        else {
          await mkdir(w.target);
          await Bun.write(path.join(w.target, 'keep.txt'), 'new occupant');
        }
      };
      if (changed.startsWith('late')) {
        let injected = false;
        w.io.git.runBytes = async (program, args, options) => {
          const result = await run(program, args, options);
          if (!injected && args.includes('worktree') && args.includes('list')) {
            injected = true;
            await change();
          }
          return result;
        };
      } else await change();
      const retry = await w.apply(reviewed);
      expect(retry.status).toBe(409);
      expect(JSON.stringify(retry.json)).toContain(
        changed === 'original' ? 'occupied' : changed.includes('identity') ? 'identity' : 'marker',
      );
      expect((await w.listing()).worktrees.some(row => row.main)).toBe(true);
      expect(await Bun.file(path.join(reviewed.destination!, 'README.md')).text()).toBe('# fixture\n');
      if (changed.includes('identity'))
        expect(await Bun.file(path.join(`${reviewed.destination!}-kept`, 'README.md')).text()).toBe('# fixture\n');
      if (changed === 'original') expect(await Bun.file(path.join(w.target, 'keep.txt')).text()).toBe('new occupant');
    });

  for (const changed of ['adoption', 'marker', 'removal', 'detached', 'group'] as const)
    test(`refuses changed ${changed} evidence in both the offer and apply`, async () => {
      const w = await fixture(`project-move-evidence-${changed}`);
      const reviewed = await w.offer();
      if (changed === 'adoption')
        changeRecord(w, record => ({
          ...record,
          adoptionIdentity: { ...record.adoptionIdentity!, checkout: '0:0' },
        }));
      if (changed === 'marker') {
        const gitDir = (await setupGit(w.target, 'rev-parse', '--absolute-git-dir')).trim();
        await Bun.write(path.join(gitDir, 'worktree-owner'), 'another-owner');
      }
      if (changed === 'removal') changeRecord(w, record => ({ ...record, removalStartedAt: '2026-11-16T00:00:00Z' }));
      if (changed === 'detached') await setupGit(w.target, 'checkout', '--detach');
      if (changed === 'group')
        w.projects.set('project-1', { folder: w.root, commonDirectory: path.join(w.root, '.git') });
      expect((await w.offer()).reviewedIdentity).toBeUndefined();
      expect((await w.apply(reviewed)).status).toBe(409);
      expect(await Bun.file(path.join(w.target, 'README.md')).text()).toBe('# fixture\n');
    });

  for (const kind of ['start', 'resume'] as const)
    test(`a ferret ${kind} racing the Git move is refused before it can launch`, async () => {
      const fleet = await ferretWorld();
      const w = await fixture(`project-move-${kind}-race`, fleet.service);
      let id: string | undefined;
      if (kind === 'resume') {
        const started = await fleet.service.start({ folder: w.target, by: 'owner' }, PERSON_ORIGIN);
        if (!started.ok) throw new Error(started.error.reason);
        id = started.value;
        await fleet.service.stop(started.value, 'now');
      }
      const reviewed = await w.offer();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const run = w.io.git.runBytes;
      w.io.git.runBytes = async (program, args, options) => {
        if (args.includes('move')) {
          entered.resolve();
          await release.promise;
        }
        return await run(program, args, options);
      };
      const moving = w.apply(reviewed);
      try {
        await entered.promise;
        const result =
          kind === 'start'
            ? await fleet.service.start({ folder: w.target, by: 'owner' }, PERSON_ORIGIN)
            : await fleet.service.resume(id as never, undefined, { origin: PERSON_ORIGIN });
        expect(result).toMatchObject({ ok: false, error: { code: 'refused' } });
      } finally {
        release.resolve();
        await moving;
      }
      expect((await moving).status).toBe(200);
      expect(await Bun.file(path.join(reviewed.destination!, 'README.md')).text()).toBe('# fixture\n');
    });
  test('an actual Git metadata write failure keeps listing available and retries repair without losing data', async () => {
    const w = await fixture('project-move-half-renamed');
    const reviewed = await w.offer();
    const gitDir = (await setupGit(w.target, 'rev-parse', '--absolute-git-dir')).trim();
    const backPointer = path.join(gitDir, 'gitdir');
    const before = await setupGit(w.target, 'show-ref');
    const head = await readFile(path.join(gitDir, 'HEAD'), 'utf8');
    const run = w.io.git.runBytes;
    w.io.git.runBytes = async (program, args, options) => {
      if (args.includes('move')) await chmod(backPointer, 0o400);
      return await run(program, args, options);
    };
    try {
      expect((await w.apply(reviewed)).status).toBe(409);
      expect(await Bun.file(path.join(w.target, 'README.md')).exists()).toBe(false);
      expect(await Bun.file(path.join(reviewed.destination!, 'README.md')).text()).toBe('# fixture\n');
      const listing = await w.listing();
      expect(listing.worktrees.some(row => row.main)).toBe(true);
      expect(listing.worktrees.find(row => row.path === w.target)?.move?.reason).toContain('git worktree repair');
    } finally {
      await chmod(backPointer, 0o600);
    }
    expect((await w.apply(reviewed)).status).toBe(200);
    expect(await setupGit(reviewed.destination!, 'show-ref')).toBe(before);
    expect(await readFile(path.join(gitDir, 'HEAD'), 'utf8')).toBe(head);
    expect(await setupGit(reviewed.destination!, 'status', '--porcelain=v1')).toBe('');
    expect((await w.listing()).worktrees.find(row => row.path === reviewed.destination)?.tracked).toBe('adopted');
  });

  test('read-only project imports never authorize moving a tracked checkout or its Git metadata', async () => {
    const w = await fixture('project-move-read-only-authority');
    const reviewed = await w.offer();
    w.revokeWriteRoot();
    const offer = await w.offer();
    expect(offer.reviewedIdentity).toBeUndefined();
    expect(offer.reason).toContain('write authority');
    expect((await w.apply(reviewed)).status).toBe(409);
    expect(await Bun.file(path.join(w.target, 'README.md')).text()).toBe('# fixture\n');
    expect(await Bun.file(path.join(reviewed.destination!, 'README.md')).exists()).toBe(false);
  });
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
    w.revokeWriteRoot();
    expect((await w.listing()).worktrees.find(row => row.path === target)?.move?.reason).toContain('write authority');
    expect((await w.apply(move)).status).toBe(409);
    w.restoreWriteRoot();
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
    expect((await w.apply(move)).status).toBe(409);
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
