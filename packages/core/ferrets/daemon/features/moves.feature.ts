import { ApiError, type CallContext, jsonResponse } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import {
  type FerretId,
  type RunnerHandle,
  JobKeeper,
  type RuntimeStartResolution,
  Harnesses,
  RUNTIME_START_DEADLINE_MS,
  RUNTIME_START_KEY,
  Runners,
  RuntimeStart,
} from '../../contract/index.ts';
import { FerretMonitorSend } from '../adapters/session/monitor/index.ts';
import { bindBackstopAsk } from '../lib/moves/job-backstop-send.ts';
import { runJobBackstop } from '../lib/moves/jobs-handover.ts';
import type { SessionId } from '../lib/session-id.ts';
import { boundConversation } from '../lib/ferrets/bound-conversation.ts';
import { ferretsRestartResume } from '../lib/ferrets/move-resume.ts';
import { paneIdentityKey } from '../lib/moves/pane-identity.ts';
import type { MovePane } from '../lib/moves/process-inventory-port.ts';
import { createSessionDirectory } from '../lib/session/directory/index.ts';
import { relaunchSettings } from '../modules/relaunch-settings.ts';
import { buildMoves, MOVE_ROUTE_KEYS } from '../moves.ts';
import { movesDeps } from '../moves-deps.ts';
import type { FeatureContribution, FerretsContext, FerretsFeature } from './types.ts';

/** How often kept jobs that ended unattended are looked for. */
const JOB_BACKSTOP_EVERY_MS = 15_000;

function register(f: FerretsContext): FeatureContribution | undefined {
  const { daemon: ctx, kernel, hooks, registry, service, sessionStore, storeLoaded, pathFerret, mayAct, late } = f;
  // THE FERRET'S PANE, through its own runner by the registry's handle (c58-37): never a tmux session name. Both answers are
  // three-valued: a ferret with no handle has no pane (proved gone), a runner that cannot identify or read one is a blind
  // spot the gate refuses on.
  const runnerOf = (ferret: FerretId) => {
    const key = registry.get(ferret)?.runner;
    const found = key === undefined ? 'unavailable' : hooks.provider(Runners, key);
    return found === 'unavailable' ? undefined : found;
  };
  const identify = async (id: SessionId) => {
    const record = registry.get(id as unknown as FerretId);
    if (record?.handle === undefined) return 'gone' as const;
    const runner = runnerOf(id as unknown as FerretId);
    // With the ferret named: a stale handle that now names another ferret's pane must not take stock of ITS processes.
    return runner?.identify === undefined
      ? undefined
      : await runner.identify(record.handle as RunnerHandle, id as unknown as FerretId);
  };
  const pane = (id: SessionId): MovePane => ({
    identify: async () => await identify(id),
    screen: async () => {
      const record = registry.get(id as unknown as FerretId);
      if (record?.handle === undefined) return undefined;
      const runner = runnerOf(id as unknown as FerretId);
      if (runner?.lastScreen === undefined) throw new Error('the runner cannot read the pane');
      return await runner.lastScreen(record.handle as RunnerHandle, id as unknown as FerretId);
    },
  });
  // What Runtimes answers a move, bounded on the kernel clock as a start's own resolution is: an answer that never settles
  // must not hold the ferret's move lock. A late answer is dropped; the move then says it could not check.
  const runtimes = () => {
    const found = hooks.provider(RuntimeStart, RUNTIME_START_KEY);
    return found === 'unavailable' ? undefined : found;
  };
  const withinDeadline = async <T>(answer: Promise<T>, late: T): Promise<T> => {
    let cancel: () => void = () => {};
    const expired = new Promise<T>(resolve => {
      cancel = kernel.clock.after(milliseconds(RUNTIME_START_DEADLINE_MS), () => {
        resolve(late);
      });
    });
    try {
      return await Promise.race([answer, expired]);
    } finally {
      cancel();
    }
  };
  // ONE reader of a ferret's documents as every other surface reads them (as the runtime control builds it).
  const directory = createSessionDirectory({
    sessions: () => sessionStore.listSessions(),
    find: id => sessionStore.findSession(id),
    readConfig: async id => await sessionStore.readConfig(id).catch(() => undefined),
    readState: async id => await sessionStore.readState(id).catch(() => undefined),
    // A view names its session's folder, and 5.0 names no state folder to any caller: the ferret's own id stands for it.
    directory: id => `sessions/${id}`,
    ended: () => true,
    yieldToLoop: async () => await kernel.clock.sleep(milliseconds(0)),
  });
  // Moves and forks (ferrets-c): today's fork, handover and move modules, built once. The archive the session store
  // keeps is read before the first of their routes answers; the handover's reconcile loop is armed once the daemon
  // serves (today: beside the warden sweep) and disarmed when it stops.
  /** Terminals' job keeper, if it is installed: asked when a move happens, never held. */
  const keeper = () => hooks.contributions(JobKeeper)[0]?.item;
  const moves = buildMoves(
    ctx,
    movesDeps(ctx, {
      jobs: keeper,
      storage: sessionStore,
      clientName: 'fy',
      move: {
        sessions: directory,
        pane,
        // What identifies the pane a rollback must find unchanged: handle, pid and start; unknown proves nothing.
        paneIdentity: async id => paneIdentityKey(await identify(id)),
        // No tool names are read from the transcript yet, so an open tool is classified unknown and the gate refuses on it
        // (the fail-closed answer a session with no transcript always gave).
        transcripts: { tail: async () => [] },
        restart: {
          // The facts only the registry owns: the runtime it is on (a ferret with none can be moved but not restarted), the
          // harness a move must stay on, and the pane the gate judges.
          record: id => {
            const record = registry.get(id as unknown as FerretId);
            return record === undefined
              ? undefined
              : { runtime: record.runtime, harness: record.harness, handle: record.handle };
          },
          relaunch: ferretsRestartResume(service, ferret => registry.get(ferret)),
        },
        // A move onto another login: Runtimes resolves and describes the target; the ferret's own harness says whether the
        // conversation it is bound to is still in its home.
        login: {
          resolve: async (runtime): Promise<RuntimeStartResolution> => {
            const source = runtimes();
            return source === undefined
              ? {
                  ok: false,
                  sentence: `runtime ${runtime} cannot be started: the Runtimes plugin is not running, so its login cannot be found`,
                }
              : await withinDeadline(source.resolve(runtime), {
                  ok: false,
                  sentence: `could not check runtime ${runtime} in time; try again`,
                });
          },
          catalog: async runtime => {
            const source = runtimes();
            return source?.catalog === undefined ? undefined : await withinDeadline(source.catalog(runtime), undefined);
          },
          conversation: async id => {
            const record = registry.get(id as unknown as FerretId);
            if (record === undefined) return { id: undefined, present: undefined };
            const found = hooks.provider(Harnesses, record.harness);
            return await boundConversation(record, found === 'unavailable' ? undefined : found);
          },
        },
      },
      // The relaunch-settings read (W2-c, RULING #27 Q9): the ferret's own harness compares what it launched under with
      // its settings now; Ferrets reads no harness file. The caller check is `mayAct` below, as for every move route.
      launch: relaunchSettings({
        harnessOf: ferret => registry.get(ferret)?.harness,
        harness: key => {
          const found = hooks.provider(Harnesses, key);
          return found === 'unavailable' ? undefined : found;
        },
        after: (delayMs, fire) => kernel.clock.after(milliseconds(delayMs), fire),
      }),
    }),
  );
  late.moves = moves;
  // These routes fork, hand over, move or read the conversation of the ferret they name, so — like resume and stop — a
  // ferret may reach only itself and its helpers.
  const MOVE_ACTING_ROUTES: readonly string[] = [
    'POST /v1/ferrets/:ferretId/move',
    'POST /v1/ferrets/:ferretId/move/ask-to-stop-jobs',
    'POST /v1/ferrets/:ferretId/handover',
    'GET /v1/ferrets/:ferretId/handover',
    'POST /v1/ferrets/:ferretId/handover/cancel',
    'GET /v1/ferrets/:ferretId/relaunch-settings',
    'POST /v1/ferrets/:ferretId/conversion-preview',
  ];
  const moveRoutes = Object.fromEntries(
    MOVE_ROUTE_KEYS.map(key => [
      key,
      async (call: CallContext) => {
        if (MOVE_ACTING_ROUTES.includes(key)) mayAct(call, await pathFerret(call));
        await storeLoaded;
        const answer = await moves.routes[key](call);
        if (key !== 'POST /v1/ferrets/:ferretId/move' || answer.status !== 200) return answer;
        // A Restart or move that went on without Fast says why in its own answer, as a start's and a resume's do.
        const notice = registry.detailsOf(await pathFerret(call))?.notice;
        return notice === undefined ? answer : jsonResponse({ ...JSON.parse(answer.body), notice });
      },
    ]),
  ) as typeof moves.routes;
  kernel.jobs.add({
    id: 'ferrets.handover-reconcile',
    schedule: { onceAfterStart: true },
    run: async () => {
      await storeLoaded;
      kernel.lifecycle.onStop(moves.arm());
    },
  });

  // THE COMPLETION BACKSTOP: a kept job that ended while no attachment was live tells its ferret once (a live attachment
  // already reports the exit itself, so the keeper leaves those out). It rides the send the monitor's wakes already use (typed
  // when the pane is idle, queued under the job's id when busy) — deliberately NOT `movesDeps`' `askAgent`, which would also
  // switch on the ask-to-stop-jobs route. With no keeper installed it does nothing.
  const backstopAsk = bindBackstopAsk(
    async ferret => await service.harness(ferret as FerretId),
    new FerretMonitorSend(async ferret => await service.harness(ferret)),
  );
  // THE FLOOD GUARD'S CUT-OVER is the keeper's own, written once on the very first run and never moved (not this daemon's boot:
  // a restart or update must not turn a job that ended during the downtime into history).
  kernel.jobs.add({
    id: 'ferrets.job-completion-backstop',
    schedule: { every: milliseconds(JOB_BACKSTOP_EVERY_MS) },
    run: async () => {
      await storeLoaded;
      const source = keeper();
      if (source === undefined) return;
      await runJobBackstop({
        keeper: source,
        askAgent: backstopAsk,
        log: kernel.log.child('ferrets'),
      });
    },
  });

  // THE FORK ROUTE is Conversation's (it owns the message selection, the attachments and the form); until that route lands
  // the declared one answers 503 as the unbound fork always did. The cut and the start it will call are `forks.feature.ts`.
  const forkRoute = async (call: CallContext) => {
    mayAct(call, await pathFerret(call));
    throw new ApiError(503, 'Fork is served by the Conversation plugin, which is not running.', 'plugin_unavailable');
  };
  return { routes: { ...moveRoutes, 'POST /v1/ferrets/:ferretId/fork': forkRoute } };
}

export default { id: 'moves', register } satisfies FerretsFeature;
