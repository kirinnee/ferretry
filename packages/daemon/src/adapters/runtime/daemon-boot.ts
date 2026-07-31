import {
  defaultBindRetryPolicy,
  healthEndpoint,
  shouldRetryBind,
  type BindRetryPolicy,
} from '../../lib/runtime/boot.ts';

export interface DaemonHealthProbeOptions {
  readonly url: string;
  readonly token?: string;
  readonly timeoutMs?: number;
}

export interface FetchPort {
  fetch(url: string, init: RequestInit): Promise<Response>;
}

export interface SleepPort {
  sleep(milliseconds: number): Promise<void>;
}

export interface ClockPort {
  now(): number;
}

/** HTTP adapter for detecting any incumbent process on the configured address. */
export class DaemonHealthProbe {
  constructor(private readonly fetcher: FetchPort) {}

  async responds(options: DaemonHealthProbeOptions): Promise<boolean> {
    try {
      const response = await this.fetcher.fetch(healthEndpoint(options.url), {
        headers: options.token === undefined ? {} : { authorization: `Bearer ${options.token}` },
        signal: AbortSignal.timeout(options.timeoutMs ?? 2_000),
      });
      return response instanceof Response;
    } catch {
      return false;
    }
  }
}

/** Performs a bounded retry around a concrete address-binding operation. */
export class DaemonBinder {
  constructor(
    private readonly sleep: SleepPort,
    private readonly clock: ClockPort,
    private readonly policy: BindRetryPolicy = defaultBindRetryPolicy(),
  ) {}

  async bind<T>(operation: () => T | Promise<T>): Promise<T> {
    const deadlineMs = this.clock.now() + this.policy.totalMs;
    while (true) {
      try {
        return await operation();
      } catch (error) {
        if (!shouldRetryBind(error, this.clock.now(), deadlineMs, this.policy)) throw error;
        await this.sleep.sleep(this.policy.backoffMs);
      }
    }
  }
}
