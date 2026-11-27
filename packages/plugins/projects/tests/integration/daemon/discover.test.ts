import { describe, expect, test } from 'bun:test';
import { type FerretId, FerretStarted, type FerretStartedPayload } from '@ferretry/core-ferrets/contract';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { owner, testHost } from '@ferretry/kernel/testing';
import type { ProjectInfo } from '../../../contract/index.ts';
import { implementProjects } from '../../../daemon/index.ts';
import { fakeMachine } from '../../unit/daemon/support.ts';

/** A synthetic machine: `/work/alpha` is a repository, `/work/alpha/src` a folder in it, `/work/alpha-wt` its linked worktree. */
const start = async (registered: readonly string[] = []) => {
  const machine = fakeMachine(['/work/alpha', '/work/alpha/src', '/work/alpha-wt', '/work/plain', '/work/other'], {
    '/work/alpha': '/work/alpha/.git',
    '/work/alpha/src': '/work/alpha/.git',
    '/work/alpha-wt': '/work/alpha/.git',
    '/work/other': '/work/other/.git',
  });
  // Ferrets' stand-in offers `ferret.started` and holds the kernel's hook invoker: a start is the kernel's own observe.
  const held: { observe?: (payload: FerretStartedPayload) => void } = {};
  const ferrets = implementDaemon(
    definePlugin({
      id: 'ferrets',
      title: 'Ferrets',
      version: '5.0.0',
      api: 5,
      core: true,
      kinds: [],
      hooks: { offers: [{ hook: FerretStarted }] },
    }),
    {
      build: ({ hooks }) => {
        held.observe = payload => hooks.observe(FerretStarted, payload);
        return {};
      },
    },
  );
  const host = await testHost({ plugins: [ferrets, implementProjects(machine)] });
  const list = async () => (await host.request('GET', '/v1/projects', { as: owner() })).json<ProjectInfo[]>();
  for (const path of registered)
    await host.request('POST', '/v1/projects', { body: { kind: 'existing-folder', path }, as: owner() });
  const started = async (folder: string) => {
    held.observe?.({ ferret: 'f1' as FerretId, name: 'worker', role: 'helper', folder, by: 'owner' });
    await host.settle();
  };
  return { list, started };
};

describe('a ferret starting in a repository nobody registered registers it (W-42)', () => {
  test('the repository appears once; starting again does not duplicate it', async () => {
    const { list, started } = await start();
    expect(await list()).toEqual([]);
    await started('/work/alpha');
    await started('/work/alpha');
    const projects = await list();
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ path: '/work/alpha', name: 'alpha', source: 'existing-folder' });
  });

  test('a ferret in a subfolder or a linked worktree registers the repository, not the place it stands', async () => {
    const { list, started } = await start();
    await started('/work/alpha/src');
    await started('/work/alpha-wt');
    expect((await list()).map(project => project.path)).toEqual(['/work/alpha']);
  });

  test('a registered repository is never overwritten: its record is exactly as it was', async () => {
    const { list, started } = await start(['/work/alpha']);
    const before = await list();
    await started('/work/alpha');
    await started('/work/alpha-wt');
    expect(await list()).toEqual(before);
  });

  test('a folder that is not a repository registers nothing; another repository is its own project', async () => {
    const { list, started } = await start(['/work/alpha']);
    await started('/work/plain');
    expect((await list()).map(project => project.path)).toEqual(['/work/alpha']);
    await started('/work/other');
    expect((await list()).map(project => project.path)).toEqual(['/work/alpha', '/work/other']);
  });
});
