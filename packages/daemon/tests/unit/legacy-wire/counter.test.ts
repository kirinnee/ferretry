import { describe, it } from 'bun:test';
import type { LegacyWireUse } from '@ferretry/protocol';
import should from 'should';
import {
  LEGACY_WIRE_WRITE_INTERVAL_MS,
  LegacyWireUseCounter,
  type LegacyWireDiagnostics,
  type LegacyWireTimers,
  type LegacyWireUseStore,
} from '../../../src/lib/legacy-wire/index.ts';

const ROUTE = 'GET /v1/sessions/:sessionId/attention';
const OTHER = 'POST /v1/sessions/:sessionId/notify';

class Clock implements LegacyWireTimers {
  at = Date.parse('2026-10-20T00:00:00.000Z');
  readonly pending: Array<{ readonly at: number; readonly run: () => void; cancelled: boolean }> = [];

  now(): number {
    return this.at;
  }

  after(delayMs: number, run: () => void): () => void {
    const entry = { at: this.at + delayMs, run, cancelled: false };
    this.pending.push(entry);
    return () => {
      entry.cancelled = true;
    };
  }

  /** Moves time forward and fires every live timer that came due. */
  advance(ms: number): void {
    this.at += ms;
    for (const entry of this.pending.filter(item => !item.cancelled && item.at <= this.at)) {
      entry.cancelled = true;
      entry.run();
    }
  }

  get live(): number {
    return this.pending.filter(item => !item.cancelled).length;
  }
}

class MemoryStore implements LegacyWireUseStore {
  saved: Array<readonly LegacyWireUse[]> = [];
  initial: readonly LegacyWireUse[] = [];
  failLoad = false;
  failSave = false;

  async load(): Promise<readonly LegacyWireUse[]> {
    if (this.failLoad) throw new Error('unreadable');
    return this.initial;
  }

  async save(uses: readonly LegacyWireUse[]): Promise<void> {
    if (this.failSave) throw new Error('disk full');
    this.saved.push(uses);
  }
}

function fixture() {
  const clock = new Clock();
  const store = new MemoryStore();
  const warnings: string[] = [];
  const diagnostics: LegacyWireDiagnostics = { warn: message => warnings.push(message) };
  const counter = new LegacyWireUseCounter(store, clock, diagnostics);
  return { clock, store, warnings, counter };
}

const settle = async () => {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
};

describe('the legacy-wire use counter', () => {
  it('should count a hit with when it happened and the version that made it', () => {
    // Arrange
    const { counter } = fixture();

    // Act
    counter.record({ route: ROUTE, clientVersion: '4.108.0' });

    // Assert
    should(counter.snapshot()).deepEqual([
      {
        route: ROUTE,
        firstAt: '2026-10-20T00:00:00.000Z',
        lastAt: '2026-10-20T00:00:00.000Z',
        count: 1,
        lastClientVersion: '4.108.0',
      },
    ]);
  });

  it('should leave the version out when the caller sent none or only blanks', () => {
    // Arrange
    const { counter } = fixture();

    // Act
    counter.record({ route: ROUTE });
    counter.record({ route: OTHER, clientVersion: '   ' });

    // Assert
    for (const use of counter.snapshot()) should(use).not.have.property('lastClientVersion');
  });

  it('should bound a caller-chosen version', () => {
    // Arrange
    const { counter } = fixture();

    // Act
    counter.record({ route: ROUTE, clientVersion: `  ${'v'.repeat(200)}  ` });

    // Assert
    should(counter.snapshot()[0]?.lastClientVersion).equal('v'.repeat(64));
  });

  it('should keep the first instant, advance the last and sum the count on a second hit', () => {
    // Arrange
    const { counter, clock } = fixture();
    counter.record({ route: ROUTE, clientVersion: '4.1.0' });
    clock.advance(1000);

    // Act
    counter.record({ route: ROUTE, clientVersion: '4.2.0' });

    // Assert
    should(counter.snapshot()).deepEqual([
      {
        route: ROUTE,
        firstAt: '2026-10-20T00:00:00.000Z',
        lastAt: '2026-10-20T00:00:01.000Z',
        count: 2,
        lastClientVersion: '4.2.0',
      },
    ]);
  });

  it('should list routes in a stable order', () => {
    // Arrange
    const { counter } = fixture();

    // Act
    counter.record({ route: OTHER });
    counter.record({ route: ROUTE });

    // Assert
    should(counter.snapshot().map(use => use.route)).deepEqual([ROUTE, OTHER]);
  });

  it('should write the first hit after a quiet spell at once and then at most once a minute', async () => {
    // Arrange
    const { counter, store, clock } = fixture();

    // Act
    counter.record({ route: ROUTE });
    clock.advance(0);
    await settle();
    should(store.saved).have.length(1);
    for (let hit = 0; hit < 20; hit += 1) {
      clock.advance(1000);
      counter.record({ route: ROUTE });
      await settle();
    }

    // Assert — twenty hits inside one minute are one pending write, not twenty
    should(store.saved).have.length(1);
    should(clock.live).equal(1);
    clock.advance(LEGACY_WIRE_WRITE_INTERVAL_MS);
    await settle();
    should(store.saved).have.length(2);
    should(store.saved[1]?.[0]?.count).equal(21);
  });

  it('should flush what is pending and cancel the wait', async () => {
    // Arrange
    const { counter, store, clock } = fixture();
    counter.record({ route: ROUTE });
    clock.advance(0);
    await settle();
    clock.advance(1000);
    counter.record({ route: ROUTE });

    // Act
    await counter.flush();

    // Assert
    should(store.saved).have.length(2);
    should(store.saved[1]?.[0]?.count).equal(2);
    should(clock.live).equal(0);
  });

  it('should write nothing on a flush with nothing pending', async () => {
    // Arrange
    const { counter, store } = fixture();

    // Act
    await counter.flush();

    // Assert
    should(store.saved).have.length(0);
  });

  it('should say a failed save once, keep the count and retry on the next hit', async () => {
    // Arrange
    const { counter, store, clock, warnings } = fixture();
    store.failSave = true;
    counter.record({ route: ROUTE });
    clock.advance(0);
    await settle();
    should(warnings).have.length(1);
    should(warnings[0]).match(/could not be saved: disk full/u);

    // Act
    store.failSave = false;
    clock.advance(1000);
    counter.record({ route: ROUTE });
    clock.advance(LEGACY_WIRE_WRITE_INTERVAL_MS);
    await settle();

    // Assert
    should(store.saved).have.length(1);
    should(store.saved[0]?.[0]?.count).equal(2);
    should(warnings).have.length(1);
  });

  it('should merge what an earlier run saved into this one', async () => {
    // Arrange
    const { counter, store } = fixture();
    store.initial = [
      {
        route: ROUTE,
        firstAt: '2026-10-01T00:00:00.000Z',
        lastAt: '2026-10-10T00:00:00.000Z',
        count: 4,
        lastClientVersion: '4.0.0',
      },
      { route: OTHER, firstAt: '2026-10-02T00:00:00.000Z', lastAt: '2026-10-03T00:00:00.000Z', count: 1 },
    ];
    counter.record({ route: ROUTE, clientVersion: '4.3.0' });

    // Act
    await counter.load();

    // Assert — the earlier first instant, this run's later last instant and version, and both counts
    should(counter.snapshot()).deepEqual([
      {
        route: ROUTE,
        firstAt: '2026-10-01T00:00:00.000Z',
        lastAt: '2026-10-20T00:00:00.000Z',
        count: 5,
        lastClientVersion: '4.3.0',
      },
      { route: OTHER, firstAt: '2026-10-02T00:00:00.000Z', lastAt: '2026-10-03T00:00:00.000Z', count: 1 },
    ]);
  });

  it('should keep the later of two saved entries for one route', async () => {
    // Arrange
    const { counter, store } = fixture();
    store.initial = [
      { route: ROUTE, firstAt: '2026-10-05T00:00:00.000Z', lastAt: '2026-10-06T00:00:00.000Z', count: 1 },
      {
        route: ROUTE,
        firstAt: '2026-10-01T00:00:00.000Z',
        lastAt: '2026-10-02T00:00:00.000Z',
        count: 2,
        lastClientVersion: '3.0.0',
      },
    ];

    // Act
    await counter.load();

    // Assert
    should(counter.snapshot()).deepEqual([
      { route: ROUTE, firstAt: '2026-10-01T00:00:00.000Z', lastAt: '2026-10-06T00:00:00.000Z', count: 3 },
    ]);
  });

  it('should start empty and say so when the store cannot be loaded', async () => {
    // Arrange
    const { counter, store, warnings } = fixture();
    store.failLoad = true;

    // Act
    await counter.load();

    // Assert
    should(counter.snapshot()).deepEqual([]);
    should(warnings[0]).match(/could not be loaded: unreadable/u);
  });

  it('should never throw from record, whatever its clock does', () => {
    // Arrange
    const warnings: string[] = [];
    const counter = new LegacyWireUseCounter(
      new MemoryStore(),
      {
        now: () => {
          throw new Error('the clock broke');
        },
        after: () => () => {},
      },
      { warn: message => warnings.push(message) },
    );

    // Act / Assert
    should(() => counter.record({ route: ROUTE })).not.throw();
    should(warnings[0]).match(/was not counted: the clock broke/u);
  });

  it('should describe a thrown non-error by its text', async () => {
    // Arrange
    const warnings: string[] = [];
    const store: LegacyWireUseStore = {
      load: async () => {
        throw 'plain text';
      },
      save: async () => {},
    };
    const counter = new LegacyWireUseCounter(store, new Clock(), { warn: message => warnings.push(message) });

    // Act
    await counter.load();

    // Assert
    should(warnings[0]).match(/plain text/u);
  });
});
