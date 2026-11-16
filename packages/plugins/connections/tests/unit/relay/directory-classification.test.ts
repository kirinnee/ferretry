/**
 * TRANSIENT OR DEFINITIVE: the one place a failed directory read is sorted.
 *
 * A daemon that read the hosted relay directory once and gave up stayed direct-only until the next
 * restart whenever the network was not up yet. The sorting rule below decides which failures are
 * worth asking again for (the network was not there, the service was busy) and which are answers
 * (the operator switched the relay off, the document is not one this daemon can read) — and asking
 * again for an answer is how an emergency stop turns into a retry storm.
 */

import { describe, expect, test } from 'bun:test';
import { HostedRelayDirectory } from '../../../daemon/adapters/relay/hosted-relay-directory.ts';
import {
  classifyDirectoryOutcome,
  type DirectoryOutcome,
  isTransientAdvertisement,
  parseRetryAfterMs,
} from '../../../daemon/lib/relay/discovery.ts';
import {
  DIRECTORY_RETRY_BASE_MS,
  DIRECTORY_RETRY_CAP_MS,
  directoryRetryDelayMs,
} from '../../../daemon/lib/relay/directory-retry.ts';

const transientOutcomes: ReadonlyArray<readonly [string, DirectoryOutcome]> = [
  ['the network is not up (fetch threw)', { kind: 'unreachable' }],
  ['the directory never answered (timeout)', { kind: 'timeout' }],
  ['a 500', { kind: 'status', status: 500, retryAfter: null }],
  ['a 502', { kind: 'status', status: 502, retryAfter: null }],
  ['a 503', { kind: 'status', status: 503, retryAfter: null }],
  ['a 599', { kind: 'status', status: 599, retryAfter: null }],
  ['a 429', { kind: 'status', status: 429, retryAfter: null }],
  ['a body that broke mid-read', { kind: 'body-interrupted' }],
];

const definitiveOutcomes: ReadonlyArray<readonly [string, DirectoryOutcome]> = [
  ['a build with no origin', { kind: 'no-origin' }],
  ['an origin this daemon may not ask', { kind: 'refused-origin' }],
  ['a 400', { kind: 'status', status: 400, retryAfter: null }],
  ['a 401', { kind: 'status', status: 401, retryAfter: null }],
  ['a 403', { kind: 'status', status: 403, retryAfter: null }],
  ['a 404', { kind: 'status', status: 404, retryAfter: null }],
  ['a 410', { kind: 'status', status: 410, retryAfter: null }],
  ['a body that is not a document', { kind: 'body-not-document' }],
  ['a document of the wrong version', { kind: 'document', value: { version: 9, relayUrl: 'https://relay.example' } }],
  ['a document with an extra key', { kind: 'document', value: { version: 1, relayUrl: null, extra: true } }],
];

describe('classifying a directory outcome', () => {
  for (const [name, outcome] of transientOutcomes)
    test(`should retry ${name}`, () => {
      const answer = classifyDirectoryOutcome(outcome);
      expect(answer.kind).toBe('undetermined');
      expect(isTransientAdvertisement(answer)).toBe(true);
    });

  for (const [name, outcome] of definitiveOutcomes)
    test(`should not retry ${name}`, () => {
      const answer = classifyDirectoryOutcome(outcome);
      expect(answer.kind).toBe('undetermined');
      expect(isTransientAdvertisement(answer)).toBe(false);
    });

  test('should treat the operator switching the relay off as an answer, never a failure', () => {
    const answer = classifyDirectoryOutcome({ kind: 'document', value: { version: 1, relayUrl: null } });
    expect(answer).toEqual({ kind: 'disabled' });
    expect(isTransientAdvertisement(answer)).toBe(false);
  });

  test('should take an advertised relay as an answer', () => {
    const answer = classifyDirectoryOutcome({
      kind: 'document',
      value: { version: 1, relayUrl: 'https://relay.example' },
    });
    expect(answer).toEqual({ kind: 'available', relayUrl: 'https://relay.example' });
    expect(isTransientAdvertisement(answer)).toBe(false);
  });

  test('should keep the sentences the boot trail already says', () => {
    expect(classifyDirectoryOutcome({ kind: 'unreachable' })).toMatchObject({
      reason: 'this daemon could not reach the relay directory',
    });
    expect(classifyDirectoryOutcome({ kind: 'timeout' })).toMatchObject({
      reason: 'this daemon could not reach the relay directory',
    });
    expect(classifyDirectoryOutcome({ kind: 'status', status: 503, retryAfter: null })).toMatchObject({
      reason: 'the relay directory answered 503',
    });
    expect(classifyDirectoryOutcome({ kind: 'body-not-document' })).toMatchObject({
      reason: 'the relay directory answered something that is not a document',
    });
  });

  test('should carry a sane Retry-After on a 429 and a 503, and ignore it elsewhere', () => {
    expect(classifyDirectoryOutcome({ kind: 'status', status: 429, retryAfter: '30' })).toMatchObject({
      retry: { retryAfterMs: 30_000 },
    });
    expect(classifyDirectoryOutcome({ kind: 'status', status: 503, retryAfter: '5' })).toMatchObject({
      retry: { retryAfterMs: 5_000 },
    });
    expect(classifyDirectoryOutcome({ kind: 'status', status: 404, retryAfter: '5' })).not.toHaveProperty('retry');
  });
});

describe('Retry-After', () => {
  test('should read whole seconds', () => {
    expect(parseRetryAfterMs('0')).toBe(0);
    expect(parseRetryAfterMs('120')).toBe(120_000);
    expect(parseRetryAfterMs(' 7 ')).toBe(7_000);
  });
  test('should clamp a valid whole-seconds value of any length instead of discarding it', () => {
    expect(parseRetryAfterMs('1000000')).toBe(1_000_000_000);
    expect(parseRetryAfterMs('0000000000000000000120')).toBe(120_000);
    expect(parseRetryAfterMs('0'.repeat(400))).toBe(0);
    expect(parseRetryAfterMs('9'.repeat(400))).toBe(999_999_999_000);
    expect(parseRetryAfterMs('1234567890123')).toBe(999_999_999_000);
    // …and whatever it returns, the retry never waits past the 300 s cap.
    for (const header of ['1000000', '0000000000000000000120', '9'.repeat(400)]) {
      const ms = parseRetryAfterMs(header);
      expect(Number.isFinite(ms)).toBe(true);
      expect(directoryRetryDelayMs(1, 1, ms)).toBeLessThanOrEqual(DIRECTORY_RETRY_CAP_MS);
    }
    expect(directoryRetryDelayMs(1, 1, parseRetryAfterMs('1000000'))).toBe(300_000);
    expect(directoryRetryDelayMs(1, 1, parseRetryAfterMs('9'.repeat(400)))).toBe(300_000);
    expect(directoryRetryDelayMs(1, 1, parseRetryAfterMs('0'.repeat(400)))).toBe(2_000);
  });
  test('should ignore anything it cannot trust', () => {
    for (const bad of [null, '', 'soon', '-3', '+3', '1.5', '1e9', 'Wed, 21 Oct 2026 07:28:00 GMT', 'NaN', 'Infinity'])
      expect(parseRetryAfterMs(bad)).toBeUndefined();
  });
});

describe('the retry delay', () => {
  test('should start at the base window and double to the cap', () => {
    const windows = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20].map(attempt => directoryRetryDelayMs(attempt, 1));
    expect(windows).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000, 300_000]);
    expect(DIRECTORY_RETRY_BASE_MS).toBe(2_000);
    expect(DIRECTORY_RETRY_CAP_MS).toBe(300_000);
  });

  test('should land in the upper half of the window (equal jitter), never below it, never above', () => {
    for (const attempt of [1, 2, 5, 9, 30]) {
      const window = directoryRetryDelayMs(attempt, 1);
      expect(directoryRetryDelayMs(attempt, 0)).toBe(window / 2);
      expect(directoryRetryDelayMs(attempt, 0.5)).toBe(Math.round(window * 0.75));
    }
  });

  test('should be total: an unusable attempt is the first retry, an unusable random the bottom', () => {
    expect(directoryRetryDelayMs(Number.NaN, 1)).toBe(2_000);
    expect(directoryRetryDelayMs(-4, 1)).toBe(2_000);
    expect(directoryRetryDelayMs(0, 1)).toBe(2_000);
    expect(directoryRetryDelayMs(Number.POSITIVE_INFINITY, 1)).toBe(300_000);
    expect(directoryRetryDelayMs(3, Number.NaN)).toBe(4_000);
    expect(directoryRetryDelayMs(3, 7)).toBe(8_000);
    expect(directoryRetryDelayMs(3, -7)).toBe(4_000);
  });

  test('should honour a Retry-After longer than the backoff, but never past the cap or below the backoff', () => {
    expect(directoryRetryDelayMs(1, 1, 20_000)).toBe(20_000);
    expect(directoryRetryDelayMs(1, 1, 99_999_999)).toBe(300_000);
    expect(directoryRetryDelayMs(3, 1, 1_000)).toBe(8_000);
    expect(directoryRetryDelayMs(1, 1, Number.NaN)).toBe(2_000);
  });
});

describe('the hosted directory adapter, with a fake fetch', () => {
  const read = (fetcher: (input: string, init?: RequestInit) => Promise<Response>, timeoutMs = 50) =>
    new HostedRelayDirectory('https://relay.example', { fetcher, timeoutMs }).read();

  test('should answer a thrown fetch as transient', async () => {
    const answer = await read(async () => await Promise.reject(new Error('Unable to connect.')));
    expect(isTransientAdvertisement(answer)).toBe(true);
  });

  test('should answer a timeout as transient', async () => {
    const answer = await read(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    expect(isTransientAdvertisement(answer)).toBe(true);
    expect(answer).toMatchObject({ reason: 'this daemon could not reach the relay directory' });
  });

  test('should answer 5xx and 429 as transient and any other 4xx as definitive', async () => {
    for (const status of [500, 502, 503, 504, 429])
      expect(isTransientAdvertisement(await read(async () => new Response('', { status })))).toBe(true);
    for (const status of [400, 401, 403, 404, 410])
      expect(isTransientAdvertisement(await read(async () => new Response('', { status })))).toBe(false);
  });

  test('should read Retry-After off a 429', async () => {
    const answer = await read(async () => new Response('', { status: 429, headers: { 'retry-after': '45' } }));
    expect(answer).toMatchObject({ kind: 'undetermined', retry: { retryAfterMs: 45_000 } });
  });

  test('should answer a body that is not JSON as definitive and a body that breaks mid-read as transient', async () => {
    expect(isTransientAdvertisement(await read(async () => new Response('<html>hello</html>')))).toBe(false);
    const broken = new Response(
      new ReadableStream({
        start: controller => controller.error(new Error('connection reset')),
      }),
    );
    expect(isTransientAdvertisement(await read(async () => broken))).toBe(true);
  });

  test('should answer a 429 whose Retry-After has many digits as transient, waiting the capped time', async () => {
    for (const header of ['1000000', '00000000000000000030', '9'.repeat(400)]) {
      const answer = await read(async () => new Response('', { status: 429, headers: { 'retry-after': header } }));
      expect(isTransientAdvertisement(answer)).toBe(true);
      expect(answer).toMatchObject({ retry: { retryAfterMs: expect.any(Number) } });
    }
  });

  test('should answer a network break or a deadline AFTER the headers, while the body is read, as transient', async () => {
    const bodyThatFails = (failure: () => unknown) =>
      new Response(new ReadableStream({ start: controller => controller.error(failure()) }));
    for (const failure of [
      () => new TypeError('terminated'),
      () => new DOMException('The operation timed out.', 'TimeoutError'),
      () => new DOMException('The operation was aborted.', 'AbortError'),
      () => new Error('connection reset'),
    ])
      expect(isTransientAdvertisement(await read(async () => bodyThatFails(failure)))).toBe(true);
  });

  test('should answer a body still streaming when the read deadline passes as transient', async () => {
    const answer = await read(async (_input, init) => {
      const signal = init?.signal;
      return new Response(
        new ReadableStream({
          start: controller => {
            signal?.addEventListener('abort', () => controller.error(signal.reason));
          },
        }),
      );
    }, 20);
    expect(isTransientAdvertisement(answer)).toBe(true);
    expect(answer).toMatchObject({ reason: expect.stringContaining('cut off') });
  });

  test('should keep a malformed-but-complete body definitive', async () => {
    for (const body of ['{"version":1,', '', 'null', '<html>']) {
      const answer = await read(async () => new Response(body));
      expect(isTransientAdvertisement(answer)).toBe(false);
    }
  });

  test('should answer a document the schema refuses as definitive', async () => {
    const answer = await read(async () => Response.json({ version: 2, relayUrl: 'https://relay.example' }));
    expect(answer).toMatchObject({ kind: 'undetermined' });
    expect(isTransientAdvertisement(answer)).toBe(false);
  });

  test('should answer no origin and an origin it may not ask as definitive, without asking', async () => {
    let asked = 0;
    const fetcher = async () => {
      asked++;
      return Response.json({ version: 1, relayUrl: null });
    };
    expect(isTransientAdvertisement(await new HostedRelayDirectory(undefined, { fetcher }).read())).toBe(false);
    expect(isTransientAdvertisement(await new HostedRelayDirectory('http://relay.example', { fetcher }).read())).toBe(
      false,
    );
    expect(asked).toBe(0);
  });

  test('should keep cache: no-store on every read', async () => {
    const seen: Array<RequestCache | undefined> = [];
    const directory = new HostedRelayDirectory('https://relay.example', {
      fetcher: async (_input, init) => {
        seen.push(init?.cache);
        return new Response('', { status: 503 });
      },
    });
    await directory.read();
    await directory.read();
    expect(seen).toEqual(['no-store', 'no-store']);
  });

  test('should abort an in-flight read when the caller’s signal aborts', async () => {
    const controller = new AbortController();
    let aborted = false;
    const directory = new HostedRelayDirectory('https://relay.example', {
      timeoutMs: 60_000,
      fetcher: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(init.signal?.reason);
          });
        }),
    });
    const pending = directory.read(controller.signal);
    controller.abort();
    const answer = await pending;
    expect(aborted).toBe(true);
    expect(answer.kind).toBe('undetermined');
  });
});
