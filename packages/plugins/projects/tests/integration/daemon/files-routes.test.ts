import { describe, expect, test } from 'bun:test';
import { ferret, owner, type TestCaller, testHost } from '@ferretry/kernel/testing';
import type { Instant } from '@ferretry/std';
import { type ProjectFilesAnswer, type ProjectFilesStatus, type ProjectInfo } from '../../../contract/index.ts';
import { implementProjects } from '../../../daemon/index.ts';
import type { ProjectIndex } from '../../../daemon/features/files/build.ts';
import { fakeMachine } from '../../unit/daemon/support.ts';

const entry = (path: string) => ({ path, name: path.split('/').at(-1) ?? path });
const INDEX: ProjectIndex = {
  files: ['README.md', 'src/app.ts'].map(entry),
  summary: {
    builtAt: '2026-11-22T00:00:00.000Z' as Instant,
    indexed: 2,
    coverage: 'complete',
    skipped: [],
    biggestFolders: [{ folder: 'src', files: 1 }],
    nestedWorktrees: [],
  },
};

/** A device holding exactly these capabilities, the way a paired phone narrowed by its owner holds them. */
const device = (...capabilities: string[]): TestCaller => ({ kind: 'device', holder: 'phone', capabilities });

const start = async () => {
  const built: string[] = [];
  const host = await testHost({
    plugins: [
      implementProjects(fakeMachine(['/work/alpha']), undefined, {
        build: async path => {
          built.push(path);
          return INDEX;
        },
        // `/work/alpha` is a fake machine's folder, not one on this disk: inside a home of `/work`, resolving to itself.
        place: { home: async () => '/work', resolve: async path => path },
      }),
    ],
  });
  const project = (
    await host.request('POST', '/v1/projects', {
      body: { kind: 'existing-folder', path: '/work/alpha' },
      as: owner(),
    })
  ).json<ProjectInfo>();
  return { host, id: project.id, built };
};

describe('a project’s file finder over HTTP', () => {
  test('the owner and a device holding filesystem.use read matches, status and rescan; the folder is built once', async () => {
    const { host, id, built } = await start();

    const files = await host.request('GET', `/v1/projects/${id}/files`, {
      query: { q: 'app' },
      as: device('filesystem.use'),
    });
    const status = await host.request('GET', `/v1/projects/${id}/files/status`, { as: device('filesystem.use') });
    const rescan = await host.request('POST', `/v1/projects/${id}/files/rescan`, { as: owner() });

    expect(files.status).toBe(200);
    expect(files.json<ProjectFilesAnswer>().files).toEqual([entry('src/app.ts')]);
    expect(files.json<ProjectFilesAnswer>().index.coverage).toBe('complete');
    expect(status.json<ProjectFilesStatus>()).toEqual({ rebuilding: false, index: INDEX.summary });
    expect(rescan.status).toBe(200);
    expect(rescan.json<ProjectFilesStatus>().rebuilding).toBe(true);
    expect(built[0]).toBe('/work/alpha');
  });

  test('a device narrowed off the filesystem is refused on all three routes, and nothing is built for it', async () => {
    const { host, id, built } = await start();
    const narrowed = device('fleet.use');

    const refused = [
      await host.request('GET', `/v1/projects/${id}/files`, { as: narrowed }),
      await host.request('GET', `/v1/projects/${id}/files/status`, { as: narrowed }),
      await host.request('POST', `/v1/projects/${id}/files/rescan`, { as: narrowed }),
    ];

    expect(refused.map(response => response.status)).toEqual([403, 403, 403]);
    expect(built).toEqual([]);
  });

  test('is a person’s read: a ferret is refused', async () => {
    const { host, id, built } = await start();

    const response = await host.request('GET', `/v1/projects/${id}/files`, { as: ferret('f1') });

    expect(response.status).toBe(403);
    expect(built).toEqual([]);
  });

  test('is never stored by an intermediary, and answers no file content', async () => {
    const { host, id } = await start();

    const response = await host.request('GET', `/v1/projects/${id}/files`, { as: owner() });

    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(Object.keys(response.json<ProjectFilesAnswer>().files[0] ?? {}).sort()).toEqual(['name', 'path']);
  });
});
