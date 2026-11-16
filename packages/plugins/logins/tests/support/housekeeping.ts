import type { FetchPort, RootHandle, WorkerHandle, WorkersPort } from '@ferretry/kernel/contract';
import {
  answerHousekeeping,
  signalClock,
  type HousekeepingGrants,
} from '../../daemon/adapters/credentials/housekeeping-job.ts';
import type { MaterialReader } from '../../daemon/adapters/credentials/material-read.ts';
import type { HousekeepingRequest } from '../../daemon/lib/credentials/housekeeping-protocol.ts';

/**
 * The worker's read-only grant as the worker sees it, over the kernel's REAL `credentials` root: relative paths only,
 * and each one fenced by the root exactly as the main thread fences a read it serves for the thread.
 */
export function relativeRoot(root: Pick<RootHandle, 'resolve' | 'lstat' | 'stat' | 'readText'>): MaterialReader {
  const at = (path: string) => {
    const resolved = root.resolve(path);
    if (!resolved.ok) throw new Error('root refused');
    return resolved.value;
  };
  return {
    lstat: async path => await root.lstat(at(path)),
    stat: async path => await root.stat(at(path)),
    readText: async path => await root.readText(at(path)),
  };
}

/**
 * A workers port whose thread is this process: it answers each posted job with the REAL job code (`answerHousekeeping`)
 * over the grants given. The test host starts no worker threads; this is what lets a whole daemon be driven through a
 * Check now while the code that reads the sign-in and makes the usage read is exactly the worker's.
 */
export function inProcessHousekeeping(
  grants: Pick<HousekeepingGrants, 'fetch'> & {
    readonly root: Pick<RootHandle, 'resolve' | 'lstat' | 'stat' | 'readText'>;
  },
  /** Every request the daemon posted to the thread, in order. */
  posted: HousekeepingRequest[] = [],
): Pick<WorkersPort, 'start'> {
  return {
    start: (): WorkerHandle => {
      const listeners = new Set<(message: unknown) => void>();
      return {
        post: message => {
          posted.push(message as HousekeepingRequest);
          const fetch: FetchPort = grants.fetch;
          void answerHousekeeping(
            () => ({ root: relativeRoot(grants.root), fetch, clock: signalClock }),
            message as HousekeepingRequest,
          ).then(answer => {
            for (const listener of listeners) listener(answer);
          });
        },
        onMessage: listener => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        onExit: () => () => undefined,
        terminate: async () => undefined,
      };
    },
  };
}
