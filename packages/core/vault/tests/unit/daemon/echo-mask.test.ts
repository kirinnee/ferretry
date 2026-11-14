import { describe, expect, test } from 'bun:test';
import { echoMask, maskEvent, maskJson, maskText, sanitizeBody } from '../../../daemon/lib/secrets/echo-mask.ts';

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
