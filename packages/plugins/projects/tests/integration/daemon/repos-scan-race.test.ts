import { afterEach, expect, test } from 'bun:test';
import { rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { FerretsChanged } from '@ferretry/core-ferrets/contract';
import { owner, testHost } from '@ferretry/kernel/testing';
import type { ProjectFilesAnswer, ProjectInfo } from '../../../contract/index.ts';
import { placeOf } from '../../../daemon/features/files/pins.ts';
import { kernelBrowser } from '../../../daemon/features/folders/adapter.ts';
import type { FolderBrowser } from '../../../daemon/features/folders/port.ts';
import { implementProjects } from '../../../daemon/index.ts';
import { fakeMachine } from '../../unit/daemon/support.ts';
import { cleanUp, git, put, world } from './files-support.ts';

afterEach(cleanUp);

async function setup(options: { readonly scan?: (browser: FolderBrowser, alpha: string) => FolderBrowser } = {}) {
  const disk = await world();
  const alpha = join(disk.user, 'alpha');
  const beta = join(disk.user, 'beta');
  const link = join(alpha, 'link');
  await put(disk.user, { 'alpha/a.txt': 'a', 'beta/b.txt': 'b' });
  const built: string[] = [];
  const browser = kernelBrowser(disk.kernel);
  const host = await testHost({
    plugins: [
      implementProjects(
        fakeMachine([alpha, beta]),
        { browser: options.scan?.(browser, alpha) ?? browser },
        {
          build: async path => {
            built.push(path);
            return await disk.build(path);
          },
          place: placeOf(browser),
        },
      ),
    ],
    uses: { ferrets: { get: async () => ({ folder: link }) } },
  });
  const register = async (path: string, name?: string) =>
    (
      await host.request('POST', '/v1/projects', {
        body: { kind: 'existing-folder', path, ...(name === undefined ? {} : { name }) },
        as: owner(),
      })
    ).json<ProjectInfo>();
  const read = async (id: string) =>
    (await host.request('GET', '/v1/projects/' + id + '/files', { as: owner() })).json<ProjectFilesAnswer>();
  const warm = async (id: string) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await read(id);
      if (!result.rebuilding) return result;
      await Bun.sleep(10);
    }
    throw new Error('index failed to settle');
  };
  const scan = async (id: string) =>
    (await host.request('GET', '/v1/projects/' + id + '/repos', { as: owner() })).json<{
      repos: { path: string }[];
      truncated: boolean;
    }>();
  const addApp = async () => {
    await put(alpha, { 'app/visible.txt': 'app' });
    git(join(alpha, 'app'), disk.user, 'init', '--quiet');
  };
  return { alpha, beta, built, host, link, register, read, warm, scan, addApp };
}

test('re-register returns the same full record and publishes exactly one event while invalidating', async () => {
  const { alpha, built, host, register, read } = await setup();
  const original = await register(alpha, 'Original');
  await host.settle();
  await read(original.id);
  expect((await read(original.id)).rebuilding).toBe(false);
  expect(built).toEqual([alpha]);
  expect(await register(alpha, 'Ignored')).toEqual(original);
  await host.settle();
  expect(host.published.filter(event => event.event === 'projects.registered')).toHaveLength(1);
  expect((await read(original.id)).rebuilding).toBe(true);
  await host.settle();
  expect(built).toEqual([alpha, alpha]);
});

test('idle cwd through an actual symlink refreshes only the physical project via the public files route', async () => {
  const { alpha, beta, built, host, link, register, read } = await setup();
  await symlink(beta, link);
  const a = await register(alpha);
  const b = await register(beta);
  await host.settle();
  await read(a.id);
  await read(b.id);
  expect(built).toEqual([alpha, beta]);
  host.emit(FerretsChanged, { ferret: 'probe', generation: 1, state: 'idle' });
  await host.settle();
  expect((await read(a.id)).rebuilding).toBe(false);
  expect((await read(b.id)).rebuilding).toBe(true);
  await host.settle();
  expect(built).toEqual([alpha, beta, beta]);
});

test('an actual repo scan invalidates when it adds a repo and keeps the index when the list stays the same', async () => {
  const { alpha, built, host, register, read, warm, scan, addApp } = await setup();
  const a = await register(alpha);
  await host.settle();
  await read(a.id);
  expect(await scan(a.id)).toEqual({ repos: [], truncated: false });
  expect((await read(a.id)).rebuilding).toBe(false);
  await addApp();
  expect(await scan(a.id)).toEqual({ repos: [{ path: 'app' }], truncated: false });
  expect((await read(a.id)).rebuilding).toBe(true);
  await warm(a.id);
  expect((await scan(a.id)).repos).toEqual([{ path: 'app' }]);
  expect((await read(a.id)).rebuilding).toBe(false);
  expect(built).toEqual([alpha, alpha]);
});

test('an overlapping scan that persists a changed list still invalidates', async () => {
  const firstScanRead = Promise.withResolvers<void>();
  const finishFirstScan = Promise.withResolvers<void>();
  let delayFirst = true;
  const { alpha, host, register, read, warm, scan, addApp } = await setup({
    scan: (browser, project) => ({
      ...browser,
      open: async (path, verdict) => {
        const held = await browser.open(path, verdict);
        if (!held.ok || path !== project || !delayFirst) return held;
        delayFirst = false;
        return {
          ok: true,
          folder: {
            ...held.folder,
            entries: async limit => {
              const entries = await held.folder.entries(limit);
              firstScanRead.resolve();
              await finishFirstScan.promise;
              return entries;
            },
          },
        };
      },
    }),
  });
  const a = await register(alpha);
  await host.settle();
  await read(a.id);
  const older = scan(a.id);
  try {
    await firstScanRead.promise;
    await addApp();
    expect(await scan(a.id)).toEqual({ repos: [{ path: 'app' }], truncated: false });
    expect((await read(a.id)).rebuilding).toBe(true);
    expect((await warm(a.id)).files.map(file => file.path)).toContain('app/visible.txt');
    await rm(join(alpha, 'app'), { recursive: true });
  } finally {
    finishFirstScan.resolve();
    expect(await older).toEqual({ repos: [], truncated: false });
  }
  const projects = (await host.request('GET', '/v1/projects', { as: owner() })).json<ProjectInfo[]>();
  expect(projects.find(project => project.id === a.id)?.repos ?? []).toEqual([]);
  const current = await read(a.id);
  expect(current.files.map(file => file.path)).toContain('app/visible.txt');
  expect(current.rebuilding).toBe(true);
});
