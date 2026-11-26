import { afterAll, describe, it } from 'bun:test';
import path from 'node:path';
import { mkdir, rename } from 'node:fs/promises';
import should from 'should';
import { WorktreesFile, type CreatedWorktree, type RepoWorktreeListResponse } from '../../../../contract/index.ts';
import { worktreeRouteWorld } from '../../../support/daemon/worktree-world.ts';
import { KernelGitRunner } from '../../../../daemon/adapters/git/runner.ts';
import { InPlaceWorktrees } from '../../../../daemon/adapters/worktrees/in-place.ts';
import {
  GitWorktreeGateway,
  KernelWorktreeClock,
  ManagedWorktreeAdapter,
  WorktreeOperationQueue,
} from '../../../../daemon/adapters/worktrees/index.ts';
import { cleanupTempDirectories, setupGit, tempRepository } from '../support/repository.ts';

async function fixture(label: string) {
  const world = await worktreeRouteWorld(label);
  const target = path.join(world.repository.root, 'hand-made');
  await setupGit(world.repository.root, 'worktree', 'add', '-b', 'adopt/me', target);
  return { ...world, target };
}

describe('adopt in place through the real roots and Git', () => {
  afterAll(cleanupTempDirectories);

  it('should refuse relative or non-canonical paths and detached checkouts without writing ownership', async () => {
    const world = await fixture('adopt-invalid-target');
    for (const target of ['relative/checkout', `${world.target}/../hand-made`]) {
      should((await world.call('POST /v1/worktrees/adopt', { body: { path: target } })).status).equal(409);
    }
    const detached = path.join(world.repository.root, 'detached');
    await setupGit(world.repository.root, 'worktree', 'add', '--detach', detached);
    should((await world.call('POST /v1/worktrees/adopt', { body: { path: detached } })).status).equal(409);
    should(world.state.raw(WorktreesFile)).be.undefined();
  });

  it('should refuse a checkout that disappears between metadata authorization and Git enumeration', async () => {
    const world = await fixture('adopt-disappeared');
    const discover = world.io.repoAccess.commonDirectory;
    world.io.repoAccess.commonDirectory = async folder => {
      const common = await discover(folder);
      await setupGit(world.repository.root, 'worktree', 'remove', world.target);
      return common;
    };
    should((await world.call('POST /v1/worktrees/adopt', { body: { path: world.target } })).status).equal(409);
    should(world.state.raw(WorktreesFile)).be.undefined();
  });

  it('should recheck the state-home fence after recording intent and before writing a marker', async () => {
    const world = await fixture('adopt-late-fence');
    const clock = new KernelWorktreeClock(world.clock);
    const runner = new KernelGitRunner(world.io.git);
    const base = new ManagedWorktreeAdapter(
      new GitWorktreeGateway(runner, world.io.fileSystem, clock),
      world.io.fileSystem,
      clock,
      new WorktreeOperationQueue(),
      world.io.pinner,
    );
    let checks = 0;
    let planned = 0;
    const subject = new InPlaceWorktrees(base, runner, world.io.repoAccess, world.io.fileSystem, clock, async () =>
      ++checks === 1 ? undefined : '/synthetic/state-home',
    );
    await should(
      subject.adoptExisting(world.target, 'synthetic-owner-token', async () => {
        planned++;
      }),
    ).be.rejectedWith(/state home/);
    should(planned).equal(1);
    const gitDir = (await setupGit(world.target, 'rev-parse', '--absolute-git-dir')).trim();
    should(await Bun.file(path.join(gitDir, 'worktree-owner')).exists()).equal(false);
  });

  it('should keep unreadable adopted repositories visible but never removable or silently re-owned', async () => {
    const world = await fixture('adopt-unreadable');
    should((await world.call('POST /v1/worktrees/adopt', { body: { path: world.target } })).status).equal(200);
    await rename(path.join(world.repository.root, '.git'), path.join(world.repository.root, '.git-away'));
    const list = await world.built.service.list();
    should(list.worktrees[0]).match({
      origin: 'adopted',
      removal: { removable: false, blockers: [{ code: 'undetermined_evidence' }] },
    });
    should((await world.call('POST /v1/worktrees/adopt', { body: { path: world.target } })).status).equal(409);
    should(JSON.parse(world.state.raw(WorktreesFile)!).worktrees).have.length(1);
  });

  it('should preserve ordinary managed creation, crash recovery, inspection and removal', async () => {
    const world = await worktreeRouteWorld('adopt-managed-delegation');
    const writeText = world.io.fileSystem.writeText;
    world.io.fileSystem.writeText = async (...args) => {
      await writeText(...args);
      throw new Error('synthetic managed-creation crash');
    };
    await world
      .call('POST /v1/worktrees', {
        body: { sourcePath: world.repository.root, branch: 'managed/recovery', sessionId: 'session-1' },
      })
      .should.be.rejectedWith(/managed-creation crash/);
    const list = await world.built.service.list();
    const target = list.worktrees[0]!.path;
    should(list.worktrees[0]?.origin).be.undefined();
    const registry = JSON.parse(world.state.raw(WorktreesFile)!);
    registry.worktrees[0].removalStartedAt = '2026-11-16T00:00:00.000Z';
    world.state.plant(WorktreesFile, JSON.stringify(registry));
    await world.built.service.list();
    should(JSON.parse(world.state.raw(WorktreesFile)!).worktrees[0].removalStartedAt).be.undefined();
    const removed = await world.call('POST /v1/worktrees/remove', {
      body: {
        path: target,
        overrides: ['accept_unpushed_commits'],
        deleteBranch: false,
        confirmations: [],
      },
    });
    should(removed.status).equal(200);
  });

  it('should never recover a replacement checkout merely because it inherited the matching marker', async () => {
    const world = await fixture('adopt-crash-replaced');
    const writeText = world.io.fileSystem.writeText;
    const gitPointer = await Bun.file(path.join(world.target, '.git')).text();
    world.io.fileSystem.writeText = async (...args) => {
      await writeText(...args);
      await rename(world.target, `${world.target}-old`);
      await mkdir(world.target);
      await Bun.write(path.join(world.target, '.git'), gitPointer);
      await Bun.write(path.join(world.target, 'keep.txt'), 'foreign checkout\n');
      throw new Error('synthetic crash after replacement');
    };
    await world
      .call('POST /v1/worktrees/adopt', { body: { path: world.target } })
      .should.be.rejectedWith(/synthetic crash/);
    const retry = await world.call('POST /v1/worktrees/adopt', { body: { path: world.target } });
    should(retry.status).equal(409);
    should(JSON.parse(world.state.raw(WorktreesFile)!).worktrees).eql([]);
    should(await Bun.file(path.join(world.target, 'keep.txt')).text()).equal('foreign checkout\n');
  });

  for (const recover of [false, true]) {
    it(`should refuse a replacement with matching metadata after ${recover ? 'recovered' : 'successful'} adoption`, async () => {
      const world = await fixture(`adopt-settled-replacement-${recover}`);
      const writeText = world.io.fileSystem.writeText;
      if (recover) {
        world.io.fileSystem.writeText = async (...args) => {
          await writeText(...args);
          throw new Error('synthetic crash after marker');
        };
        await world
          .call('POST /v1/worktrees/adopt', { body: { path: world.target } })
          .should.be.rejectedWith(/synthetic crash/);
        world.io.fileSystem.writeText = writeText;
      }
      should((await world.call('POST /v1/worktrees/adopt', { body: { path: world.target } })).status).equal(200);
      const original = `${world.target}-original`;
      const pointer = await Bun.file(path.join(world.target, '.git')).text();
      const content = await Bun.file(path.join(world.target, 'README.md')).text();
      await rename(world.target, original);
      await mkdir(world.target);
      await Bun.write(path.join(world.target, '.git'), pointer);
      await Bun.write(path.join(world.target, 'README.md'), content);

      // The replacement is clean and points to the SAME metadata and ownership marker. Only the persisted
      // checkout identity distinguishes it; Git's ordinary cleanliness and ownership checks all accept it.
      const removed = await world.call('POST /v1/worktrees/remove', {
        body: { path: world.target, overrides: ['accept_unpushed_commits'], deleteBranch: false, confirmations: [] },
      });
      should(removed.status).equal(409);
      should(await Bun.file(path.join(world.target, 'README.md')).text()).equal(content);
      should(await Bun.file(path.join(original, 'README.md')).text()).equal(content);
      const registry = JSON.parse(world.state.raw(WorktreesFile)!);
      should(registry.format).equal(1);
      should(registry.intents).eql([]);
      should(registry.worktrees[0].removedAt).be.undefined();
      should(registry.worktrees[0].adoptionIdentity.checkout).match(/^\d+:\d+$/);
    });
  }

  it('should retain the pre-existing branch unless its separate deletion confirmations are supplied', async () => {
    const world = await fixture('adopt-delete-branch');
    should((await world.call('POST /v1/worktrees/adopt', { body: { path: world.target } })).status).equal(200);
    const removed = await world.call('POST /v1/worktrees/remove', {
      body: {
        path: world.target,
        overrides: ['accept_unpushed_commits'],
        deleteBranch: true,
        confirmations: ['delete_preexisting_branch', 'delete_unpushed_branch', 'delete_unmerged_branch'],
      },
    });
    should(removed).match({ status: 200, json: { branchRetained: false } });
    should((await setupGit(world.repository.root, 'branch', '--list', 'adopt/me')).trim()).equal('');
  });

  it('should keep an interrupted adoption unresolved when its marker no longer matches', async () => {
    const world = await fixture('adopt-crash-foreign');
    const writeText = world.io.fileSystem.writeText;
    world.io.fileSystem.writeText = async (...args) => {
      await writeText(...args);
      await Bun.write(args[0], 'foreign-marker');
      throw new Error('synthetic crash with replaced marker');
    };
    await world
      .call('POST /v1/worktrees/adopt', { body: { path: world.target } })
      .should.be.rejectedWith(/synthetic crash/);
    const retry = await world.call('POST /v1/worktrees/adopt', { body: { path: world.target } });
    should(retry.status).equal(409);
    const registry = JSON.parse(world.state.raw(WorktreesFile)!);
    should(registry.worktrees).eql([]);
    should(registry.intents).have.length(1);
    should(await Bun.file(path.join(registry.intents[0].gitDir, 'worktree-owner')).text()).equal('foreign-marker');
  });

  it('should preserve a foreign folder swapped in after the final removal pin', async () => {
    const world = await fixture('adopt-final-pin');
    should((await world.call('POST /v1/worktrees/adopt', { body: { path: world.target } })).status).equal(200);
    const run = world.io.git.runBytes;
    let swapped = false;
    world.io.git.runBytes = async (program, args, options) => {
      if (!swapped && args.includes('remove')) {
        swapped = true;
        await rename(world.target, `${world.target}-old`);
        await mkdir(world.target);
        await Bun.write(path.join(world.target, 'keep.txt'), 'belongs to somebody else\n');
      }
      return await run(program, args, options);
    };
    await world
      .call('POST /v1/worktrees/remove', {
        body: {
          path: world.target,
          overrides: ['accept_unpushed_commits'],
          deleteBranch: false,
          confirmations: [],
        },
      })
      .catch(() => undefined);
    should(swapped).equal(true);
    should(await Bun.file(path.join(world.target, 'keep.txt')).text()).equal('belongs to somebody else\n');
  });

  it('should reject unauthorized repositories and the state home before running Git', async () => {
    const world = await fixture('adopt-boundary');
    const other = await tempRepository('adopt-private');
    const outside = path.join(other.root, 'linked');
    await setupGit(other.root, 'worktree', 'add', '-b', 'private', outside);
    let reads = 0;
    const run = world.io.git.runBytes;
    world.io.git.runBytes = async (...args) => {
      reads++;
      return await run(...args);
    };
    const privateResult = await world.call('POST /v1/worktrees/adopt', { body: { path: outside } });
    should(privateResult.status).equal(422);
    const stateResult = await world.call('POST /v1/worktrees/adopt', {
      body: { path: path.join(world.parent, 'home', 'linked') },
    });
    should(stateResult.status).equal(409);
    should(reads).equal(0);
  });

  it('should never execute a checkout filter while adopting or checking removal', async () => {
    const world = await fixture('adopt-filter');
    const marker = path.join(world.repository.root, 'filter-executed');
    await setupGit(world.target, 'config', 'filter.marker.clean', `touch '${marker}'; cat`);
    await Bun.write(path.join(world.target, '.gitattributes'), 'README.md filter=marker\n');
    await Bun.write(path.join(world.target, 'README.md'), 'changed\n');
    const adopted = await world.call('POST /v1/worktrees/adopt', { body: { path: world.target } });
    should(adopted.status).equal(200);
    const live = (adopted.json as CreatedWorktree).worktree.live;
    should(live?.status).be.undefined();
    should(live?.undetermined.join(' ')).match(/filter/u);
    const remove = await world.call('POST /v1/worktrees/remove', {
      body: {
        path: world.target,
        overrides: ['discard_worktree_changes', 'accept_unpushed_commits'],
        deleteBranch: false,
        confirmations: [],
      },
    });
    should(remove.status).equal(409);
    should(await Bun.file(marker).exists()).equal(false);
  });

  it('should adopt outside the managed root, label it adopted, and remove with the existing loss checks', async () => {
    const world = await fixture('adopt-remove');
    const adopted = await world.call('POST /v1/worktrees/adopt', { body: { path: world.target } });
    should(adopted.status).equal(200);
    should((adopted.json as CreatedWorktree).worktree).match({
      origin: 'adopted',
      path: world.target,
      branchPreexisted: true,
    });
    const document = JSON.parse(world.state.raw(WorktreesFile)!);
    should(document.format).equal(1);
    should(document.intents).eql([]);
    const listing = await world.call('GET /v1/worktrees/repo', {
      query: { commonDir: path.join(world.repository.root, '.git') },
    });
    should((listing.json as RepoWorktreeListResponse).worktrees.find(row => row.path === world.target)?.tracked).equal(
      'adopted',
    );
    const removed = await world.call('POST /v1/worktrees/remove', {
      body: { path: world.target, overrides: ['accept_unpushed_commits'], deleteBranch: false, confirmations: [] },
    });
    should(removed.status).equal(200);
    should(await Bun.file(path.join(world.target, '.git')).exists()).equal(false);
    should((await setupGit(world.repository.root, 'branch', '--list', 'adopt/me')).trim()).equal('adopt/me');
  });

  it('should recover a crash between the exclusive marker and the final registry row', async () => {
    const world = await fixture('adopt-crash');
    const writeText = world.io.fileSystem.writeText;
    world.io.fileSystem.writeText = async (...args) => {
      await writeText(...args);
      throw new Error('synthetic crash after marker');
    };
    await world
      .call('POST /v1/worktrees/adopt', { body: { path: world.target } })
      .should.be.rejectedWith(/synthetic crash/);
    const interrupted = JSON.parse(world.state.raw(WorktreesFile)!);
    should(interrupted.worktrees).eql([]);
    should(interrupted.intents[0]).match({ origin: 'adopted', path: world.target });
    const retry = await world.call('POST /v1/worktrees/adopt', { body: { path: world.target } });
    should(retry.status).equal(200);
    should((retry.json as CreatedWorktree).worktree).match({ origin: 'adopted', path: world.target });
    should(JSON.parse(world.state.raw(WorktreesFile)!).intents).eql([]);
  });

  it('should refuse the main checkout and a foreign ownership marker without recording or overwriting them', async () => {
    const world = await fixture('adopt-refuse');
    const main = await world.call('POST /v1/worktrees/adopt', { body: { path: world.repository.root } });
    should(main.status).not.equal(200);
    const gitDir = (await setupGit(world.target, 'rev-parse', '--absolute-git-dir')).trim();
    const marker = path.join(gitDir, 'worktree-owner');
    await Bun.write(marker, 'foreign-marker');
    const foreign = await world.call('POST /v1/worktrees/adopt', { body: { path: world.target } });
    should(foreign.status).equal(409);
    should(await Bun.file(marker).text()).equal('foreign-marker');
    should(world.state.raw(WorktreesFile)).be.undefined();
  });

  it('should refuse removal when the adopted marker is replaced', async () => {
    const world = await fixture('adopt-marker');
    should((await world.call('POST /v1/worktrees/adopt', { body: { path: world.target } })).status).equal(200);
    const record = JSON.parse(world.state.raw(WorktreesFile)!).worktrees[0];
    await Bun.write(path.join(record.gitDir, 'worktree-owner'), 'foreign-marker');
    const removed = await world.call('POST /v1/worktrees/remove', {
      body: { path: world.target, overrides: ['accept_unpushed_commits'], deleteBranch: false, confirmations: [] },
    });
    should(removed).match({ status: 409 });
    should(await Bun.file(path.join(world.target, '.git')).exists()).equal(true);
  });
});
