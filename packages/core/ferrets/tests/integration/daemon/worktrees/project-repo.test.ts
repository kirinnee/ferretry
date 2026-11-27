import { afterAll, describe, it } from 'bun:test';
import path from 'node:path';
import should from 'should';
import type { ProjectRepository, RepoWorktreeListResponse } from '../../../../contract/index.ts';
import { worktreeRouteWorld } from '../../../support/daemon/worktree-world.ts';
import { cleanupTempDirectories, setupGit, tempDirectory, tempRepository } from '../support/repository.ts';

/**
 * R2-1 (PR 2654): the repository worktree list for a REGISTERED project, on a daemon with NO ferret standing in the
 * repository. The client names the project by id; the directory is the one the daemon's own registry recorded. A path
 * nobody registered stays refused.
 */

const rows = (answer: { readonly json: unknown }) => (answer.json as RepoWorktreeListResponse).worktrees;
const branches = (answer: { readonly json: unknown }): string[] =>
  rows(answer)
    .map(row => row.live.branch ?? '')
    .sort();

/** A daemon with no ferret anywhere and a project registry the test fills once it knows the folders. */
const daemon = async (label: string) => {
  const projects = new Map<string, ProjectRepository>();
  const world = await worktreeRouteWorld(label, undefined, undefined, { ferret: false, projects });
  return { world, projects };
};

describe('GET /v1/worktrees/repo for a registered project', () => {
  afterAll(cleanupTempDirectories);

  it('should list main and the linked branch for the project that is the MAIN checkout', async () => {
    const { world, projects } = await daemon('proj-main');
    const root = world.repository.root;
    const linked = path.join(await tempDirectory('proj-main-linked'), 'checkout');
    await setupGit(root, 'worktree', 'add', '-b', 'feat/linked', linked);
    projects.set('p1', { folder: root, commonDirectory: path.join(root, '.git') });
    const answer = await world.call('GET /v1/worktrees/repo', { query: { project: 'p1' } });
    should(answer.status).equal(200);
    should(rows(answer)).have.length(2);
    should(branches(answer)).containEql('feat/linked');
  });

  it('should list main and the linked branch for the project that is a LINKED checkout', async () => {
    const { world, projects } = await daemon('proj-linked');
    const main = world.repository.root;
    const linked = path.join(await tempDirectory('proj-linked-checkout'), 'checkout');
    await setupGit(main, 'worktree', 'add', '-b', 'feat/linked', linked);
    projects.set('p2', { folder: linked, commonDirectory: path.join(main, '.git') });
    const answer = await world.call('GET /v1/worktrees/repo', { query: { project: 'p2' } });
    should(answer.status).equal(200);
    should(rows(answer)).have.length(2);
    should(branches(answer)).containEql('feat/linked');
  });

  it('should still refuse a path nobody registered, however it is named', async () => {
    const stranger = await tempRepository('proj-stranger');
    const { world } = await daemon('proj-refuse');
    const raw = await world.call('GET /v1/worktrees/repo', { query: { commonDir: path.join(stranger.root, '.git') } });
    should(raw.status).equal(422);
    const unknown = await world.call('GET /v1/worktrees/repo', { query: { project: 'no-such-project' } });
    should(unknown.status).equal(422);
  });

  it('should open no path beside a registered project: a raw path stays 422 and a path with a project is 400', async () => {
    const other = await tempRepository('proj-other');
    const { world, projects } = await daemon('proj-beside');
    const own = path.join(world.repository.root, '.git');
    projects.set('p3', { folder: world.repository.root, commonDirectory: own });
    const both = await world.call('GET /v1/worktrees/repo', {
      query: { project: 'p3', commonDir: path.join(other.root, '.git') },
    });
    should(both.status).equal(400);
    should(
      (await world.call('GET /v1/worktrees/repo', { query: { commonDir: path.join(other.root, '.git') } })).status,
    ).equal(422);
    // Not even the registered project's own directory is reachable by raw path: only the project id opens it.
    should((await world.call('GET /v1/worktrees/repo', { query: { commonDir: own } })).status).equal(422);
  });
});
