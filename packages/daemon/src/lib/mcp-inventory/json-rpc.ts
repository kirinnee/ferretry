/**
 * The three MCP messages a check sends, and reading what comes back. Pure.
 *
 * A check is the opening of a session and nothing else: `initialize`, the `initialized` notification,
 * then `tools/list` (following `nextCursor` a bounded number of times). Both transports carry the same
 * JSON-RPC; only how the bytes travel differs, which is the probe adapter's business.
 */

/** The protocol revision a check offers. A server answers with the one it speaks. */
export const MCP_CHECK_PROTOCOL_VERSION = '2025-06-18';

/** How many `tools/list` pages a check follows before it stops counting. */
export const MCP_CHECK_TOOL_PAGES = 5;

export const initializeRequest = (id: number): string =>
  JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: MCP_CHECK_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'ferretry-check', version: '1' },
    },
  });

export const initializedNotification = (): string =>
  JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });

export const toolsListRequest = (id: number, cursor?: string): string =>
  JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list', ...(cursor === undefined ? {} : { params: { cursor } }) });

/** A JSON-RPC error the server answered with, in its own words (clipped). */
export class McpRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpRpcError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const clip = (text: string, max = 200): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * The response with `id` among parsed messages, or undefined when none of them is it. A server may
 * send notifications or requests first; they are skipped. An error response raises its message.
 */
export function responseFor(messages: readonly unknown[], id: number): Record<string, unknown> | undefined {
  for (const message of messages.flatMap(entry => (Array.isArray(entry) ? entry : [entry]))) {
    if (!isRecord(message) || message.id !== id) continue;
    if (isRecord(message.error))
      throw new McpRpcError(
        typeof message.error.message === 'string' ? clip(message.error.message) : 'the server answered with an error',
      );
    return isRecord(message.result) ? message.result : {};
  }
  return undefined;
}

/** What `initialize` says the server calls itself. */
export const serverNameOf = (result: Record<string, unknown>): string | undefined =>
  isRecord(result.serverInfo) && typeof result.serverInfo.name === 'string'
    ? clip(result.serverInfo.name, 256)
    : undefined;

/** One `tools/list` page: the tool names, and the cursor to the next page. */
export function toolsPage(result: Record<string, unknown>): { readonly names: string[]; readonly next?: string } {
  const names = Array.isArray(result.tools)
    ? result.tools.flatMap(tool => (isRecord(tool) && typeof tool.name === 'string' ? [clip(tool.name, 256)] : []))
    : [];
  return typeof result.nextCursor === 'string' && result.nextCursor !== ''
    ? { names, next: result.nextCursor }
    : { names };
}

/** One server-sent event. */
export interface SseEvent {
  readonly event: string;
  readonly data: string;
}

/**
 * The complete events in a chunk of an event stream, and what is left over (an event not yet ended).
 * Lines are `field: value`; an event ends at a blank line; `data` lines join with newlines.
 */
export function sseEvents(buffer: string): { readonly events: SseEvent[]; readonly rest: string } {
  const normalised = buffer.replaceAll('\r\n', '\n');
  const blocks = normalised.split('\n\n');
  const rest = blocks.pop() ?? '';
  const events = blocks.flatMap(block => {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /u, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    return data.length === 0 && event === 'message' ? [] : [{ event, data: data.join('\n') }];
  });
  return { events, rest };
}

/** Parses a message's text, or answers undefined for text that is not JSON. */
export const parseMessage = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/**
 * Expands `${VAR}` and `${VAR:-default}` the way Claude Code expands a server's `env`, `args`,
 * `url` and `headers`. A variable `environment` does not hold, with no default, becomes empty and is
 * reported by name so the check can say what was missing.
 */
export function expandVariables(
  text: string,
  environment: Readonly<Record<string, string>>,
  missing: Set<string>,
): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/gu, (_whole, name: string, fallback?: string) => {
    const value = environment[name];
    if (value !== undefined) return value;
    if (fallback !== undefined) return fallback;
    missing.add(name);
    return '';
  });
}
