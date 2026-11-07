/**
 * R518 R520 R521 R522 R523 R524 R525: the frames and query rules of `GET /v1/events`, driven through the real Ferrets
 * stream (`fleetEventsAccept`) over the real journals. R519 (identical in-flight reads sent once) is the app client's
 * `shared-reads.ts`; the daemon side has no part in it.
 */
import { describe, expect, test } from 'bun:test';
import type { CallContext, SocketDownstream } from '@ferretry/kernel/contract';
import { queryFrom } from '@ferretry/kernel/contract';
import { state } from '@ferretry/kernel/host';
import { FileTranscriptChanges } from '../../../../daemon/adapters/session/live/file-transcript-changes.ts';
import { FerretHistoryFiles } from '../../../../contract/state.ts';
import { fleetEventsAccept, HistoryEventSource } from '../../../../daemon/modules/fleet-events.ts';
import { FyEventStreamFrameSchema } from '../../../../daemon/lib/protocol/session.ts';
import { createSessionDirectory } from '../../../../daemon/lib/session/directory/session-directory.ts';
import { FLEET_EVENT_BACKLOG_LIMIT } from '../../../../daemon/lib/session/events/service.ts';
import { createSessionEvent, encodeSessionEvent } from '../../../../daemon/lib/storage/journal.ts';
import { parseSessionId, type SessionId } from '../../../../daemon/lib/session-id.ts';
import { sessionView } from '../../../support/daemon/session-view.ts';

const NOW = '2026-11-07T10:00:00.000Z';

function world(ferrets: readonly string[] = ['wren', 'oak']) {
  const port = state.createStatePort({
    home: '/home/fy',
    pluginId: 'ferrets',
    files: [FerretHistoryFiles],
    fs: state.createMemoryHostFs(),
  });
  const append = async (ferret: string, count: number) => {
    for (let index = 1; index <= count; index += 1) {
      const event = createSessionEvent(ferret as SessionId, index - 1, NOW, 'session.turn', { n: index });
      await port.append(FerretHistoryFiles, encodeSessionEvent(event), ferret);
    }
  };
  const asked: number[] = [];
  const source = new HistoryEventSource(port, () => ferrets);
  const spied = {
    replay: source.replay.bind(source),
    fleetBacklog: (limit: number, signal: AbortSignal) => (asked.push(limit), source.fleetBacklog(limit, signal)),
    subscribe: source.subscribe.bind(source),
  };
  return { append, source, spied, asked };
}

const call = (query: [string, string][]): CallContext =>
  ({ request: { query: queryFrom(query) }, params: new Map() }) as unknown as CallContext;

function feedOf() {
  const frames: unknown[] = [];
  const port: SocketDownstream = {
    send: frame => (frames.push(JSON.parse(String(frame))), 1),
    close: () => undefined,
    bufferedBytes: () => 0,
  };
  return { port, frames, kinds: () => frames.map(frame => FyEventStreamFrameSchema.parse(frame).kind) };
}

const noTimers = { after: () => ({ cancel: () => undefined }) };

async function open(
  source: Parameters<typeof fleetEventsAccept>[0],
  query: [string, string][],
  extras?: Parameters<typeof fleetEventsAccept>[3],
) {
  const accept = fleetEventsAccept(source, noTimers, () => true, extras);
  const feed = feedOf();
  const handler = await (await accept(call(query)))(feed.port);
  await handler.open();
  return { feed, handler };
}

const refusal = async (
  source: Parameters<typeof fleetEventsAccept>[0],
  query: [string, string][],
): Promise<{ status: number; code: string } | undefined> => {
  try {
    await fleetEventsAccept(source, noTimers, id => id === 'wren')(call(query));
  } catch (error) {
    const e = error as { status: number; code: string };
    return { status: e.status, code: e.code };
  }
  return undefined;
};

describe('R518 a session view carries journalSequence, and a reader opens events after it', () => {
  test('R518 events after=<journalSequence> replay nothing the view already reflects; no field means a full replay', async () => {
    const { append, source } = world();
    await append('wren', 5);
    const view = createSessionDirectory({
      sessions: () => [],
      find: id => ({ id, status: 'running', lastSequence: 3, journalLine: 3, journal: null }),
      readConfig: async id => sessionView(id).config,
      readState: async id => sessionView(id).state,
      directory: id => `/state/sessions/${id}`,
      ended: () => false,
      yieldToLoop: async () => undefined,
    });
    const viewed = await view.get('wren');
    expect(viewed?.journalSequence).toBe(3);

    const resumed = await open(source, [['sessionId', 'wren'], ['after', String(viewed?.journalSequence)]]);
    expect(resumed.feed.frames).toMatchObject([
      { kind: 'event', event: { sequence: 4 } },
      { kind: 'event', event: { sequence: 5 } },
      { kind: 'idle', scope: { kind: 'session', sessionId: 'wren', after: 5 } },
    ]);

    const bare = createSessionDirectory({
      sessions: () => [],
      find: () => undefined,
      readConfig: async id => sessionView(id).config,
      readState: async id => sessionView(id).state,
      directory: id => `/state/sessions/${id}`,
      ended: () => false,
      yieldToLoop: async () => undefined,
    });
    expect(await bare.get(parseSessionId('wren'))).not.toHaveProperty('journalSequence');
    const full = await open(source, [['sessionId', 'wren']]);
    expect(full.feed.kinds()).toEqual(['event', 'event', 'event', 'event', 'event', 'idle']);
  });
});

describe('R520 the idle frame marks the edge between replay and live', () => {
  test('R520 one idle frame follows the replay, an append racing the replay lands before it, later appends after it', async () => {
    const { append, source } = world();
    await append('wren', 2);
    // An append published while the replay read is still in flight overlaps it: delivered once, before the idle.
    const gate = Promise.withResolvers<void>();
    const slow = {
      ...source,
      replay: async (...args: Parameters<typeof source.replay>) => {
        const page = await source.replay(...args);
        await gate.promise;
        return page;
      },
      fleetBacklog: source.fleetBacklog.bind(source),
      subscribe: source.subscribe.bind(source),
    };
    const accept = fleetEventsAccept(slow, noTimers, () => true);
    const feed = feedOf();
    const handler = await (await accept(call([['sessionId', 'wren']])))(feed.port);
    const opening = handler.open();
    source.publish({ sequence: 3, sessionId: 'wren', time: NOW, type: 'session.turn', data: { n: 3 } });
    gate.resolve();
    await opening;
    source.publish({ sequence: 4, sessionId: 'wren', time: NOW, type: 'session.turn', data: { n: 4 } });
    expect(feed.kinds()).toEqual(['event', 'event', 'event', 'idle', 'event']);
    expect(feed.frames[3]).toMatchObject({ kind: 'idle', scope: { kind: 'session', after: 3 } });
  });
});

describe('R521 the event frame schema is strict', () => {
  test('R521 an unknown kind or key is refused by the frame schema, and the stream only ever sends frames that pass it', async () => {
    const { append, source } = world();
    await append('wren', 1);
    const { feed } = await open(source, [['sessionId', 'wren']]);
    for (const frame of feed.frames) expect(FyEventStreamFrameSchema.safeParse(frame).success).toBe(true);
    const [event, idle] = feed.frames as [Record<string, unknown>, Record<string, unknown>];
    expect(FyEventStreamFrameSchema.safeParse({ ...event, extra: 1 }).success).toBe(false);
    expect(FyEventStreamFrameSchema.safeParse({ ...idle, extra: 1 }).success).toBe(false);
    expect(FyEventStreamFrameSchema.safeParse({ kind: 'presence', who: 'wren' }).success).toBe(false);
    expect(FyEventStreamFrameSchema.safeParse({ kind: 'transcript', transcript: {}, extra: 1 }).success).toBe(false);
  });
});

/** A transcript file the test can write to: the stamp moves only on `write`, and `touch` is a hub notice with no write. */
function transcriptFile() {
  let listener: ((path: string) => void) | undefined;
  let stamp = { size: 10, mtimeMs: 1 };
  const changes = new FileTranscriptChanges({
    file: async () => '/home/.claude/projects/x/wren.jsonl',
    stat: async () => ({ ...stamp }),
    files: {
      subscribe: (_path, on) => {
        listener = on;
        return { close: () => (listener = undefined) };
      },
    },
    clock: { now: () => NOW },
  });
  const settle = async () => {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  };
  return {
    changes,
    settle,
    touch: async () => (listener?.('/home/.claude/projects/x/wren.jsonl'), await settle()),
    write: async (size: number) => {
      stamp = { size, mtimeMs: stamp.mtimeMs + 1 };
      listener?.('/home/.claude/projects/x/wren.jsonl');
      await settle();
    },
  };
}

describe('R522 transcript=1 sends a content-free transcript frame each time the proved file changes', () => {
  test('R522 a write that moves size or mtime sends one frame carrying no content; a notice with the same stamp sends none', async () => {
    const { append, source } = world();
    await append('wren', 1);
    const file = transcriptFile();
    const { feed, handler } = await open(source, [['sessionId', 'wren'], ['transcript', '1']], {
      transcript: file.changes,
    });
    await file.settle();
    expect(feed.kinds()).toEqual(['event', 'idle']);
    await file.touch();
    expect(feed.kinds()).toEqual(['event', 'idle']);
    await file.write(25);
    expect(feed.kinds()).toEqual(['event', 'idle', 'transcript']);
    expect(feed.frames[2]).toEqual({ kind: 'transcript', transcript: { sessionId: 'wren', at: NOW } });
    await file.write(40);
    expect(feed.kinds().filter(kind => kind === 'transcript')).toHaveLength(2);
    handler.close();
    await file.write(80);
    expect(feed.kinds().filter(kind => kind === 'transcript')).toHaveLength(2);
  });
});

describe('R523 transcript=1 on a fleet stream is refused', () => {
  test('R523 a fleet stream asking for transcript=1 is refused 400 transcript_needs_session before any frame', async () => {
    const { source } = world();
    expect(await refusal(source, [['transcript', '1']])).toEqual({ status: 400, code: 'transcript_needs_session' });
    expect(await refusal(source, [['transcript', '1'], ['tail', '0']])).toEqual({
      status: 400,
      code: 'transcript_needs_session',
    });
    expect(await refusal(source, [['transcript', '2'], ['sessionId', 'wren']])).toEqual({
      status: 400,
      code: 'invalid_query',
    });
  });
});

describe('R524 only a stream that asked for transcript=1 carries a transcript frame', () => {
  test('R524 the same writes reach the stream that asked and never the one that did not', async () => {
    const { append, source } = world();
    await append('wren', 1);
    const file = transcriptFile();
    const asked = await open(source, [['sessionId', 'wren'], ['transcript', '1']], { transcript: file.changes });
    const plain = await open(source, [['sessionId', 'wren']], { transcript: file.changes });
    const fleet = await open(source, [], { transcript: file.changes });
    await file.settle();
    await file.write(25);
    expect(asked.feed.kinds()).toContain('transcript');
    expect(plain.feed.kinds()).not.toContain('transcript');
    expect(fleet.feed.kinds()).not.toContain('transcript');
  });
});

describe('R525 tail is an integer 0-5000, default 5000, and only valid on a fleet stream', () => {
  test('R525 the bound, the default and the session refusal', async () => {
    const { source, spied, asked } = world();
    await open(spied, []);
    await open(spied, [['tail', '0']]);
    await open(spied, [['tail', '5000']]);
    expect(asked).toEqual([FLEET_EVENT_BACKLOG_LIMIT, 0, 5000]);
    expect(FLEET_EVENT_BACKLOG_LIMIT).toBe(5000);
    for (const bad of ['5001', '-1', '1.5', 'x', '']) {
      expect(await refusal(source, [['tail', bad]])).toEqual({ status: 400, code: 'invalid_query' });
    }
    expect(await refusal(source, [['sessionId', 'wren'], ['tail', '3']])).toEqual({
      status: 400,
      code: 'tail_needs_fleet',
    });
    expect(await refusal(source, [['sessionId', 'wren'], ['tail', '0']])).toEqual({
      status: 400,
      code: 'tail_needs_fleet',
    });
  });
});
