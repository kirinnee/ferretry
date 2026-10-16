import { JSON_RPC_ERRORS, type JsonRpcResponse } from '../../lib/mcp/server.ts';

/** The one method the transport needs from a server. */
export interface McpMessageHandler {
  handle(message: unknown): Promise<JsonRpcResponse | undefined>;
}

/**
 * The longest message this server reads. A tool call is a few kilobytes; a client that sends a line
 * longer than this is answered with a parse error and the line is dropped, rather than buffered until
 * the process runs out of memory.
 */
const MCP_MAX_LINE_BYTES = 1_048_576;

const parseError = (message: string): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id: null,
  error: { code: JSON_RPC_ERRORS.parse, message },
});

/**
 * MCP's stdio transport: one JSON-RPC message per line in, one per line out.
 *
 * Messages are handled CONCURRENTLY and answered as each finishes, because a client may send a
 * `ping` while a long `terminal_wait` is still running and must not have to wait behind it. The
 * promise resolves once the input has ended and every answer has been written.
 */
export async function serveMcpOverStdio(
  server: McpMessageHandler,
  input: AsyncIterable<Uint8Array>,
  write: (line: string) => void,
  maxLineBytes: number = MCP_MAX_LINE_BYTES,
): Promise<void> {
  const decoder = new TextDecoder();
  const pending = new Set<Promise<void>>();
  const respond = (response: JsonRpcResponse | undefined): void => {
    if (response !== undefined) write(`${JSON.stringify(response)}\n`);
  };
  const dispatch = (line: string): void => {
    if (line.trim() === '') return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      respond(parseError('a message must be one line of JSON'));
      return;
    }
    const work = server.handle(message).then(respond);
    pending.add(work);
    void work.finally(() => pending.delete(work));
  };

  let buffer = '';
  let discarding = false;
  for await (const chunk of input) {
    buffer += decoder.decode(chunk, { stream: true });
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (discarding) discarding = false;
      else dispatch(line);
    }
    if (Buffer.byteLength(buffer, 'utf8') > maxLineBytes) {
      if (!discarding) respond(parseError(`a message may be at most ${String(maxLineBytes)} bytes`));
      discarding = true;
      buffer = '';
    }
  }
  if (!discarding) dispatch(buffer + decoder.decode());
  await Promise.all(pending);
}
