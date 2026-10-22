import { afterEach, describe, it } from 'bun:test';
import { type FyEventStreamFrame, FyEventStreamFrameSchema, type SessionView } from '@ferretry/protocol';
import { FyApiClient } from '@ferretry/protocol/client';
import should from 'should';
import { BunApiServer } from '../../../src/adapters/api/index.ts';
import {
  ApiDispatcher,
  ApiRouter,
  type ApiServerHandle,
  ApiSocketDispatcher,
  NO_GOVERNED_ROUTES_GUARD,
} from '../../../src/lib/api/index.ts';
import { fleetEventSocketRoutes, sessionRoutes } from '../../../src/lib/runtime/index.ts';
import { type FleetEventSource, FleetEventStreamService } from '../../../src/lib/session/events/index.ts';
import type { StoredSessionEvent } from '../../../src/lib/session/reads/index.ts';
import { sessionDirectory, sessionView } from '../../unit/runtime/mounts/support.ts';

/**
 * The cheap reads, over a REAL socket: the routes the daemon mounts, behind the real Bun server, read
 * by the real protocol client and a real WebSocket. The unit tiers prove each decision; this proves
 * the bytes a phone pays for — a bodyless `304` that the client turns back into the list, and a feed
 * whose first frame arrives at once, with no replay when the reader asks for none.
 */

const BIND = { host: '127.0.0.1', port: 0, directLoopbackIsPrivileged: true } as const;
const CREDENTIALS = { admin: 'admin-secret' } as const;
const AT = '2026-08-01T00:00:00.000Z';

const running: ApiServerHandle[] = [];

afterEach(async () => {
  while (running.length > 0) {
    const handle = running.pop();
    handle?.closeSockets();
    await handle?.stop();
  }
});

/** A journal the test appends to, with a recent tail that would be replayed unless asked otherwise. */
class Journal implements FleetEventSource {
  readonly backfills: number[] = [];
  private readonly listeners = new Set<(event: StoredSessionEvent) => void>();

  constructor(private readonly tail: readonly StoredSessionEvent[]) {}

  async replay(): Promise<readonly StoredSessionEvent[]> {
    return [];
  }

  async fleetBacklog(limit: number): Promise<{ sessionIds: string[]; events: readonly StoredSessionEvent[] }> {
    this.backfills.push(limit);
    return { sessionIds: ['s1', 's2'], events: this.tail.slice(0, limit) };
  }

  subscribe(listener: (event: StoredSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  append(event: StoredSessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

const stored = (sessionId: string, sequence: number): StoredSessionEvent => ({
  sessionId,
  sequence,
  time: AT,
  type: 'session.turn',
  data: {},
});

async function serve(views: readonly SessionView[], journal: Journal): Promise<ApiServerHandle> {
  const directory = sessionDirectory(views);
  // The real scheduler: a first frame that waited out the quiet window would not arrive in this test.
  const events = new FleetEventStreamService(journal, {
    after: (milliseconds, action) => {
      const timer = setTimeout(action, milliseconds);
      return { cancel: () => clearTimeout(timer) };
    },
  });
  const configChanges = {
    handler: () => {
      throw new Error('no configuration stream is asked for here');
    },
  };
  const handle = await new BunApiServer().listen(
    {
      http: new ApiDispatcher(new ApiRouter(sessionRoutes(directory)), CREDENTIALS, NO_GOVERNED_ROUTES_GUARD),
      sockets: new ApiSocketDispatcher(
        new ApiRouter(fleetEventSocketRoutes(events, directory, configChanges)),
        CREDENTIALS,
        NO_GOVERNED_ROUTES_GUARD,
      ),
      corsOrigins: [],
    },
    BIND,
  );
  running.push(handle);
  return handle;
}

/** The frames one feed socket received, parsed as the protocol parses them. */
function follow(handle: ApiServerHandle, query: string) {
  const socket = new WebSocket(
    `${handle.url.replace('http://', 'ws://')}/v1/events?${query}&token=${CREDENTIALS.admin}`,
  );
  const frames: FyEventStreamFrame[] = [];
  socket.addEventListener('message', event =>
    frames.push(FyEventStreamFrameSchema.parse(JSON.parse(String(event.data)))),
  );
  const until = async (count: number): Promise<void> => {
    for (let attempt = 0; attempt < 300 && frames.length < count; attempt += 1) await Bun.sleep(10);
  };
  return { frames, until, close: () => socket.close() };
}

describe('cheap reads over the real server', () => {
  it('should answer an unchanged fleet with a bodyless 304 that the client turns back into the list', async () => {
    // Arrange — a client whose transport counts what crossed the wire.
    const views = [sessionView('s1'), sessionView('s2', { name: 'Mount The Boards' })];
    const handle = await serve(views, new Journal([]));
    const wire: Array<readonly [number, number]> = [];
    const client = await FyApiClient.connect({
      baseUrl: handle.url,
      token: CREDENTIALS.admin,
      version: '0.0.0',
      transport: {
        send: async (url, init) => {
          const response = await fetch(url, init);
          const body = await response.clone().arrayBuffer();
          wire.push([response.status, body.byteLength]);
          return response;
        },
      },
    });

    // Act
    const first = await client.list();
    const second = await client.list();

    // Assert — the same answer both times, and the second one carried no body at all.
    should(second).deepEqual(first);
    should(first.map(view => view.config.name)).deepEqual(['Wire Subsystems', 'Mount The Boards']);
    should(wire[0]?.[0]).equal(200);
    should(wire[0]?.[1]).be.above(1_000);
    should(wire[1]).deepEqual([304, 0]);
  });

  it('should open a quiet session feed with its proof at once, not after the quiet window', async () => {
    // Arrange
    const handle = await serve([sessionView('s1')], new Journal([]));

    // Act
    const feed = follow(handle, 'sessionId=s1&after=12');
    await feed.until(1);
    feed.close();

    // Assert — thirty seconds is the window; the test would time out long before a timer proof.
    should(feed.frames).deepEqual([
      { kind: 'idle', idleSeconds: 30, scope: { kind: 'session', sessionId: 's1', after: 12 } },
    ]);
  });

  it('should replay nothing to a fleet reader that asked for no tail, and then follow the live edge', async () => {
    // Arrange — a recent tail an old reader would be handed whole.
    const journal = new Journal([stored('s1', 1), stored('s2', 1), stored('s1', 2)]);
    const handle = await serve([sessionView('s1'), sessionView('s2')], journal);

    // Act
    const quiet = follow(handle, 'tail=0');
    await quiet.until(1);
    journal.append(stored('s2', 2));
    await quiet.until(2);
    const whole = follow(handle, 'after=0');
    await whole.until(4);
    quiet.close();
    whole.close();

    // Assert — the tail=0 reader saw the edge, then only what happened after it.
    should(journal.backfills).deepEqual([0, 5_000]);
    should(quiet.frames).deepEqual([
      { kind: 'idle', idleSeconds: 30, scope: { kind: 'fleet', followedSessions: 2 } },
      {
        kind: 'event',
        event: { sequence: 2, time: AT, sessionId: 's2', type: 'session.turn', source: 'daemon', data: {} },
      },
    ]);
    // A reader that predates `tail` is answered exactly as before, plus the opening proof.
    should(whole.frames.map(frame => frame.kind)).deepEqual(['event', 'event', 'event', 'idle']);
  });
});
