import type { CallContext } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import { Harnesses } from '../../contract/index.ts';
import type { SessionId } from '../lib/session-id.ts';
import { ferretsMoveResume, movedTarget } from '../lib/ferrets/move-resume.ts';
import { relaunchSettings } from '../modules/relaunch-settings.ts';
import { buildMoves, MOVE_ROUTE_KEYS } from '../moves.ts';
import { movesDeps } from '../moves-deps.ts';
import type { FeatureContribution, FerretsContext, FerretsFeature } from './types.ts';

function register(f: FerretsContext): FeatureContribution | undefined {
  const {
    daemon: ctx,
    kernel,
    hooks,
    registry,
    service,
    sessionStore,
    sessionFiles,
    storeLoaded,
    pathFerret,
    mayAct,
    late,
  } = f;
  // Moves and forks (ferrets-c): today's fork, handover and move modules, built once. The archive the session store
  // keeps is read before the first of their routes answers; the handover's reconcile loop is armed once the daemon
  // serves (today: beside the warden sweep) and disarmed when it stops.
  const moves = buildMoves(
    ctx,
    movesDeps(ctx, {
      storage: sessionStore,
      clientName: 'fy',
      environment: sessionFiles.environment,
      createLifecycle: sessionFiles.createLifecycle,
      // A move's relaunch is a resume of THIS service, so it goes through the ordinary launch (home, token, environment).
      resume: ferretsMoveResume(
        service,
        ferret => registry.get(ferret),
        async ferret => await movedTarget(async () => await sessionStore.readConfig(ferret as unknown as SessionId)),
      ),
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
    'POST /v1/ferrets/:ferretId/fork',
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
        return await moves.routes[key](call);
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

  return { routes: moveRoutes };
}

export default { id: 'moves', register } satisfies FerretsFeature;
