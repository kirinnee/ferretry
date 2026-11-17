import { type ApiResponse, type CallContext } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import {
  FERRET_WAKE_KEY,
  FerretWaitFiles,
  FerretSummaryFiles,
  FerretWake,
  MonitorTickFile,
} from '../../contract/index.ts';
import {
  FerretSignalArtifacts,
  type FerretSignalHost,
  FerretSignalRepository,
  FerretSignalTerminal,
} from '../adapters/session/signal/ferret-signal.ts';
import {
  FerretMonitorSend,
  MailboxMonitorSend,
  MonitorFiles,
  StorageMonitorWaits,
} from '../adapters/session/monitor/index.ts';
import { KeyedSerialExecutor } from '../adapters/storage/keyed-serial-executor.ts';
import { FerretSignals } from '../lib/ferrets/signals.ts';
import { sessionSignalRoutes } from '../lib/runtime/mounts/session-signal.ts';
import { defaultSessionMonitorSettings } from '../lib/session/monitor/index.ts';
import { SessionSignalService } from '../lib/session/signal/service.ts';
import { buildMonitor, MONITOR_RECORD_NAME, MONITOR_TICK_JOB } from '../modules/monitor.ts';
import type { FeatureContribution, FerretsContext, FerretsFeature } from './types.ts';

function register(f: FerretsContext): FeatureContribution | undefined {
  const { kernel, registry, service, sessionStore, sessionFiles, ready, storeLoaded, appendHistory } = f;
  const { resolveFerret, pathFerret, mayAct } = f;
  const parkedFile = f.parkedFile;
  const signalHost: FerretSignalHost = {
    ready,
    record: ferret => registry.get(ferret),
    resolve: resolveFerret,
    waitingOf: ferret => registry.waitingOf(ferret),
    creditOf: async ferret => (await parkedFile(ferret)).creditSeconds,
    saveWaiting: async (ferret, waiting, creditSeconds) => {
      const { waiting: _before, creditSeconds: _credit, ...kept } = await parkedFile(ferret);
      await kernel.state.write(
        FerretWaitFiles,
        {
          ...kept,
          ...(waiting === undefined ? {} : { waiting }),
          ...(creditSeconds === undefined ? {} : { creditSeconds }),
        },
        ferret,
      );
      registry.putWaiting(ferret, waiting);
    },
    saveFinished: async (ferret, at) => {
      await kernel.state.write(FerretWaitFiles, { ...(await parkedFile(ferret)), finishedAt: at as never }, ferret);
      registry.putFinished(ferret, at);
    },
    writeSummary: async (ferret, text) => {
      await kernel.state.write(FerretSummaryFiles, new TextEncoder().encode(text), ferret);
    },
    history: appendHistory,
    // `signal done` is the ferret ending on its own word: its cause is `completed`, not a stop.
    stop: async (ferret, reason) => await service.stop(ferret, 'now', reason, { kind: 'completed' }),
  };
  const signalRepository = new FerretSignalRepository(signalHost);
  const signalService = new SessionSignalService({
    repository: signalRepository,
    artifacts: new FerretSignalArtifacts(signalHost),
    terminal: new FerretSignalTerminal(signalHost),
    serial: new KeyedSerialExecutor(),
    clock: { now: () => kernel.clock.now() },
  });
  const signalRoutes = sessionSignalRoutes(
    new FerretSignals(signalService, { resolve: resolveFerret, view: async ferret => await service.get(ferret) }),
  );
  // The declared-wait monitor: a wait that ends wakes its ferret. The loop's own record sits in Ferrets' state, a
  // ferret's heartbeat in its own session folder; the tick is one job at the loop's own cadence.
  const monitor = buildMonitor({
    waits: new StorageMonitorWaits(sessionStore, signalRepository, signalService, defaultSessionMonitorSettings),
    files: new MonitorFiles(ferret => sessionFiles.root(ferret), {
      name: MONITOR_RECORD_NAME,
      write: async text => await kernel.state.write(MonitorTickFile, JSON.parse(text)),
    }),
    // A wake goes through the Mailbox when one provides `ferrets.wake`, the harness seam only without one.
    sends: new MailboxMonitorSend(
      () => f.hooks.provider(FerretWake, FERRET_WAKE_KEY),
      new FerretMonitorSend(async ferret => await service.harness(ferret)),
    ),
    clock: { now: () => kernel.clock.now(), nowMs: () => kernel.clock.nowMs() },
  });
  let monitorArmed = false;
  kernel.jobs.add({
    id: MONITOR_TICK_JOB,
    schedule: { every: milliseconds(monitor.intervalMs) },
    run: async signal => {
      await ready();
      await storeLoaded.catch(() => undefined);
      // A stop that landed while this waited arms nothing: `close()` has already said the loop is not running.
      if (signal.aborted) return;
      if (!monitorArmed) {
        monitorArmed = true;
        monitor.arm();
        kernel.lifecycle.onStop(async () => await monitor.close());
      }
      await monitor.run(signal);
    },
  });
  // A ferret signals for itself and its helpers; a person for any ferret (the same rule as stop, resume and rename).
  const signals = {
    'POST /v1/ferrets/:ferretId/signal': async (call: CallContext): Promise<ApiResponse> => {
      mayAct(call, await pathFerret(call));
      return await signalRoutes['POST /v1/ferrets/:ferretId/signal'](call);
    },
  };

  return { routes: signals };
}

export default { id: 'signals', register } satisfies FerretsFeature;
