import { describe, expect, it } from 'bun:test';
import type { PluginClient, PluginSocketListeners } from '@ferretry/kernel/manifest';
import type { TerminalDeckHost } from '../../../app/components/session-terminal-deck.tsx';
import {
  pluginTerminalDeckDependencies,
  pluginTerminalSlotsClient,
  STREAM_DROPPED_CODE,
} from '../../../app/lib/plugin-client.ts';
import { daemonConnection, daemonSessionScope } from '../../../app/shell.ts';
import { TerminalHoldersViewSchema } from '../../../contract/index.ts';
import { shouldReopenTerminalStream } from '../../../app/lib/terminal-co-control.ts';
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

const DAEMON = daemonConnection('d');
const scope = daemonSessionScope(DAEMON, 'wren');
const WREN_LISTING = terminalListing([terminalView(TERMINAL, {}, 'wren')], 'wren');

describe('pluginTerminalDeckDependencies', () => {
  it('lists a ferret’s terminals by the manifest route key, parsing the answer', async () => {
    const { calls, client } = recording(() => WREN_LISTING);
    const deps = pluginTerminalDeckDependencies(client, HOST);

    expect(await deps.list(DAEMON, scope)).toEqual(WREN_LISTING);
    expect(calls).toEqual([{ route: 'GET /v1/ferrets/:ferretId/terminals', init: { params: { ferretId: 'wren' } } }]);
  });

  it('renames and closes one terminal by its parsed id', async () => {
    const { calls, client } = recording(route =>
      route.startsWith('PATCH') ? terminalView(TERMINAL, { title: 'build' }, 'wren') : { closed: true },
    );
    const deps = pluginTerminalDeckDependencies(client, HOST);

    await deps.rename(DAEMON, scope, TERMINAL, 'build');
    await expect(deps.close(DAEMON, scope, 'not an id')).rejects.toThrow();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      route: 'PATCH /v1/ferrets/:ferretId/terminals/:terminalId',
      init: { params: { ferretId: 'wren', terminalId: TERMINAL }, body: { title: 'build' } },
    });
  });

  const HANDLERS = (seen: { bytes: Uint8Array[]; closed: [number, string][]; opened: number }) => ({
    onOpen: () => (seen.opened += 1),
    onBytes: (bytes: Uint8Array) => seen.bytes.push(bytes),
    onClosed: (code: number, reason: string) => seen.closed.push([code, reason]),
    onRefused: () => undefined,
  });

  /** A shell client whose one socket hands the test its listeners, and records what was sent and how it was closed. */
  const streaming = () => {
    const sent: (string | Uint8Array)[] = [];
    const left: { code?: number; reason?: string }[] = [];
    const opened: { key: string; params: Readonly<Record<string, string>> }[] = [];
    const heard: { listeners?: PluginSocketListeners } = {};
    const client: PluginClient = {
      call: async () => undefined as never,
      subscribe: () => () => undefined,
      socket: (key, params, given) => {
        opened.push({ key, params });
        heard.listeners = given;
        return { send: frame => sent.push(frame), close: (code, reason) => left.push({ code, reason }) };
      },
    };
    return { client, sent, left, opened, heard };
  };

  it('streams over the shell socket: bytes reach the pane, text frames are dropped, a drop is retried', async () => {
    const seen: { bytes: Uint8Array[]; closed: [number, string][]; opened: number } = {
      bytes: [],
      closed: [],
      opened: 0,
    };
    const { client, sent, opened, heard } = streaming();
    const deps = pluginTerminalDeckDependencies(client, HOST);

    const stream = await deps.attach(DAEMON, scope, TERMINAL, HANDLERS(seen));
    // Not open until the daemon accepts the stream: a frame sent before is dropped.
    expect(seen.opened).toBe(0);
    heard.listeners?.onOpen?.();
    heard.listeners?.onFrame(new Uint8Array([104, 105]));
    heard.listeners?.onFrame('{"daemon":"json"}');
    stream.control('{"type":"resize","cols":80,"rows":24}');
    heard.listeners?.onClose('carrier lost');

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
    expect(shouldReopenTerminalStream(STREAM_DROPPED_CODE)).toBe(true);
  });

  for (const code of [1008, 1009]) {
    it(`a close with the daemon's ${code} reaches the deck as that code, which is final`, async () => {
      const seen: { bytes: Uint8Array[]; closed: [number, string][]; opened: number } = {
        bytes: [],
        closed: [],
        opened: 0,
      };
      const { client, heard } = streaming();
      await pluginTerminalDeckDependencies(client, HOST).attach(DAEMON, scope, TERMINAL, HANDLERS(seen));

      heard.listeners?.onOpen?.();
      heard.listeners?.onClose('policy violation', code);

      expect(seen.closed).toEqual([[code, 'policy violation']]);
      expect(shouldReopenTerminalStream(seen.closed[0]?.[0] ?? 0)).toBe(false);
    });
  }

  it('leaves with the code and reason the deck gives, so a deliberate leave is never spelled as a drop', async () => {
    const seen = { bytes: [], closed: [], opened: 0 };
    const { client, left } = streaming();
    const stream = await pluginTerminalDeckDependencies(client, HOST).attach(DAEMON, scope, TERMINAL, HANDLERS(seen));

    stream.close(1000, 'terminal tab detached');

    expect(left).toEqual([{ code: 1000, reason: 'terminal tab detached' }]);
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
