import { describe, it } from 'bun:test';
import { GIBIBYTE, resolveLimits } from '../../../../daemon/lib/protocol/limits.ts';
import should from 'should';
import {
  describeProcess,
  FleetMemoryWatcher,
  type FleetSighting,
  THROTTLE_MEMORY_MS,
  type TreeProcess,
} from '../../../../daemon/lib/cgroups/index.ts';

const SESSION = 'aaaaaaaa-1111-2222-3333-444444444444';
const SCOPE = `ferretry-agent-${SESSION}-a1b2c3d4.scope`;
const events = (high: number, oomKill = 0) => ({ high, max: 0, oom: oomKill, oomKill });

function harness() {
  let now = 1_000_000;
  let sighting: FleetSighting | undefined;
  let largest: readonly TreeProcess[] = [];
  const notes: { sessionId: string; kind: string; data: unknown }[] = [];
  const watcher = new FleetMemoryWatcher({
    fleet: { read: async () => sighting, largest: async () => largest },
    memory: { sessions: async () => [SESSION], total: async () => 13 * GIBIBYTE },
    notes: {
      note: async (sessionId, kind, data) => void notes.push({ sessionId, kind, data }),
      callsign: async () => 'gertrude',
    },
    now: () => now,
    iso: ms => new Date(ms).toISOString(),
  });
  return {
    watcher,
    notes,
    see: (next: FleetSighting | undefined) => (sighting = next),
    biggest: (next: readonly TreeProcess[]) => (largest = next),
    advance: (ms: number) => (now += ms),
  };
}

const scope = (high: number, oomKill = 0, currentBytes = 1 * GIBIBYTE) => ({
  scope: SCOPE,
  events: events(high, oomKill),
  currentBytes,
  highBytes: 12 * GIBIBYTE,
});

describe('watching a ferret being slowed', () => {
  it('should treat the first look as a baseline: old history is not news', async () => {
    // Arrange
    const { watcher, see, notes } = harness();
    see({ events: events(40), scopes: [scope(40)] });

    // Act
    await watcher.tickLinux();

    // Assert
    should((await watcher.state()).throttled).deepEqual([]);
    should(notes).deepEqual([]);
  });

  it('should call a ferret slowed when `high` rose, tell it once, and stop saying so after a while', async () => {
    // Arrange
    const { watcher, see, notes, advance } = harness();
    see({ events: events(0), scopes: [scope(0)] });
    await watcher.tickLinux();

    // Act
    advance(30_000);
    see({ events: events(3), scopes: [scope(3)] });
    await watcher.tickLinux();
    advance(30_000);
    see({ events: events(7), scopes: [scope(7)] });
    await watcher.tickLinux();
    const slowed = (await watcher.state()).throttled;
    advance(THROTTLE_MEMORY_MS + 1);
    const later = (await watcher.state()).throttled;

    // Assert
    should(slowed).deepEqual([{ sessionId: SESSION, callsign: 'gertrude' }]);
    should(notes.filter(note => note.kind === 'memory_throttled')).have.length(1);
    should(later).deepEqual([]);
  });
});

describe('watching a ferret being killed for memory', () => {
  it('should report a process killed inside a live scope, with what was biggest when last looked', async () => {
    // Arrange
    const { watcher, see, biggest, notes, advance } = harness();
    see({ events: events(0), scopes: [scope(0)] });
    await watcher.tickLinux();
    advance(30_000);
    biggest([{ argv: 'bun test --coverage', rssBytes: Math.floor(9.1 * GIBIBYTE) }]);
    see({ events: events(2), scopes: [scope(2, 0, 11 * GIBIBYTE)] });
    await watcher.tickLinux();

    // Act
    advance(30_000);
    see({ events: events(2, 1), scopes: [scope(2, 1, 3 * GIBIBYTE)] });
    await watcher.tickLinux();

    // Assert
    const killed = (await watcher.state()).killed;
    should(killed).have.length(1);
    should(killed[0]).match({
      sessionId: SESSION,
      callsign: 'gertrude',
      what: 'bun test',
      bytes: Math.floor(9.1 * GIBIBYTE),
    });
    should(notes.some(note => note.kind === 'memory_killed')).equal(true);
  });

  it('should blame the ferret whose scope vanished when the fleet’s own counter says something was killed', async () => {
    // Arrange — the agent itself died: its scope is gone, but the slice kept the count.
    const { watcher, see, advance } = harness();
    see({ events: events(0), scopes: [scope(0, 0, 13 * GIBIBYTE)] });
    await watcher.tickLinux();

    // Act
    advance(30_000);
    see({ events: events(0, 1), scopes: [] });
    await watcher.tickLinux();

    // Assert
    const killed = (await watcher.state()).killed;
    should(killed).have.length(1);
    should(killed[0]?.sessionId).equal(SESSION);
    should(watcher.killedRecently(SESSION, 60_000)).not.equal(undefined);
  });

  it('should not blame anyone when a scope merely ended', async () => {
    // Arrange
    const { watcher, see, advance } = harness();
    see({ events: events(0), scopes: [scope(0)] });
    await watcher.tickLinux();

    // Act
    advance(30_000);
    see({ events: events(0), scopes: [] });
    await watcher.tickLinux();

    // Assert
    should((await watcher.state()).killed).deepEqual([]);
  });

  it('should keep going when the kernel read fails', async () => {
    // Arrange
    const { watcher, see } = harness();
    see(undefined);

    // Act + Assert
    await watcher.tickLinux();
    should((await watcher.state()).throttled).deepEqual([]);
  });

  it('should shorten a command line to what a sentence can hold', () => {
    // Arrange / Act / Assert
    should(describeProcess({ argv: '/usr/bin/bun test --coverage', rssBytes: 1 })).equal('bun test');
    should(describeProcess({ argv: 'node --max-old-space-size=4096', rssBytes: 1 })).equal('node');
    should(describeProcess({ argv: '', rssBytes: 1 })).equal('a process');
  });
});

describe('a watcher whose reads fail', () => {
  const failing = (over: { readFleet?: boolean; sessions?: boolean }) =>
    new FleetMemoryWatcher({
      fleet: {
        read: async () => {
          if (over.readFleet === true) throw new Error('no cgroup');
          return undefined;
        },
        largest: async () => [],
      },
      memory: {
        sessions: async () => {
          if (over.sessions === true) throw new Error('no ps');
          return [];
        },
        total: async () => 0,
      },
      notes: { note: async () => undefined, callsign: async () => undefined },
      now: () => 0,
      iso: ms => new Date(ms).toISOString(),
    });

  it('should change nothing, and say nothing, when the kernel read throws', async () => {
    // Arrange
    const watcher = failing({ readFleet: true });

    // Act
    await watcher.tickLinux();

    // Assert
    should((await watcher.state()).throttled).deepEqual([]);
  });

  it('should keep the last answer when the process list throws', async () => {
    // Arrange
    const watcher = failing({ sessions: true });

    // Act
    await watcher.tickWatch(resolveLimits({}, { memoryCeilingBytes: 48 * GIBIBYTE }));

    // Assert
    should((await watcher.state()).overBudget).deepEqual([]);
  });
});

describe('watching memory where the kernel keeps no counters (macOS)', () => {
  it('should report a ferret over its share, once, without capping anything', async () => {
    // Arrange
    const { watcher, notes } = harness();
    const limits = resolveLimits({}, { memoryCeilingBytes: 48 * GIBIBYTE });

    // Act
    await watcher.tickWatch(limits);
    await watcher.tickWatch(limits);

    // Assert — 13 GiB against the 12 GiB per-ferret soft limit.
    should((await watcher.state()).overBudget).deepEqual([
      { sessionId: SESSION, bytes: 13 * GIBIBYTE, callsign: 'gertrude' },
    ]);
    should(notes).have.length(1);
  });
});

describe('watching the ferrets together being slowed by the fleet’s own soft limit', () => {
  it('should report the aggregate throttling when only the fleet’s counter rose, and tell each live ferret once', async () => {
    // Arrange — each ferret stays under its own soft limit, so no child counter moves
    const { watcher, see, notes, advance } = harness();
    see({ events: events(0), scopes: [scope(0)] });
    await watcher.tickLinux();

    // Act
    advance(30_000);
    see({ events: events(100), scopes: [scope(0)] });
    await watcher.tickLinux();
    advance(30_000);
    see({ events: events(180), scopes: [scope(0)] });
    await watcher.tickLinux();
    const during = await watcher.state();
    advance(THROTTLE_MEMORY_MS + 1);
    const after = await watcher.state();

    // Assert
    should(during.fleetSlowed).be.true();
    should(during.throttled).deepEqual([]);
    const told = notes.filter(note => note.kind === 'memory_throttled');
    should(told).have.length(1);
    should(told[0]).match({ sessionId: SESSION, data: { shared: true } });
    should(after.fleetSlowed).be.false();
  });

  it('should hand the view what the kernel holds for the slice and each scope, and none once the slice is gone', async () => {
    // Arrange
    const { watcher, see } = harness();
    see({
      events: events(0),
      applied: { memoryMax: 55 * GIBIBYTE, memoryHigh: null },
      scopes: [{ ...scope(0), applied: { memoryMax: 14 * GIBIBYTE } }],
    });

    // Act
    await watcher.tickLinux();
    const present = (await watcher.state()).applied;
    see(undefined);
    await watcher.tickLinux();
    const gone = (await watcher.state()).applied;

    // Assert
    should(present).deepEqual({
      fleet: { memoryMax: 55 * GIBIBYTE, memoryHigh: null },
      scopes: [{ memoryMax: 14 * GIBIBYTE }],
    });
    should(gone).equal(undefined);
  });
});
