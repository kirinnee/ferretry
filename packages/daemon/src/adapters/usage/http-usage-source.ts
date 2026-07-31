import type { AccountUsage } from '@ferretry/protocol';
import { parseUsageAccounts, type UsageSourcePort } from '../../lib/usage/index.ts';

export type UsageFetcher = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpUsageSourceOptions {
  readonly fetcher?: UsageFetcher;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 3_000;

/**
 * Reads the fleet collector's JSON usage endpoint.
 *
 * The caller's abort signal is combined with the request timeout, so cancelling a read actually
 * cancels the request; the source implementation only applied its own timeout and left an abandoned
 * request running to completion.
 */
export class HttpUsageSource implements UsageSourcePort {
  private readonly fetcher: UsageFetcher;
  private readonly timeoutMs: number;

  constructor(
    private readonly url: string,
    options: HttpUsageSourceOptions = {},
  ) {
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async read(signal?: AbortSignal): Promise<readonly AccountUsage[] | undefined> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    try {
      const response = await this.fetcher(this.url, { signal: combined });
      if (!response.ok) return undefined;
      return parseUsageAccounts(await response.json());
    } catch {
      return undefined;
    }
  }
}
