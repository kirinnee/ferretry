import { describe, it } from 'bun:test';
import should from 'should';
import { type LivenessSample, type LivenessTarget, WardenLivenessMonitor } from '../../../src/lib/warden/index.ts';

const NOW = Date.parse('2026-07-31T12:00:00.000Z');
const TICK_MS = 30_000;

const target = (overrides: Partial<LivenessTarget> = {}): LivenessTarget => ({
  id: 's1',
  status: 'running',
  turn: 1,
  mode: 'auto',
  waiting: false,
  ...overrides,
});

/** A monitor over a fleet and a screen the test controls, on a clock it moves. */
function subject(options: {
  readonly targets?: () => readonly LivenessTarget[];
  readonly sample?: (target: LivenessTarget) => LivenessSample;
}) {
  let now = NOW;
  const monitor = new WardenLivenessMonitor(
    {
      targets: async () => options.targets?.() ?? [target()],
      sample: async item => options.sample?.(item) ?? { paneHash: 'same', transcriptHash: 'same' },
      nowMs: () => now,
    },
    TICK_MS / 1000,
  );
  return {
    monitor,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('the liveness monitor', () => {
  it('should nudge a quiet ferret once, then report it frozen after two frozen ticks', async () => {
    // Arrange
    const { monitor, advance } = subject({});
    monitor.arm();
    const kinds: string[][] = [];

    // Act: a tick every 30s for 21 minutes of total silence.
    for (let tick = 0; tick <= 42; tick += 1) {
      kinds.push((await monitor.tick({ nudgeAllowed: true })).map(event => event.kind));
      advance(TICK_MS);
    }

    // Assert
    const flat = kinds.flatMap((events, tick) => events.map(kind => `${tick}:${kind}`));
    should(flat).deepEqual(['10:nudge', '31:frozen']);
    should(monitor.frozenAt('s1')).equal(new Date(NOW + 31 * TICK_MS).toISOString());
  });

  it.each(['your-turn', 'needs-input'] as const)(
    'should never nudge or freeze a ferret whose turn state is %s — it waits on its owner',
    async turnState => {
      // Arrange — the same total silence as above, but the ferret is at its prompt.
      const { monitor, advance } = subject({ targets: () => [target({ turnState })] });
      monitor.arm();
      const events: string[] = [];

      // Act
      for (let tick = 0; tick <= 42; tick += 1) {
        events.push(...(await monitor.tick({ nudgeAllowed: true })).map(event => event.kind));
        advance(TICK_MS);
      }

      // Assert
      should(events).deepEqual([]);
    },
  );

  it('should remember since when a leftover browser has run under a ferret', async () => {
    // Arrange
    const { monitor, advance } = subject({ sample: () => ({ subprocessAlive: false, leftoverBrowser: true }) });
    await monitor.tick({ nudgeAllowed: true });
    advance(TICK_MS);

    // Act
    await monitor.tick({ nudgeAllowed: true });

    // Assert
    should(monitor.leftoverBrowserSince('s1')).equal(new Date(NOW).toISOString());
  });

  it('should fill the ledger the sweep reads from what changed between looks', async () => {
    // Arrange
    let pane = 'a';
    const { monitor, advance } = subject({ sample: () => ({ paneHash: pane, subprocessAlive: true }) });
    await monitor.tick({ nudgeAllowed: true });
    advance(TICK_MS);
    pane = 'b';

    // Act
    await monitor.tick({ nudgeAllowed: true });

    // Assert
    should(monitor.ledger('s1')).deepEqual({
      lastPaneChangeAt: new Date(NOW + TICK_MS).toISOString(),
      lastSubprocessAt: new Date(NOW + TICK_MS).toISOString(),
      subprocessSince: new Date(NOW).toISOString(),
    });
    should(monitor.ledger('nobody')).be.undefined();
  });

  it('should watch only working ferrets and forget one that stops working or leaves', async () => {
    // Arrange
    let fleet = [target(), target({ id: 's2', status: 'awaiting_user' })];
    const looked: string[] = [];
    const { monitor } = subject({
      targets: () => fleet,
      sample: item => {
        looked.push(item.id);
        return { paneHash: 'x' };
      },
    });
    await monitor.tick({ nudgeAllowed: true });
    fleet = [];

    // Act
    await monitor.tick({ nudgeAllowed: true });

    // Assert
    should(looked).deepEqual(['s1']);
    should(monitor.ledger('s1')).be.undefined();
  });

  it('should never nudge or freeze a waiting or interactive ferret, and never nudge when it may not', async () => {
    // Arrange
    const { monitor, advance } = subject({
      targets: () => [
        target({ id: 'parked', waiting: true }),
        target({ id: 'chat', mode: 'interactive' }),
        target({ id: 'plain' }),
      ],
    });
    const events: string[] = [];

    // Act
    for (let tick = 0; tick <= 32; tick += 1) {
      events.push(...(await monitor.tick({ nudgeAllowed: false })).map(event => `${event.sessionId}:${event.kind}`));
      advance(TICK_MS);
    }

    // Assert
    should(events).deepEqual(['plain:frozen']);
  });

  it('should discount a tick that ran long after it was due, starting the silence again', async () => {
    // Arrange
    const { monitor, advance } = subject({});
    await monitor.tick({ nudgeAllowed: true });

    // Act: the host was starved for twenty minutes, then ticks resume on time.
    advance(20 * 60_000);
    const late = await monitor.tick({ nudgeAllowed: true });
    advance(TICK_MS);
    const next = await monitor.tick({ nudgeAllowed: true });

    // Assert
    should(late).deepEqual([]);
    should(next).deepEqual([]);
  });

  it('should keep going past a look that throws, as no evidence', async () => {
    // Arrange
    const { monitor } = subject({
      sample: () => {
        throw new Error('tmux went away');
      },
    });
    monitor.arm();

    // Act
    const events = await monitor.tick({ nudgeAllowed: true });

    // Assert
    should(events).deepEqual([]);
    should(monitor.ledger('s1')).deepEqual({});
  });

  it('should count a ferret watched in its grace period and while it was seen recently, never disarmed', async () => {
    // Arrange
    let readable = true;
    const { monitor, advance } = subject({ sample: () => (readable ? { paneHash: 'x' } : {}) });
    const disarmed = monitor.watching('s1');
    monitor.arm();
    const grace = monitor.watching('s1');
    advance(3 * TICK_MS);
    const unseen = monitor.watching('s1');
    await monitor.tick({ nudgeAllowed: true });
    const seen = monitor.watching('s1');
    readable = false;
    advance(TICK_MS);
    await monitor.tick({ nudgeAllowed: true });
    advance(2 * TICK_MS);

    // Act
    const blind = monitor.watching('s1');
    monitor.disarm();

    // Assert
    should([disarmed, grace, unseen, seen, blind, monitor.watching('s1')]).deepEqual([
      false,
      true,
      false,
      true,
      false,
      false,
    ]);
  });
});
