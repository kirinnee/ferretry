import { AnalyticsPricingFeedSchema, type ConfiguredAnalyticsPricingSource } from '@ferretry/protocol';
import type { AnalyticsPricingFeedPort, AnalyticsPricingFeedRead } from '../../lib/analytics/pricing-service.ts';

/** A configured pricing document may occupy at most 512 KiB before it is parsed. */
export const ANALYTICS_PRICING_FEED_MAX_BYTES = 512 * 1024;

/** One configured pricing source gets ten seconds to answer and finish its body. */
export const ANALYTICS_PRICING_FEED_TIMEOUT_MS = 10_000;

/** The narrow fetch surface this one GET needs, injected so tests never dial a network. */
export type AnalyticsPricingFeedFetch = (input: string, init: RequestInit) => Promise<Response>;

/** Starts one deadline and returns the function that clears it. */
export type AnalyticsPricingFeedTimeoutScheduler = (onTimeout: () => void, timeoutMs: number) => () => void;

export interface HttpAnalyticsPricingFeedOptions {
  readonly fetcher?: AnalyticsPricingFeedFetch;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly scheduleTimeout?: AnalyticsPricingFeedTimeoutScheduler;
}

const scheduleSystemTimeout: AnalyticsPricingFeedTimeoutScheduler = (onTimeout, timeoutMs) => {
  const timer = setTimeout(onTimeout, timeoutMs);
  return () => clearTimeout(timer);
};

/**
 * One bounded GET of an operator-configured pricing feed.
 *
 * THE ADDRESS IS THE PORT INPUT, NEVER A REQUEST PARAMETER. The protocol has already constrained
 * `source.url`, and redirects are refused so the fetch cannot escape to an unvalidated address.
 * Every expected remote-document failure is returned as data; this adapter never retries.
 */
export class HttpAnalyticsPricingFeed implements AnalyticsPricingFeedPort {
  private readonly fetcher: AnalyticsPricingFeedFetch;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly scheduleTimeout: AnalyticsPricingFeedTimeoutScheduler;

  constructor(options: HttpAnalyticsPricingFeedOptions = {}) {
    // Wrapped rather than stored bare: a builtin kept as a member value can be invoked with the
    // instance as its receiver, a failure an injected fetcher would never reveal.
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? ANALYTICS_PRICING_FEED_TIMEOUT_MS;
    this.maxBytes = options.maxBytes ?? ANALYTICS_PRICING_FEED_MAX_BYTES;
    this.scheduleTimeout = options.scheduleTimeout ?? scheduleSystemTimeout;
  }

  async read(source: ConfiguredAnalyticsPricingSource): Promise<AnalyticsPricingFeedRead> {
    const controller = new AbortController();
    const deadline = Promise.withResolvers<AnalyticsPricingFeedRead>();
    const clearDeadline = this.scheduleTimeout(() => {
      controller.abort();
      deadline.resolve({ kind: 'timeout' });
    }, this.timeoutMs);

    try {
      return await Promise.race([this.exchange(source.url, controller), deadline.promise]);
    } finally {
      clearDeadline();
    }
  }

  private async exchange(url: string, controller: AbortController): Promise<AnalyticsPricingFeedRead> {
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
    } catch {
      return controller.signal.aborted ? { kind: 'timeout' } : { kind: 'unreachable' };
    }

    if (controller.signal.aborted) {
      discard(response);
      return { kind: 'timeout' };
    }
    if (!response.ok) {
      discard(response);
      return { kind: 'status', status: response.status };
    }

    const bounded = await this.readBounded(response, controller);
    if (bounded.kind !== 'text') return bounded;

    let value: unknown;
    try {
      value = JSON.parse(bounded.value);
    } catch {
      return { kind: 'invalid_json' };
    }

    const parsed = AnalyticsPricingFeedSchema.safeParse(value);
    return parsed.success ? { kind: 'feed', feed: parsed.data } : { kind: 'invalid_schema' };
  }

  private async readBounded(
    response: Response,
    controller: AbortController,
  ): Promise<{ readonly kind: 'text'; readonly value: string } | AnalyticsPricingFeedRead> {
    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > this.maxBytes) {
      discard(response);
      return { kind: 'oversized' };
    }

    const body = response.body;
    if (body === null) return { kind: 'invalid_json' };

    const reader = (() => {
      try {
        return body.getReader();
      } catch {
        return undefined;
      }
    })();
    if (reader === undefined) return { kind: 'unreachable' };

    const chunks: Uint8Array[] = [];
    let received = 0;
    const cancelOnAbort = () => bestEffort(() => reader.cancel());
    controller.signal.addEventListener('abort', cancelOnAbort, { once: true });
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += chunk.value.byteLength;
        if (received > this.maxBytes) {
          controller.abort();
          return { kind: 'oversized' };
        }
        chunks.push(chunk.value);
      }
    } catch {
      bestEffort(() => reader.cancel());
      return controller.signal.aborted ? { kind: 'timeout' } : { kind: 'unreachable' };
    } finally {
      controller.signal.removeEventListener('abort', cancelOnAbort);
    }
    bestEffort(() => reader.releaseLock());

    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return { kind: 'text', value: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
    } catch {
      return { kind: 'invalid_json' };
    }
  }
}

function discard(response: Response): void {
  bestEffort(() => response.body?.cancel());
}

function bestEffort(action: () => unknown): void {
  try {
    // Start disposal synchronously, but never await a promise controlled by an untrusted stream.
    void Promise.resolve(action()).catch(() => undefined);
  } catch {
    // A body that throws while being released is already unusable; there is nothing to recover.
  }
}
