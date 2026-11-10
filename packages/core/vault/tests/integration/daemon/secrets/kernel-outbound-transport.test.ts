import { describe, expect, test } from 'bun:test';
import type { FetchPort } from '@ferretry/kernel/contract';
import { fixedClock } from '@ferretry/kernel/testing';
import type { OutboundHttpRequest } from '../../../../contract/index.ts';
import { KernelOutboundTransport } from '../../../../daemon/adapters/secrets/kernel-outbound-transport.ts';

const SECRET = 'sk-live-super-secret-value-0123456789';
const REQUEST: OutboundHttpRequest = {
  method: 'POST',
  url: 'https://provider.example.test/v1/complete',
  headers: { authorization: `Bearer ${SECRET}` },
  body: '{"prompt":"hi"}',
  timeoutMs: 1000,
  maxResponseBytes: 64,
};

const bytes = (text: string) => new TextEncoder().encode(text);

function streamOf(...chunks: (Uint8Array | undefined)[]): ReadableStream<Uint8Array> {
  let next = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[next++];
      if (next > chunks.length) controller.close();
      else controller.enqueue(chunk as Uint8Array);
    },
  });
}

function setup(answer: (init: RequestInit | undefined) => Promise<Response>) {
  const clock = fixedClock();
  const seen: { url: string; init?: RequestInit }[] = [];
  const fetchPort: FetchPort = {
    request: async (url, init) => {
      seen.push({ url: String(url), ...(init === undefined ? {} : { init }) });
      return await answer(init);
    },
  };
  return { transport: new KernelOutboundTransport(fetchPort, clock), clock, seen };
}

describe('the outbound transport', () => {
  test('a good reply is its parsed JSON, and the request goes out exactly as built with the abort signal', async () => {
    const { transport, seen, clock } = setup(async () => Response.json({ text: 'done' }));
    expect(await transport.send(REQUEST)).toEqual({ kind: 'completion', payload: { text: 'done' } });
    expect(seen[0]?.url).toBe(REQUEST.url);
    expect(seen[0]?.init).toMatchObject({ method: 'POST', headers: REQUEST.headers, body: REQUEST.body });
    expect(seen[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    // The timer is released when the exchange ends.
    expect(clock.pending()).toBe(0);
  });

  test('a request with no body sends none', async () => {
    const { transport, seen } = setup(async () => Response.json({}));
    const { body: _body, ...bare } = REQUEST;
    await transport.send({ ...bare, method: 'GET' });
    expect(seen[0]?.init).not.toHaveProperty('body');
  });

  test('a reply that is not JSON, or has no body at all, is unreadable', async () => {
    expect(await setup(async () => new Response('plain words')).transport.send(REQUEST)).toEqual({
      kind: 'unreadable',
    });
    expect(await setup(async () => new Response(null)).transport.send(REQUEST)).toEqual({ kind: 'unreadable' });
  });

  test('a failure status is reported with its Retry-After seconds only when the header is a number', async () => {
    const reply = (headers?: Record<string, string>) =>
      setup(async () => new Response(`echo ${SECRET}`, { status: 429, ...(headers === undefined ? {} : { headers }) }));
    expect(await reply({ 'retry-after': ' 30 ' }).transport.send(REQUEST)).toEqual({
      kind: 'status',
      status: 429,
      retryAfterSeconds: 30,
    });
    expect(await reply().transport.send(REQUEST)).toEqual({ kind: 'status', status: 429 });
    expect(await reply({ 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }).transport.send(REQUEST)).toEqual({
      kind: 'status',
      status: 429,
    });
    expect(await reply({ 'retry-after': '-5' }).transport.send(REQUEST)).toEqual({ kind: 'status', status: 429 });
  });

  test('a failure status never reports the body it carried', async () => {
    const outcome = await setup(async () => new Response(`echo ${SECRET}`, { status: 500 })).transport.send(REQUEST);
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
  });

  test('a declared length over the ceiling is refused without reading the body', async () => {
    let read = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          read = true;
        },
      },
      { highWaterMark: 0 },
    );
    const reply = new Response(body, { headers: { 'content-length': '65' } });
    expect(await setup(async () => reply).transport.send(REQUEST)).toEqual({ kind: 'oversized' });
    expect(read).toBe(false);
  });

  test('an undeclared reply is cut off the moment it crosses the ceiling', async () => {
    const reply = new Response(streamOf(bytes('x'.repeat(40)), bytes('y'.repeat(40)), bytes('never read')));
    const { transport } = setup(async () => reply);
    expect(await transport.send(REQUEST)).toEqual({ kind: 'oversized' });
  });

  test('a reply of several chunks, one of them empty, is read whole', async () => {
    const reply = new Response(streamOf(bytes('{"a":'), undefined, bytes('1}')));
    expect(await setup(async () => reply).transport.send(REQUEST)).toEqual({
      kind: 'completion',
      payload: { a: 1 },
    });
  });

  test('a stream that breaks mid-reply is unreadable', async () => {
    const broken = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error('connection reset');
      },
    });
    expect(await setup(async () => new Response(broken)).transport.send(REQUEST)).toEqual({ kind: 'unreadable' });
  });

  test('a host that cannot be reached is unreachable, with the cause for the caller to classify', async () => {
    const cause = new Error('ECONNREFUSED');
    const outcome = await setup(async () => {
      throw cause;
    }).transport.send(REQUEST);
    expect(outcome).toEqual({ kind: 'unreachable', cause });
  });

  test('a request that outlives its budget is aborted and reported as a timeout, even when the reply stalls mid-body', async () => {
    const stalled = setup(
      async init =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const sending = stalled.transport.send(REQUEST);
    await stalled.clock.advance(1000);
    expect(await sending).toEqual({ kind: 'timeout' });

    const midBody = setup(async init => {
      const body = new ReadableStream<Uint8Array>({
        pull: () =>
          new Promise<void>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      });
      return new Response(body);
    });
    const reading = midBody.transport.send(REQUEST);
    await Bun.sleep(0);
    await midBody.clock.advance(1000);
    expect(await reading).toEqual({ kind: 'timeout' });
  });

  test('a body or reader that cannot even be cancelled does not hold the exchange open', async () => {
    const hostile = (response: Response): Response => {
      Object.defineProperty(response, 'body', {
        value: {
          getReader: () => ({
            read: async () => ({ done: false, value: bytes('z'.repeat(100)) }),
            cancel: () => {
              throw new Error('will not cancel');
            },
          }),
          cancel: () => {
            throw new Error('will not cancel');
          },
        },
      });
      return response;
    };
    expect(await setup(async () => hostile(new Response('x', { status: 200 }))).transport.send(REQUEST)).toEqual({
      kind: 'oversized',
    });
    expect(await setup(async () => hostile(new Response('x', { status: 503 }))).transport.send(REQUEST)).toEqual({
      kind: 'status',
      status: 503,
    });
  });
});
