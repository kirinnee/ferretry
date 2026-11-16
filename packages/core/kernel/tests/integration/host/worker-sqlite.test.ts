import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { defineState } from '../../../contract/index.ts';
import type { WorkerHandle } from '../../../contract/ports.ts';
import { bunWorkers } from '../../../host/adapters/process.ts';
import { workersFor } from '../../../host/permissions.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';
import { createStatePort } from '../../../host/state/state-port.ts';

const Archive = defineState({ name: 'archive', path: 'archive.sqlite', store: 'sqlite', format: 1 });
const Notes = defineState({ name: 'notes', path: 'notes.json', store: 'json', format: 1 });

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

function reply(worker: WorkerHandle): Promise<unknown> {
  return new Promise(resolve => {
    const cancel = worker.onMessage(message => {
      cancel();
      resolve(message);
    });
  });
}

describe('kernel.workers: a declared sqlite file opened on the worker thread', () => {
  test('the worker opens the granted file in the plugin state folder; the main thread reads its rows', async () => {
    const home = await mkdtemp(`${tmpdir()}/fy-worker-`);
    homes.push(home);
    const port = createStatePort({ home, pluginId: 'asks', fs: createMemoryHostFs(), files: [Archive, Notes] });
    const workers = workersFor(bunWorkers(), () => (def, name) => port.sqliteGrant(def, name));
    const worker = workers.start(new URL('./fixtures/sqlite-worker.ts', import.meta.url), { state: [Archive] });
    try {
      const answer = reply(worker);
      worker.post({ insert: 'v1' });
      expect(await answer).toEqual({ rows: 1 });
      expect(port.sqlite(Archive).query<{ label: string }>('SELECT label FROM versions')).toEqual([{ label: 'v1' }]);
    } finally {
      await worker.terminate();
    }
  });

  test('a file that is not declared sqlite refuses the start before a thread exists', () => {
    const port = createStatePort({ home: '/nowhere', pluginId: 'asks', fs: createMemoryHostFs(), files: [Notes] });
    const workers = workersFor(bunWorkers(), () => (def, name) => port.sqliteGrant(def, name));
    expect(() => workers.start(new URL('./fixtures/sqlite-worker.ts', import.meta.url), { state: [Notes] })).toThrow(
      TypeError,
    );
    expect(() =>
      workers.start(new URL('./fixtures/sqlite-worker.ts', import.meta.url), { state: [Archive] }),
    ).toThrow();
  });
});
