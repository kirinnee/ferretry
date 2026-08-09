import { describe, it } from 'bun:test';
import type { AnalyticsPricingFeed, ConfiguredAnalyticsPricingSource } from '@ferretry/protocol';
import should from 'should';
import {
  ANALYTICS_PRICING_FEED_MAX_BYTES,
  ANALYTICS_PRICING_FEED_TIMEOUT_MS,
  type AnalyticsPricingFeedTimeoutScheduler,
  HttpAnalyticsPricingFeed,
} from '../../../src/adapters/analytics/pricing-feed-source.ts';

const source: ConfiguredAnalyticsPricingSource = {
  id: 'openai-feed',
  provider: 'openai',
  url: 'https://pricing.example.test/openai.json',
  enabled: true,
  lastSyncedAt: null,
};

const feed: AnalyticsPricingFeed = {
  entries: [
    {
      pricingKey: 'openai-gpt-5',
      modelId: 'gpt-5',
      aliases: ['gpt-5-latest'],
      currency: 'USD',
      rates: {
        input: 1_250_000,
        output: 10_000_000,
        cachedInput: 125_000,
        cacheWrite: null,
        cacheWrite5m: null,
        cacheWrite1h: null,
        reasoning: 10_000_000,
        image: null,
        tool: null,
      },
      validFrom: '2026-08-01T00:00:00.000Z',
      validThrough: null,
    },
  ],
};

function neverSettlingBody(onCancel: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    cancel: () => {
      onCancel();
      return new Promise<void>(() => undefined);
    },
  });
}

describe('the bounded analytics pricing feed', () => {
  it('should return a feed parsed by the shared protocol schema', async () => {
    // Arrange
    const pricing = new HttpAnalyticsPricingFeed({
      fetcher: async () => Response.json(feed),
    });

    // Act
    const actual = await pricing.read(source);

    // Assert
    should(actual).deepEqual({ kind: 'feed', feed });
    should(ANALYTICS_PRICING_FEED_MAX_BYTES).equal(512 * 1024);
    should(ANALYTICS_PRICING_FEED_TIMEOUT_MS).equal(10_000);
  });

  it('should GET only the configured URL with no cache, redirect, credential, or body escape hatch', async () => {
    // Arrange — replace the global before constructing the default adapter, proving its wrapped
    // binding without ever allowing this test to reach the real network.
    const originalFetch = globalThis.fetch;
    let seenInput: unknown;
    let seenInit: RequestInit | undefined;
    globalThis.fetch = (async (input, init) => {
      seenInput = input;
      seenInit = init;
      return Response.json({ entries: [] });
    }) as typeof fetch;

    try {
      // Act
      const actual = await new HttpAnalyticsPricingFeed().read(source);

      // Assert
      should(actual).deepEqual({ kind: 'feed', feed: { entries: [] } });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const { signal, ...init } = seenInit ?? {};
    should(String(seenInput)).equal(source.url);
    should(init).deepEqual({
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      headers: { accept: 'application/json' },
    });
    should(signal).be.ok();
    should((signal as AbortSignal).aborted).be.false();
    should(new Headers(seenInit?.headers).has('authorization')).be.false();
    should(new Headers(seenInit?.headers).has('cookie')).be.false();
    should(init).not.have.property('body');
  });

  it('should classify the deadline separately when fetch rejects after being aborted', async () => {
    // Arrange
    let fire: () => void = () => undefined;
    let scheduledMs: number | undefined;
    let cleared = 0;
    let seenSignal: AbortSignal | null | undefined;
    const scheduleTimeout: AnalyticsPricingFeedTimeoutScheduler = (onTimeout, timeoutMs) => {
      fire = onTimeout;
      scheduledMs = timeoutMs;
      return () => {
        cleared += 1;
      };
    };
    const pricing = new HttpAnalyticsPricingFeed({
      timeoutMs: 73,
      scheduleTimeout,
      fetcher: async (_input, init) => {
        seenSignal = init.signal;
        fire();
        throw new Error('the injected fetch observed its abort');
      },
    });

    // Act
    const actual = await pricing.read(source);

    // Assert
    should(actual).deepEqual({ kind: 'timeout' });
    should(scheduledMs).equal(73);
    should(seenSignal?.aborted).be.true();
    should(cleared).equal(1);
  });

  it('should discard a response that arrives only after its deadline fired', async () => {
    // Arrange
    let fire: () => void = () => undefined;
    let cancelled = false;
    const pricing = new HttpAnalyticsPricingFeed({
      scheduleTimeout: onTimeout => {
        fire = onTimeout;
        return () => undefined;
      },
      fetcher: async () => {
        fire();
        return new Response(neverSettlingBody(() => (cancelled = true)));
      },
    });

    // Act
    const actual = await pricing.read(source);

    // Assert
    should(actual).deepEqual({ kind: 'timeout' });
    should(cancelled).be.true();
  });

  it('should classify a redirect-mode fetch rejection as unreachable without throwing it', async () => {
    // Arrange — browsers reject a redirect under `redirect: error`; there is no response status to
    // inspect, so it is the same transport fact as any other unreachable configured endpoint.
    const pricing = new HttpAnalyticsPricingFeed({
      fetcher: async () => {
        throw new TypeError('fetch failed because redirect mode is set to error');
      },
    });

    // Act
    const actual = await pricing.read(source);

    // Assert
    should(actual).deepEqual({ kind: 'unreachable' });
  });

  it('should refuse a non-2xx response without buffering or awaiting its hostile body', async () => {
    // Arrange
    let cancelled = false;
    const pricing = new HttpAnalyticsPricingFeed({
      fetcher: async () =>
        new Response(
          neverSettlingBody(() => (cancelled = true)),
          { status: 503 },
        ),
    });

    // Act
    const actual = await pricing.read(source);

    // Assert
    should(actual).deepEqual({ kind: 'status', status: 503 });
    should(cancelled).be.true();
  });

  it('should refuse a declared oversized body before trying to read it', async () => {
    // Arrange
    let cancelled = false;
    const pricing = new HttpAnalyticsPricingFeed({
      maxBytes: 4,
      fetcher: async () =>
        new Response(
          neverSettlingBody(() => (cancelled = true)),
          {
            headers: { 'content-length': '5' },
          },
        ),
    });

    // Act
    const actual = await pricing.read(source);

    // Assert
    should(actual).deepEqual({ kind: 'oversized' });
    should(cancelled).be.true();
  });

  it('should stop an undeclared streamed body the moment its running byte count crosses the cap', async () => {
    // Arrange
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start: controller => {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5]));
      },
      cancel: () => {
        cancelled = true;
        return new Promise<void>(() => undefined);
      },
    });
    const pricing = new HttpAnalyticsPricingFeed({
      maxBytes: 4,
      fetcher: async () => new Response(body),
    });

    // Act
    const actual = await pricing.read(source);

    // Assert
    should(actual).deepEqual({ kind: 'oversized' });
    should(cancelled).be.true();
  });

  it('should return invalid_json for malformed JSON and an absent body', async () => {
    // Arrange
    const malformed = new HttpAnalyticsPricingFeed({
      fetcher: async () => new Response('{not json'),
    });
    const absent = new HttpAnalyticsPricingFeed({
      fetcher: async () => new Response(null, { status: 200 }),
    });

    // Act
    const actual = [await malformed.read(source), await absent.read(source)];

    // Assert
    should(actual).deepEqual([{ kind: 'invalid_json' }, { kind: 'invalid_json' }]);
  });

  it('should return invalid_json for bytes that are not valid UTF-8 JSON', async () => {
    // Arrange
    const pricing = new HttpAnalyticsPricingFeed({
      fetcher: async () => new Response(new Uint8Array([0xff])),
    });

    // Act
    const actual = await pricing.read(source);

    // Assert
    should(actual).deepEqual({ kind: 'invalid_json' });
  });

  it('should return invalid_schema when strict shared validation refuses the parsed document', async () => {
    // Arrange — `provider` is provenance a feed is explicitly forbidden to claim.
    const pricing = new HttpAnalyticsPricingFeed({
      fetcher: async () => Response.json({ entries: [], provider: 'openai' }),
    });

    // Act
    const actual = await pricing.read(source);

    // Assert
    should(actual).deepEqual({ kind: 'invalid_schema' });
  });

  it('should return unreachable for a body stream that fails while being read', async () => {
    // Arrange
    const body = new ReadableStream<Uint8Array>({
      start: controller => controller.error(new Error('connection reset during body')),
    });
    const pricing = new HttpAnalyticsPricingFeed({
      fetcher: async () => new Response(body),
    });

    // Act
    const actual = await pricing.read(source);

    // Assert
    should(actual).deepEqual({ kind: 'unreachable' });
  });

  it('should return unreachable rather than throw when the response body cannot be acquired', async () => {
    // Arrange
    const response = Response.json(feed);
    const heldReader = response.body?.getReader();
    const pricing = new HttpAnalyticsPricingFeed({
      fetcher: async () => response,
    });

    // Act
    const actual = await pricing.read(source);
    heldReader?.releaseLock();

    // Assert
    should(actual).deepEqual({ kind: 'unreachable' });
  });
});
