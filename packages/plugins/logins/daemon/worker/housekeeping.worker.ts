/**
 * The housekeeping worker: the free usage read of a sign-in, on its own thread (see `housekeeping-client.ts` for the
 * daemon's end and `housekeeping-job.ts` for everything this decides). It holds no vault, no state file and no write: its
 * grants are the READ-ONLY `credentials` root and the provider hosts, and it answers facts only.
 *
 * It asks for a grant per request, so the `fyd --check` probe (started with none) is answered without one.
 */
import { fetchPort, rootPort } from '@ferretry/kernel/worker';
import type { HousekeepingRequest, HousekeepingResponse } from '../lib/credentials/housekeeping-protocol.ts';
import { answerHousekeeping, signalClock } from '../adapters/credentials/housekeeping-job.ts';

declare const self: {
  onmessage: ((event: MessageEvent<HousekeepingRequest>) => void) | null;
  postMessage(message: HousekeepingResponse): void;
};

self.onmessage = async event => {
  self.postMessage(
    await answerHousekeeping(
      () => ({ root: rootPort('credentials'), fetch: fetchPort(), clock: signalClock }),
      event.data,
    ),
  );
};
