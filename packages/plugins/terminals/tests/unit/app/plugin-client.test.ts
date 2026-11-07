import { describe, expect, it } from 'bun:test';
import type { PluginClient } from '@ferretry/kernel/manifest';
import type { TerminalDeckHost } from '../../../app/components/session-terminal-deck.tsx';
import {
  pluginTerminalDeckDependencies,
  pluginTerminalSlotsClient,
  type SocketPluginClient,
  STREAM_DROPPED_CODE,
} from '../../../app/lib/plugin-client.ts';
import { TerminalHoldersViewSchema } from '../../../contract/index.ts';
import { terminalListing, terminalView } from '../../support/app/terminal-deck.ts';

const TERMINAL = '7f0d2c5e0a1b';

const HOST: TerminalDeckHost = {
  loadXterm: async () => {
    throw new Error('not in a unit test');
  },
  watchTheme: () => () => undefined,
  confirmClose: () => true,
  confirmLink: () => true,
  writeClipboard: async () => undefined,
};

function recording(reply: (route: string) => unknown) {
  const calls: { route: string; init?: unknown }[] = [];
  const client: PluginClient = {
    call: async <Answer>(route: string, init?: unknown): Promise<Answer> => {
      calls.push(init === undefined ? { route } : { route, init });
      return reply(route) as Answer;
    },
    subscribe: () => () => undefined,
  };
  return { calls, client };
}

const DAEMON = { daemonId: 'd' } as never;
const scope = { daemonId: 'd', sessionId: 'wren' } as never;

describe('pluginTerminalDeckDependencies', () => {
  it('lists a ferret’s terminals by the manifest route key, parsing the answer', async () => {
    const listing = terminalListing([terminalView(TERMINAL)]);
    const { calls, client } = recording(() => listing);
    const deps = pluginTerminalDeckDependencies(client, HOST);

    expect(await deps.list(DAEMON, scope)).toEqual(listing);
    expect(calls).toEqual([{ route: 'GET /v1/ferrets/:ferretId/terminals', init: { params: { ferretId: 'wren' } } }]);
  });

  it('renames and closes one terminal by its parsed id', async () => {
    const { calls, client } = recording(route =>
      route.startsWith('PATCH') ? terminalView(TERMINAL, { title: 'build' }) : { closed: true },
    );
    const deps = pluginTerminalDeckDependencies(client, HOST);

    await deps.rename(DAEMON, scope, TERMINAL, 'build');
    await expect(deps.close(DAEMON, scope, 'not an id')).rejects.toThrow();
    expect(calls).toEqual([
      {
        route: 'PATCH /v1/ferrets/:ferretId/terminals/:terminalId',
        init: { params: { ferretId: 'wren', terminalId: TERMINAL }, body: { title: 'build' } },
      },
    ]);
  });

  it('streams over the shell socket: bytes reach the pane, text frames are dropped, a drop is retried', async () => {
    const seen: { bytes: Uint8Array[]; closed: [number, string][]; opened: number } = {
      bytes: [],
      closed: [],
      opened: 0,
    };
    const sent: (string | Uint8Array)[] = [];
    let listeners: { onFrame(frame: string | Uint8Array): void; onClose(reason: string): void } | undefined;
    const opened: { key: string; params: Readonly<Record<string, string>> }[] = [];
    const client: SocketPluginClient = {
      call: async () => undefined as never,
      subscribe: () => () => undefined,
      socket: (key, params, given) => {
        opened.push({ key, params });
        listeners = given;
        return { send: frame => sent.push(frame), close: () => undefined };
      },
    };
    const deps = pluginTerminalDeckDependencies(client, HOST);

    const stream = await deps.attach(DAEMON, scope, TERMINAL, {
      onOpen: () => (seen.opened += 1),
      onBytes: bytes => seen.bytes.push(bytes),
      onClosed: (code, reason) => seen.closed.push([code, reason]),
      onRefused: () => undefined,
    });
    listeners?.onFrame(new Uint8Array([104, 105]));
    listeners?.onFrame('{"daemon":"json"}');
    stream.control('{"type":"resize","cols":80,"rows":24}');
    listeners?.onClose('carrier lost');

    expect(opened).toEqual([
      {
        key: 'GET /v1/ferrets/:ferretId/terminals/:terminalId/stream',
        params: { ferretId: 'wren', terminalId: TERMINAL },
      },
    ]);
    expect(seen.opened).toBe(1);
    expect(seen.bytes).toEqual([new Uint8Array([104, 105])]);
    expect(sent).toEqual(['{"type":"resize","cols":80,"rows":24}']);
    expect(seen.closed).toEqual([[STREAM_DROPPED_CODE, 'carrier lost']]);
  });

  it('refuses to stream through a client that has no sockets', async () => {
    const { client } = recording(() => undefined);
    const deps = pluginTerminalDeckDependencies(client, HOST);

    await expect(
      deps.attach(DAEMON, scope, TERMINAL, { onOpen() {}, onBytes() {}, onClosed() {}, onRefused() {} }),
    ).rejects.toThrow('cannot open a terminal stream');
  });
});

describe('pluginTerminalSlotsClient', () => {
  it('maps the tab’s two paths to their route keys and refuses any other', async () => {
    const view = { limit: 24, open: 0, holders: [] };
    const { calls, client } = recording(() => view);
    const slots = pluginTerminalSlotsClient(client);

    expect(await slots.request('/v1/terminals', TerminalHoldersViewSchema)).toEqual(view);
    await expect(slots.request('/v1/terminals', TerminalHoldersViewSchema, { method: 'POST' })).rejects.toThrow();
    await expect(slots.request('/v1/elsewhere', TerminalHoldersViewSchema)).rejects.toThrow();
    expect(calls).toEqual([{ route: 'GET /v1/terminals' }]);
  });
});
