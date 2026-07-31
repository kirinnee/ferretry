import {
  defaultBindRetryPolicy,
  healthEndpoint,
  shouldRetryBind,
  type BindRetryPolicy,
} from '../../lib/runtime/boot.ts';
import type { DaemonFetchPort, MillisecondClockPort, SleepPort } from '../../lib/runtime/readiness.ts';

export interface DaemonHealthProbeOptions {
  readonly url: string;
  readonly token?: string;
  readonly timeoutMs?: number;
}

/** HTTP adapter for detecting any incumbent process on the configured address. */
export class DaemonHealthProbe {
  constructor(private readonly fetcher: DaemonFetchPort) {}

  async responds(options: DaemonHealthProbeOptions): Promise<boolean> {
    try {
      await this.fetcher.fetch(healthEndpoint(options.url), {
        headers: options.token === undefined ? {} : { authorization: `Bearer ${options.token}` },
        signal: AbortSignal.timeout(options.timeoutMs ?? 2_000),
      });
      return true;
    } catch {
      return false;
    }
  }
}

/** Performs a bounded retry around a concrete address-binding operation. */
export class DaemonBinder {
  constructor(
    private readonly sleep: SleepPort,
    private readonly clock: MillisecondClockPort,
    private readonly policy: BindRetryPolicy = defaultBindRetryPolicy(),
  ) {}

  async bind<T>(operation: () => T | Promise<T>): Promise<T> {
    const deadlineMs = this.clock.now() + this.policy.totalMs;
    let attempts = 0;
    while (true) {
      try {
        return await operation();
      } catch (error) {
        attempts += 1;
        if (!shouldRetryBind(error, this.clock.now(), deadlineMs, attempts, this.policy)) throw error;
        await this.sleep.sleep(this.policy.backoffMs);
      }
    }
  }
}
