import type { Instant } from '@ferretry/std';
import { describe, expect, it } from 'bun:test';
import type { TerminalListView, TerminalView } from '../../../contract/index.ts';
import {
  closeSessionTerminal,
  consoleInputChunks,
  createSessionTerminal,
  endSessionQuarantine,
  listSessionQuarantines,
  listSessionTerminals,
  renameSessionTerminal,
  STREAM_DROPPED_CODE,
  terminalLimitLabel,
  terminalStreamAttach,
  typeIntoSessionConsole,
} from '../../../app/lib/web-terminals.ts';
import { refusal, scriptedClient, socketClient } from '../../support/app/client.ts';

const scope = { sessionId: 'shared/session' };
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

describe('web terminal transport', () => {
  it('addresses every call to the ferret by the manifest route key, on the client it was given', async () => {
    const { calls, client } = scriptedClient(list);
    expect(await listSessionTerminals(client, scope)).toEqual(list);
    expect(calls).toEqual([
      { route: 'GET /v1/ferrets/:ferretId/terminals', init: { params: { ferretId: 'shared/session' } } },
    ]);
  });

  it('sends the create request parsed, and an empty body when the caller lets the daemon choose a size', async () => {
    const { calls, client } = scriptedClient(terminal);
    expect(await createSessionTerminal(client, scope, { cols: 100, rows: 30 })).toEqual(terminal);
    await createSessionTerminal(client, scope);
    expect(calls[0]).toEqual({
      route: 'POST /v1/ferrets/:ferretId/terminals',
      init: { params: { ferretId: 'shared/session' }, body: { cols: 100, rows: 30 } },
    });
    expect(calls[1]?.init?.body).toEqual({});
  });

  it('renames and closes one terminal by its daemon-issued id', async () => {
    const renamed = { ...terminal, title: 'tests' };
    const { calls, client } = scriptedClient(renamed, { closed: true, id: TERMINAL_ID });
    expect(await renameSessionTerminal(client, scope, TERMINAL_ID, 'tests')).toEqual(renamed);
    expect(calls[0]).toEqual({
      route: 'PATCH /v1/ferrets/:ferretId/terminals/:terminalId',
      init: { params: { ferretId: 'shared/session', terminalId: TERMINAL_ID }, body: { title: 'tests' } },
    });
    expect(await closeSessionTerminal(client, scope, TERMINAL_ID)).toEqual({ closed: true, id: TERMINAL_ID });
    expect(calls[1]).toEqual({
      route: 'DELETE /v1/ferrets/:ferretId/terminals/:terminalId',
      init: { params: { ferretId: 'shared/session', terminalId: TERMINAL_ID } },
    });
  });

  it('rejects a terminal id that is not the daemon-issued shape before it reaches a route', async () => {
    const { calls, client } = scriptedClient(terminal);
    await expect(renameSessionTerminal(client, scope, '../../secrets', 'x')).rejects.toThrow();
    await expect(closeSessionTerminal(client, scope, 'not an id')).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('rejects an invalid title rather than letting the daemon decide', async () => {
    const { calls, client } = scriptedClient(terminal);
    await expect(renameSessionTerminal(client, scope, TERMINAL_ID, '   ')).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('refuses a daemon answer describing another ferret or another terminal', async () => {
    const other = { ...list, sessionId: 'other', terminals: [] };
    await expect(listSessionTerminals(scriptedClient(other).client, scope)).rejects.toMatchObject({ status: 502 });
    await expect(
      createSessionTerminal(scriptedClient({ ...terminal, sessionId: 'other' }).client, scope),
    ).rejects.toMatchObject({ status: 502 });
    await expect(
      closeSessionTerminal(scriptedClient({ closed: true, id: 'ffffffffffff' }).client, scope, TERMINAL_ID),
    ).rejects.toMatchObject({ status: 502 });
  });

  it('rejects a malformed daemon payload whole', async () => {
    await expect(listSessionTerminals(scriptedClient({ nope: true }).client, scope)).rejects.toThrow();
    await expect(
      createSessionTerminal(scriptedClient({ ...terminal, state: 'exited' }).client, scope),
    ).rejects.toThrow();
  });

  it('lets a daemon refusal through with its status, code and sentence', async () => {
    await expect(
      listSessionTerminals(scriptedClient(refusal(404, 'no session', 'not_found')).client, scope),
    ).rejects.toMatchObject({ status: 404, message: 'no session', code: 'not_found' });
  });

  it('reports the session and box counts in the original wording', () => {
    expect(terminalLimitLabel(list)).toBe('1/6 in this session · 3/24 on this box');
  });
});

describe('typing into the Console', () => {
  it('posts the keys to the ferret’s own pane by route key', async () => {
    const { calls, client } = scriptedClient({ written: 3 });
    expect(await typeIntoSessionConsole(client, scope, 'ls\r')).toBe(3);
    expect(calls).toEqual([
      {
        route: 'POST /v1/ferrets/:ferretId/console/input',
        init: { params: { ferretId: 'shared/session' }, body: { data: 'ls\r' } },
      },
    ]);
  });

  it('R546 sends a long paste as ordered writes', async () => {
    const { calls, client } = scriptedClient({ written: 4_096 }, { written: 1 });
    expect(await typeIntoSessionConsole(client, scope, 'x'.repeat(4_097))).toBe(4_097);
    expect(calls.map(call => ((call.init?.body ?? { data: '' }) as { data: string }).data.length)).toEqual([4_096, 1]);
  });

  it('keeps a grant refusal as the daemon said it', async () => {
    const refused = scriptedClient(refusal(401, 'unlock this machine first', 'unlock_required')).client;
    await expect(typeIntoSessionConsole(refused, scope, 'x')).rejects.toMatchObject({
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
  it('reads the ferret’s quarantines (Vault’s holds) and parses what comes back', async () => {
    const quarantines = [{ key: 'dev', until: '2026-10-30T10:02:00.000Z' as Instant }];
    const { calls, client } = scriptedClient({ quarantines });
    expect(await listSessionQuarantines(client, scope)).toEqual({ quarantines });
    expect(calls[0]?.route).toBe('GET /v1/ferrets/:ferretId/input-quarantines');
    await expect(
      listSessionQuarantines(scriptedClient({ quarantines: [{ key: 'dev' }] }).client, scope),
    ).rejects.toThrow();
  });

  it('ends one quarantine by key, and fails when the daemon did not end it', async () => {
    const { calls, client } = scriptedClient({ ended: true });
    await endSessionQuarantine(client, scope, 'dev');
    expect(calls).toEqual([
      {
        route: 'POST /v1/ferrets/:ferretId/input-quarantines/:key/end',
        init: { params: { ferretId: 'shared/session', key: 'dev' } },
      },
    ]);
    await expect(endSessionQuarantine(scriptedClient({ ended: false }).client, scope, 'dev')).rejects.toThrow(
      'daemon did not end the quarantine',
    );
  });
});

describe('the viewer stream', () => {
  const handlers = () => {
    const seen = { opened: 0, bytes: [] as Uint8Array[], closed: [] as [number, string][], refused: [] as number[] };
    return {
      seen,
      handlers: {
        onOpen: () => {
          seen.opened += 1;
        },
        onBytes: (bytes: Uint8Array) => void seen.bytes.push(bytes),
        onClosed: (code: number, reason: string) => void seen.closed.push([code, reason]),
        onRefused: (status: number) => void seen.refused.push(status),
      },
    };
  };

  it('opens one guarded socket with the ferret and the terminal and nothing else', async () => {
    const { client, opened } = socketClient();
    await terminalStreamAttach(client)(scope, TERMINAL_ID, handlers().handlers);
    expect(opened).toEqual([
      {
        key: 'GET /v1/ferrets/:ferretId/terminals/:terminalId/stream',
        params: { ferretId: 'shared/session', terminalId: TERMINAL_ID },
      },
    ]);
  });

  it('draws only bytes: a text frame is the daemon speaking a shape this stream does not have', async () => {
    const { client, daemon, sent } = socketClient();
    const { seen, handlers: given } = handlers();
    const stream = await terminalStreamAttach(client)(scope, TERMINAL_ID, given);
    daemon.frame(new Uint8Array([104, 105]));
    daemon.frame('{"daemon":"json"}');
    stream.control('{"type":"resize","cols":80,"rows":24}');
    stream.write(new Uint8Array([108]));
    expect(seen.opened).toBe(1);
    expect(seen.bytes).toEqual([new Uint8Array([104, 105])]);
    expect(sent).toEqual(['{"type":"resize","cols":80,"rows":24}', new Uint8Array([108])]);
  });

  it('hands a carrier drop up as the abnormal closure the deck retries with backoff', async () => {
    const { client, daemon } = socketClient();
    const { seen, handlers: given } = handlers();
    await terminalStreamAttach(client)(scope, TERMINAL_ID, given);
    daemon.close('carrier lost');
    expect(seen.closed).toEqual([[STREAM_DROPPED_CODE, 'carrier lost']]);
    expect(seen.refused).toEqual([]);
  });

  it('tells a refusal from a drop, so the deck does not retry a permanent no', async () => {
    const { client, daemon } = socketClient();
    const { seen, handlers: given } = handlers();
    await terminalStreamAttach(client)(scope, TERMINAL_ID, given);
    daemon.close('the daemon refused this stream: 403');
    expect(seen.refused).toEqual([403]);
    expect(seen.closed).toEqual([]);
  });

  it('says nothing after a deliberate leave', async () => {
    const { client, daemon, closes } = socketClient();
    const { seen, handlers: given } = handlers();
    const stream = await terminalStreamAttach(client)(scope, TERMINAL_ID, given);
    stream.close(1000, 'terminal tab detached');
    daemon.close('closed');
    daemon.frame(new Uint8Array([1]));
    expect(closes).toHaveLength(1);
    expect(seen.closed).toEqual([]);
    expect(seen.bytes).toEqual([]);
  });

  it('refuses a terminal id that is not the daemon-issued shape, and a client with no sockets', async () => {
    const { client } = socketClient();
    await expect(terminalStreamAttach(client)(scope, '../x', handlers().handlers)).rejects.toThrow();
    await expect(
      terminalStreamAttach(scriptedClient().client)(scope, TERMINAL_ID, handlers().handlers),
    ).rejects.toThrow('cannot open a terminal stream');
  });
});
