import { describe, expect, test } from 'bun:test';
import { echoMask, maskEvent, maskPayload, maskText, sanitizeBody } from '../../../daemon/lib/secrets/echo-mask.ts';

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

describe('masking a credential out of a stranger’s reply, whole and in every spelling', () => {
  test('a value split across chunk boundaries is still masked', async () => {
    const body = await sanitizeBody(reply(streamOf('{"a":"FAKE-MCP', '-TOKEN-01234', '56789","b":1}')), around);
    expect(body).toEqual({ kind: 'text', text: '{"a":"[x]","b":1}' });
  });

  test('text that only starts like the value is passed through whole', async () => {
    const body = await sanitizeBody(reply(streamOf('FAKE-MCP-TOKEN-0', '12 and FAKE'), 'text/plain'), around);
    expect(body).toEqual({ kind: 'text', text: 'FAKE-MCP-TOKEN-012 and FAKE' });
  });

  test('the scheme and value together, and the value alone, both go', () => {
    expect(maskText(`Authorization: Bearer ${FAKE}`, around)).toBe('Authorization: [x]');
  });

  test('JSON escapes of every kind, mixed, are found after the parse', () => {
    const escaped = [...FAKE]
      .map((char, index) => (index % 3 === 0 ? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}` : char))
      .join('');
    expect(maskPayload(`{"k":"${escaped}","n":1}`, around)).toBe('{"k":"[x]","n":1}');
    expect(maskPayload(`{"${escaped}":["${escaped}"]}`, around)).toBe('{"[x]":["[x]"]}');
  });

  test('NDJSON is masked line by line', () => {
    const escaped = FAKE.replace('MCP', '\\u004d\\u0043\\u0050');
    expect(maskPayload(`{"a":1}\n{"b":"${escaped}"}\n`, around)).toBe('{"a":1}\n{"b":"[x]"}\n');
  });

  test('an event masks its data as one payload and every other line as text', () => {
    const escaped = FAKE.replace('MCP', '\\u004d\\u0043\\u0050');
    expect(maskEvent(`id: ${FAKE}\nevent: message\ndata: {"t":"${escaped}"}`, around)).toBe(
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

  test('FAILS CLOSED on a stream that is not text, or too large', async () => {
    const bad = await sanitizeBody(
      new Response(new Uint8Array([0xff, 0xfe, 0x0a, 0x0a]), { headers: { 'content-type': 'text/event-stream' } }),
      around,
    );
    if (bad.kind !== 'events') throw new Error('not events');
    await expect(read(bad.events)).rejects.toThrow('not valid text');
    const large = await sanitizeBody(reply(streamOf('data: x\n\n'.repeat(50)), 'text/event-stream'), around, 20);
    if (large.kind !== 'events') throw new Error('not events');
    await expect(read(large.events)).rejects.toThrow('larger');
  });
});
