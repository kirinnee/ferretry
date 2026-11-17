import { describe, it } from 'bun:test';
import should from 'should';
import {
  type LivenessSample,
  type LivenessTarget,
  type ReflexEvent,
  WardenLivenessMonitor,
} from '../../daemon/lib/index.ts';

const START = Date.parse('2026-07-31T12:00:00.000Z');
const TICK_SECONDS = 30;
/** The reflex's default quiet window: five minutes. */
const NUDGE_AFTER_SECONDS = 300;

const working: LivenessTarget = { id: 's1', status: 'running', turn: 1, mode: 'auto', waiting: false };
/** At its prompt after a finished turn: waiting on its owner, so the reflex is suspended. */
const atPrompt: LivenessTarget = { ...working, turnState: 'your-turn' };

/** A monitor over one ferret and a silent screen, on a fake clock the test moves. */
function subject() {
  let now = START;
  let current: LivenessTarget | undefined = working;
  const monitor = new WardenLivenessMonitor(
    {
      targets: async () => (current === undefined ? [] : [current]),
      sample: async (): Promise<LivenessSample> => ({ paneHash: 'same', transcriptHash: 'same' }),
      nowMs: () => now,
    },
    TICK_SECONDS,
  );
  monitor.arm();
  const world = {
    monitor,
    advance: (seconds: number) => {
      now += seconds * 1000;
    },
    /** What the fleet says the ferret is now; `undefined` is stopped (not listed as working). */
    set: (value: LivenessTarget | undefined) => {
      current = value;
    },
    seconds: () => (now - START) / 1000,
    /** Tick every 30 s for `seconds`; the seconds since `from` at which a nudge came. */
    async tickFor(seconds: number, from = 0): Promise<readonly number[]> {
      const nudges: number[] = [];
      for (let spent = 0; spent < seconds; spent += TICK_SECONDS) {
        const events: readonly ReflexEvent[] = await monitor.tick({ nudgeAllowed: true });
        if (events.some(event => event.kind === 'nudge')) nudges.push(world.seconds() - from);
        world.advance(TICK_SECONDS);
      }
      return nudges;
    },
  };
  return world;
}

describe('the liveness monitor on a launch', () => {
  it('should send no nudge to a ferret resumed after ten minutes stopped until the quiet window has passed since the resume', async () => {
    // Arrange — it sat at its prompt, then was stopped for ten minutes, the same turn throughout.
    const world = subject();
    world.set(atPrompt);
    await world.tickFor(300);
    world.set(undefined);
    await world.tickFor(600);

    // Act — the resume is announced; the ferret is working again and its first look comes 3 s later.
    world.set(working);
    world.monitor.launched('s1');
    const resumedAt = world.seconds();
    world.advance(3);
    const nudges = await world.tickFor(NUDGE_AFTER_SECONDS - TICK_SECONDS, resumedAt);

    // Assert
    should(nudges).deepEqual([]);
  });

  it('should send no nudge to a fresh start until the quiet window has passed since it launched', async () => {
    // Arrange — it sat at its prompt for ten minutes before this start, the same turn.
    const world = subject();
    world.set(atPrompt);
    await world.tickFor(600);

    // Act — the start is announced and the ferret works; its first look comes a second later.
    world.set(working);
    world.monitor.launched('s1');
    const startedAt = world.seconds();
    world.advance(1);
    const nudges = await world.tickFor(NUDGE_AFTER_SECONDS - TICK_SECONDS, startedAt);

    // Assert
    should(nudges).deepEqual([]);
  });

  it('should send no nudge to a quiet ferret relaunched in place until the quiet window has passed since the relaunch', async () => {
    // Arrange — quiet for 4 min 30 s: a tick short of its nudge. The restart lands inside one tick.
    const world = subject();
    await world.tickFor(270);

    // Act
    world.monitor.launched('s1');
    const relaunchedAt = world.seconds();
    const nudges = await world.tickFor(NUDGE_AFTER_SECONDS - TICK_SECONDS, relaunchedAt);

    // Assert
    should(nudges).deepEqual([]);
  });

  it('should still nudge a ferret that stays quiet for the whole window after its launch', async () => {
    // Arrange
    const world = subject();
    world.set(atPrompt);
    await world.tickFor(600);
    world.set(working);
    world.monitor.launched('s1');
    const resumedAt = world.seconds();
    world.advance(3);

    // Act
    const nudges = await world.tickFor(NUDGE_AFTER_SECONDS + 2 * TICK_SECONDS, resumedAt);

    // Assert — exactly one, no sooner than the window and within a tick or two of it.
    should(nudges).have.length(1);
    should(nudges[0]).be.aboveOrEqual(NUDGE_AFTER_SECONDS);
    should(nudges[0]).be.belowOrEqual(NUDGE_AFTER_SECONDS + TICK_SECONDS);
  });
});
