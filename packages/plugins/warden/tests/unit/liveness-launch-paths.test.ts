import { describe, it } from 'bun:test';
import should from 'should';
import {
  type LivenessSample,
  type LivenessTarget,
  type ReflexEvent,
  WardenLivenessMonitor,
} from '../../daemon/lib/index.ts';
import { type FerretChangeFacts, isLaunchChange } from '../../daemon/lib/launch-change.ts';

/**
 * M2 — the Warden's "Liveness check" nudge must never land seconds after a launch. Every way a ferret is launched
 * writes the `ferret.changed` payloads below (read from the Ferrets service: `startNamed` writes `starting` with
 * change `started`; `resumeHeld` — resume, restart, the restart queue, a model switch, a revive, the lifecycle's
 * `launchHeld` — writes `starting` over `stopped`; `attach` writes `working` straight over `stopped`; the registry's
 * own `put` says the state alone). A virtual clock drives the real monitor through the real launch decision and counts
 * the seconds from THE LAUNCH to the first nudge.
 */

const START = Date.parse('2026-07-31T12:00:00.000Z');
const TICK_SECONDS = 30;
/** The reflex's default quiet window: five minutes. */
const NUDGE_AFTER_SECONDS = 300;
/** A tick short of the nudge: the most stale a track can be and still be un-nudged. */
const STALE_SECONDS = NUDGE_AFTER_SECONDS - TICK_SECONDS;

const working: LivenessTarget = { id: 's1', status: 'running', turn: 1, mode: 'auto', waiting: false };
/** At its prompt, waiting on its owner: the reflex is suspended, but its track and anchor keep ageing. */
const atPrompt: LivenessTarget = { ...working, turnState: 'your-turn' };

/** The payloads each launch path writes, in order. */
const STARTED: readonly FerretChangeFacts[] = [
  { state: 'starting', change: 'started' },
  { state: 'working', previous: 'starting', change: 'state' },
];
const RELAUNCHED: readonly FerretChangeFacts[] = [
  { state: 'starting', previous: 'stopped', change: 'state' },
  { state: 'working', previous: 'starting', change: 'state' },
];
const RELAUNCHED_LIVE: readonly FerretChangeFacts[] = [
  { state: 'starting', previous: 'working', change: 'state' },
  { state: 'working', previous: 'starting', change: 'state' },
];
const ATTACHED: readonly FerretChangeFacts[] = [{ state: 'working', previous: 'stopped', change: 'state' }];
const REGISTRY_PUT: readonly FerretChangeFacts[] = [{ state: 'starting' }];

/** A monitor over one ferret and a silent screen, on a fake clock the test moves. */
function subject(listed: LivenessTarget | null = working) {
  let now = START;
  let current: LivenessTarget | undefined = listed ?? undefined;
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
    set: (value: LivenessTarget | undefined) => {
      current = value;
    },
    seconds: () => (now - START) / 1000,
    /** The Warden's own `ferret.changed` handler: the launch decision, then the monitor. */
    hear(payloads: readonly FerretChangeFacts[]) {
      for (const payload of payloads) if (isLaunchChange(payload)) monitor.launched('s1');
    },
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

/** Quiet for a tick short of the nudge, then `payloads` are heard; the nudges counted from the launch. */
async function launchAfterStaleTrack(payloads: readonly FerretChangeFacts[], settle: number, observe: number) {
  const world = subject();
  await world.tickFor(STALE_SECONDS);
  world.hear(payloads);
  const launchedAt = world.seconds();
  world.advance(settle);
  return await world.tickFor(observe, launchedAt);
}

describe('the reflex nudge after every way a ferret is launched', () => {
  it('M2 start: should send no nudge until the quiet window has passed since a fresh start, even one that reuses a stale track', async () => {
    should(await launchAfterStaleTrack(STARTED, 1, NUDGE_AFTER_SECONDS - TICK_SECONDS)).deepEqual([]);
  });

  it('M2 resume: should send no nudge until the quiet window has passed since the resume', async () => {
    should(await launchAfterStaleTrack(RELAUNCHED, 3, NUDGE_AFTER_SECONDS - TICK_SECONDS)).deepEqual([]);
  });

  it('M2 relaunch or restart in place: should send no nudge until the quiet window has passed since a ferret still working was relaunched', async () => {
    should(await launchAfterStaleTrack(RELAUNCHED_LIVE, 0, NUDGE_AFTER_SECONDS - TICK_SECONDS)).deepEqual([]);
  });

  it('M2 model switch relaunch: should send no nudge until the quiet window has passed since the switch relaunched it', async () => {
    should(await launchAfterStaleTrack(RELAUNCHED_LIVE, 5, NUDGE_AFTER_SECONDS - TICK_SECONDS)).deepEqual([]);
  });

  it('M2 restart queue: should send no nudge until the quiet window has passed since the queued restart launched it', async () => {
    // The restart queue relaunches through the lifecycle's own start (launchHeld → resumeHeld): the same `starting` write.
    should(await launchAfterStaleTrack(RELAUNCHED, 2, NUDGE_AFTER_SECONDS - TICK_SECONDS)).deepEqual([]);
  });

  it('M2 revive: should send no nudge until the quiet window has passed since the revive, though the ferret died quiet', async () => {
    const world = subject();
    await world.tickFor(STALE_SECONDS);
    world.set(undefined);
    await world.tickFor(60);
    world.set(working);
    world.hear(RELAUNCHED);
    const revivedAt = world.seconds();
    world.advance(4);
    should(await world.tickFor(NUDGE_AFTER_SECONDS - TICK_SECONDS, revivedAt)).deepEqual([]);
  });

  it('M2 attach: should send no nudge until the quiet window has passed since a stopped ferret came back working with no `starting` write', async () => {
    should(await launchAfterStaleTrack(ATTACHED, 1, NUDGE_AFTER_SECONDS - TICK_SECONDS)).deepEqual([]);
  });

  it('M2 registry write: should send no nudge until the quiet window has passed when the payload says only that the ferret is starting', async () => {
    should(await launchAfterStaleTrack(REGISTRY_PUT, 1, NUDGE_AFTER_SECONDS - TICK_SECONDS)).deepEqual([]);
  });

  it('M2 converted ferret resumed: should send no nudge to a v4 ferret listed working with no pane for ten minutes until the window has passed since its resume', async () => {
    // slot 3 (2026-11-17): a ferret that came over from v4 is listed `running` though no pane exists, so the monitor
    // holds a track on it from daemon boot, suspended while it waits on its owner; the owner's resume then got a nudge 4 s later.
    const world = subject(atPrompt);
    await world.tickFor(600);
    world.set(working);
    world.hear(RELAUNCHED);
    const resumedAt = world.seconds();
    world.advance(4);
    should(await world.tickFor(NUDGE_AFTER_SECONDS - TICK_SECONDS, resumedAt)).deepEqual([]);
  });

  it('M2 converted ferret first boot: should send no nudge to a v4 ferret first seen at daemon boot until the window has passed since the first look', async () => {
    // A restarted daemon builds a new monitor: no launch was announced and the quiet clock starts at the first look.
    const world = subject();
    world.advance(45);
    should(await world.tickFor(NUDGE_AFTER_SECONDS - TICK_SECONDS, world.seconds())).deepEqual([]);
  });

  it('M2 launch before first look: should send no nudge when the ferret is launched while no tick lists it as working yet', async () => {
    const world = subject(null);
    await world.tickFor(120);
    world.hear(STARTED);
    const startedAt = world.seconds();
    await world.tickFor(60, startedAt);
    world.set(working);
    const nudges = await world.tickFor(NUDGE_AFTER_SECONDS - TICK_SECONDS, startedAt);
    should(nudges).deepEqual([]);
  });

  it('M2 control: should still send one nudge to a ferret that stays quiet the whole window after its launch', async () => {
    const nudges = await launchAfterStaleTrack(RELAUNCHED, 3, NUDGE_AFTER_SECONDS + 2 * TICK_SECONDS);
    should(nudges).have.length(1);
    should(nudges[0]).be.aboveOrEqual(NUDGE_AFTER_SECONDS);
    should(nudges[0]).be.belowOrEqual(NUDGE_AFTER_SECONDS + TICK_SECONDS);
  });
});

describe('which ferret.changed payloads are launches', () => {
  it('M2 should read a ferret leaving stopped, or being written starting, or started, as a launch', () => {
    should(
      [...STARTED, ...RELAUNCHED, ...RELAUNCHED_LIVE, ...ATTACHED, ...REGISTRY_PUT].filter(isLaunchChange),
    ).have.length(5);
  });

  it('M2 should not read a ferret that works, idles, stops or is renamed as a launch', () => {
    const quiet: readonly FerretChangeFacts[] = [
      { state: 'working', previous: 'starting', change: 'state' },
      { state: 'idle', previous: 'working', change: 'state' },
      { state: 'working', previous: 'idle', change: 'state' },
      { state: 'stopped', previous: 'working', change: 'stopped' },
      { state: 'stopped', previous: 'stopped', change: 'renamed' },
      { state: 'working', previous: 'working', change: 'renamed' },
    ];
    should(quiet.filter(isLaunchChange)).deepEqual([]);
  });
});
