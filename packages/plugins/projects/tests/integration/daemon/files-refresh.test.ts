import { describe, expect, test } from 'bun:test';
import { FerretsChanged } from '@ferretry/core-ferrets/contract';
import { owner, testHost } from '@ferretry/kernel/testing';
import type { Instant } from '@ferretry/std';
import { type ProjectFilesAnswer, type ProjectInfo, ProjectRemoved } from '../../../contract/index.ts';
import type { ProjectIndex } from '../../../daemon/features/files/build.ts';
import type { FolderBrowser } from '../../../daemon/features/folders/port.ts';
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

/** A machine whose home is /work and whose only repository is `app` once `repos.found` is true (a scan then finds it). */
const scanning = (repos: { found: boolean }): FolderBrowser => ({
  home: async () => '/work',
  holdsSignIn: async () => false,
  leaf: async () => 'present',
  realPaths: async paths => [...paths],
  open: async (path, verdict) => {
    if ((await verdict(path)) !== undefined) return { ok: false, reason: 'refused' };
    return {
      ok: true,
      folder: {
        real: path,
        entries: async () => ({
          entries:
            path === '/work/alpha' && repos.found
              ? [{ name: 'app', kind: 'directory' as const, modified: '2026-11-19T00:00:00.000Z' as Instant }]
              : [],
          more: false,
        }),
        lookup: async () => 'missing',
        readText: async () => '[remote "origin"]\n\turl = https://github.com/o/app.git\n',
        hasGit: async name => name === 'app',
        device: async () => 'd1',
        makeLeaf: async () => ({ kind: 'failed' }),
        close: async () => undefined,
      },
    };
  },
});

describe('what names a folder again or changes what it holds refreshes the file index (&F6061 U6 review R1)', () => {
  test('registering the same folder again keeps its idempotent answer and event, yet the next read rebuilds', async () => {
    const { host, id, built, read } = await start();
    await read();
    const announced = () => host.published.filter(event => event.event === 'projects.registered').length;
    const before = announced();

    const again = await host.request('POST', '/v1/projects', {
      body: { kind: 'existing-folder', path: '/work/alpha' },
      as: owner(),
    });
    await host.settle();
    const refreshed = (await read()).json<ProjectFilesAnswer>();
    await host.settle();

    expect(again.json<ProjectInfo>().id).toBe(id);
    expect(announced()).toBe(before); // the repeat announces nothing: it is still one registration
    expect(refreshed.rebuilding).toBe(true);
    expect(built).toHaveLength(2);
  });

  test('a ferret idle in a link that resolves to the registered folder refreshes that project (alias, through the place)', async () => {
    const built: string[] = [];
    const host = await testHost({
      plugins: [
        implementProjects(fakeMachine(['/work/alpha', '/work/beta']), undefined, {
          build: async path => {
            built.push(path);
            return INDEX;
          },
          place: {
            home: async () => '/work',
            resolve: async path => (path === '/work/alpha/link' ? '/work/beta' : path),
          },
        }),
      ],
      uses: { ferrets: { get: async () => ({ folder: '/work/alpha/link' }) } },
    });
    const ids: Record<string, string> = {};
    for (const name of ['alpha', 'beta'])
      ids[name] = (
        await host.request('POST', '/v1/projects', {
          body: { kind: 'existing-folder', path: `/work/${name}` },
          as: owner(),
        })
      ).json<ProjectInfo>().id;
    const read = async (name: string) =>
      (await host.request('GET', `/v1/projects/${ids[name]}/files`, { as: owner() })).json<ProjectFilesAnswer>();
    await read('alpha');
    await read('beta');

    host.emit(FerretsChanged, { ferret: 'x', generation: 1, state: 'idle' });
    await host.settle();

    expect((await read('alpha')).rebuilding).toBe(false);
    expect((await read('beta')).rebuilding).toBe(true);
  });

  test('a repo scan that changes the list refreshes the index; one that changes nothing does not', async () => {
    const repos = { found: false };
    const built: string[] = [];
    const host = await testHost({
      plugins: [
        implementProjects(
          fakeMachine(['/work/alpha']),
          { browser: scanning(repos) },
          {
            build: async path => {
              built.push(path);
              return INDEX;
            },
            place: { home: async () => '/work', resolve: async path => path },
          },
        ),
      ],
    });
    const id = (
      await host.request('POST', '/v1/projects', {
        body: { kind: 'existing-folder', path: '/work/alpha' },
        as: owner(),
      })
    ).json<ProjectInfo>().id;
    const read = async () =>
      (await host.request('GET', `/v1/projects/${id}/files`, { as: owner() })).json<ProjectFilesAnswer>();
    const scan = async () =>
      (await host.request('GET', `/v1/projects/${id}/repos`, { as: owner() })).json<{ repos: unknown[] }>();
    await read();

    await scan(); // finds nothing: the list did not change
    expect((await read()).rebuilding).toBe(false);

    repos.found = true;
    expect((await scan()).repos).toHaveLength(1);
    const refreshed = await read();
    await host.settle();

    expect(refreshed.rebuilding).toBe(true);
    expect(built).toHaveLength(2);

    await scan(); // the same list again: nothing more to refresh
    await host.settle();
    expect((await read()).rebuilding).toBe(false);
    expect(built).toHaveLength(2);
  });
});
