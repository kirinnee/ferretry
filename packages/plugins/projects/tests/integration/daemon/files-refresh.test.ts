import { describe, expect, test } from 'bun:test';
import { FerretsChanged } from '@ferretry/core-ferrets/contract';
import { owner, testHost } from '@ferretry/kernel/testing';
import type { Instant } from '@ferretry/std';
import { type ProjectFilesAnswer, type ProjectInfo, ProjectRemoved } from '../../../contract/index.ts';
import type { ProjectIndex } from '../../../daemon/features/files/build.ts';
import { implementProjects } from '../../../daemon/index.ts';
import { fakeMachine } from '../../unit/daemon/support.ts';

const INDEX: ProjectIndex = {
  files: [{ path: 'README.md', name: 'README.md' }],
  summary: {
    builtAt: '2026-11-22T00:00:00.000Z' as Instant,
    indexed: 1,
    coverage: 'complete',
    skipped: [],
    biggestFolders: [],
    nestedWorktrees: [],
  },
};

/** One registered project and a fake Ferrets that says where each ferret works; every build is counted. */
const start = async () => {
  const built: string[] = [];
  const host = await testHost({
    plugins: [
      implementProjects(fakeMachine(['/work/alpha']), undefined, {
        build: async path => {
          built.push(path);
          return INDEX;
        },
        place: { home: async () => '/work', resolve: async path => path },
      }),
    ],
    uses: {
      ferrets: {
        get: async (ferret: string) =>
          ({ inside: { folder: '/work/alpha/src' }, outside: { folder: '/elsewhere' } })[
            ferret as 'inside' | 'outside'
          ],
      },
    },
  });
  const project = (
    await host.request('POST', '/v1/projects', {
      body: { kind: 'existing-folder', path: '/work/alpha' },
      as: owner(),
    })
  ).json<ProjectInfo>();
  const read = () => host.request('GET', `/v1/projects/${project.id}/files`, { as: owner() });
  return { host, id: project.id, built, read };
};

describe('the file index refreshes without a watcher (&F6061 U6)', () => {
  test('a ferret in the project ending its turn makes the next read rebuild; one elsewhere, or still working, does not', async () => {
    const { host, built, read } = await start();
    await read();
    expect(built).toHaveLength(1);

    host.emit(FerretsChanged, { ferret: 'outside', generation: 1, state: 'idle' });
    host.emit(FerretsChanged, { ferret: 'inside', generation: 2, state: 'working' });
    await host.settle();
    const unchanged = (await read()).json<ProjectFilesAnswer>();
    expect(unchanged.rebuilding).toBe(false);
    expect(built).toHaveLength(1);

    host.emit(FerretsChanged, { ferret: 'inside', generation: 3, state: 'idle' });
    await host.settle();
    const refreshed = (await read()).json<ProjectFilesAnswer>();
    await host.settle();

    expect(refreshed.rebuilding).toBe(true);
    expect(refreshed.files).toEqual([...INDEX.files]);
    expect(built).toHaveLength(2);
  });

  test('a removed project is forgotten: nothing of it is answered from memory when it is read again', async () => {
    const { host, id, built, read } = await start();
    await read();

    host.emit(ProjectRemoved, { id });
    await host.settle();
    await read();

    expect(built).toHaveLength(2);
  });
});
