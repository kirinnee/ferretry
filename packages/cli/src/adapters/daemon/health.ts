import { z } from 'zod';
import type { IDaemonHealthPort, LocalUpdateHealth } from '../../lib/daemon/ports.ts';
import type { Fetcher } from './http-transport.ts';

/** The daemon's liveness route, served from the moment its address is bound (`GET /healthz`). */
const LIVENESS_PATH = '/healthz';

/**
 * What process control reads: which process serves and which build. The protocol is ANY integer here, because a daemon
 * on another protocol is exactly the one a person must be able to stop, restart and see (`daemon-older`); judging
 * the protocol is the guard's job, not this read's.
 */
export const ServingSchema = z
  .object({ protocol: z.number().int(), version: z.string(), pid: z.number().int().min(2) })
  .strip();

/**
 * Asks the daemon at `baseUrl()` whether it serves, and which process it is. The address is read again for every
 * ask, from the run record the daemon writes when it listens, so a daemon that restarted onto another port is found.
 *
 * An unreachable or booting daemon (`503`) resolves to `undefined` rather than throwing: every caller treats "did not
 * answer" as a fact to report. The pid it gives is a claim over HTTP, so no signal is sent to it before the
 * supervisor proves that pid holds this state home's lifetime lock (`assertServes`).
 */
export class RunRecordDaemonHealth implements IDaemonHealthPort {
  constructor(
    private readonly baseUrl: () => Promise<string>,
    private readonly fetcher: Fetcher = (url, init) => fetch(url, init),
    private readonly timeoutMs = 2_000,
  ) {}

  async probe(): Promise<LocalUpdateHealth | undefined> {
    try {
      const response = await this.fetcher(`${await this.baseUrl()}${LIVENESS_PATH}`, {
        method: 'GET',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) return undefined;
      const parsed = ServingSchema.safeParse(await response.json().catch(() => undefined));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }
}
