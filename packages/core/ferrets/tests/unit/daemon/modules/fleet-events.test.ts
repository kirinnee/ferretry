/** R520 / R537 / G161: `GET /v1/events` — the journal stream, over each ferret's history.jsonl and Ferrets' append edge. */
import { describe, expect, test } from 'bun:test';
import type { CallContext, SocketDownstream } from '@ferretry/kernel/contract';
import { queryFrom } from '@ferretry/kernel/contract';
import { state } from '@ferretry/kernel/host';
import { FerretHistoryFiles } from '../../../../contract/state.ts';
import {
  backlogTailBytes,
  eventStreamScope,
  fleetEventsAccept,
  followableFerret,
  HistoryEventSource,
} from '../../../../daemon/modules/fleet-events.ts';
import { FyEventStreamFrameSchema } from '../../../../daemon/lib/protocol/session.ts';
import { journalEventToFyEvent } from '../../../../daemon/lib/session/peers/reads.ts';
import { FerretLiveActivitySchema } from '../../../../contract/index.ts';
import ferretsManifest from '../../../../manifest.ts';
import { createSessionEvent, encodeSessionEvent } from '../../../../daemon/lib/storage/journal.ts';
import type { SessionId } from '../../../../daemon/lib/session-id.ts';

const NOW = '2026-11-07T10:00:00.000Z';

function world() {
  const port = state.createStatePort({
    home: '/home/fy',
    pluginId: 'ferrets',
    files: [FerretHistoryFiles],
    fs: state.createMemoryHostFs(),
  });
  const append = async (ferret: string, count: number, from = 0) => {
    for (let index = 1; index <= count; index += 1) {
      const event = createSessionEvent(ferret as SessionId, from + index - 1, NOW, 'session.turn', { n: from + index });
      await port.append(FerretHistoryFiles, encodeSessionEvent(event), ferret);
    }
  };
  const source = new HistoryEventSource(port, () => ['wren', 'oak']);
  return { port, append, source };
}

const call = (query: [string, string][]): CallContext =>
  ({ request: { query: queryFrom(query) }, params: new Map() }) as unknown as CallContext;
const scope = (query: [string, string][], known = ['wren']) => eventStreamScope(call(query), id => known.includes(id));
const refusal = (query: [string, string][]): { status: number; code: string } | undefined => {
  try {
    scope(query);
  } catch (error) {
    const e = error as { status: number; code: string };
    return { status: e.status, code: e.code };
  }
  return undefined;
};

function downstream() {
  const frames: unknown[] = [];
  const closed: { code: number; reason: string }[] = [];
  const port: SocketDownstream = {
    send: frame => (frames.push(JSON.parse(String(frame))), 1),
    close: (code, reason) => void closed.push({ code, reason }),
    bufferedBytes: () => 0,
  };
  return { port, frames, closed };
}

describe('the journals as the stream’s source', () => {
  test('replay returns one ferret’s events after a cursor, in order, bounded by the limit', async () => {
    const { append, source } = world();
    await append('wren', 5);
    const page = await source.replay('wren', 2, 2, new AbortController().signal);
    expect(page.map(event => event.sequence)).toEqual([3, 4]);
    expect(page[0]).toMatchObject({ sessionId: 'wren', type: 'session.turn', data: { n: 3 } });
    expect(await source.replay('wren', 5, 10, new AbortController().signal)).toEqual([]);
    expect(await source.replay('oak', 0, 10, new AbortController().signal)).toEqual([]);
  });

  test('the fleet backlog is the last N events across ferrets, and 0 replays nothing but still names the ferrets', async () => {
    const { append, source } = world();
    await append('wren', 3);
    await append('oak', 2);
    const backlog = await source.fleetBacklog(4, new AbortController().signal);
    expect(backlog.sessionIds).toEqual(['wren', 'oak']);
    expect(backlog.events).toHaveLength(4);
    expect(new Set(backlog.events.map(event => event.sessionId))).toEqual(new Set(['wren', 'oak']));
    expect(await source.fleetBacklog(0, new AbortController().signal)).toEqual({
      sessionIds: ['wren', 'oak'],
      events: [],
    });
  });

  test('feeds that open together share the backlog pass: N sockets read each ferret once, not N times', async () => {
    const { port, append } = world();
    await append('wren', 3);
    await append('oak', 2);
    const reads: number[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => (release = resolve));
    const source = new HistoryEventSource(
      {
        lines: (file, name) => port.lines(file, name),
        tail: async (file, options) => {
          reads.push(options.maxBytes);
          await gate;
          return await port.tail(file, options);
        },
      },
      () => ['wren', 'oak'],
    );
    const signal = new AbortController().signal;
    // The first feed's pass is running (held in its first read); five more open meanwhile and join ONE queued pass.
    const first = source.fleetBacklog(3, signal);
    await Bun.sleep(5);
    const burst = Array.from({ length: 5 }, () => source.fleetBacklog(3, signal));
    release();
    const all = await Promise.all([first, ...burst]);
    expect(all.every(backlog => backlog.events.length === 3)).toBe(true);
    // two passes (the running one and the one queued behind it) x two ferrets, however many feeds opened
    expect(reads).toHaveLength(4);
  });

  test('the backlog reads each ferret’s tail with the bound for its limit: limit 10 asks for 64 KiB, not 4 MiB', async () => {
    const { port, append } = world();
    await append('wren', 3);
    await append('oak', 2);
    const asked: number[] = [];
    const source = new HistoryEventSource(
      {
        lines: (file, name) => port.lines(file, name),
        tail: async (file, options) => {
          asked.push(options.maxBytes);
          return await port.tail(file, options);
        },
      },
      () => ['wren', 'oak'],
    );
    await source.fleetBacklog(10, new AbortController().signal);
    expect(asked).toEqual([backlogTailBytes(10), backlogTailBytes(10)]);
    expect(backlogTailBytes(10)).toBe(64 * 1024);
    asked.length = 0;
    await source.fleetBacklog(5_000, new AbortController().signal);
    expect(asked).toEqual([4 * 1024 * 1024, 4 * 1024 * 1024]);
  });

  test('a pass nobody is waiting for any more reads nothing', async () => {
    const { port, append } = world();
    await append('wren', 3);
    let reads = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => (release = resolve));
    const source = new HistoryEventSource(
      {
        lines: (file, name) => port.lines(file, name),
        tail: async (file, options) => {
          reads += 1;
          await gate;
          return await port.tail(file, options);
        },
      },
      () => ['wren'],
    );
    const running = source.fleetBacklog(3, new AbortController().signal);
    await Bun.sleep(5);
    const leaver = new AbortController();
    const gone = source.fleetBacklog(2, leaver.signal);
    leaver.abort(new Error('closed'));
    await expect(gone).rejects.toThrow('closed');
    release();
    await running;
    expect(reads).toBe(1);
  });

  test('the tail read per ferret is about limit lines, not a flat 4 MiB (floor 64 KiB, cap 4 MiB)', () => {
    expect(backlogTailBytes(1)).toBe(64 * 1024);
    expect(backlogTailBytes(200)).toBe(200 * 1024);
    expect(backlogTailBytes(5_000)).toBe(4 * 1024 * 1024);
  });

  test('publish reaches every subscriber until it cancels, and one failing reader never reaches the others', () => {
    const { source } = world();
    const heard: number[] = [];
    const stopFirst = source.subscribe(() => {
      throw new Error('a reader failed');
    });
    const stopSecond = source.subscribe(event => heard.push(event.sequence));
    source.publish({ sequence: 7, sessionId: 'wren', time: NOW, type: 'x', data: {} });
    stopSecond();
    source.publish({ sequence: 8, sessionId: 'wren', time: NOW, type: 'x', data: {} });
    stopFirst();
    expect(heard).toEqual([7]);
  });
});

describe('R537 the query rules are today’s', () => {
  test('a fleet stream: bare, with a tail, and the refusals that keep it from pretending to resume', () => {
    expect(scope([])).toEqual({ kind: 'fleet' });
    expect(scope([['tail', '0']])).toEqual({ kind: 'fleet', tail: 0 });
    expect(refusal([['tail', '5001']])).toEqual({ status: 400, code: 'invalid_query' });
    expect(refusal([['tail', 'x']])).toEqual({ status: 400, code: 'invalid_query' });
    expect(refusal([['after', '3']])).toEqual({ status: 400, code: 'fleet_cursor_unavailable' });
    expect(refusal([['live', '1']])).toEqual({ status: 400, code: 'live_needs_session' });
    expect(refusal([['transcript', '1']])).toEqual({ status: 400, code: 'transcript_needs_session' });
  });

  test('one ferret: its own cursor, live and transcript flags, and its refusals', () => {
    expect(
      scope([
        ['sessionId', 'wren'],
        ['after', '4'],
        ['live', '1'],
        ['transcript', '1'],
      ]),
    ).toEqual({
      kind: 'session',
      sessionId: 'wren',
      after: 4,
      live: true,
      transcript: true,
    });
    expect(
      refusal([
        ['sessionId', 'wren'],
        ['tail', '3'],
      ]),
    ).toEqual({ status: 400, code: 'tail_needs_fleet' });
    expect(refusal([['sessionId', 'nobody']])).toEqual({ status: 404, code: 'not-found' });
    expect(refusal([['sessionId', '../etc']])).toEqual({ status: 400, code: 'invalid_session_id' });
    expect(
      refusal([
        ['sessionId', 'wren'],
        ['live', '2'],
      ]),
    ).toEqual({ status: 400, code: 'invalid_query' });
  });

  test('an unknown parameter, a repeated one and a token in the URL are refused; a leftover ticket is tolerated', () => {
    expect(refusal([['token', 'abc']])).toEqual({ status: 400, code: 'invalid_query' });
    expect(
      refusal([
        ['after', '1'],
        ['after', '2'],
      ]),
    ).toEqual({ status: 400, code: 'invalid_query' });
    expect(refusal([['after', '-1']])).toEqual({ status: 400, code: 'invalid_query' });
    expect(scope([['ticket', 'old']])).toEqual({ kind: 'fleet' });
  });
});

describe('G161 R520 the socket: replay, then the idle proof, then live appends', () => {
  test('a ferret stream replays from its cursor, says idle, then carries what Ferrets appends next', async () => {
    const { append, source } = world();
    await append('wren', 3);
    const timers: (() => void)[] = [];
    const accept = fleetEventsAccept(
      source,
      { after: (_ms, action) => (timers.push(action), { cancel: () => undefined }) },
      id => id === 'wren',
    );
    const attach = await accept(
      call([
        ['sessionId', 'wren'],
        ['after', '1'],
      ]),
    );
    const feed = downstream();
    const handler = await attach(feed.port);
    await handler.open();
    const kinds = () => feed.frames.map(frame => FyEventStreamFrameSchema.parse(frame));
    expect(kinds().map(frame => frame.kind)).toEqual(['event', 'event', 'idle']);
    source.publish({ sequence: 4, sessionId: 'wren', time: NOW, type: 'session.turn', data: { n: 4 } });
    source.publish({ sequence: 4, sessionId: 'oak', time: NOW, type: 'session.turn', data: { n: 4 } });
    const after = kinds();
    expect(after.map(frame => frame.kind)).toEqual(['event', 'event', 'idle', 'event']);
    expect(after.at(-1)).toMatchObject({ kind: 'event', event: { sequence: 4, sessionId: 'wren' } });
    handler.close();
    source.publish({ sequence: 5, sessionId: 'wren', time: NOW, type: 'x', data: {} });
    expect(feed.frames).toHaveLength(4);
  });

  test('a client frame ends the stream: it is server-only', async () => {
    const { source } = world();
    const accept = fleetEventsAccept(source, { after: () => ({ cancel: () => undefined }) }, () => true);
    const attach = await accept(call([]));
    const feed = downstream();
    const handler = await attach(feed.port);
    await handler.open();
    handler.fromClient('hello');
    expect(feed.closed).toEqual([{ code: 1008, reason: 'event stream is server-only' }]);
  });
});

describe('journal events on the stream', () => {
  test('a live-tailed event carries only the envelope fields a replayed event carries, nothing the journal line did not', async () => {
    const { append, source } = world();
    await append('wren', 1);
    const accept = fleetEventsAccept(source, { after: () => ({ cancel: () => undefined }) }, id => id === 'wren');
    const attach = await accept(
      call([
        ['sessionId', 'wren'],
        ['after', '0'],
      ]),
    );
    const feed = downstream();
    const handler = await attach(feed.port);
    await handler.open();
    // A journal line that somehow carried a field beyond the stored envelope: it must not reach the wire.
    source.publish({
      sequence: 2,
      sessionId: 'wren',
      time: NOW,
      type: 'session.turn',
      data: { n: 2 },
      token: 'must-not-travel',
    } as never);
    const events = feed.frames
      .map(frame => FyEventStreamFrameSchema.parse(frame))
      .flatMap(frame => (frame.kind === 'event' ? [frame.event] : []));
    expect(events).toHaveLength(2);
    const [replayed, live] = events;
    expect(Object.keys(live ?? {}).sort()).toEqual(Object.keys(replayed ?? {}).sort());
    expect(Object.keys(live ?? {}).sort()).toEqual(
      Object.keys(journalEventToFyEvent({ sequence: 0, sessionId: 'x', time: NOW, type: 't', data: null })).sort(),
    );
    expect(JSON.stringify(feed.frames).includes('must-not-travel')).toBe(false);
  });
});

describe('G161 live frames widen nothing', () => {
  /** The socket the way a `?live=1` reader opens it, with `sample` as the live readout behind it. */
  async function openLive(sample: () => unknown) {
    const { source } = world();
    const timers: (() => void)[] = [];
    const accept = fleetEventsAccept(
      source,
      { after: (_ms, action) => (timers.push(action), { cancel: () => undefined }) },
      id => id === 'wren',
      { live: { sample: async () => sample() as never } },
    );
    const attach = await accept(
      call([
        ['sessionId', 'wren'],
        ['live', '1'],
      ]),
    );
    const feed = downstream();
    const handler = await attach(feed.port);
    await handler.open();
    // Run every timer armed so far (the live sampler is armed at once after the replay), then let its sample settle.
    for (const run of timers.splice(0)) run();
    await Bun.sleep(5);
    const live = () =>
      feed.frames
        .map(frame => FyEventStreamFrameSchema.parse(frame))
        .flatMap(frame => (frame.kind === 'live' ? [frame.live] : []));
    return { live, feed };
  }

  const FULL_READING = {
    sessionId: 'wren',
    at: NOW,
    turnStartedAt: NOW,
    verb: 'Pontificating…',
    outputTokens: 12,
    inputTokens: 34,
    outputSource: 'transcript',
    compaction: { phase: 'done', endedAt: NOW },
  };

  test('G161 the socket descriptor’s minimum is operator, the same as the ferret read Gate admits at', () => {
    const declared = ferretsManifest.actions?.sockets?.find(entry => entry.key === 'GET /v1/events');
    const read = ferretsManifest.actions?.routes?.find(entry => entry.key === 'GET /v1/ferrets/:ferretId');
    expect(declared?.minimum).toBe('operator');
    expect(declared?.minimum).toBe(read?.minimum);
  });

  test('G161 a ?live=1 stream sends live frames whose fields are exactly the live-activity fields the readout serves', async () => {
    const { live } = await openLive(() => FULL_READING);
    const frames = live();
    expect(frames).toHaveLength(1);
    const allowed = Object.keys(FerretLiveActivitySchema.shape).sort();
    expect(Object.keys(frames[0] ?? {}).sort()).toEqual(allowed);
    expect(frames[0]).toEqual(FULL_READING as never);
  });

  test('G161 a reading that carries a field beyond those is refused by the frame schema, so it never travels', async () => {
    const { live, feed } = await openLive(() => ({ ...FULL_READING, secret: 'must-not-travel' }));
    expect(live()).toEqual([]);
    expect(JSON.stringify(feed.frames).includes('must-not-travel')).toBe(false);
  });

  test('G161 a stream that did not ask for ?live=1 sends no live frame even when a readout is wired', async () => {
    const { source } = world();
    const timers: (() => void)[] = [];
    const accept = fleetEventsAccept(
      source,
      { after: (_ms, action) => (timers.push(action), { cancel: () => undefined }) },
      id => id === 'wren',
      { live: { sample: async () => FULL_READING as never } },
    );
    const attach = await accept(call([['sessionId', 'wren']]));
    const feed = downstream();
    const handler = await attach(feed.port);
    await handler.open();
    for (const run of timers.splice(0)) run();
    await Bun.sleep(5);
    expect(feed.frames.map(frame => FyEventStreamFrameSchema.parse(frame).kind)).not.toContain('live');
  });
});

describe('GET /v1/events follows an archived ferret as today’s findSession did', () => {
  const known = (live: string[], archived: string[]) =>
    followableFerret({ live: id => live.includes(id), archived: id => archived.includes(id) });

  test('a live ferret and an archived one are both followed; one nobody holds is a 404', () => {
    const exists = known(['wren'], ['oak']);
    expect(eventStreamScope(call([['sessionId', 'wren']]), exists)).toMatchObject({
      kind: 'session',
      sessionId: 'wren',
    });
    expect(
      eventStreamScope(
        call([
          ['sessionId', 'oak'],
          ['after', '3'],
        ]),
        exists,
      ),
    ).toEqual({
      kind: 'session',
      sessionId: 'oak',
      after: 3,
    });
    expect(() => eventStreamScope(call([['sessionId', 'ghost']]), exists)).toThrow('no session ghost');
  });

  test('an archived ferret’s journal replays through the same source', async () => {
    const { append, source } = world();
    await append('oak', 3);
    const page = await source.replay('oak', 1, 10, new AbortController().signal);
    expect(page.map(event => event.sequence)).toEqual([2, 3]);
  });
});
