import type { Instant } from '@ferretry/std';
import { describe, expect, it } from 'bun:test';
import { DaemonCallError, FY_REQUEST_ID_HEADER } from '@ferretry/app';
import type { TerminalListView, TerminalView } from '../../../contract/index.ts';
import { daemonConnection, daemonSessionScope } from '../../../app/shell.ts';
import {
  closeSessionTerminal,
  consoleInputChunks,
  createSessionTerminal,
  endSessionQuarantine,
  listSessionQuarantines,
  listSessionTerminals,
  renameSessionTerminal,
  TERMINAL_ROUTES,
  terminalLimitLabel,
  typeIntoSessionConsole,
} from '../../../app/lib/web-terminals.ts';
import manifest from '../../../manifest.ts';

const daemonA = daemonConnection('daemon-a');
const daemonB = daemonConnection('daemon-b');
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
  createdAt: '2026-07-31T10:00:00.000Z' as Instant,
  lastActivityAt: '2026-07-31T10:01:00.000Z' as Instant,
} satisfies TerminalView;

const list = {
  sessionId: 'shared/session',
  terminals: [terminal],
  limits: { perSession: 6, global: 24, runningGlobal: 3, idleTimeoutSeconds: 900, scrollbackLines: 5_000 },
} satisfies TerminalListView;

interface Call {
  readonly route: string;
  readonly init: {
    readonly params?: Record<string, string>;
    readonly body?: unknown;
    readonly headers?: Record<string, string>;
    readonly quiet?: boolean;
  };
}

/** A client that records every call by route key and answers the next scripted body (the last one repeats). */
const recorder = (...bodies: readonly unknown[]) => {
  const calls: Call[] = [];
  let index = 0;
  const client = {
    call: async <T>(route: string, init: Call['init'] = {}): Promise<T> => {
      calls.push({ route, init });
      return bodies[Math.min(index++, bodies.length - 1)] as T;
    },
  };
  return { calls, client };
};

const refusing = (error: unknown) => ({
  call: async (): Promise<never> => {
    throw error;
  },
});

describe('web terminal transport', () => {
  it('calls the daemon’s routes by manifest key, one path part per param, and carries no credential', async () => {
    const { calls, client } = recorder(list);
    expect(await listSessionTerminals(client, daemonA, scopeA)).toEqual(list);
    expect(calls).toEqual([
      { route: TERMINAL_ROUTES.list, init: { params: { ferretId: 'shared/session' }, quiet: true } },
    ]);
    expect(calls[0]?.init.headers).toBeUndefined();
  });

  it('lists quietly by default, but an explicit read by the person is NOT quiet so the step-up can run', async () => {
    const quietly = recorder(list);
    await listSessionTerminals(quietly.client, daemonA, scopeA, { explicit: false });
    expect(quietly.calls[0]?.init.quiet).toBe(true);

    const pressed = recorder(list);
    await listSessionTerminals(pressed.client, daemonA, scopeA, { explicit: true });
    expect(pressed.calls).toEqual([{ route: TERMINAL_ROUTES.list, init: { params: { ferretId: 'shared/session' } } }]);
    expect(pressed.calls[0]?.init.quiet).toBeUndefined();
  });

  it('calls only routes the manifests declare: its own, bar the stream (a socket) and Vault’s quarantine pair', () => {
    const declared: ReadonlySet<string> = new Set((manifest.actions?.routes ?? []).map(each => each.key));
    const elsewhere: readonly string[] = [
      TERMINAL_ROUTES.stream,
      TERMINAL_ROUTES.quarantines,
      TERMINAL_ROUTES.endQuarantine,
    ];
    for (const route of Object.values<string>(TERMINAL_ROUTES))
      expect(declared.has(route) || elsewhere.includes(route)).toBe(true);
    expect((manifest.actions?.sockets ?? []).map(each => each.key)).toContain(TERMINAL_ROUTES.stream);
  });

  it('refuses a scope belonging to a different daemon on every operation, before anything is sent', async () => {
    const { calls, client } = recorder(list);
    const crossed = 'terminal scope must belong to the requested daemon';
    await expect(listSessionTerminals(client, daemonA, scopeB)).rejects.toThrow(crossed);
    await expect(createSessionTerminal(client, daemonA, scopeB)).rejects.toThrow(crossed);
    await expect(renameSessionTerminal(client, daemonA, scopeB, TERMINAL_ID, 'x')).rejects.toThrow(crossed);
    await expect(closeSessionTerminal(client, daemonA, scopeB, TERMINAL_ID)).rejects.toThrow(crossed);
    expect(calls).toHaveLength(0);
  });

  it('stamps a request id on mutations only', async () => {
    const { calls, client } = recorder(terminal);
    expect(await createSessionTerminal(client, daemonA, scopeA, { cols: 100, rows: 30 })).toEqual(terminal);
    expect(calls[0]?.route).toBe(TERMINAL_ROUTES.create);
    expect(calls[0]?.init.headers?.[FY_REQUEST_ID_HEADER]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(calls[0]?.init.body).toEqual({ cols: 100, rows: 30 });
  });

  it('sends an empty create body when the caller lets the daemon choose a size', async () => {
    const { calls, client } = recorder(terminal);
    await createSessionTerminal(client, daemonA, scopeA);
    expect(calls[0]?.init.body).toEqual({});
  });

  it('renames and closes one terminal by its daemon-issued id', async () => {
    const renamed = { ...terminal, title: 'tests' };
    const { calls, client } = recorder(renamed, { closed: true, id: TERMINAL_ID });
    expect(await renameSessionTerminal(client, daemonA, scopeA, TERMINAL_ID, 'tests')).toEqual(renamed);
    expect(calls[0]?.route).toBe(TERMINAL_ROUTES.rename);
    expect(calls[0]?.init.params).toEqual({ ferretId: 'shared/session', terminalId: TERMINAL_ID });
    expect(calls[0]?.init.body).toEqual({ title: 'tests' });
    expect(await closeSessionTerminal(client, daemonA, scopeA, TERMINAL_ID)).toEqual({
      closed: true,
      id: TERMINAL_ID,
    });
    expect(calls[1]?.route).toBe(TERMINAL_ROUTES.close);
    expect(calls[1]?.init.body).toBeUndefined();
  });

  it('rejects a terminal id that is not the daemon-issued shape before it reaches a path', async () => {
    const { calls, client } = recorder(terminal);
    await expect(renameSessionTerminal(client, daemonA, scopeA, '../../secrets', 'x')).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('rejects an invalid title rather than letting the daemon decide', async () => {
    const { calls, client } = recorder(terminal);
    await expect(renameSessionTerminal(client, daemonA, scopeA, TERMINAL_ID, '   ')).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('refuses a daemon answer describing another session or another terminal', async () => {
    const other = { ...list, sessionId: 'other', terminals: [] };
    await expect(listSessionTerminals(recorder(other).client, daemonA, scopeA)).rejects.toMatchObject({
      status: 502,
    });
    await expect(
      createSessionTerminal(recorder({ ...terminal, sessionId: 'other' }).client, daemonA, scopeA),
    ).rejects.toMatchObject({ status: 502 });
    await expect(
      closeSessionTerminal(recorder({ closed: true, id: 'ffffffffffff' }).client, daemonA, scopeA, TERMINAL_ID),
    ).rejects.toMatchObject({ status: 502 });
  });

  it('rejects a malformed daemon payload whole', async () => {
    await expect(listSessionTerminals(recorder({ nope: true }).client, daemonA, scopeA)).rejects.toThrow();
    await expect(
      createSessionTerminal(recorder({ ...terminal, state: 'exited' }).client, daemonA, scopeA),
    ).rejects.toThrow();
  });

  it('keeps daemon failure detail as the shell client raised it', async () => {
    const refusal = new DaemonCallError(404, 'not_found', 'no session');
    await expect(listSessionTerminals(refusing(refusal), daemonA, scopeA)).rejects.toMatchObject({
      status: 404,
      message: 'no session',
      code: 'not_found',
    });
  });

  it('reports the session and box counts in the original wording', () => {
    expect(terminalLimitLabel(list)).toBe('1/6 in this session · 3/24 on this box');
  });
});

describe('typing into the Console', () => {
  it('posts the keys to the session’s own pane on its own daemon, as a mutation', async () => {
    const { calls, client } = recorder({ written: 3 });
    expect(await typeIntoSessionConsole(client, daemonA, scopeA, 'ls\r')).toBe(3);
    expect(calls[0]?.route).toBe(TERMINAL_ROUTES.consoleInput);
    expect(calls[0]?.init.params).toEqual({ ferretId: 'shared/session' });
    expect(calls[0]?.init.body).toEqual({ data: 'ls\r' });
    expect(calls[0]?.init.headers?.[FY_REQUEST_ID_HEADER]).toBeDefined();
  });

  it('R546 sends a long paste as ordered writes and refuses another daemon’s scope', async () => {
    const { calls, client } = recorder({ written: 4_096 }, { written: 1 });
    expect(await typeIntoSessionConsole(client, daemonA, scopeA, 'x'.repeat(4_097))).toBe(4_097);
    expect(calls.map(call => (call.init.body as { data: string }).data.length)).toEqual([4_096, 1]);
    await expect(typeIntoSessionConsole(client, daemonA, scopeB, 'x')).rejects.toThrow(
      'terminal scope must belong to the requested daemon',
    );
  });

  it('keeps a refusal as the daemon said it', async () => {
    const refused = new DaemonCallError(401, 'unlock_required', 'unlock this machine first');
    await expect(typeIntoSessionConsole(refusing(refused), daemonA, scopeA, 'x')).rejects.toMatchObject({
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
    const quarantines = [{ key: 'dev', until: '2026-10-30T10:02:00.000Z' as Instant }];
    const { calls, client } = recorder({ quarantines });
    expect(await listSessionQuarantines(client, daemonA, scopeA)).toEqual({ quarantines });
    expect(calls).toEqual([
      { route: TERMINAL_ROUTES.quarantines, init: { params: { ferretId: 'shared/session' }, quiet: true } },
    ]);
    await expect(
      listSessionQuarantines(recorder({ quarantines: [{ key: 'dev' }] }).client, daemonA, scopeA),
    ).rejects.toThrow();
    await expect(listSessionQuarantines(client, daemonA, scopeB)).rejects.toThrow(
      'terminal scope must belong to the requested daemon',
    );
  });

  it('ends one quarantine by key as a mutation, and fails when the daemon did not end it', async () => {
    const { calls, client } = recorder({ ended: true });
    await endSessionQuarantine(client, daemonA, scopeA, 'dev');
    expect(calls[0]?.route).toBe(TERMINAL_ROUTES.endQuarantine);
    expect(calls[0]?.init.params).toEqual({ ferretId: 'shared/session', key: 'dev' });
    expect(calls[0]?.init.headers?.[FY_REQUEST_ID_HEADER]).toBeDefined();
    await expect(endSessionQuarantine(recorder({ ended: false }).client, daemonA, scopeA, 'dev')).rejects.toThrow(
      'daemon did not end the quarantine',
    );
  });
});
