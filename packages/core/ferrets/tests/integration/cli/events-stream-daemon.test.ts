/**
 * `fy events` and `fy stream` against the REAL Ferrets daemon half, over a REAL WebSocket (M1, c58 u3).
 *
 * The acceptance sweep saw every form fail with a bare "WebSocket stream failed". The unit tests had a fake client that
 * answered any socket query, so they could not see the cause: the journal socket knows session ids only, and the daemon
 * answers an upgrade for anything else with a 404 before any frame. Here the daemon is the production one (the `ferrets`
 * plugin on the test host: its real route table, accept and journals), served on a loopback `Bun.serve` that upgrades
 * exactly when the host's own socket accept admits the call, and refuses with the host's own status and body when it does
 * not. The verbs are the shipped ones (`cli.build`), and the client's socket is a plain `WebSocket`, as the transport's is.
 * No home, no network beyond 127.0.0.1, fixture values only.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { PluginClient, PluginSocketListeners, VerbInvocation } from '@ferretry/kernel/manifest';
import type { TestHost } from '@ferretry/kernel/testing';
import cli from '../../../cli/index.ts';
import { FerretHistoryFiles } from '../../../contract/index.ts';
import manifest from '../../../manifest.ts';
import { host, record } from '../../unit/daemon/ferrets/route-fixture.ts';

const ID = 'mwkiz159-f60c1cc7';
const OTHER = 'mwkiz160-0a1b2c3d';

const line = (sessionId: string, sequence: number, note: string) =>
  JSON.stringify({
    format: 1,
    schemaVersion: 1,
    sequence,
    sessionId,
    time: `2026-11-17T10:00:0${sequence}.000Z`,
    type: 'lifecycle',
    data: { note },
  });

interface Served {
  readonly url: string;
  readonly hostUnderTest: TestHost;
  readonly sockets: string[];
  stop(): void;
}

/** The test host on a real loopback listener: HTTP calls go to `host.request`, an upgrade goes through `host.socket`. */
async function serve(): Promise<Served> {
  const first = await host([
    { ...record(ID), name: 'finch' },
    { ...record(OTHER), name: 'robin' },
  ]);
  first
    .state('ferrets')
    .plant(FerretHistoryFiles, `${line(ID, 1, 'finch started')}\n${line(ID, 2, 'finch idle')}\n`, ID);
  first.state('ferrets').plant(FerretHistoryFiles, `${line(OTHER, 1, 'robin started')}\n`, OTHER);
  const hostUnderTest = await first.restart();
  const sockets: string[] = [];
  const timers = new WeakMap<object, ReturnType<typeof setInterval>>();
  const server = Bun.serve<{ sent: number; readonly opened: Awaited<ReturnType<TestHost['socket']>> }>({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request, bun) => {
      const url = new URL(request.url);
      const query = Object.fromEntries(url.searchParams);
      if (url.pathname === '/v1/events' && request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        sockets.push(url.search);
        const opened = await hostUnderTest.socket('/v1/events', { query });
        if (opened.response !== undefined)
          return new Response(opened.response.body, {
            status: opened.response.status,
            headers: { 'content-type': 'application/json' },
          });
        return bun.upgrade(request, { data: { sent: 0, opened } }) ? undefined : new Response('no', { status: 400 });
      }
      const reply = await hostUnderTest.request(request.method, url.pathname, { query });
      return new Response(reply.body, { status: reply.status, headers: { 'content-type': 'application/json' } });
    },
    websocket: {
      open: socket => {
        // The host pushes frames into `opened.frames` as the daemon sends them; hand over each as it appears.
        const timer = setInterval(() => {
          const { opened, sent } = socket.data;
          for (const frame of opened.frames.slice(sent)) socket.send(frame);
          socket.data.sent = opened.frames.length;
          if (opened.closed !== undefined) {
            clearInterval(timer);
            socket.close(opened.closed.code, opened.closed.reason);
          }
        }, 5);
        timers.set(socket, timer);
      },
      close: socket => clearInterval(timers.get(socket)),
      message: () => undefined,
    },
  });
  return {
    url: `http://127.0.0.1:${String(server.port)}`,
    hostUnderTest,
    sockets,
    stop: () => {
      server.stop(true);
      void hostUnderTest.stop();
    },
  };
}

/** A guarded client whose HTTP goes to the daemon above and whose socket is a real `WebSocket` to it. */
function clientFor(base: string): PluginClient {
  const pathOf = (route: string, params: Readonly<Record<string, string>> = {}) => {
    const [method = 'GET', template = ''] = route.split(' ');
    return {
      method,
      path: template.replace(/:(\w+)/gu, (_all, name: string) => encodeURIComponent(params[name] ?? '')),
    };
  };
  return {
    call: (async (
      route: string,
      init?: { params?: Record<string, string>; query?: Record<string, string>; body?: unknown },
    ) => {
      const { method, path } = pathOf(route, init?.params);
      const url = new URL(path, base);
      for (const [key, value] of Object.entries(init?.query ?? {})) url.searchParams.set(key, value);
      const reply = await fetch(url, { method });
      const text = await reply.text();
      const body = text === '' ? undefined : (JSON.parse(text) as unknown);
      if (reply.status >= 400)
        throw Object.assign(new Error((body as { error?: string } | undefined)?.error ?? `HTTP ${reply.status}`), {
          status: reply.status,
        });
      return body;
    }) as PluginClient['call'],
    subscribe: () => () => undefined,
    socket: ((_key: string, _params: unknown, listeners: PluginSocketListeners, query?: Record<string, string>) => {
      const url = new URL('/v1/events', base);
      url.protocol = 'ws:';
      for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
      const socket = new WebSocket(url);
      let closing = false;
      socket.onmessage = message => {
        if (typeof message.data === 'string') listeners.onFrame(message.data);
      };
      // The same words the shell's transport gives: a refusal before any frame is a failed stream naming the status.
      socket.onerror = failure => {
        if (closing) return;
        const status = /status code: (\d{3})/u.exec((failure as { message?: string }).message ?? '')?.[1];
        listeners.onClose(
          status === undefined
            ? 'WebSocket stream failed'
            : `WebSocket stream failed: the daemon refused the stream (HTTP ${status})`,
        );
      };
      return {
        send: () => undefined,
        close: (code?: number, reason?: string) => {
          closing = true;
          socket.close(code ?? 1000, reason ?? 'event stream cancelled');
        },
      };
    }) as PluginClient['socket'],
  };
}

function run(base: string) {
  const out: string[] = [];
  const err: string[] = [];
  const half = cli.build?.({
    manifest,
    client: clientFor(base),
    io: { out: t => out.push(t.replace(/\n$/u, '')), err: t => err.push(t.replace(/\n$/u, '')), isTty: false },
    clock: { now: () => '2026-11-17T10:00:00.000Z' as never, nowMs: () => Date.now() },
    sleep: async () => undefined,
  });
  if (half === undefined) throw new Error('the cli half is real');
  const verbs = half.verbs as Readonly<Record<string, (invocation: VerbInvocation) => Promise<number>>>;
  const verb = async (line: string, args: readonly string[] = [], options: VerbInvocation['options'] = {}) => {
    const handler = verbs[line];
    if (handler === undefined) throw new Error(`no verb ${line}`);
    return await handler({ args, options });
  };
  return { verb, out, err };
}

let served: Served | undefined;
afterEach(() => {
  served?.stop();
  served = undefined;
});

const waitFor = async (until: () => boolean) => {
  for (let waited = 0; waited < 200 && !until(); waited += 1) await Bun.sleep(10);
  expect(until()).toBe(true);
};

/**
 * A `fy stream` runs until a signal; this gives it the one a person's Ctrl-C gives, once it has said it is caught up.
 *
 * The verb listens on the real `process`, so the test takes the listener the verb registers for SIGINT/SIGTERM and calls it
 * itself. It never emits a signal event on the shared test process: that would run every SIGINT listener any other file
 * of the run left behind (a handler that exits the runner) and, under a newer Bun, can raise a real signal that ends it.
 */
async function streamUntilCaughtUp(world: ReturnType<typeof run>, args: readonly string[]) {
  const held = new Set<() => void>();
  const once = process.once.bind(process);
  const off = process.off.bind(process);
  const isStop = (event: string | symbol): boolean => event === 'SIGINT' || event === 'SIGTERM';
  process.once = ((event: string | symbol, listener: () => void) => {
    if (!isStop(event)) return once(event as never, listener);
    held.add(listener);
    return process;
  }) as typeof process.once;
  process.off = ((event: string | symbol, listener: () => void) => {
    if (!isStop(event)) return off(event as never, listener);
    held.delete(listener);
    return process;
  }) as typeof process.off;
  try {
    const ended = world.verb('stream [id]', args);
    await waitFor(() => world.err.some(text => text.includes('caught up')));
    for (const listener of [...held]) listener();
    return await ended;
  } finally {
    process.once = once as typeof process.once;
    process.off = off as typeof process.off;
  }
}

describe('V-0258 fy events against the real daemon', () => {
  test('V-0258 fy events <id> prints the ferret’s journal and exits 0', async () => {
    served = await serve();
    const world = run(served.url);

    expect(await world.verb('events <id>', [ID])).toBe(0);

    expect(world.out.join('\n')).toContain('finch started');
    expect(world.out.join('\n')).toContain('finch idle');
    expect(world.err).toEqual([]);
    expect(served.sockets).toEqual([`?after=0&sessionId=${ID}`]);
  });

  test('V-0258 fy events <callsign> asks the daemon who it is and opens the socket with the id, never the callsign', async () => {
    served = await serve();
    const world = run(served.url);

    expect(await world.verb('events <id>', ['finch'])).toBe(0);

    expect(world.out.join('\n')).toContain('finch started');
    expect(world.err).toEqual([]);
    // The original failure: the callsign went to the socket and the daemon refused the upgrade with a 404.
    expect(served.sockets).toEqual([`?after=0&sessionId=${ID}`]);
  });

  test('V-0258 fy events --json prints one protocol event per line', async () => {
    served = await serve();
    const world = run(served.url);

    expect(await world.verb('events <id>', ['finch'], { json: true })).toBe(0);

    const events = world.out.map(each => JSON.parse(each) as { sequence: number; sessionId: string });
    expect(events.map(event => [event.sessionId, event.sequence])).toEqual([
      [ID, 1],
      [ID, 2],
    ]);
  });

  test('V-0258 fy events for a reference nobody holds says the daemon’s own "no ferret", never a bare stream failure', async () => {
    served = await serve();
    const world = run(served.url);

    expect(await world.verb('events <id>', ['ghost'])).toBe(1);
    expect(world.err.join('\n')).toMatch(/no ferret|not found/iu);
    expect(world.err).not.toContain('WebSocket stream failed');
  });
});

describe('V-0452 fy stream against the real daemon', () => {
  test('V-0452 fy stream <id> replays the journal, says it is caught up, and ends 0 on SIGINT', async () => {
    served = await serve();
    const world = run(served.url);

    expect(await streamUntilCaughtUp(world, [ID])).toBe(0);

    expect(world.out.join('\n')).toContain('finch idle');
    expect(world.err.join('\n')).toContain(`caught up on ${ID}`);
  });

  test('V-0452 fy stream <callsign> follows the ferret by the id the daemon resolved', async () => {
    served = await serve();
    const world = run(served.url);

    expect(await streamUntilCaughtUp(world, ['finch'])).toBe(0);

    expect(world.out.join('\n')).toContain('finch started');
    expect(served.sockets).toEqual([`?after=0&sessionId=${ID}`]);
  });

  test('V-0452 fy stream with no id follows the fleet: every ferret’s events, one socket without a session id', async () => {
    served = await serve();
    const world = run(served.url);

    expect(await streamUntilCaughtUp(world, [])).toBe(0);

    expect(world.out.join('\n')).toContain('finch started');
    expect(world.out.join('\n')).toContain('robin started');
    expect(served.sockets.every(search => !search.includes('sessionId'))).toBe(true);
  });

  test('V-0452 fy stream for a reference nobody holds fails with the daemon’s words and exit 1', async () => {
    served = await serve();
    const world = run(served.url);

    expect(await world.verb('stream [id]', ['ghost'])).toBe(1);
    expect(world.err.join('\n')).toMatch(/no ferret|not found/iu);
    expect(world.err).not.toContain('WebSocket stream failed');
  });
});
