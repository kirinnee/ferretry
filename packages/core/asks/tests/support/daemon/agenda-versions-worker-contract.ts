import { describe, it } from 'bun:test';
import should from 'should';
import {
  type AgendaVersionsRequest,
  type AgendaVersionsResponse,
  type AgendaVersionsScope,
  serveAgendaVersions,
} from '../../../daemon/adapters/agenda/agenda-versions-program.ts';
import { FileAgendaVersionStore } from '../../../daemon/adapters/agenda/worker-agenda-versions.ts';
import type { HostedWorker } from '../../src/adapters/runtime/bundled-worker-host.ts';
import type { AgendaVersionStore } from '../../../daemon/lib/agenda/versions.ts';

export function agendaVersionsWorkerContract() {
  describe('awaited agenda version worker requests', () => {
    it('does not complete a record until the archive answers, and propagates a failed request without poisoning the queue', async () => {
      let release = () => {};
      const commit = new Promise<void>(resolve => {
        release = resolve;
      });
      const calls: string[] = [];
      const scope: AgendaVersionsScope = {
        onmessage: null,
        postMessage: data => worker.onmessage?.({ data } as MessageEvent<AgendaVersionsResponse>),
      };
      const worker: HostedWorker<AgendaVersionsRequest, AgendaVersionsResponse> = {
        onmessage: null,
        onerror: null,
        postMessage: data => scope.onmessage?.({ data } as MessageEvent<AgendaVersionsRequest>),
        terminate: () => {},
      };
      let fail = true;
      const backend: Required<AgendaVersionStore> = {
        record: async () => {
          calls.push('record');
          await commit;
          calls.push('committed');
        },
        list: async () => {
          calls.push('list');
          if (fail) {
            fail = false;
            throw 'disk unavailable';
          }
          return [];
        },
        get: async () => undefined,
        conversation: async () => undefined,
        discard: async () => undefined,
      };
      serveAgendaVersions(scope, directory => {
        calls.push(directory);
        return backend;
      });
      const store = new FileAgendaVersionStore(session => `/tmp/${session}`, { spawn: () => worker });
      try {
        // Probe replies do not settle a request. A later list queues behind the unresolved commit.
        let done = false;
        const write = store.record('s1', []).then(() => {
          done = true;
        });
        worker.postMessage({ probe: true });
        const refused = should(store.list('s1', 'A1')).be.rejectedWith('disk unavailable');
        await Promise.resolve();
        should(done).be.false();
        should(calls).deepEqual(['/tmp/s1', 'record']);
        release();
        await write;
        await refused;
        should(calls).deepEqual(['/tmp/s1', 'record', 'committed', 'list']);
        should(await store.list('s2', 'A1')).deepEqual([]);
        should(calls.slice(-2)).deepEqual(['/tmp/s2', 'list']);
        should(await store.conversation('s2', 'A1', 999)).be.undefined();
        await should(store.get('../bad', 'A1', 1)).be.rejectedWith(/not a valid agenda session id/u);
        await should(store.list('s2', '../bad' as never)).be.rejectedWith(/not a valid agenda id/u);
        await should(store.record('s2', [{ entry: { item: { id: '../bad' } } } as never])).be.rejectedWith(
          /not a valid agenda id/u,
        );
      } finally {
        store.close();
      }
    });
  });
}
