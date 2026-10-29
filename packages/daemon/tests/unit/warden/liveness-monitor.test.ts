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

  it('should count a ferret watched in its grace period, unwatched only after three on-time blind looks', async () => {
    // Arrange
    let readable = true;
    const { monitor, advance } = subject({ sample: () => (readable ? { paneHash: 'x' } : {}) });
    const disarmed = monitor.watching('s1');
    monitor.arm();
    const grace = monitor.watching('s1');
    for (let tick = 0; tick < 4; tick += 1) {
      await monitor.tick({ nudgeAllowed: true });
      advance(TICK_MS);
    }
    const seen = monitor.watching('s1');
    readable = false;
    const blindAfter: boolean[] = [];
    for (let look = 0; look < 3; look += 1) {
      await monitor.tick({ nudgeAllowed: true });
      blindAfter.push(monitor.watching('s1'));
      advance(TICK_MS);
    }

    // Act
    monitor.disarm();

    // Assert
    should([disarmed, grace, seen, ...blindAfter, monitor.watching('s1')]).deepEqual([
      false,
      true,
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  it('should count a ferret started since the last tick as watched — it has missed no look', async () => {
    // Arrange — 2026-10-29 06:26: a ferret flagged dead_monitor 14 s after it was born.
    let fleet = [target()];
    const { monitor, advance } = subject({ targets: () => fleet });
    monitor.arm();
    for (let tick = 0; tick < 4; tick += 1) {
      await monitor.tick({ nudgeAllowed: true });
      advance(TICK_MS);
    }
    fleet = [target(), target({ id: 'newborn' })];

    // Act
    const watched = monitor.watching('newborn');

    // Assert
    should(watched).be.true();
    should(monitor.stalled()).be.false();
  });

  it('should count no ferret unwatched when the host is starved — the stall is the monitor’s, said once', async () => {
    // Arrange — 2026-10-29 05:54–06:10: event-loop stalls of 10–143 s; every tick ran minutes late.
    const fleet = Array.from({ length: 15 }, (_, index) => target({ id: `s${index}` }));
    const { monitor, advance } = subject({ targets: () => fleet });
    monitor.arm();
    await monitor.tick({ nudgeAllowed: true });

    // Act — ticks every three minutes instead of every thirty seconds.
    for (let tick = 0; tick < 4; tick += 1) {
      advance(6 * TICK_MS);
      await monitor.tick({ nudgeAllowed: true });
    }
    advance(4 * TICK_MS);
    const watchedWhileStarved = fleet.filter(item => monitor.watching(item.id)).length;
    // …then the host stops ticking at all for five minutes.
    advance(7 * TICK_MS);

    // Assert — nobody was counted unwatched while ticks still ran; a monitor that sees nothing for five
    // minutes is stalled, which the sweep reports as ONE fault.
    should(watchedWhileStarved).equal(15);
    should(monitor.stalled()).be.true();
    should(fleet.filter(item => monitor.watching(item.id))).be.empty();
  });

  it('should not count a blind look in a tick that ran long against the ferret', async () => {
    // Arrange — one ferret readable, one not, and each look takes 20 s of a starved host.
    let now = NOW;
    const monitor = new WardenLivenessMonitor(
      {
        targets: async () => [target(), target({ id: 's2' })],
        sample: async item => {
          now += 20_000;
          return item.id === 's1' ? { paneHash: 'x' } : {};
        },
        nowMs: () => now,
      },
      TICK_MS / 1000,
    );
    monitor.arm();

    // Act
    for (let tick = 0; tick < 6; tick += 1) {
      await monitor.tick({ nudgeAllowed: true });
      now += TICK_MS;
    }

    // Assert
    should([monitor.watching('s1'), monitor.watching('s2'), monitor.stalled()]).deepEqual([true, true, false]);
  });

  it('should not blame the ferrets for a tick blind to every one of them', async () => {
    // Arrange
    let readable = true;
    const fleet = [target(), target({ id: 's2' })];
    const { monitor, advance } = subject({ targets: () => fleet, sample: () => (readable ? { paneHash: 'x' } : {}) });
    monitor.arm();
    await monitor.tick({ nudgeAllowed: true });
    readable = false;

    // Act
    for (let tick = 0; tick < 10; tick += 1) {
      advance(TICK_MS);
      await monitor.tick({ nudgeAllowed: true });
    }
    const unwatchedWhileBlind = [monitor.watching('s1'), monitor.watching('s2')];
    const stalledAfterBlindTicks = monitor.stalled();
    readable = true;
    advance(TICK_MS);
    await monitor.tick({ nudgeAllowed: true });

    // Assert — no ferret blamed for ticks blind to all; stalled once that lasts five minutes; and both
    // watched again the moment it sees.
    should(unwatchedWhileBlind).deepEqual([false, false]);
    should(stalledAfterBlindTicks).be.true();
    should([monitor.stalled(), monitor.watching('s1'), monitor.watching('s2')]).deepEqual([false, true, true]);
  });

  it('should say when it first looked at a ferret, and forget it when the ferret stops working', async () => {
    // Arrange
    let fleet = [target()];
    const { monitor, advance } = subject({ targets: () => fleet });
    const before = monitor.observedSince('s1');
    await monitor.tick({ nudgeAllowed: true });
    advance(TICK_MS);
    await monitor.tick({ nudgeAllowed: true });
    const first = monitor.observedSince('s1');
    fleet = [];

    // Act
    await monitor.tick({ nudgeAllowed: true });

    // Assert
    should([before, first, monitor.observedSince('s1')]).deepEqual([undefined, new Date(NOW).toISOString(), undefined]);
  });
});
