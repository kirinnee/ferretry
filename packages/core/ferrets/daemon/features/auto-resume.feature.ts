import { milliseconds } from '@ferretry/std';
import { AutoResumeDecide, DAEMON_ORIGIN, Runners } from '../../contract/index.ts';
import { boundedReason } from '../lib/ferrets/auto-resume.ts';
import type { SessionId } from '../lib/session-id.ts';
import { SessionStateSchema } from '../lib/protocol/session.ts';
import { AUTO_RESUME_JOB, buildAutoResume } from '../modules/auto-resume.ts';
import type { FeatureContribution, FerretsContext, FerretsFeature } from './types.ts';

function register(f: FerretsContext): FeatureContribution | undefined {
  const { kernel, hooks, registry, service, sessionStore, log, ready, storeLoaded, appendHistory } = f;
  // Auto-resume after a host restart (W2-a, today's `createAutoResume` + `BootExitRecorder`): once the daemon serves, the
  // ferrets whose terminal the runner PROVES gone are settled `terminal_gone` and written to the ledger, then resumed
  // through the ordinary resume, staggered, two at a time, each only on Runtimes' OWN yes (RULING #27 Q5: no answer, no
  // resume, no spend). A person's stop, resume or archive in between wins (`expect`, judged under the ferret's queue).
  const autoResume = buildAutoResume({
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
    gone: async ferret => {
      const runner = hooks.provider(Runners, 'tmux');
      return runner !== 'unavailable' && runner.gone !== undefined && (await runner.gone(ferret)) === true;
    },
    settle: async (ferret, handle, exited) => await service.settleGone(ferret, handle, exited),
    decide: async input => await hooks.decideAnswered(AutoResumeDecide, input),
    // Why a resume was refused (a start.decide taker's sentence, a launch's message) is kept in the journal and the
    // summary, so it is bounded as Runtimes' own refusal is.
    resume: async (ferret, message, expect) => {
      const resumed = await service
        .resume(ferret, message, { actor: 'daemon', automatic: true, expect, origin: DAEMON_ORIGIN })
        .catch((error: unknown) => {
          throw new Error(boundedReason(error instanceof Error ? error.message : String(error)));
        });
      if (!resumed.ok) throw new Error(boundedReason(resumed.error.reason));
    },
    history: appendHistory,
    clock: { now: () => kernel.clock.now(), nowMs: () => kernel.clock.nowMs() },
    sleep: async delay => await kernel.clock.sleep(milliseconds(delay)),
    log,
  });
  kernel.jobs.add({
    id: AUTO_RESUME_JOB,
    schedule: { onceAfterStart: true },
    run: async () => {
      await ready();
      await storeLoaded.catch(() => undefined);
      await autoResume
        .run()
        .catch((error: unknown) =>
          log.warn('the auto-resume pass stopped early', { error: error instanceof Error ? error.name : 'unknown' }),
        );
    },
  });

  return { port: { lastAutoResume: async () => await autoResume.summary.read() } };
}

export default { id: 'auto-resume', register } satisfies FerretsFeature;
