import { describe, expect, test } from 'bun:test';
import type {
  CliContext,
  Manifest,
  PluginClient,
  PluginSocket,
  PluginSocketListeners,
  VerbInvocation,
} from '@ferretry/kernel/manifest';
import type { FyEventStreamFrame } from '../../../../contract/index.ts';
import cli from '../../../../cli/index.ts';
import { runCancellableStream, StreamController } from '../../../../cli/lib/stream/controller.ts';
import { ClientEventStream, EVENTS_SOCKET } from '../../../../cli/lib/stream/gateway.ts';
import type { IEventStream, StreamScope } from '../../../../cli/lib/stream/ports.ts';
import { renderEvent } from '../../../../cli/lib/stream/render.ts';
import manifest from '../../../../manifest.ts';

/** Today's `fy stream [id]` (reads/controller.ts, reads/commands.ts) over the journal socket `GET /v1/events`. */

const event = (sessionId: string, sequence: number, extra: Record<string, unknown> = {}): FyEventStreamFrame => ({
  kind: 'event',
  event: {
    sequence,
    time: '2026-11-06T09:00:00.000Z',
    sessionId,
    type: 'turn.started',
    source: 'daemon',
    data: { note: 'hello' },
    ...extra,
  } as never,
});
const sessionIdle = (sessionId: string, after: number, idleSeconds = 30): FyEventStreamFrame => ({
  kind: 'idle',
  idleSeconds,
  scope: { kind: 'session', sessionId, after },
});
const fleetIdle = (followedSessions: number, idleSeconds = 30): FyEventStreamFrame => ({
  kind: 'idle',
  idleSeconds,
  scope: { kind: 'fleet', followedSessions },
});

/** A stream double: records the scope, plays the frames, then waits for the caller to leave. */
function scripted(frames: readonly FyEventStreamFrame[]) {
  const scopes: StreamScope[] = [];
  const stream: IEventStream = {
    follow: async (scope, onFrame, signal) => {
      scopes.push(scope);
      for (const frame of frames) onFrame(frame);
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve()));
    },
  };
  return { stream, scopes };
}

function controllerOver(frames: readonly FyEventStreamFrame[]) {
  const out: string[] = [];
  const err: string[] = [];
  const { stream, scopes } = scripted(frames);
  const controller = new StreamController(stream, { success: m => out.push(m), error: m => err.push(m) }, 'fy');
  const abort = new AbortController();
  const follow = async (id: string | undefined, options: { after?: number; json?: boolean } = {}) => {
    const done = controller.follow(id, options, abort.signal);
    await Promise.resolve();
    abort.abort();
    await done;
  };
  return { follow, out, err, scopes };
}

describe('V-0452 fy stream [id] — what it follows', () => {
  test('V-0452 one ferret replays from --after; the cursor is the scope the socket is opened with', async () => {
    const world = controllerOver([event('wren', 8), event('wren', 9)]);
    await world.follow('wren', { after: 7 });
    expect(world.scopes).toEqual([{ ferretId: 'wren', after: 7 }]);
    expect(world.out).toEqual([
      '#8 2026-11-06T09:00:00.000Z turn.started (daemon) {"note":"hello"}',
      '#9 2026-11-06T09:00:00.000Z turn.started (daemon) {"note":"hello"}',
    ]);
  });

  test('V-0452 without --after a ferret replays from the start', async () => {
    const world = controllerOver([event('wren', 1)]);
    await world.follow('wren');
    expect(world.scopes).toEqual([{ ferretId: 'wren', after: 0 }]);
    expect(world.out).toHaveLength(1);
  });

  test('V-0452 no id follows the fleet; each ferret keeps its own cursor', async () => {
    const world = controllerOver([event('wren', 4), event('oak', 1), event('wren', 5), event('oak', 2)]);
    await world.follow(undefined);
    expect(world.scopes).toEqual([{ after: 0 }]);
    expect(world.out).toHaveLength(4);
  });

  test('V-0452 a fleet stream has no global cursor: --after with no id is refused as a usage mistake', async () => {
    const world = controllerOver([]);
    await expect(world.follow(undefined, { after: 3 })).rejects.toMatchObject({
      message: 'a fleet stream has no global cursor; omit --after or name one ferret',
      exitCode: 2,
    });
    expect(world.scopes).toEqual([]);
  });

  test('V-0452 --after must be a non-negative whole number', async () => {
    for (const after of [-1, 1.5, Number.NaN]) {
      const world = controllerOver([]);
      await expect(world.follow('wren', { after })).rejects.toMatchObject({
        message: '--after must be a non-negative integer',
        exitCode: 2,
      });
    }
  });

  test('V-0452 an event for another ferret, or one that does not advance, ends the stream with an error', async () => {
    await expect(controllerOver([event('oak', 1)]).follow('wren')).rejects.toThrow(
      'the daemon returned an event for oak while following wren',
    );
    await expect(controllerOver([event('wren', 3), event('wren', 3)]).follow('wren')).rejects.toThrow(
      'non-advancing event sequence #3 for wren after #3',
    );
    await expect(controllerOver([event('wren', 5)]).follow('wren', { after: 5 })).rejects.toThrow(
      'non-advancing event sequence #5 for wren after #5',
    );
    await expect(
      controllerOver([event('wren', 2), event('oak', 2), event('oak', 1)]).follow(undefined),
    ).rejects.toThrow('non-advancing event sequence #1 for oak after #2');
  });
});

describe('V-0452 fy stream [id] — the proofs on stderr', () => {
  test('V-0452 the first idle proof says caught up; the next ones say how long it has been quiet', async () => {
    const world = controllerOver([event('wren', 1), sessionIdle('wren', 1), sessionIdle('wren', 1, 60)]);
    await world.follow('wren');
    expect(world.err).toEqual([
      'fy stream: caught up on wren at #1 (following live)',
      'fy stream: no new events for wren in 60s (still following from #1)',
    ]);
    expect(world.out).toHaveLength(1);
  });

  test('V-0452 the fleet form of caught-up and idle names how many ferrets it follows, and no cursor', async () => {
    const world = controllerOver([fleetIdle(3), fleetIdle(4, 45)]);
    await world.follow(undefined);
    expect(world.err).toEqual([
      'fy stream: caught up on the fleet (following 3 ferrets live)',
      'fy stream: no new fleet events in 45s (socket is live; following 4 ferrets)',
    ]);
    expect(world.out).toEqual([]);
  });

  test('V-0452 an idle proof that contradicts the followed cursor, or the wrong scope, is an error', async () => {
    await expect(controllerOver([event('wren', 2), sessionIdle('wren', 1)]).follow('wren')).rejects.toThrow(
      'an idle proof that contradicted the followed ferret cursor',
    );
    await expect(controllerOver([sessionIdle('oak', 0)]).follow('wren')).rejects.toThrow('contradicted');
    await expect(controllerOver([fleetIdle(2)]).follow('wren')).rejects.toThrow('contradicted');
    await expect(controllerOver([sessionIdle('wren', 0)]).follow(undefined)).rejects.toThrow(
      'a ferret idle proof for a fleet stream',
    );
  });

  test('V-0452 a live readout or transcript note is ignored: this stream never asks for one', async () => {
    const world = controllerOver([
      { kind: 'transcript', transcript: { sessionId: 'wren', at: '2026-11-06T09:00:00.000Z' } } as never,
      event('wren', 1),
    ]);
    await world.follow('wren');
    expect(world.out).toHaveLength(1);
    expect(world.err).toEqual([]);
  });
});

describe('V-0452 fy stream [id] — renderings', () => {
  test('V-0452 --json prints one protocol event per line on stdout and keeps the notes off it', async () => {
    const frame = event('wren', 1);
    const world = controllerOver([frame, sessionIdle('wren', 1)]);
    await world.follow('wren', { json: true });
    expect(world.out).toEqual([JSON.stringify((frame as { event: unknown }).event)]);
    expect(JSON.parse(world.out[0] as string)).toMatchObject({ sequence: 1, sessionId: 'wren' });
    expect(world.err).toHaveLength(1);
  });

  test('V-0452 the human line leads with the sequence, shows the turn only when there is one, and omits empty data', () => {
    const base = (event('wren', 7) as { event: Parameters<typeof renderEvent>[0] }).event;
    expect(renderEvent({ ...base, turn: 2, data: undefined })).toBe(
      '#7 2026-11-06T09:00:00.000Z turn.started turn=2 (daemon)',
    );
    expect(renderEvent({ ...base, data: null })).toBe('#7 2026-11-06T09:00:00.000Z turn.started (daemon)');
  });
});

describe('V-0452 fy stream [id] — interruption', () => {
  const fakeSignals = () => {
    const listeners = new Map<string, () => void>();
    return {
      listeners,
      source: {
        once: (name: 'SIGINT' | 'SIGTERM', listener: () => void) => void listeners.set(name, listener),
        off: (name: 'SIGINT' | 'SIGTERM', listener: () => void) => {
          if (listeners.get(name) === listener) listeners.delete(name);
        },
      },
    };
  };

  test('V-0452 SIGINT and SIGTERM end the follow cleanly and the listeners are released', async () => {
    for (const name of ['SIGINT', 'SIGTERM'] as const) {
      const signals = fakeSignals();
      const { stream } = scripted([event('wren', 1)]);
      const out: string[] = [];
      const controller = new StreamController(stream, { success: m => out.push(m), error: () => undefined }, 'fy');
      const done = runCancellableStream(controller, 'wren', {}, signals.source);
      await Promise.resolve();
      expect([...signals.listeners.keys()].sort()).toEqual(['SIGINT', 'SIGTERM']);
      signals.listeners.get(name)?.();
      await done;
      expect(signals.listeners.size).toBe(0);
      expect(out).toHaveLength(1);
    }
  });

  test('V-0452 the listeners are released when the stream fails too', async () => {
    const signals = fakeSignals();
    const controller = new StreamController(
      scripted([event('oak', 1)]).stream,
      { success: () => undefined, error: () => undefined },
      'fy',
    );
    await expect(runCancellableStream(controller, 'wren', {}, signals.source)).rejects.toThrow();
    expect(signals.listeners.size).toBe(0);
  });
});

/** A PluginClient whose `socket` the test drives by hand. */
function socketWorld() {
  const opened: { key: string; params: unknown; query: unknown; listeners: PluginSocketListeners }[] = [];
  const closed: { code?: number; reason?: string }[] = [];
  const socket: PluginSocket = {
    send: () => undefined,
    close: (code, reason) =>
      void closed.push({ ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) }),
  };
  const client: PluginClient = {
    call: async () => ({}) as never,
    subscribe: () => () => undefined,
    socket: (key, params, listeners, query) => {
      opened.push({ key, params, query, listeners });
      return socket;
    },
  };
  return { client, opened, closed };
}

describe('V-0452 fy stream [id] — the shell’s socket', () => {
  test('V-0452 the socket is GET /v1/events, opened through the shell client with the cursor in the query', async () => {
    const world = socketWorld();
    const frames: FyEventStreamFrame[] = [];
    const abort = new AbortController();
    const done = new ClientEventStream(world.client).follow(
      { ferretId: 'wren', after: 7 },
      f => frames.push(f),
      abort.signal,
    );
    expect(world.opened).toHaveLength(1);
    expect(world.opened[0]).toMatchObject({ key: EVENTS_SOCKET, params: {}, query: { after: '7', sessionId: 'wren' } });
    expect(EVENTS_SOCKET).toBe('GET /v1/events');
    world.opened[0]?.listeners.onFrame(JSON.stringify(event('wren', 8)));
    world.opened[0]?.listeners.onFrame(new TextEncoder().encode(JSON.stringify(sessionIdle('wren', 8))));
    expect(frames.map(f => f.kind)).toEqual(['event', 'idle']);
    abort.abort();
    await done;
  });

  test('V-0452 the fleet socket carries after=0 and no sessionId', async () => {
    const world = socketWorld();
    const abort = new AbortController();
    const done = new ClientEventStream(world.client).follow({ after: 0 }, () => undefined, abort.signal);
    expect(world.opened[0]?.query).toEqual({ after: '0' });
    abort.abort();
    await done;
  });

  test('V-0452 leaving closes the socket with 1000 "event stream cancelled" and ends the follow without an error', async () => {
    const world = socketWorld();
    const abort = new AbortController();
    const done = new ClientEventStream(world.client).follow({ after: 0 }, () => undefined, abort.signal);
    abort.abort();
    await done;
    expect(world.closed).toEqual([{ code: 1000, reason: 'event stream cancelled' }]);
    // A close that arrives after the caller left is not an error.
    world.opened[0]?.listeners.onClose('gone', 1006);
  });

  test('V-0452 an already-cancelled follow opens nothing', async () => {
    const world = socketWorld();
    await new ClientEventStream(world.client).follow({ after: 0 }, () => undefined, AbortSignal.abort());
    expect(world.opened).toEqual([]);
  });

  test('V-0452 a socket that closes early is an error naming the daemon’s reason and code', async () => {
    const world = socketWorld();
    const done = new ClientEventStream(world.client).follow(
      { after: 0 },
      () => undefined,
      new AbortController().signal,
    );
    world.opened[0]?.listeners.onClose('no ferret wren', 1008);
    await expect(done).rejects.toThrow('WebSocket stream closed unexpectedly: no ferret wren (code 1008)');
    const bare = socketWorld();
    const second = new ClientEventStream(bare.client).follow(
      { after: 0 },
      () => undefined,
      new AbortController().signal,
    );
    bare.opened[0]?.listeners.onClose('', 1006);
    await expect(second).rejects.toThrow('WebSocket stream closed unexpectedly: code 1006');
  });

  test('V-0452 a socket the shell refuses to open ends with the shell’s own sentence', async () => {
    const world = socketWorld();
    const done = new ClientEventStream(world.client).follow(
      { after: 0 },
      () => undefined,
      new AbortController().signal,
    );
    world.opened[0]?.listeners.onClose('the plugin ferrets is paused');
    await expect(done).rejects.toThrow('WebSocket stream failed: the plugin ferrets is paused');
  });

  test('V-0452 a frame the daemon’s schema refuses ends the follow and closes the socket', async () => {
    const world = socketWorld();
    const done = new ClientEventStream(world.client).follow(
      { after: 0 },
      () => undefined,
      new AbortController().signal,
    );
    world.opened[0]?.listeners.onFrame(JSON.stringify({ kind: 'event', event: { sequence: 'x' } }));
    await expect(done).rejects.toThrow();
    expect(world.closed).toHaveLength(1);
    const garbage = socketWorld();
    const second = new ClientEventStream(garbage.client).follow(
      { after: 0 },
      () => undefined,
      new AbortController().signal,
    );
    garbage.opened[0]?.listeners.onFrame('not json');
    await expect(second).rejects.toThrow();
  });

  test('V-0452 a shell with no socket says so instead of opening a raw connection', async () => {
    const client: PluginClient = { call: async () => ({}) as never, subscribe: () => () => undefined };
    await expect(
      new ClientEventStream(client).follow({ after: 0 }, () => undefined, new AbortController().signal),
    ).rejects.toMatchObject({ message: 'this fy has no event socket to follow', exitCode: 1 });
  });

  test('V-0452 the renderer prints what the daemon sent and nothing it did not: an envelope token never appears', async () => {
    const world = socketWorld();
    const out: string[] = [];
    const controller = new StreamController(
      new ClientEventStream(world.client),
      { success: m => out.push(m), error: () => undefined },
      'fy',
    );
    const abort = new AbortController();
    const done = controller.follow('wren', {}, abort.signal);
    // The daemon masks secrets in `data`; a field outside the envelope's schema is dropped at the parse, not rendered.
    world.opened[0]?.listeners.onFrame(
      JSON.stringify({
        kind: 'event',
        event: { ...(event('wren', 1) as { event: object }).event, token: 'tok-SECRET', data: { key: '[masked]' } },
      }),
    );
    abort.abort();
    await done;
    expect(out).toEqual(['#1 2026-11-06T09:00:00.000Z turn.started (daemon) {"key":"[masked]"}']);
    expect(out.join('')).not.toContain('SECRET');
  });
});

/** The verb itself, built over the same shell client as the other verbs. */
function verbWorld() {
  const world = socketWorld();
  const out: string[] = [];
  const err: string[] = [];
  const half = cli.build?.({
    manifest,
    client: world.client,
    io: { out: t => out.push(t), err: t => err.push(t), isTty: false },
  } as CliContext<Manifest> as never);
  if (half === undefined) throw new Error('the cli half is real');
  const verbs = half.verbs as Readonly<Record<string, (invocation: VerbInvocation) => Promise<number>>>;
  return {
    ...world,
    out,
    err,
    run: (args: readonly string[], options: VerbInvocation['options'] = {}) => verbs['stream [id]']!({ args, options }),
  };
}

describe('V-0452 fy stream [id] — the verb', () => {
  test('V-0452 the manifest declares the verb', () => {
    expect((manifest.actions.cli ?? []).some(decl => decl.verb === 'stream [id]')).toBe(true);
  });

  test('V-0452 fy stream wren --after 7 --json follows one ferret and ends 0 on SIGINT', async () => {
    const world = verbWorld();
    const exit = world.run(['wren'], { after: '7', json: true });
    await Promise.resolve();
    expect(world.opened[0]).toMatchObject({ key: 'GET /v1/events', query: { after: '7', sessionId: 'wren' } });
    world.opened[0]?.listeners.onFrame(JSON.stringify(event('wren', 8)));
    process.emit('SIGINT');
    expect(await exit).toBe(0);
    expect(JSON.parse(world.out[0] as string)).toMatchObject({ sequence: 8 });
    expect(world.closed).toEqual([{ code: 1000, reason: 'event stream cancelled' }]);
  });

  test('V-0452 fy stream with no id follows the fleet; --after there exits 2 without opening a socket', async () => {
    const fleet = verbWorld();
    const exit = fleet.run([]);
    await Promise.resolve();
    expect(fleet.opened[0]?.query).toEqual({ after: '0' });
    process.emit('SIGTERM');
    expect(await exit).toBe(0);
    const refused = verbWorld();
    expect(await refused.run([], { after: '4' })).toBe(2);
    expect(refused.opened).toEqual([]);
    expect(refused.err).toEqual(['a fleet stream has no global cursor; omit --after or name one ferret']);
  });

  test('V-0452 a bad --after exits 2; a stream that dies exits 1 with the reason on stderr', async () => {
    const bad = verbWorld();
    expect(await bad.run(['wren'], { after: 'abc' })).toBe(2);
    expect(await bad.run(['wren'], { after: true })).toBe(2);
    const dead = verbWorld();
    const exit = dead.run(['wren']);
    await Promise.resolve();
    dead.opened[0]?.listeners.onClose('no ferret wren', 1008);
    expect(await exit).toBe(1);
    expect(dead.err).toEqual(['WebSocket stream closed unexpectedly: no ferret wren (code 1008)']);
  });
});
