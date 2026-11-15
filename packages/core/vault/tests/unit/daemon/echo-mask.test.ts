import { describe, expect, test } from 'bun:test';
import {
  echoMask,
  maskEvent,
  maskJson,
  maskReplyHeaders,
  maskText,
  sanitizeBody,
} from '../../../daemon/lib/secrets/echo-mask.ts';

const FAKE = 'FAKE-MCP-TOKEN-0123456789';
const around = echoMask([FAKE, `Bearer ${FAKE}`], '[x]');
const streamOf = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
const reply = (body: ReadableStream<Uint8Array>, type = 'application/json') =>
  new Response(body, { headers: { 'content-type': type } });
const read = async (stream: ReadableStream<string>): Promise<string> => {
  let all = '';
  for (const reader = stream.getReader(); ; ) {
    const next = await reader.read();
    if (next.done) return all;
    all += next.value;
  }
};

describe('checking a stranger’s reply for the credential: parse, decode every string, replace it whole', () => {
  test('a value split across chunk boundaries is found, because the body is read whole', async () => {
    const body = await sanitizeBody(reply(streamOf('{"a":"FAKE-MCP', '-TOKEN-01234', '56789","b":1}')), around);
    expect(body).toEqual({ kind: 'text', text: '{"a":"[x]","b":1}' });
  });

  test('a string that only starts like the value is passed through whole', async () => {
    const body = await sanitizeBody(reply(streamOf('{"a":"FAKE-MCP-TOKEN-0', '12 and FAKE"}')), around);
    expect(body).toEqual({ kind: 'text', text: '{"a":"FAKE-MCP-TOKEN-012 and FAKE"}' });
  });

  test('the scheme and value together, and the value alone, both replace the whole string', () => {
    expect(maskText(`Authorization: Bearer ${FAKE}`, around)).toBe('[x]');
    expect(maskText('nothing here', around)).toBe('nothing here');
  });

  test('JSON escapes of every kind, mixed, are found after the parse, keys included', () => {
    const escaped = [...FAKE]
      .map((char, index) => (index % 3 === 0 ? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}` : char))
      .join('');
    expect(maskJson(`{"k":"${escaped}","n":1}`, around)).toBe('{"k":"[x]","n":1}');
    expect(maskJson(`{"${escaped}":["${escaped}"]}`, around)).toBe('{"[x]":["[x]"]}');
  });

  test('a digit credential riding as a JSON number is replaced', () => {
    const digits = echoMask(['1234567890123'], '[x]');
    expect(maskJson('{"a":1234567890123,"b":12}', digits)).toBe('{"a":"[x]","b":12}');
  });

  test('a value too short to search for is checked only as it is', () => {
    const short = echoMask(['abc'], '[x]');
    expect(maskText('xabcx', short)).toBe('[x]');
    expect(maskText('x%61bcx', short)).toBe('x%61bcx');
  });

  test('text that is not JSON throws, so a caller drops the body', () => {
    expect(() => maskJson('FAKE-MCP', around)).toThrow();
  });

  test('an event is rebuilt from checked parts only', () => {
    const escaped = FAKE.replace('MCP', '\\u004d\\u0043\\u0050');
    expect(maskEvent(`: ${FAKE}\nid: ${FAKE}\nevent: message\nfoo: ${FAKE}\ndata: {"t":"${escaped}"}`, around)).toBe(
      'id: [x]\nevent: message\ndata: {"t":"[x]"}',
    );
  });

  test('a stream of events arrives whole, even when a chunk ends inside one', async () => {
    const body = await sanitizeBody(
      reply(streamOf('data: {"a":"FAKE-MC', 'P-TOKEN-0123456789"}\n', '\ndata: two\n\n'), 'text/event-stream'),
      around,
    );
    if (body.kind !== 'events') throw new Error('not events');
    expect(await read(body.events)).toBe('data: {"a":"[x]"}\n\ndata: two\n\n');
  });

  test('FAILS CLOSED on a stream that is not text, or too large, or too complex', async () => {
    const bad = await sanitizeBody(
      new Response(new Uint8Array([0xff, 0xfe, 0x0a, 0x0a]), { headers: { 'content-type': 'text/event-stream' } }),
      around,
    );
    if (bad.kind !== 'events') throw new Error('not events');
    await expect(read(bad.events)).rejects.toThrow('not valid text');
    const large = await sanitizeBody(reply(streamOf('data: x\n\n'.repeat(50)), 'text/event-stream'), around, 20);
    if (large.kind !== 'events') throw new Error('not events');
    await expect(read(large.events)).rejects.toThrow('larger');
    const deep = await sanitizeBody(
      reply(streamOf(`data: ${'['.repeat(300)}${']'.repeat(300)}\n\n`), 'text/event-stream'),
      around,
    );
    if (deep.kind !== 'events') throw new Error('not events');
    await expect(read(deep.events)).rejects.toThrow('too complex');
  });

  describe('FAILS CLOSED when the decoder round cap ends a chain that is not finished', () => {
    /** The value wrapped in `layers` rounds of base64: each layer is one more round of decoding to reach it. */
    const nested = (layers: number): string => {
      let text = `id=${FAKE};`;
      for (let layer = 0; layer < layers; layer += 1) text = Buffer.from(text).toString('base64');
      return text;
    };
    const DEEP = nested(9);

    test('a chain inside the cap is found and replaced; the same chain deeper than the cap is NOT passed as checked', () => {
      expect(maskText(nested(3), around)).toBe('[x]');
      // not found by decoding (the cap stops it), so it must be replaced because the check did not finish
      expect(maskText(DEEP, around)).toBe('[x]');
    });

    test('a JSON body holding an unfinished chain is refused (key or value), not returned', async () => {
      expect(() => maskJson(JSON.stringify({ a: DEEP }), around)).toThrow();
      expect(() => maskJson(JSON.stringify({ [DEEP]: 1 }), around)).toThrow();
      const body = await sanitizeBody(reply(streamOf(JSON.stringify({ a: DEEP }))), around);
      expect(body.kind).toBe('dropped');
    });

    test('an event stream holding an unfinished chain ends with an error instead of passing the event', async () => {
      const body = await sanitizeBody(
        reply(streamOf(`data: ${JSON.stringify({ a: DEEP })}\n\n`), 'text/event-stream'),
        around,
      );
      if (body.kind !== 'events') throw new Error('not events');
      await expect(read(body.events)).rejects.toThrow('too complex');
    });
  });

  test('a body of any type that is not JSON is dropped, whatever it says', async () => {
    for (const type of ['text/plain', 'text/html', 'application/xml', 'application/x-ndjson', 'image/png']) {
      const body = await sanitizeBody(reply(streamOf('hello'), type), around);
      expect(body.kind).toBe('dropped');
    }
    expect((await sanitizeBody(reply(streamOf('{}'), 'application/problem+json'), around)).kind).toBe('text');
    expect((await sanitizeBody(reply(streamOf('{}'), 'application/json; charset=utf-16'), around)).kind).toBe(
      'dropped',
    );
  });
});

describe('the edges of the check: what it keeps, what it refuses, and what it never swallows', () => {
  /** A mask whose `sent` list cannot be read: the only way to make the check fail with an error that is not its own bound. */
  const broken = {
    mask: '[x]',
    get sent(): never {
      throw new Error('boom');
    },
  };

  test('an HTML entity that is not a code point reads as nothing, so a value split by one is still found', () => {
    expect(maskText('FAKE-MCP&#x110000;-TOKEN-0123456789', around)).toBe('[x]');
    expect(maskText('a harmless &#1114112; string', around)).toBe('a harmless &#1114112; string');
  });

  test('a percent run that is not valid UTF-8 still decodes what it can, so the value beside it is found', () => {
    expect(maskText(`${FAKE}%ff%2d`, around)).toBe('[x]');
    expect(maskText('only %ff%2d noise here', around)).toBe('only %ff%2d noise here');
  });

  test('null and booleans in JSON are kept as they are', () => {
    expect(maskJson('{"a":null,"b":true,"c":false}', around)).toBe('{"a":null,"b":true,"c":false}');
  });

  test('a retry is kept only as digits that do not hold the credential', () => {
    expect(maskEvent('retry: 3000\ndata: x', around)).toBe('retry: 3000\ndata: x');
    expect(maskEvent('retry: soon\ndata: x', around)).toBe('data: x');
    const digits = echoMask(['3000'], '[x]');
    expect(maskEvent('retry: 3000\ndata: x', digits)).toBe('data: x');
  });

  test('an unexpected failure inside the check is thrown, never turned into a mask', () => {
    expect(() => maskText('anything', broken)).toThrow('boom');
    expect(() => maskJson('{"a":"b"}', broken)).toThrow('boom');
  });

  test('an unexpected failure while checking a JSON body is thrown from the reader, not reported as a dropped body', async () => {
    await expect(sanitizeBody(reply(streamOf('{"a":"b"}')), broken)).rejects.toThrow('boom');
  });

  test('a reply with no content, or a compressed one, is not read for the credential', async () => {
    const empty = await sanitizeBody(
      new Response(streamOf('ignored'), { headers: { 'content-type': 'application/json', 'content-length': '0' } }),
      around,
    );
    expect(empty).toEqual({ kind: 'text', text: '' });
    const gzip = await sanitizeBody(
      new Response(streamOf('x'), { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }),
      around,
    );
    expect(gzip.kind).toBe('dropped');
    if (gzip.kind === 'dropped') expect(gzip.why).toContain('compressed');
  });

  test('a JSON body past the byte bound is dropped, never clipped', async () => {
    const body = await sanitizeBody(reply(streamOf('{"a":"', 'x'.repeat(50), '"}')), around, 20);
    expect(body.kind).toBe('dropped');
    if (body.kind === 'dropped') expect(body.why).toContain('larger');
  });

  test('a JSON body that is not valid text, or not valid JSON, is dropped with its own sentence', async () => {
    const notText = await sanitizeBody(
      new Response(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]), { headers: { 'content-type': 'application/json' } }),
      around,
    );
    expect(notText.kind).toBe('dropped');
    if (notText.kind === 'dropped') expect(notText.why).toContain('not valid text');
    const notJson = await sanitizeBody(reply(streamOf('{"a":')), around);
    expect(notJson.kind).toBe('dropped');
    if (notJson.kind === 'dropped') expect(notJson.why).toContain('not valid JSON');
  });

  test('a body stream that breaks while being read is an error, not a dropped body', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('connection lost'));
      },
    });
    await expect(sanitizeBody(reply(stream), around)).rejects.toThrow('connection lost');
  });

  test('an event stream that ends inside a character, or holds an event with no blank line after it, is handled at the end', async () => {
    const cut = await sanitizeBody(reply(streamOf('data: ok\n\n'), 'text/event-stream'), around);
    if (cut.kind !== 'events') throw new Error('not events');
    expect(await read(cut.events)).toBe('data: ok\n\n');
    const half = await sanitizeBody(
      new Response(new Uint8Array([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xe2, 0x82]), {
        headers: { 'content-type': 'text/event-stream' },
      }),
      around,
    );
    if (half.kind !== 'events') throw new Error('not events');
    await expect(read(half.events)).rejects.toThrow('not valid text');
    const tail = await sanitizeBody(reply(streamOf(`data: {"a":"${FAKE}"}`), 'text/event-stream'), around);
    if (tail.kind !== 'events') throw new Error('not events');
    expect(await read(tail.events)).toBe('data: {"a":"[x]"}');
  });

  test('an unexpected failure while checking an event ends the stream with that failure', async () => {
    const stream = await sanitizeBody(reply(streamOf('data: x\n\n'), 'text/event-stream'), broken);
    if (stream.kind !== 'events') throw new Error('not events');
    await expect(read(stream.events)).rejects.toThrow('boom');
  });

  test('only the allowlisted reply headers are kept, each checked as a string', () => {
    const headers = new Headers({
      'content-type': 'application/json',
      'mcp-session-id': FAKE,
      'set-cookie': `session=${FAKE}`,
      'retry-after': '30',
    });
    expect(maskReplyHeaders(headers, around)).toEqual({
      'content-type': 'application/json',
      'mcp-session-id': '[x]',
      'retry-after': '30',
    });
  });
});
