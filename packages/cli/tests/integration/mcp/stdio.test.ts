import { describe, it } from 'bun:test';
import should from 'should';
import { serveMcpOverStdio } from '../../../src/adapters/mcp/stdio';

/** Input as a client writes it: arbitrary chunks, not one message per chunk. */
async function* chunks(...parts: string[]): AsyncIterable<Uint8Array> {
  for (const part of parts) yield new TextEncoder().encode(part);
}

const echo = {
  handle: async (message: unknown) => {
    const { id, method } = message as { id?: number; method: string };
    if (id === undefined) return undefined;
    return { jsonrpc: '2.0' as const, id, result: { method } };
  },
};

/** A handler whose `slow` request stays open until `release()`, so "still running" is a fact and not a timer. */
function gatedEcho() {
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  return {
    release,
    handle: async (message: unknown) => {
      if ((message as { method: string }).method === 'slow') {
        let giveUp: ReturnType<typeof setTimeout> | undefined;
        const neverReleased = new Promise<never>((_, reject) => {
          giveUp = setTimeout(() => {
            reject(new Error('the quick request was never answered while the slow one was still running'));
          }, 30_000);
        });
        await Promise.race([gate, neverReleased]).finally(() => clearTimeout(giveUp));
      }
      return echo.handle(message);
    },
  };
}

describe('the MCP stdio transport', () => {
  it('should read one message per line, across chunk boundaries, and answer each on its own line', async () => {
    // Arrange
    const written: string[] = [];

    // Act
    await serveMcpOverStdio(
      echo,
      chunks(
        '{"jsonrpc":"2.0","id":1,"me',
        'thod":"ping"}\n\n{"jsonrpc":"2.0","method":"note"}\n',
        '{"jsonrpc":"2.0","id":2,"method":"last"}',
      ),
      line => written.push(line),
    );

    // Assert — the notification gets nothing, and the final line needs no newline.
    should(written).deepEqual([
      '{"jsonrpc":"2.0","id":1,"result":{"method":"ping"}}\n',
      '{"jsonrpc":"2.0","id":2,"result":{"method":"last"}}\n',
    ]);
  });

  it('should answer a quick request while a slow one is still running', async () => {
    const written: string[] = [];
    const handler = gatedEcho();
    await serveMcpOverStdio(
      handler,
      chunks('{"jsonrpc":"2.0","id":1,"method":"slow"}\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n'),
      line => {
        written.push(line);
        if ((JSON.parse(line) as { id: number }).id === 2) handler.release();
      },
    );
    should(written.map(line => (JSON.parse(line) as { id: number }).id)).deepEqual([2, 1]);
  });

  it('should answer a line that is not JSON with a parse error, and keep serving', async () => {
    const written: string[] = [];
    await serveMcpOverStdio(echo, chunks('not json\n{"jsonrpc":"2.0","id":3,"method":"ping"}\n'), line =>
      written.push(line),
    );
    should(written.map(line => JSON.parse(line))).deepEqual([
      { jsonrpc: '2.0', id: null, error: { code: -32_700, message: 'a message must be one line of JSON' } },
      { jsonrpc: '2.0', id: 3, result: { method: 'ping' } },
    ]);
  });

  it('should drop a line longer than its bound without holding it, and keep serving after it', async () => {
    // Arrange
    const written: string[] = [];

    // Act
    await serveMcpOverStdio(
      echo,
      chunks('x'.repeat(40), 'y'.repeat(40), 'z\n{"jsonrpc":"2.0","id":4,"method":"ping"}\n', 'w'.repeat(80)),
      line => written.push(line),
      64,
    );

    // Assert — one refusal per overlong line, never the line itself, and the request after it served.
    should(written).have.length(3);
    should(written.map(line => JSON.parse(line))).containDeep([
      { jsonrpc: '2.0', id: null, error: { code: -32_700, message: 'a message may be at most 64 bytes' } },
      { jsonrpc: '2.0', id: 4, result: { method: 'ping' } },
      { jsonrpc: '2.0', id: null, error: { code: -32_700, message: 'a message may be at most 64 bytes' } },
    ]);
  });
});
