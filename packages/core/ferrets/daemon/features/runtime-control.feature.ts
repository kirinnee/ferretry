import { milliseconds } from '@ferretry/std';
import { Harnesses, type FerretId } from '../../contract/index.ts';
import { createSessionDirectory } from '../lib/session/directory/index.ts';
import { FerretRuntimeControl, runtimeQuarantineState } from '../lib/session/runtime-control/index.ts';
import type { FeatureContribution, FerretsContext, FerretsFeature } from './types.ts';

/** The CLI a quarantined session tells a human to type. */
const CLIENT_NAME = 'fy';

/**
 * Live model, effort and fast-mode control of a RUNNING ferret (`FerretsApi.runtimeControl`), which Runtimes mounts as
 * `GET /v1/ferrets/:id/runtime-models` and `POST /v1/ferrets/:id/runtime`. It serves no route itself: it adds one member
 * to the Ferrets port, over the ferret's own harness seam and its harness plugin's `runtimeSwitch`.
 */
function register(f: FerretsContext): FeatureContribution | undefined {
  const { kernel, hooks, registry, service, sessionStore, sessionFiles, resolveFerret, ready } = f;
  // ONE reader of a ferret's documents as every other surface reads them. It is asked for one ferret at a time, so it lists
  // nothing and projects nothing: the turn watch already folds what a ferret's transcript says into its state document.
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
  const control = new FerretRuntimeControl({
    resolve: async reference => {
      await ready();
      return resolveFerret(reference);
    },
    seam: async (ferret: FerretId, caller) => await service.harness(ferret, caller),
    runtimeSwitchOf: ferret => {
      const key = registry.get(ferret)?.harness;
      const found = key === undefined ? 'unavailable' : hooks.provider(Harnesses, key);
      return found === 'unavailable' ? undefined : found.runtimeSwitch?.bind(found);
    },
    view: async id => await directory.get(id),
    journal: async (id, event, data) => {
      await sessionStore.append(id, event, data);
    },
    quarantine: async (id, patch) => {
      await sessionStore.updateState(id, current => runtimeQuarantineState(current, patch));
    },
    effects: id => sessionFiles.effectLedger(id),
    // The control holds this ferret's key on the shared queue while it drives, so its stop must not wait for that key.
    stopHeld: async ferret =>
      await service.stopHeld(ferret, 'now', 'a runtime control left its picker open', { kind: 'stopped' }),
    serial: sessionFiles.serial,
    // GAP(ferrets): the published accounts are Runtimes' to read and Ferrets does not need Runtimes, so none are offered
    // here: a live Codex catalog is described by what the app-server advertises alone (no tier or context from the account).
    accounts: { accounts: async () => [] },
    clock: { now: () => kernel.clock.now() },
    sleeper: { sleep: async delay => await kernel.clock.sleep(milliseconds(delay)) },
    clientName: CLIENT_NAME,
  });
  return { port: { runtimeControl: control } };
}

export default { id: 'runtime-control', register } satisfies FerretsFeature;
