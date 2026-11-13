/**
 * The bytes of an MCP check: a command over stdio, a Streamable HTTP endpoint, or a legacy SSE stream.
 *
 * Each transport opens a session (`initialize`, `notifications/initialized`) and lists tools, under the
 * caller's deadline. A failure becomes a {@link McpProbeFailure} whose message is this adapter's own
 * sentence plus, at most, a status code or the last line a command printed to stderr — never a header,
 * never a body the server sent (which the check service redacts anyway).
 */

import type { MintedExchangeOutcome, MintedExchangeRequest } from '@ferretry/core-vault/contract';
import type { ChildEnvironment, ChildHandle, KernelPorts } from '@ferretry/kernel/contract';
import type { Result } from '@ferretry/std';
import { type McpProbe, type McpProbeAnswer, McpProbeFailure, type McpProbeSpec } from '../lib/inventory/check.ts';
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
} from '../lib/inventory/json-rpc.ts';

type RemoteSpec = Extract<McpProbeSpec, { readonly url: string }>;

/** What a check reaches the world with: the kernel's spawn, fetch and clock, nothing else. */
export type ProbePorts = Pick<KernelPorts, 'spawn' | 'fetch' | 'clock'>;

/**
 * What opens a command's `${secret:NAME}` references for ONE child: the Vault's child environment (use, never read). The
 * values are in that child's environment and nowhere else; a name the Vault does not hold comes back as a name.
 */
export interface ProbeSecrets {
  childEnvironment(
    env: Readonly<Record<string, string>>,
  ): Promise<Result<ChildEnvironment, { readonly unknown: readonly string[] }>>;
  /**
   * ONE request with a secret THIS plugin minted placed on it by the Vault (use, never read): the reply is the server's,
   * the credential masked out. Absent: the Vault offers none, and a check that needs one says so.
   */
  fetchMinted?(
    secret: string,
    request: MintedExchangeRequest,
    placement: { readonly header: string; readonly scheme?: string },
  ): Promise<MintedExchangeOutcome>;
}

/** Whether a value names a stored secret (`${secret:NAME}`, or the optional `${secret?:NAME}`). */
const namesSecret = (value: string): boolean => /\$\{secret\??:/u.test(value);

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

async function probeStdio(
  ports: ProbePorts,
  secrets: ProbeSecrets | undefined,
  spec: Extract<McpProbeSpec, { transport: 'stdio' }>,
  signal: AbortSignal,
) {
  let child: ChildHandle;
  // A value that names a stored secret is opened by the Vault for this one child; every other value passes as it is.
  let env: Readonly<Record<string, string>> | ChildEnvironment = { ...spec.env };
  if (secrets !== undefined && Object.values(spec.env).some(namesSecret)) {
    const opened = await secrets.childEnvironment(spec.env);
    if (!opened.ok)
      throw new McpProbeFailure(
        'unreachable',
        `It names ${opened.error.unknown.length === 1 ? 'a secret' : 'secrets'} that ${opened.error.unknown.length === 1 ? 'is' : 'are'} not stored: ${opened.error.unknown.join(', ')}.`,
      );
    env = opened.value;
  }
  try {
    child = ports.spawn.start(spec.command, spec.args, {
      ...(spec.cwd === undefined ? {} : { cwd: spec.cwd as never }),
      env,
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
    // Whole, like every stranger's string here: the check scrubs it and THEN clips it.
    return lines.length === 0 ? '' : ` It said: “${lines[lines.length - 1] ?? ''}”`;
  };
  const exited = child.exited.then(code => code);
  const kill = (): void => {
    child.kill();
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
      child.write(`${message}\n`);
      if (id === undefined) return undefined;
      for (;;) {
        const found = responseFor(messages, id);
        if (found !== undefined) return found;
        if (!(await next())) {
          const failure = timedOut(signal);
          if (failure !== undefined) throw failure;
          const code = await Promise.race([exited, ports.clock.sleep(200 as never).then(() => undefined)]);
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

/** The reply for a request that carries a held sign-in: placed by the Vault, never by this plugin. */
async function sendCredentialed(
  secrets: ProbeSecrets | undefined,
  credential: NonNullable<RemoteSpec['credential']>,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const host = new URL(url).host;
  if (secrets?.fetchMinted === undefined)
    throw new McpProbeFailure('unreachable', 'This machine has no way to present a held sign-in, so it was not sent.');
  const method = init.method === 'DELETE' || init.method === 'GET' ? init.method : 'POST';
  const outcome = await secrets.fetchMinted(
    credential.secret,
    {
      method,
      url,
      headers: { ...(init.headers as Record<string, string>) },
      ...(typeof init.body === 'string' ? { body: init.body } : {}),
      ...(init.signal === undefined || init.signal === null ? {} : { signal: init.signal }),
    },
    { header: credential.header, ...(credential.scheme === undefined ? {} : { scheme: credential.scheme }) },
  );
  switch (outcome.kind) {
    case 'response':
      return outcome.response;
    case 'aborted':
      throw new McpProbeFailure('timeout', '');
    case 'secret_missing':
      throw new McpProbeFailure('unauthorized', 'The held sign-in is gone.');
    case 'vault_damaged':
      throw new McpProbeFailure('unreachable', 'The secret store could not be opened, so the sign-in was not sent.');
    case 'unreachable':
      throw new McpProbeFailure(
        'unreachable',
        `Nothing answered at ${host}${outcome.certificate ? ' (its certificate was refused)' : ''}.`,
      );
    case 'refused':
      throw new McpProbeFailure(
        'unreachable',
        `The held sign-in could not be presented to ${host}; signing in again may fix it.`,
      );
  }
}

async function send(
  ports: ProbePorts,
  url: string,
  init: RequestInit,
  carried?: { readonly secrets: ProbeSecrets | undefined; readonly credential: RemoteSpec['credential'] },
): Promise<Response> {
  if (carried?.credential !== undefined) return await sendCredentialed(carried.secrets, carried.credential, url, init);
  try {
    return await ports.fetch.request(url, { ...init, redirect: 'manual' });
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

async function probeHttp(ports: ProbePorts, secrets: ProbeSecrets | undefined, spec: RemoteSpec, signal: AbortSignal) {
  let session: string | undefined;
  let protocol: string | undefined;
  const carried = { secrets, credential: spec.credential };
  const answer = await exchange(async (message, id) => {
    const response = await send(
      ports,
      spec.url,
      {
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
      },
      carried,
    );
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
    await send(
      ports,
      spec.url,
      {
        method: 'DELETE',
        headers: { ...spec.headers, 'mcp-session-id': session },
        signal: AbortSignal.timeout(2000),
      },
      carried,
    ).then(
      reply => reply.body?.cancel().catch(() => undefined),
      () => undefined,
    );
  return answer;
}

// ── Legacy SSE ───────────────────────────────────────────────────────────────────────────────────

async function probeSse(ports: ProbePorts, secrets: ProbeSecrets | undefined, spec: RemoteSpec, signal: AbortSignal) {
  const carried = { secrets, credential: spec.credential };
  const stream = await send(
    ports,
    spec.url,
    { method: 'GET', signal, headers: { ...spec.headers, accept: 'text/event-stream' } },
    carried,
  );
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
      const response = await send(
        ports,
        target,
        { method: 'POST', signal, headers: { ...spec.headers, 'content-type': 'application/json' }, body: message },
        carried,
      );
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
  constructor(
    private readonly ports: ProbePorts,
    private readonly secrets?: ProbeSecrets,
  ) {}

  async probe(spec: McpProbeSpec, signal: AbortSignal): Promise<McpProbeAnswer> {
    if (spec.transport === 'stdio') return await probeStdio(this.ports, this.secrets, spec, signal);
    try {
      return spec.transport === 'sse'
        ? await probeSse(this.ports, this.secrets, spec, signal)
        : await probeHttp(this.ports, this.secrets, spec, signal);
    } catch (error) {
      throw timedOut(signal) ?? error;
    }
  }
}
