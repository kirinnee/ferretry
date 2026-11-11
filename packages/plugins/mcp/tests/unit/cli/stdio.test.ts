import { describe, it } from 'bun:test';
import should from 'should';
import { serveMcpOverStdio } from '../../../cli/adapters/stdio.ts';
import { McpServer } from '../../../cli/lib/serve/server.ts';

const bytes = (...parts: string[]): AsyncIterable<Uint8Array> =>
  (async function* () {
    for (const part of parts) yield new TextEncoder().encode(part);
  })();

const server = (call: (name: string) => Promise<{ text: string }> = async () => ({ text: 'ok' })) =>
  new McpServer({ call: async name => await call(name) }, { name: 'ferretry', version: '1.0.0' });

async function run(input: AsyncIterable<Uint8Array>, handler = server(), max?: number): Promise<unknown[]> {
  const lines: string[] = [];
  await serveMcpOverStdio(handler, input, line => lines.push(line), max);
  return lines.map(line => JSON.parse(line) as unknown);
}

describe('serveMcpOverStdio', () => {
  it('should answer one JSON-RPC message per line, one line per answer, and nothing for a notification', async () => {
    const answers = await run(
      bytes(
        '{"jsonrpc":"2.0","id":1,"method":"ping"}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n',
        '{"jsonrpc":"2.0","id":2,"method":"ping"}\n',
      ),
    );
    should(answers).eql([
      { jsonrpc: '2.0', id: 1, result: {} },
      { jsonrpc: '2.0', id: 2, result: {} },
    ]);
  });

  it('should join a message that arrives in pieces, and read a last line with no newline', async () => {
    const answers = await run(bytes('{"jsonrpc":"2.0",', '"id":1,"method":"pi', 'ng"}'));
    should(answers).eql([{ jsonrpc: '2.0', id: 1, result: {} }]);
  });

  it('should answer a line that is not JSON with a parse error and carry on', async () => {
    const answers = await run(bytes('not json\n{"jsonrpc":"2.0","id":1,"method":"ping"}\n\n'));
    should(answers).eql([
      { jsonrpc: '2.0', id: null, error: { code: -32_700, message: 'a message must be one line of JSON' } },
      { jsonrpc: '2.0', id: 1, result: {} },
    ]);
  });

  it('should drop a line over the cap with one parse error, then read on', async () => {
    const answers = await run(
      bytes(`${'x'.repeat(200)}`, '\n{"jsonrpc":"2.0","id":3,"method":"ping"}\n'),
      server(),
      100,
    );
    should(answers).have.length(2);
    should(answers[0]).match({ error: { code: -32_700 } });
    should(answers[1]).eql({ jsonrpc: '2.0', id: 3, result: {} });
  });

  it('should answer a ping while a long call is still running, and write the long answer once it ends', async () => {
    let release: () => void = () => undefined;
    const slow = new Promise<void>(resolve => {
      release = resolve;
    });
    const lines: string[] = [];
    const done = serveMcpOverStdio(
      server(async () => {
        await slow;
        return { text: 'late' };
      }),
      bytes(
        '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"terminal_list"}}\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n',
      ),
      line => lines.push(line),
    );
    await new Promise(resolve => setTimeout(resolve, 20));
    should(lines.map(line => (JSON.parse(line) as { id: number }).id)).eql([2]);
    release();
    await done;
    should(lines.map(line => (JSON.parse(line) as { id: number }).id)).eql([2, 1]);
  });
});
