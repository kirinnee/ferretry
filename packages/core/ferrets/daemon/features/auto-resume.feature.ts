import { milliseconds } from '@ferretry/std';
import { AutoResumeDecide, DAEMON_ORIGIN, FerretHistoryFiles, Runners } from '../../contract/index.ts';
import { sharedBootPass } from '../lib/session/auto-resume/boot-gate.ts';
import { boundedReason } from '../lib/ferrets/auto-resume.ts';
import { NoLongerOwed } from '../lib/session/auto-resume/index.ts';
import type { SessionId } from '../lib/session-id.ts';
import { SessionStateSchema } from '../lib/protocol/session.ts';
import { AUTO_RESUME_JOB, buildAutoResume } from '../modules/auto-resume.ts';
import type { FeatureContribution, FerretsContext, FerretsFeature } from './types.ts';

function register(f: FerretsContext): FeatureContribution | undefined {
  const { kernel, hooks, registry, service, sessionStore, log, ready, storeLoaded, appendHistory, late } = f;
  // Opened when the pass has closed its recorder (or ended without one); the turn watch's observers wait on it.
  const bootPass = sharedBootPass(late);
  // Auto-resume after a host restart (W2-a, today's `createAutoResume` + `BootExitRecorder`): once the daemon serves, the
  // ferrets whose terminal the runner PROVES gone are settled `terminal_gone` and written to the ledger, then resumed
  // through the ordinary resume, staggered, two at a time, each only on Runtimes' OWN yes (RULING #27 Q5: no answer, no
  // resume, no spend). A person's stop, resume or archive in between wins (`expect`, judged under the ferret's queue).
  const autoResume = buildAutoResume({
    // Registered as the daemon starts, before anything serves: a ferret settled gone from here on is the restart's.
    bootedAt: kernel.clock.now(),
    bootPass,
    state: kernel.state,
    // The held records (with the runner handle the list view leaves out): the handle is what the settle compares.
    records: () =>
      registry.list().flatMap(ferret => {
        const held = registry.get(ferret.id);
        return held === undefined ? [] : [held];
      }),
    record: ferret => registry.get(ferret),
    status: async ferret => {
      const state = SessionStateSchema.safeParse(await sessionStore.readState(ferret as unknown as SessionId));
      return state.success ? state.data.status : undefined;
    },
    // When the limited login resets, as the document says: a `rate_limited` ferret is resumed at boot only past it.
    quota: async ferret => {
      const state = SessionStateSchema.safeParse(await sessionStore.readState(ferret as unknown as SessionId));
      const quota = state.success ? state.data.quota : undefined;
      return quota === undefined ? undefined : { atLimit: quota.atLimit === true, retryAt: quota.retryAt };
    },
    // What the sweep's settle said the ferret was doing (idle or mid-turn): only the journal still knows.
    exitedFrom: async ferret => {
      const tail = await kernel.state.tail(FerretHistoryFiles, { maxBytes: 64 * 1024, name: ferret });
      const exited = tail.records.findLast(record => record.type === 'session.exited');
      const data = exited?.data as { readonly from?: unknown } | undefined;
      return typeof data?.from === 'string' ? data.from : undefined;
    },
    gone: async ferret => {
      const runner = hooks.provider(Runners, 'tmux');
      return runner !== 'unavailable' && runner.gone !== undefined && (await runner.gone(ferret)) === true;
    },
    settle: async (ferret, handle, exited) => await service.settleGone(ferret, handle, exited),
    decide: async input => await hooks.decideAnswered(AutoResumeDecide, input),
    // Why a resume was refused (a start.decide taker's sentence, a launch's message) is kept in the journal and the
    // summary, so it is bounded as Runtimes' own refusal is.
    resume: async (ferret, message, expect) => {
      // Whether the resume was refused by `expect` itself (judged under the ferret's queue), as distinct from any other
      // refusal or failure: only that one says another path got there first.
      let notOwed = false;
      const judged = (record: Parameters<typeof expect>[0]): boolean => {
        const owed = expect(record);
        if (!owed) notOwed = true;
        return owed;
      };
      const resumed = await service
        .resume(ferret, message, { actor: 'daemon', automatic: true, expect: judged, origin: DAEMON_ORIGIN })
        .catch((error: unknown) => {
          throw new Error(boundedReason(error instanceof Error ? error.message : String(error)));
        });
      if (!resumed.ok) throw new (notOwed ? NoLongerOwed : Error)(boundedReason(resumed.error.reason));
    },
    history: appendHistory,
    clock: { now: () => kernel.clock.now(), nowMs: () => kernel.clock.nowMs() },
    sleep: async (delay, signal) => await kernel.clock.sleep(milliseconds(delay), signal),
    log,
  });
  kernel.jobs.add({
    id: AUTO_RESUME_JOB,
    schedule: { onceAfterStart: true },
    run: async signal => {
      try {
        await ready();
        await storeLoaded.catch(() => undefined);
        // The job's signal reaches the pass: a daemon stopping ends its waits and asks and launches nothing more.
        await autoResume.run(signal).catch((error: unknown) => {
          if (!signal.aborted)
            log.warn('the auto-resume pass stopped early', { error: error instanceof Error ? error.name : 'unknown' });
        });
      } finally {
        // A pass that failed, or never got to its recorder, still lets the observers settle (the sweep must not be lost).
        bootPass.release();
      }
    },
  });

  return { port: { lastAutoResume: async () => await autoResume.summary.read() } };
}

export default { id: 'auto-resume', register } satisfies FerretsFeature;
