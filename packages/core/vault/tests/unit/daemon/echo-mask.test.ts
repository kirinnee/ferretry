import { describe, expect, test } from 'bun:test';
import { maskEchoHeaders, maskEchoStream } from '../../../daemon/lib/secrets/echo-mask.ts';

const FAKE = 'FAKE-MCP-TOKEN-0123456789';
const streamOf = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
const read = async (stream: ReadableStream<Uint8Array>): Promise<string> => await new Response(stream).text();

describe('masking a credential out of a stranger’s reply', () => {
  test('a value split across chunk boundaries is still masked', async () => {
    const split = streamOf('{"a":"FAKE-MCP', '-TOKEN-01234', '56789","b":1}');
    expect(await read(maskEchoStream(split, FAKE, '[x]'))).toBe('{"a":"[x]","b":1}');
  });

  test('text that only starts like the value is passed through whole', async () => {
    expect(await read(maskEchoStream(streamOf('FAKE-MCP-TOKEN-0', '12 and FAKE'), FAKE, '[x]'))).toBe(
      'FAKE-MCP-TOKEN-012 and FAKE',
    );
  });

  test('every header value is masked', () => {
    const masked = maskEchoHeaders(new Headers({ 'x-echo': `Bearer ${FAKE}`, other: 'fine' }), FAKE, '[x]');
    expect(masked.get('x-echo')).toBe('Bearer [x]');
    expect(masked.get('other')).toBe('fine');
  });
});
