import { milliseconds } from '@ferretry/std';
import { QUESTION_OPEN_KEY, QuestionOpen, Runners } from '../../contract/index.ts';
import { buildTurnWatch } from '../modules/turn-watch.ts';
import type { FeatureContribution, FerretsContext, FerretsFeature } from './types.ts';

/** The job that arms the turn watch once the daemon serves (today's `activities.run('turn watcher', …)`, J-0001). */
export const TURN_WATCH_JOB = 'ferrets.turn-watch';

function register(f: FerretsContext): FeatureContribution | undefined {
  const { kernel, hooks, registry, service, sessionStore, log, ready, storeLoaded, transcripts, late } = f;
  const { followStatus, removeEnvironment } = f;
  // The turn watch (U4, RULING #44): the session observer's turn part on the main thread, every live ferret's pane looked
  // at through `Runner.look` at today's 2 s tick (a quiet pane backing off to 10 s), one pane per turn of the loop.
  // Armed once the daemon serves (today's `observer.arm()` after the first monitor tick), closed when it stops.
  // The transcript, through the harness that wrote it (U5): the proof of WHICH file is a ferret's is the harness's, so
  // Ferrets opens no transcript path. The turn fold and both stream sources read it here.
  const turnWatch = buildTurnWatch({
    storage: sessionStore,
    tail: transcripts.tail,
    record: ferret => registry.get(ferret),
    live: () =>
      registry.list().flatMap(ferret => {
        const held = registry.get(ferret.id);
        return held === undefined ? [] : [held];
      }),
    runner: () => {
      const found = hooks.provider(Runners, 'tmux');
      return found === 'unavailable' ? undefined : found;
    },
    turnObserved: async (ferret, turn) => await service.turnObserved(ferret, turn),
    settleGone: async (ferret, handle, exited, stillGone) =>
      await service.settleGone(ferret, handle, exited, stillGone),
    settleExited: async (ferret, handle, exit, from, stillExited) =>
      await service.settleExited(ferret, handle, exit, from, stillExited),
    clock: { now: () => kernel.clock.now() },
    // The owner of the stored question says whether one is open (Conversation's `question.json`); with none, it is "no".
    questionOpen: async ferret => {
      const found = hooks.provider(QuestionOpen, QUESTION_OPEN_KEY);
      return found === 'unavailable' ? false : await found.isOpen(ferret);
    },
    every: (intervalMs, tick) => kernel.clock.every(milliseconds(intervalMs), tick),
    yieldToLoop: async () => await kernel.clock.sleep(milliseconds(0)),
    log,
  });
  late.wakeTurnWatch = turnWatch.wake;
  kernel.jobs.add({
    id: TURN_WATCH_JOB,
    schedule: { onceAfterStart: true },
    run: async () => {
      // The 30 s sweep is registered BEFORE anything is awaited: a ferret that vanishes while the registry is still
      // loading is swept on the first tick after it has (a tick that finds nothing loaded asks about nothing, and a
      // settle waits for `ready` itself), instead of the sweep not existing until a slow load is over.
      kernel.lifecycle.onStop(turnWatch.startSweep());
      await ready();
      await storeLoaded.catch(() => undefined);
      // Once per arm, every held ferret's document is brought to its registry state: one left `starting` by a crash
      // between the registry's write and the status lane's (or written before U4) would otherwise never be given a
      // turn, and no registry change would come to repair it. The same lane and rule as every later edge.
      // A registry read at arm may be stale, so it is no proof of a new run: it never revives an ended document.
      for (const record of registry.list()) followStatus(record.id, record.state, 'reconcile');
      // The boot sweep: an ended ferret's environment file a crash (or an older daemon) left behind goes now.
      for (const record of registry.list()) if (record.state === 'stopped') removeEnvironment(record.id);
      turnWatch.host.arm();
      kernel.lifecycle.onStop(async () => await turnWatch.host.close());
    },
  });

  return undefined;
}

export default { id: 'turn-watch', register } satisfies FerretsFeature;
