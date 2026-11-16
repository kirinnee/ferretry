import { describe, expect, test } from 'bun:test';
import type { ProjectInfo } from '../../../contract/index.ts';
import { NO_PROJECTS, ProjectsStore } from '../../../app/lib/projects-store.ts';

const project = (name: string): ProjectInfo =>
  ({
    id: '11111111-1111-4111-8111-111111111111',
    name,
    path: `/work/${name}`,
    source: 'existing-folder',
    createdAt: '2026-08-01T10:00:00.000Z',
  }) as ProjectInfo;

/** A reader whose reads are settled by hand, in whatever order the test chooses. */
function manualReader() {
  const reads: { resolve(value: readonly ProjectInfo[]): void; reject(reason: unknown): void }[] = [];
  return {
    reads,
    reader: {
      projects: () =>
        new Promise<readonly ProjectInfo[]>((resolve, reject) => {
          reads.push({ resolve, reject });
        }),
    },
  };
}

describe('ProjectsStore', () => {
  test('answers a shared empty and an idle slice before any read', () => {
    const { reader } = manualReader();
    const store = new ProjectsStore(reader);

    expect(store.getSnapshot()).toEqual({ projects: null, status: 'idle', error: null });
    expect(store.projects()).toBe(NO_PROJECTS);
  });

  test('keeps the whole record of every row it reads', async () => {
    const store = new ProjectsStore({ projects: async () => [project('ferretry')] });

    await store.hydrate();

    expect(store.getSnapshot().status).toBe('ready');
    expect(store.projects()[0]).toMatchObject({ source: 'existing-folder', createdAt: '2026-08-01T10:00:00.000Z' });
  });

  test('coalesces a burst into one request', async () => {
    const { reader, reads } = manualReader();
    const store = new ProjectsStore(reader);

    const first = store.hydrate();
    const second = store.hydrate();
    expect(reads).toHaveLength(1);
    reads[0]?.resolve([project('a')]);

    expect(await first).toBe(await second);
  });

  test('refreshes past the coalescing slot, because a read in flight predates the write', async () => {
    const { reader, reads } = manualReader();
    const store = new ProjectsStore(reader);

    void store.hydrate();
    const refreshed = store.refresh();
    expect(reads).toHaveLength(2);
    reads[1]?.resolve([project('fresh')]);
    await refreshed;

    expect(store.projects().map(row => row.name)).toEqual(['fresh']);
  });

  test('discards the abandoned read when it settles AFTER the refresh it was replaced by', async () => {
    const { reader, reads } = manualReader();
    const store = new ProjectsStore(reader);

    const stale = store.hydrate();
    const fresh = store.refresh();
    reads[1]?.resolve([project('post-write')]);
    await fresh;
    reads[0]?.resolve([project('pre-write')]);
    await stale;

    expect(store.projects().map(row => row.name)).toEqual(['post-write']);
  });

  test('discards an abandoned read’s FAILURE, so a stale error cannot mark a good refresh errored', async () => {
    const { reader, reads } = manualReader();
    const store = new ProjectsStore(reader);

    const stale = store.hydrate().catch(() => undefined);
    const fresh = store.refresh();
    reads[1]?.resolve([project('ok')]);
    await fresh;
    reads[0]?.reject(new Error('timed out'));
    await stale;

    expect(store.getSnapshot()).toMatchObject({ status: 'ready', error: null });
  });

  test('keeps a good list when a later read fails, and reports the failure', async () => {
    const { reader, reads } = manualReader();
    const store = new ProjectsStore(reader);
    const first = store.hydrate();
    reads[0]?.resolve([project('kept')]);
    await first;

    const later = store.refresh().catch(() => undefined);
    reads[1]?.reject(new Error('daemon unreachable'));
    await later;

    expect(store.projects().map(row => row.name)).toEqual(['kept']);
    expect(store.getSnapshot()).toMatchObject({ status: 'error', error: 'daemon unreachable' });
  });

  test('stringifies a rejection that is not an Error', async () => {
    const store = new ProjectsStore({ projects: () => Promise.reject('plain text') });

    await store.hydrate().catch(() => undefined);

    expect(store.getSnapshot().error).toBe('plain text');
  });

  test('publishes to subscribers until they leave', async () => {
    const store = new ProjectsStore({ projects: async () => [project('a')] });
    let heard = 0;
    const leave = store.subscribe(() => {
      heard += 1;
    });

    await store.hydrate();
    const afterFirst = heard;
    leave();
    await store.refresh();

    expect(afterFirst).toBeGreaterThan(0);
    expect(heard).toBe(afterFirst);
  });
});
