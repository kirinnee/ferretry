import { describe, expect, test } from 'bun:test';
import type { TestHost } from '@ferretry/kernel/testing';
import { ArchiveFile } from '../../../../contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../contract/testing/index.ts';
import { host, record } from './route-fixture.ts';

/**
 * `GET /v1/events?sessionId=` through the real daemon index wiring (`followableFerret` over the live registry and
 * `DaemonStorage.findSession`): an archived ferret is followed as today's `findSession` allowed, a ferret nobody holds is
 * a 404, and an archive that cannot be read leaves every live ferret followable.
 */

const AT = '2026-11-07T10:00:00.000Z';
const ARCHIVED = 'mi4abc-1a2b3c4d';
const entry = {
  archivedAt: AT,
  name: 'oak',
  status: 'completed',
  createdAt: AT,
  updatedAt: AT,
  lastSequence: 12,
  journalLine: 13,
  journal: { device: 'state', inode: 'history', size: 12, modifiedAtMs: 0 },
};

const withArchive = async (body: string | undefined): Promise<TestHost> => {
  const first = await host([record('lead')], { harness: new FakeHarness(), runner: new FakeRunner() });
  if (body !== undefined) first.state('ferrets').plant(ArchiveFile, body);
  return await first.restart();
};
const follow = async (h: TestHost, sessionId: string) => await h.socket('/v1/events', { query: { sessionId } });

describe('GET /v1/events following an archived ferret', () => {
  test('an archived ferret is accepted, a live one too, and an id nobody holds is a 404 not-found', async () => {
    const h = await withArchive(JSON.stringify({ format: 1, sessions: { [ARCHIVED]: entry } }));
    const archived = await follow(h, ARCHIVED);
    expect(archived.response).toBeUndefined();
    expect(archived.handler).toBeDefined();
    expect((await follow(h, 'lead')).response).toBeUndefined();
    const ghost = await follow(h, 'ghost');
    expect(ghost.response?.status).toBe(404);
    expect(ghost.response?.json<{ code: string }>().code).toBe('not-found');
    expect((await follow(h, 'mi4zzz-00000000')).response?.status).toBe(404);
  });

  test('a stream asked for while the archive is still loading waits for it, then accepts the archived ferret', async () => {
    const first = await host([record('lead')], { harness: new FakeHarness(), runner: new FakeRunner() });
    const folder = first.state('ferrets');
    folder.plant(ArchiveFile, JSON.stringify({ format: 1, sessions: { [ARCHIVED]: entry } }));
    // Hold the archive read open until the test lets it go, as a start-up that is still reading the file would.
    let release: () => void = () => {};
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const realPort = folder.port.bind(folder);
    folder.port = declared => {
      const port = realPort(declared);
      return {
        ...port,
        read: (async (file: Parameters<typeof port.read>[0], name?: string) => {
          if (file.name === ArchiveFile.name) await held;
          return await port.read(file, name);
        }) as typeof port.read,
      };
    };
    const h = await first.restart();
    let settled = false;
    const following = follow(h, ARCHIVED).then(result => {
      settled = true;
      return result;
    });
    await Bun.sleep(20);
    expect(settled).toBe(false);
    release();
    const archived = await following;
    expect(archived.response).toBeUndefined();
    expect(archived.handler).toBeDefined();
  });

  test('an archive that cannot be read leaves the live ferret followable and the archived id a 404', async () => {
    const h = await withArchive('{ not a registry');
    expect((await follow(h, 'lead')).response).toBeUndefined();
    expect((await follow(h, ARCHIVED)).response?.status).toBe(404);
  });
});
