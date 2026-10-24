/**
 * The bytes of an MCP check: a command over stdio, a Streamable HTTP endpoint, or a legacy SSE stream.
 *
 * Each transport opens a session (`initialize`, `notifications/initialized`) and lists tools, under the
 * caller's deadline. A failure becomes a {@link McpProbeFailure} whose message is this adapter's own
 * sentence plus, at most, a status code or the last line a command printed to stderr — never a header,
 * never a body the server sent (which the check service redacts anyway).
 */

import {
  type McpProbe,
  type McpProbeAnswer,
  McpProbeFailure,
  type McpProbeSpec,
} from '../../lib/mcp-inventory/check.ts';
import {
  initializedNotification,
  initializeRequest,
  MCP_CHECK_TOOL_PAGES,
  McpRpcError,
  parseMessage,
  responseFor,
  serverNameOf,
  sseEvents,
  toolsListRequest,
  toolsPage,
} from '../../lib/mcp-inventory/json-rpc.ts';

type RemoteSpec = Extract<McpProbeSpec, { readonly url: string }>;

/** The most a check reads of one response body. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** The most of a command's stderr a check keeps, for its last line. */
const MAX_STDERR_BYTES = 8 * 1024;

const clip = (text: string, max = 200): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const timedOut = (signal: AbortSignal): McpProbeFailure | undefined =>
  signal.aborted ? new McpProbeFailure('timeout', '') : undefined;

/** Runs the session-opening exchange over any request/response pair. */
async function exchange(
  send: (message: string, id: number | undefined) => Promise<Record<string, unknown> | undefined>,
): Promise<McpProbeAnswer> {
  try {
    const initialized = await send(initializeRequest(1), 1);
    if (initialized === undefined) throw new McpProbeFailure('protocol', 'It never answered initialize.');
    await send(initializedNotification(), undefined);
    const tools: string[] = [];
    let cursor: string | undefined;
    for (let page = 0, id = 2; page < MCP_CHECK_TOOL_PAGES; page += 1, id += 1) {
      const result = await send(toolsListRequest(id, cursor), id);
      if (result === undefined) throw new McpProbeFailure('protocol', 'It never answered tools/list.');
      const read = toolsPage(result);
      tools.push(...read.names);
      if (read.next === undefined) break;
      cursor = read.next;
    }
    const serverName = serverNameOf(initialized);
    return { ...(serverName === undefined ? {} : { serverName }), tools };
  } catch (error) {
    if (error instanceof McpRpcError) throw new McpProbeFailure('protocol', `It refused: ${error.message}`);
    throw error;
  }
}

// ── stdio ────────────────────────────────────────────────────────────────────────────────────────

async function probeStdio(spec: Extract<McpProbeSpec, { transport: 'stdio' }>, signal: AbortSignal) {
  let child: ReturnType<typeof Bun.spawn<'pipe', 'pipe', 'pipe'>>;
  try {
    child = Bun.spawn([spec.command, ...spec.args], {
      cwd: spec.cwd,
      env: { ...spec.env },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch {
    throw new McpProbeFailure(
      'unreachable',
      `The command ${clip(spec.command, 120)} could not be started (is it installed?).`,
    );
  }
  const stderr: string[] = [];
  let stderrBytes = 0;
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr) {
      if (stderrBytes >= MAX_STDERR_BYTES) continue;
      stderrBytes += chunk.byteLength;
      stderr.push(decoder.decode(chunk, { stream: true }));
    }
  })().catch(() => undefined);
  const lastStderr = (): string => {
    const lines = stderr
      .join('')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line !== '');
    return lines.length === 0 ? '' : ` It said: “${clip(lines[lines.length - 1] ?? '')}”`;
  };
  const exited = child.exited.then(code => code);
  const kill = (): void => {
    try {
      child.kill();
    } catch {
      // already gone
    }
  };
  signal.addEventListener('abort', kill, { once: true });

  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const messages: unknown[] = [];
  const next = async (): Promise<boolean> => {
    const read = await Promise.race([reader.read(), exited.then(() => ({ done: true, value: undefined }) as const)]);
    if (read.done || read.value === undefined) return false;
    buffer += decoder.decode(read.value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const message = parseMessage(line.trim());
      if (message !== undefined) messages.push(message);
    }
    return true;
  };
  try {
    return await exchange(async (message, id) => {
      child.stdin.write(`${message}\n`);
      await child.stdin.flush();
      if (id === undefined) return undefined;
      for (;;) {
        const found = responseFor(messages, id);
        if (found !== undefined) return found;
        if (!(await next())) {
          const failure = timedOut(signal);
          if (failure !== undefined) throw failure;
          const code = await Promise.race([exited, Bun.sleep(200).then(() => undefined)]);
          throw new McpProbeFailure(
            'unreachable',
            `The command stopped${code === undefined ? '' : ` (exit code ${code})`} before it answered.${lastStderr()}`,
          );
        }
      }
    });
  } catch (error) {
    throw timedOut(signal) ?? error;
  } finally {
    signal.removeEventListener('abort', kill);
    kill();
    reader.releaseLock();
  }
}

// ── HTTP ─────────────────────────────────────────────────────────────────────────────────────────

const statusFailure = (status: number): McpProbeFailure =>
  status === 401 || status === 403
    ? new McpProbeFailure('unauthorized', `It answered ${status}.`)
    : new McpProbeFailure(
        status >= 500 ? 'unreachable' : 'protocol',
        `It answered HTTP ${status}${status === 404 || status === 405 ? ' — is this the MCP endpoint, and the right transport?' : '.'}`,
      );

async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, redirect: 'manual' });
  } catch (error) {
    if (init.signal?.aborted === true) throw new McpProbeFailure('timeout', '');
    const reason =
      error instanceof Error && /certificate|ssl|tls/iu.test(error.message) ? ' (its certificate was refused)' : '';
    throw new McpProbeFailure('unreachable', `Nothing answered at ${new URL(url).host}${reason}.`);
  }
}

/** Reads a body as messages: one JSON document, or every `data` of an event stream until `id` answers. */
async function messagesOf(response: Response, id: number | undefined): Promise<unknown[]> {
  if (response.body === null) return [];
  const type = response.headers.get('content-type') ?? '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  const messages: unknown[] = [];
  try {
    for (;;) {
      const read = await reader.read();
      if (read.done) break;
      bytes += read.value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw new McpProbeFailure('protocol', 'Its answer was too large.');
      text += decoder.decode(read.value, { stream: true });
      if (type.includes('text/event-stream')) {
        const parsed = sseEvents(text);
        text = parsed.rest;
        for (const event of parsed.events) {
          const message = parseMessage(event.data);
          if (message !== undefined) messages.push(message);
        }
        if (id !== undefined && responseFor(messages, id) !== undefined) break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (!type.includes('text/event-stream')) {
    const message = parseMessage(text);
    if (message !== undefined) messages.push(message);
  }
  return messages;
}

async function probeHttp(spec: RemoteSpec, signal: AbortSignal) {
  let session: string | undefined;
  let protocol: string | undefined;
  const answer = await exchange(async (message, id) => {
    const response = await send(spec.url, {
      method: 'POST',
      signal,
      headers: {
        ...spec.headers,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(session === undefined ? {} : { 'mcp-session-id': session }),
        ...(protocol === undefined ? {} : { 'mcp-protocol-version': protocol }),
      },
      body: message,
    });
    if (response.status >= 300 && response.status < 400)
      throw new McpProbeFailure('protocol', `It redirected (HTTP ${response.status}); use the address it moved to.`);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw statusFailure(response.status);
    }
    session ??= response.headers.get('mcp-session-id') ?? undefined;
    if (id === undefined) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const found = responseFor(await messagesOf(response, id), id);
    if (id === 1 && found !== undefined && typeof found.protocolVersion === 'string') protocol = found.protocolVersion;
    return found;
  });
  if (session !== undefined)
    await fetch(spec.url, {
      method: 'DELETE',
      headers: { ...spec.headers, 'mcp-session-id': session },
      signal: AbortSignal.timeout(2000),
    }).catch(() => undefined);
  return answer;
}

// ── Legacy SSE ───────────────────────────────────────────────────────────────────────────────────

async function probeSse(spec: RemoteSpec, signal: AbortSignal) {
  const stream = await send(spec.url, {
    method: 'GET',
    signal,
    headers: { ...spec.headers, accept: 'text/event-stream' },
  });
  if (!stream.ok || stream.body === null) {
    await stream.body?.cancel().catch(() => undefined);
    throw statusFailure(stream.status);
  }
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let endpoint: string | undefined;
  const messages: unknown[] = [];
  const pump = async (): Promise<boolean> => {
    const read = await reader.read();
    if (read.done) return false;
    text += decoder.decode(read.value, { stream: true });
    const parsed = sseEvents(text);
    text = parsed.rest;
    for (const event of parsed.events) {
      if (event.event === 'endpoint') endpoint = new URL(event.data.trim(), spec.url).toString();
      else {
        const message = parseMessage(event.data);
        if (message !== undefined) messages.push(message);
      }
    }
    return true;
  };
  try {
    while (endpoint === undefined)
      if (!(await pump())) throw new McpProbeFailure('protocol', 'Its event stream ended before it named an endpoint.');
    const target = endpoint;
    if (new URL(target).origin !== new URL(spec.url).origin)
      throw new McpProbeFailure(
        'protocol',
        'It named an endpoint on another host; a check does not send headers there.',
      );
    return await exchange(async (message, id) => {
      const response = await send(target, {
        method: 'POST',
        signal,
        headers: { ...spec.headers, 'content-type': 'application/json' },
        body: message,
      });
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok) throw statusFailure(response.status);
      if (id === undefined) return undefined;
      for (;;) {
        const found = responseFor(messages, id);
        if (found !== undefined) return found;
        if (!(await pump())) throw new McpProbeFailure('protocol', 'Its event stream ended before it answered.');
      }
    });
  } catch (error) {
    throw timedOut(signal) ?? error;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export class TransportMcpProbe implements McpProbe {
  async probe(spec: McpProbeSpec, signal: AbortSignal): Promise<McpProbeAnswer> {
    if (spec.transport === 'stdio') return await probeStdio(spec, signal);
    try {
      return spec.transport === 'sse' ? await probeSse(spec, signal) : await probeHttp(spec, signal);
    } catch (error) {
      throw timedOut(signal) ?? error;
    }
  }
}
