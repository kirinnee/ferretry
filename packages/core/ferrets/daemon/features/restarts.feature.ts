import { type ApiResponse, ApiError, type CallContext } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import { RestartQueueEntrySchema, RestartsFile } from '../../contract/index.ts';
import { FerretRestarts, restartService } from '../lib/ferrets/restarts.ts';
import { sessionRestartRoutes } from '../lib/runtime/mounts/session-restart.ts';
import { callerFerret } from './caller.ts';
import type { FeatureContribution, FerretsContext, FerretsFeature } from './types.ts';

function register(f: FerretsContext): FeatureContribution | undefined {
  const { kernel, registry, service, ready, appendHistory, resolveFerret } = f;
  const outdatedFor = f.outdated.sections;
  const restartSubsystem = new FerretRestarts(
    restartService({
      ready,
      ferrets: () => registry.list(),
      waitingOf: ferret => registry.waitingOf(ferret),
      outdated: outdatedFor,
      // The daemon's own restart: its turn is drawn as Ferretry's Restart, never as the owner's words. It REPLACES the live
      // pane: the runtime, its login, the folder and the start gate are judged first, and only then is the old harness
      // stopped (`now`, as a move's `releaseLive` does: a polite stop is one Ctrl-C, which Claude Code answers with "Press
      // Ctrl-C again to exit"). A login that needs sign-in therefore leaves the ferret running, never stopped and unstarted.
      resume: async (ferret, origin) =>
        await service.resume(ferret, undefined, { actor: 'daemon', origin, replaceLiveTerminal: true }),
      startable: async ferret => await service.startable(ferret),
      history: appendHistory,
      // An entry that does not parse is dropped on its own; the rest survive, and a queue that cannot be read is empty.
      loadQueue: async () => {
        const read = await kernel.state.read(RestartsFile);
        const queued = read.ok ? (read.value as { queued?: unknown } | undefined)?.queued : undefined;
        if (!Array.isArray(queued)) return [];
        return queued.flatMap(entry => {
          const parsed = RestartQueueEntrySchema.safeParse(entry);
          return parsed.success ? [parsed.data] : [];
        });
      },
      saveQueue: async entries => {
        await kernel.state.write(RestartsFile, { queued: entries });
      },
      now: () => kernel.clock.now(),
    }),
    { resolve: resolveFerret, mayTouch: (caller, target) => registry.mayTouch(caller, target) },
  );
  const restartRoutes = sessionRestartRoutes(restartSubsystem);
  const restarts = {
    ...restartRoutes,
    // Clearing the queue clears every ferret's waiting restart: a person's act.
    'DELETE /v1/restarts': async (call: CallContext): Promise<ApiResponse> => {
      if (callerFerret(call) !== undefined)
        throw new ApiError(403, 'a ferret does not clear the restart queue of every ferret', 'forbidden');
      return await restartRoutes['DELETE /v1/restarts'](call);
    },
  };
  // A waiting restart is tried again at its ferret's next idle moment; an empty queue costs no read.
  kernel.jobs.add({
    id: 'restart-drain',
    schedule: { every: milliseconds(10_000) },
    run: async () => await restartSubsystem.drain(),
  });

  return { routes: restarts };
}

export default { id: 'restarts', register } satisfies FerretsFeature;
