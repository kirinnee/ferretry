import { describe, expect, it } from 'bun:test';
import { FY_REQUEST_ID_HEADER, type TerminalListView, type TerminalView } from '@ferretry/protocol';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import {
  closeSessionTerminal,
  createSessionTerminal,
  daemonTerminalTicket,
  listSessionTerminals,
  renameSessionTerminal,
  terminalLimitLabel,
  terminalStreamUrl,
} from '../../src/lib/web-terminals.ts';

const daemonA = daemonConnection({
  daemonId: 'daemon-a',
  baseUrl: 'https://a.example.test',
  deviceToken: 'token-a',
});
const daemonB = daemonConnection({
  daemonId: 'daemon-b',
  baseUrl: 'https://b.example.test',
  deviceToken: 'token-b',
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
  it('addresses every call to the paired daemon with a bearer token, never the page origin', async () => {
    const { calls, fetcher } = recorder(list);
    expect(await listSessionTerminals(daemonA, scopeA, fetcher)).toEqual(list);
    expect(calls[0]?.url).toBe('https://a.example.test/v1/sessions/shared%2Fsession/terminals');
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get('authorization')).toBe('Bearer token-a');
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
    expect(() => terminalStreamUrl(daemonA, scopeB, TERMINAL_ID, 'ticket')).toThrow(crossed);
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
    expect(() => terminalStreamUrl(daemonA, scopeA, '../../secrets', 'ticket')).toThrow();
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

  it('builds a ticket-only stream URL on the paired daemon, upgrading the scheme', () => {
    expect(terminalStreamUrl(daemonA, scopeA, TERMINAL_ID, 'one-time')).toBe(
      `wss://a.example.test/v1/sessions/shared%2Fsession/terminals/${TERMINAL_ID}/stream?ticket=one-time`,
    );
    const insecure = daemonConnection({ daemonId: 'daemon-c', baseUrl: 'http://localhost:8787', deviceToken: 'c' });
    expect(terminalStreamUrl(insecure, daemonSessionScope(insecure, 's'), TERMINAL_ID, 't')).toBe(
      `ws://localhost:8787/v1/sessions/s/terminals/${TERMINAL_ID}/stream?ticket=t`,
    );
    expect(() => terminalStreamUrl(daemonA, scopeA, TERMINAL_ID, ' ')).toThrow('ticket must not be empty');
  });

  it('buys a terminal-scoped socket ticket with the device token kept in the request header', async () => {
    const { calls, fetcher } = recorder({
      ticket: `fy_ticket_${'t'.repeat(43)}`,
      ttlSeconds: 30,
      expiresAt: '2026-08-04T12:00:30.000Z',
    });

    await expect(daemonTerminalTicket(daemonA, scopeA, TERMINAL_ID, fetcher)).resolves.toBe(
      `fy_ticket_${'t'.repeat(43)}`,
    );

    expect(calls[0]?.url).toBe(
      `https://a.example.test/v1/sessions/shared%2Fsession/terminals/${TERMINAL_ID}/stream/ticket`,
    );
    expect(calls[0]?.init?.method).toBe('POST');
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer token-a');
  });

  it('reports the session and box counts in the original wording', () => {
    expect(terminalLimitLabel(list)).toBe('1/6 in this session · 3/24 on this box');
  });
});
