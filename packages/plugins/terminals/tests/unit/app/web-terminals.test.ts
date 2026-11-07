import { describe, expect, it } from 'bun:test';
import { FY_REQUEST_ID_HEADER, type TerminalListView, type TerminalView } from '@ferretry/protocol';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import {
  browserTerminalStreamAttach,
  closeSessionTerminal,
  consoleInputChunks,
  createSessionTerminal,
  endSessionQuarantine,
  listSessionQuarantines,
  listSessionTerminals,
  renameSessionTerminal,
  terminalLimitLabel,
  typeIntoSessionConsole,
} from '../../src/lib/web-terminals.ts';

const daemonA = daemonConnection({
  daemonId: 'daemon-a',
  baseUrl: 'https://a.example.test',
  deviceId: 'token-a',
});
const daemonB = daemonConnection({
  daemonId: 'daemon-b',
  baseUrl: 'https://b.example.test',
  deviceId: 'token-b',
});
const scopeA = daemonSessionScope(daemonA, 'shared/session');
const scopeB = daemonSessionScope(daemonB, 'shared/session');
const TERMINAL_ID = 'a1b2c3d4e5f6';

const terminal = {
  id: TERMINAL_ID,
  sessionId: 'shared/session',
  title: 'build',
  state: 'running',
  cols: 80,
  rows: 24,
  viewers: 1,
  createdAt: '2026-07-31T10:00:00.000Z',
  lastActivityAt: '2026-07-31T10:01:00.000Z',
} satisfies TerminalView;

const list = {
  sessionId: 'shared/session',
  terminals: [terminal],
  limits: { perSession: 6, global: 24, runningGlobal: 3, idleTimeoutSeconds: 900, scrollbackLines: 5_000 },
} satisfies TerminalListView;

const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

const recorder = (...bodies: readonly unknown[]) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  let index = 0;
  const fetcher = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init });
    return response(bodies[Math.min(index++, bodies.length - 1)]);
  };
  return { calls, fetcher };
};

describe('web terminal transport', () => {
  it('addresses every call to the paired daemon, never the page origin, and carries no credential', async () => {
    const { calls, fetcher } = recorder(list);
    expect(await listSessionTerminals(daemonA, scopeA, fetcher)).toEqual(list);
    expect(calls[0]?.url).toBe('https://a.example.test/v1/sessions/shared%2Fsession/terminals');
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.has('authorization')).toBe(false);
    expect(headers.get(FY_REQUEST_ID_HEADER)).toBeNull();
    expect(calls[0]?.init?.credentials).toBe('include');
  });

  it('refuses a scope belonging to a different daemon on every operation', async () => {
    const { fetcher } = recorder(list);
    const crossed = 'terminal scope must belong to the requested daemon';
    await expect(listSessionTerminals(daemonA, scopeB, fetcher)).rejects.toThrow(crossed);
    await expect(createSessionTerminal(daemonA, scopeB, {}, fetcher)).rejects.toThrow(crossed);
    await expect(renameSessionTerminal(daemonA, scopeB, TERMINAL_ID, 'x', fetcher)).rejects.toThrow(crossed);
    await expect(closeSessionTerminal(daemonA, scopeB, TERMINAL_ID, fetcher)).rejects.toThrow(crossed);
  });

  it('stamps a request id and JSON content type on mutations only', async () => {
    const { calls, fetcher } = recorder(terminal);
    expect(await createSessionTerminal(daemonA, scopeA, { cols: 100, rows: 30 }, fetcher)).toEqual(terminal);
    const headers = new Headers(calls[0]?.init?.headers);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get(FY_REQUEST_ID_HEADER)).toMatch(/^[0-9a-f-]{36}$/u);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ cols: 100, rows: 30 });
  });

  it('sends an empty create body when the caller lets the daemon choose a size', async () => {
    const { calls, fetcher } = recorder(terminal);
    await createSessionTerminal(daemonA, scopeA, undefined, fetcher);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({});
  });

  it('renames and closes one terminal by its daemon-issued id', async () => {
    const renamed = { ...terminal, title: 'tests' };
    const { calls, fetcher } = recorder(renamed, { closed: true, id: TERMINAL_ID });
    expect(await renameSessionTerminal(daemonA, scopeA, TERMINAL_ID, 'tests', fetcher)).toEqual(renamed);
    expect(calls[0]?.url).toBe(`https://a.example.test/v1/sessions/shared%2Fsession/terminals/${TERMINAL_ID}`);
    expect(calls[0]?.init?.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ title: 'tests' });
    expect(await closeSessionTerminal(daemonA, scopeA, TERMINAL_ID, fetcher)).toEqual({
      closed: true,
      id: TERMINAL_ID,
    });
    expect(calls[1]?.init?.method).toBe('DELETE');
    expect(calls[1]?.init?.body).toBeUndefined();
  });

  it('rejects a terminal id that is not the daemon-issued shape before it reaches a URL', async () => {
    const { calls, fetcher } = recorder(terminal);
    await expect(renameSessionTerminal(daemonA, scopeA, '../../secrets', 'x', fetcher)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('rejects an invalid title rather than letting the daemon decide', async () => {
    const { calls, fetcher } = recorder(terminal);
    await expect(renameSessionTerminal(daemonA, scopeA, TERMINAL_ID, '   ', fetcher)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('refuses a daemon answer describing another session or another terminal', async () => {
    const other = { ...list, sessionId: 'other', terminals: [] };
    await expect(listSessionTerminals(daemonA, scopeA, async () => response(other))).rejects.toMatchObject({
      status: 502,
    });
    await expect(
      createSessionTerminal(daemonA, scopeA, {}, async () => response({ ...terminal, sessionId: 'other' })),
    ).rejects.toMatchObject({ status: 502 });
    await expect(
      closeSessionTerminal(daemonA, scopeA, TERMINAL_ID, async () => response({ closed: true, id: 'ffffffffffff' })),
    ).rejects.toMatchObject({ status: 502 });
  });

  it('rejects a malformed daemon payload whole', async () => {
    await expect(listSessionTerminals(daemonA, scopeA, async () => response({ nope: true }))).rejects.toThrow();
    await expect(
      createSessionTerminal(daemonA, scopeA, {}, async () => response({ ...terminal, state: 'exited' })),
    ).rejects.toThrow();
  });

  it('keeps daemon failure detail, falling back when the body is not JSON', async () => {
    await expect(
      listSessionTerminals(daemonA, scopeA, async () => response({ error: 'no session', code: 'not_found' }, 404)),
    ).rejects.toMatchObject({ status: 404, message: 'no session', code: 'not_found' });
    await expect(
      listSessionTerminals(daemonA, scopeA, async () => new Response('nope', { status: 503 })),
    ).rejects.toMatchObject({ status: 503, message: 'HTTP 503', code: undefined });
  });

  it('reports the session and box counts in the original wording', () => {
    expect(terminalLimitLabel(list)).toBe('1/6 in this session · 3/24 on this box');
  });
});

describe('typing into the Console', () => {
  it('posts the keys to the session’s own pane on its own daemon, as a mutation', async () => {
    const { calls, fetcher } = recorder({ written: 3 });
    expect(await typeIntoSessionConsole(daemonA, scopeA, 'ls\r', fetcher)).toBe(3);
    expect(calls[0]?.url).toBe('https://a.example.test/v1/sessions/shared%2Fsession/console/input');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ data: 'ls\r' });
    expect(new Headers(calls[0]?.init?.headers).get(FY_REQUEST_ID_HEADER)).not.toBeNull();
  });

  it('sends a long paste as ordered writes and refuses another daemon’s scope', async () => {
    const { calls, fetcher } = recorder({ written: 4_096 }, { written: 1 });
    expect(await typeIntoSessionConsole(daemonA, scopeA, 'x'.repeat(4_097), fetcher)).toBe(4_097);
    expect(calls.map(call => (JSON.parse(String(call.init?.body)) as { data: string }).data.length)).toEqual([
      4_096, 1,
    ]);
    await expect(typeIntoSessionConsole(daemonA, scopeB, 'x', fetcher)).rejects.toThrow(
      'terminal scope must belong to the requested daemon',
    );
  });

  it('keeps a grant refusal as the daemon said it', async () => {
    const refused = async () => response({ error: 'unlock this machine first', code: 'unlock_required' }, 401);
    await expect(typeIntoSessionConsole(daemonA, scopeA, 'x', refused)).rejects.toMatchObject({
      status: 401,
      code: 'unlock_required',
    });
  });

  it('never splits a surrogate pair across two writes', () => {
    expect(consoleInputChunks('ab😀c', 3)).toEqual(['ab', '😀c']);
    expect(consoleInputChunks('')).toEqual([]);
  });
});

describe('terminal quarantine transport', () => {
  it('reads the session quarantines from its own daemon and parses what comes back', async () => {
    const quarantines = [{ key: 'dev', until: '2026-10-30T10:02:00.000Z' }];
    const { calls, fetcher } = recorder({ quarantines });
    expect(await listSessionQuarantines(daemonA, scopeA, fetcher)).toEqual({ quarantines });
    expect(calls[0]?.url).toBe('https://a.example.test/v1/sessions/shared%2Fsession/input-quarantines');
    expect(calls[0]?.init?.method ?? 'GET').toBe('GET');
    await expect(
      listSessionQuarantines(daemonA, scopeA, recorder({ quarantines: [{ key: 'dev' }] }).fetcher),
    ).rejects.toThrow();
    await expect(listSessionQuarantines(daemonA, scopeB, fetcher)).rejects.toThrow(
      'terminal scope must belong to the requested daemon',
    );
  });

  it('ends one quarantine by key as a mutation, and fails when the daemon did not end it', async () => {
    const { calls, fetcher } = recorder({ ended: true });
    await endSessionQuarantine(daemonA, scopeA, 'dev', fetcher);
    expect(calls[0]?.url).toBe('https://a.example.test/v1/sessions/shared%2Fsession/input-quarantines/dev/end');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(new Headers(calls[0]?.init?.headers).get(FY_REQUEST_ID_HEADER)).not.toBeNull();
    await expect(endSessionQuarantine(daemonA, scopeA, 'dev', recorder({ ended: false }).fetcher)).rejects.toThrow(
      'daemon did not end the quarantine',
    );
  });

  it('asks the stream for reveal=1 only when a viewer chose to see a quarantined pane', async () => {
    const seen: { path: string; query?: readonly (readonly [string, string])[] }[] = [];
    const attach = browserTerminalStreamAttach((async (_daemon: unknown, request: (typeof seen)[number]) => {
      seen.push(request);
      return { onStreamClosed: () => undefined, sendStream: () => undefined, closeStream: () => undefined };
    }) as never);
    const handlers = {
      onOpen: () => undefined,
      onBytes: () => undefined,
      onClosed: () => undefined,
      onRefused: () => undefined,
    };
    await attach(daemonA, scopeA, TERMINAL_ID, handlers);
    await attach(daemonA, scopeA, TERMINAL_ID, handlers, { reveal: true });
    expect(seen[0]?.query).toBeUndefined();
    expect(seen[1]?.query).toEqual([['reveal', '1']]);
  });
});
