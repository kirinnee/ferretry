import { afterAll, describe, it } from 'bun:test';
import { mkdir, rm, rename, symlink } from 'node:fs/promises';
import path from 'node:path';
import should from 'should';
import { WorktreesFile, type RepoWorktreeListResponse } from '../../../../contract/index.ts';
import { GitRepoWorktreeRows } from '../../../../daemon/adapters/worktrees/repo-git.ts';
import { KernelGitRunner } from '../../../../daemon/adapters/git/runner.ts';
import {
  GitWorktreeGateway,
  ManagedWorktreeAdapter,
  WorktreeOperationQueue,
} from '../../../../daemon/adapters/worktrees/index.ts';
import { RepoWorktreeLister } from '../../../../daemon/lib/worktrees/repo-list.ts';
import { WorktreeError } from '../../../../daemon/lib/worktrees/index.ts';
import { PosixSessionRootPinner, ProcfsSessionRootPinner } from '../../../support/daemon/session-filesystem/index.ts';
import { NodeWorktreeFileSystem, TestWorktreeClock, testGitRunner } from '../../../support/daemon/host-io.ts';
import { worktreeRouteWorld } from '../../../support/daemon/worktree-world.ts';
import { cleanupTempDirectories, setupGit, tempDirectory, tempRepository } from '../support/repository.ts';

/**
 * Listing every worktree of one repository against REAL Git on a synthetic repository: one Ferretry made (managed), one
 * made by hand elsewhere, one inside the repository, one detached, one locked and one whose folder was deleted by hand.
 */

const files = new NodeWorktreeFileSystem();
const clock = new TestWorktreeClock();
const readers: GitRepoWorktreeRows[] = [];

const adapter = (): ManagedWorktreeAdapter =>
  new ManagedWorktreeAdapter(
    new GitWorktreeGateway(testGitRunner(), files, clock),
    files,
    clock,
    new WorktreeOperationQueue(),
    process.platform === 'linux' ? new ProcfsSessionRootPinner() : new PosixSessionRootPinner(),
  );

const rowOf = (listing: RepoWorktreeListResponse, folder: string) => listing.worktrees.find(row => row.path === folder);

describe('the repository worktree list over real Git', () => {
  afterAll(async () => {
    for (const reader of readers) await reader.close();
    await cleanupTempDirectories();
  });

  it('should refuse an unauthorized, redirected or symlinked common directory before Git reads it', async () => {
    const world = await worktreeRouteWorld('repo-list-boundary');
    let gitReads = 0;
    const runBytes = world.io.git.runBytes;
    world.io.git.runBytes = async (...args) => {
      gitReads++;
      return await runBytes(...args);
    };
    const other = await tempRepository('repo-list-private');
    const commonDir = path.join(world.repository.root, '.git');
    const query = async (value: string) => await world.call('GET /v1/worktrees/repo', { query: { commonDir: value } });
    should((await query(path.join(other.root, '.git'))).status).equal(422);
    const link = path.join(world.repository.root, 'linked-metadata');
    await symlink(path.join(other.root, '.git'), link);
    should((await query(link)).status).equal(422);
    await Bun.write(path.join(commonDir, 'commondir'), path.join(other.root, '.git'));
    should((await query(commonDir)).status).equal(422);
    should(gitReads).equal(0);
  });

  it('should never label a replacement checkout from another repo as managed', async () => {
    const world = await worktreeRouteWorld('repo-list-replaced');
    const result = await world.call('POST /v1/worktrees', {
      body: { sourcePath: world.repository.root, branch: 'feature/replaced', sessionId: 'session-1' },
    });
    should(result.status).equal(200);
    const registry = JSON.parse(world.state.raw(WorktreesFile)!);
    const target = registry.worktrees[0].path as string;
    await rename(target, `${target}-old`);
    const other = await tempRepository('repo-list-replacement');
    const otherRoot = path.join(world.repository.root, 'other-repository');
    await rename(other.root, otherRoot);
    await setupGit(otherRoot, 'worktree', 'add', '-b', 'replacement', target);
    const answer = await world.call('GET /v1/worktrees/repo', {
      query: { commonDir: path.join(world.repository.root, '.git') },
    });
    should(answer.status).equal(200);
    const row = rowOf(answer.json as RepoWorktreeListResponse, target);
    should(row?.tracked).equal('none');
    should(row?.live.status).be.undefined();
    should(row?.live.undetermined.join(' ')).match(/identity|repository|common|may not reach/u);
  });

  it('should report undetermined without executing a configured clean filter during status or removal examine', async () => {
    const world = await worktreeRouteWorld('repo-list-filter');
    const root = world.repository.root;
    await Bun.write(path.join(root, '.gitattributes'), 'tracked.txt filter=marker\n');
    await Bun.write(path.join(root, 'tracked.txt'), 'before\n');
    await setupGit(root, 'add', '.gitattributes', 'tracked.txt');
    await setupGit(root, 'commit', '-m', 'tracked fixture');
    const created = await world.call('POST /v1/worktrees', {
      body: { sourcePath: root, branch: 'filter/shared-examine', sessionId: 'session-1' },
    });
    should(created.status).equal(200);
    const managedPath = JSON.parse(world.state.raw(WorktreesFile)!).worktrees[0].path as string;
    const marker = path.join(root, 'filter-executed');
    await setupGit(root, 'config', 'filter.marker.clean', `touch '${marker}'; cat`);
    await Bun.write(path.join(root, 'tracked.txt'), 'changed file content\n');
    await Bun.write(path.join(managedPath, 'tracked.txt'), 'changed managed content\n');
    const answer = await world.call('GET /v1/worktrees/repo', { query: { commonDir: path.join(root, '.git') } });
    should(answer.status).equal(200);
    should(await Bun.file(marker).exists()).equal(false);
    const row = rowOf(answer.json as RepoWorktreeListResponse, root);
    should(row?.live.status).be.undefined();
    should(row?.live.undetermined.join(' ')).match(/filter/u);
    const managed = await world.built.service.list();
    should(managed.worktrees[0]?.live?.status).be.undefined();
    should(managed.worktrees[0]?.live?.undetermined.join(' ')).match(/filter/u);
    should(await Bun.file(marker).exists()).equal(false);
  });

  it('should report the status of a detached dirty checkout', async () => {
    const world = await worktreeRouteWorld('repo-list-detached');
    const target = path.join(world.repository.root, 'detached');
    await setupGit(world.repository.root, 'worktree', 'add', '--detach', target);
    await Bun.write(path.join(target, 'untracked.txt'), 'dirty\n');
    const answer = await world.call('GET /v1/worktrees/repo', {
      query: { commonDir: path.join(world.repository.root, '.git') },
    });
    should(rowOf(answer.json as RepoWorktreeListResponse, target)?.live).match({
      detached: true,
      status: { untracked: true },
    });
  });

  it('should fail closed before status could run a filter in an unchecked submodule', async () => {
    const world = await worktreeRouteWorld('repo-list-submodule-filter');
    const submodule = await tempRepository('repo-list-submodule');
    await Bun.write(path.join(submodule.root, '.gitattributes'), 'README.md filter=marker\n');
    await setupGit(submodule.root, 'add', '.gitattributes');
    await setupGit(submodule.root, 'commit', '-m', 'submodule filter attribute');
    const root = world.repository.root;
    await setupGit(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', submodule.root, 'child');
    await setupGit(root, 'commit', '-m', 'submodule fixture');
    const marker = path.join(root, 'submodule-filter-executed');
    await setupGit(path.join(root, 'child'), 'config', 'filter.marker.clean', `touch '${marker}'; cat`);
    await Bun.write(path.join(root, 'child', 'README.md'), 'changed content\n');
    const answer = await world.call('GET /v1/worktrees/repo', { query: { commonDir: path.join(root, '.git') } });
    should(answer.status).equal(200);
    should(await Bun.file(marker).exists()).equal(false);
    const row = rowOf(answer.json as RepoWorktreeListResponse, root);
    should(row?.live.status).be.undefined();
    should(row?.live.undetermined.join(' ')).match(/submodule filter safety/u);
  });

  it('should read a registry snapshot without reconciling unrelated entries or waiting for mutations', async () => {
    const world = await worktreeRouteWorld('repo-list-snapshot');
    const created = await world.call('POST /v1/worktrees', {
      body: { sourcePath: world.repository.root, branch: 'feature/snapshot', sessionId: 'session-1' },
    });
    should(created.status).equal(200);
    const registry = JSON.parse(world.state.raw(WorktreesFile)!);
    await rm(registry.worktrees[0].path, { recursive: true, force: true });
    registry.worktrees[0].removalStartedAt = '2026-11-16T00:00:00.000Z';
    world.state.plant(WorktreesFile, JSON.stringify(registry));
    const before = world.state.raw(WorktreesFile);
    const answer = await world.call('GET /v1/worktrees/repo', {
      query: { commonDir: path.join(world.repository.root, '.git') },
    });
    should(answer.status).equal(200);
    should(world.state.raw(WorktreesFile)).equal(before);
  });

  it('should list managed, hand-made, detached, locked and missing worktrees with live state', async () => {
    // Arrange
    const world = await worktreeRouteWorld('repo-list');
    const repository = world.repository;
    const reader = new GitRepoWorktreeRows(new KernelGitRunner(world.io.git), world.io.repoAccess);
    readers.push(reader);
    const managedRoot = path.join(await tempDirectory('repo-list-managed'), 'worktrees');
    const away = await tempDirectory('repo-list-away');
    const created = await adapter().create({
      sourceCwd: repository.root,
      branch: 'feature/managed',
      sessionId: 'session-1',
      ownershipToken: 'ownership-token-0001',
      managedRoot,
    });
    const handMade = path.join(away, 'hand-made');
    const detached = path.join(away, 'detached');
    const locked = path.join(away, 'locked');
    const gone = path.join(away, 'gone');
    await setupGit(repository.root, 'worktree', 'add', '-b', 'hand/made', handMade);
    await setupGit(repository.root, 'worktree', 'add', '--detach', detached);
    await setupGit(repository.root, 'worktree', 'add', '-b', 'to/lock', locked);
    await setupGit(repository.root, 'worktree', 'lock', '--reason', 'review in progress', locked);
    await setupGit(repository.root, 'worktree', 'add', '-b', 'to/vanish', gone);
    await rm(gone, { recursive: true, force: true });
    await Bun.write(path.join(handMade, 'scratch.txt'), 'untracked\n');
    const lister = new RepoWorktreeLister({
      rows: async dir => await reader.rows(dir),
      examine: async input => await adapter().examine(input),
      records: async () => [
        {
          path: created.managed.path,
          branch: created.managed.branch,
          repositoryRoot: created.managed.repositoryRoot,
          commonDirectory: created.managed.commonDir,
          relativeCwd: '',
          createdAt: created.managed.createdAt,
          initialHead: created.managed.initialHead,
          branchPreexisted: false,
        },
      ],
      sessions: async () => [{ id: 'F-hand', cwd: handMade, status: 'running' }],
      managedRoot,
      clock: { nowMs: () => Date.now(), sleep: async ms => await Bun.sleep(ms) },
    });

    // Act
    const listing = await lister.list(path.join(repository.root, '.git'));

    // Assert
    const real = async (folder: string) => await files.realPath(folder);
    should(listing).match({ total: 6, truncated: false });
    should(listing.worktrees[0]).match({ path: repository.root, main: true, tracked: 'none' });
    should(rowOf(listing, created.managed.path)).match({
      tracked: 'managed',
      main: false,
      live: { branch: 'feature/managed', detached: false },
    });
    const hand = rowOf(listing, await real(handMade));
    should(hand).match({ tracked: 'none', live: { branch: 'hand/made', status: { untracked: true } } });
    should(hand?.ferrets).eql([{ id: 'F-hand', active: true }]);
    should(rowOf(listing, await real(detached))?.live).match({ detached: true });
    should(rowOf(listing, await real(locked))?.live).match({ locked: 'review in progress' });
    const missing = listing.worktrees.find(row => row.path.endsWith('/gone'));
    should(missing?.live.prunable).be.a.String();
    should(missing?.live.undetermined.join(' ')).match(/could not be inspected/u);
  });

  it('should refuse anything that is not an existing git common directory', async () => {
    // Arrange
    const world = await worktreeRouteWorld('repo-list-refuse');
    const repository = world.repository;
    const away = await tempDirectory('repo-list-refuse-away');
    await setupGit(repository.root, 'worktree', 'add', '-b', 'linked', path.join(away, 'linked'));
    const rows = new GitRepoWorktreeRows(new KernelGitRunner(world.io.git), world.io.repoAccess);
    readers.push(rows);
    const plain = await tempDirectory('repo-list-plain');
    const linkedGitDir = path.join(repository.root, '.git', 'worktrees', 'linked');

    // Act
    const refusals = await Promise.all(
      [
        'relative/.git',
        '',
        plain,
        repository.root,
        linkedGitDir,
        path.join(repository.root, '.git', 'objects'),
        path.join(repository.root, 'no-such-dir', '.git'),
      ].map(async value => await rows.rows(value).catch((error: unknown) => error)),
    );

    // Assert
    for (const refusal of refusals)
      should(refusal).be.instanceOf(WorktreeError).and.match({ code: 'invalid_common_directory' });
  });

  it('should accept the common directory of a repository from outside any of its folders', async () => {
    // Arrange
    const world = await worktreeRouteWorld('repo-list-ok');
    const repository = world.repository;
    const rows = new GitRepoWorktreeRows(new KernelGitRunner(world.io.git), world.io.repoAccess);
    readers.push(rows);

    // Act
    const actual = await rows.rows(path.join(repository.root, '.git'));

    // Assert
    should(actual).have.length(1);
    should(actual[0]).match({ path: repository.root, branch: 'main', bare: false });
  });

  it('should answer through the route over the real roots, saying what lies outside the fence instead of inventing it', async () => {
    // Arrange
    const world = await worktreeRouteWorld('repo-list-route');
    const created = await world.call('POST /v1/worktrees', {
      body: { sourcePath: world.repository.root, branch: 'feature/route', sessionId: 'session-1' },
    });
    should(created.status).equal(200);
    const inside = path.join(world.repository.root, '.worktrees', 'inside');
    await mkdir(path.dirname(inside), { recursive: true });
    await setupGit(world.repository.root, 'worktree', 'add', '-b', 'inside/branch', inside);
    const outside = path.join(await tempDirectory('repo-list-route-away'), 'outside');
    await setupGit(world.repository.root, 'worktree', 'add', '-b', 'outside/branch', outside);

    // Act
    const answer = await world.call('GET /v1/worktrees/repo', {
      query: { commonDir: path.join(world.repository.root, '.git') },
    });

    // Assert
    should(answer.status).equal(200);
    const listing = answer.json as RepoWorktreeListResponse;
    should(listing.worktrees.map(row => row.tracked).sort()).eql(['managed', 'none', 'none', 'none']);
    should(rowOf(listing, await files.realPath(inside))?.live.status).not.be.undefined();
    const unreachable = rowOf(listing, await files.realPath(outside));
    should(unreachable?.live.branch).equal('outside/branch');
    should(unreachable?.live.status).be.undefined();
    should(unreachable?.live.undetermined.join(' ')).match(/may not reach/u);
  });

  it('should refuse a route call whose commonDir is not a git common directory, with the contract status and code', async () => {
    // Arrange
    const world = await worktreeRouteWorld('repo-list-route-refuse');

    // Act
    const relative = await world.call('GET /v1/worktrees/repo', { query: { commonDir: 'repo/.git' } });
    const folder = await world.call('GET /v1/worktrees/repo', { query: { commonDir: world.repository.root } });
    const missing = await world.call('GET /v1/worktrees/repo', {});

    // Assert
    should(relative).match({ status: 422, json: { code: 'invalid_common_directory' } });
    should(folder).match({ status: 422, json: { code: 'invalid_common_directory' } });
    should(missing).match({ status: 400, json: { code: 'invalid_common_directory' } });
  });
});
