import type { AccountModel, HarnessKind } from '@ferretry/fleet';
import { deliverCodexCallback } from '../../src/adapters/fleet-login/callback-delivery.ts';
import { harnessLoginTimer, spawnHarnessLoginChild } from '../../src/adapters/fleet-login/login-child.ts';
import { systemPortHolders } from '../../src/adapters/fleet-login/port-holders.ts';
import type { ConfigChangeSink } from '../../src/lib/config-files/changes.ts';
import type { FleetCredentialCatalog } from '../../src/lib/fleet/credentials-service.ts';
import { HarnessLoginService } from '../../src/lib/fleet-login/service.ts';
import type { DaemonModule } from '../../src/lib/runtime/modules.ts';
import { harnessLoginContribution } from '../../src/lib/runtime/mounts/fleet-login.ts';

/**
 * Driving a harness's own sign-in from a browser, holding no token (docs/design/harness-login.md): the harness's
 * own login against one credential's store, started, answered and ended through `/v1/fleet/login`.
 *
 * See `./learning.ts` for what a module file owns. This module has no `Seams` (it replaces no production adapter that
 * `DaemonWorld` carries: the child launcher, the callback delivery, the timer and the port reader are production
 * adapters fixed here), no jobs and no releases of its own: the service is inert until a request. Its shutdown — which
 * ends every child a sign-in launched, so a pending `codex login` never holds `localhost:1455` after the daemon — is
 * armed by `start()` beside the other acquisitions, where it always was.
 */

/** What the fleet-login module is built from. */
export interface FleetLoginNeeds {
  /** The fleet's credentials, which a sign-in by credential id resolves through to the store it signs in. */
  readonly credentials: Pick<FleetCredentialCatalog, 'entry' | 'signInTarget'>;
  /** The harness command, by this daemon's one rule (an explicit path, the declared search directories, the environment). */
  readonly locate: (kind: HarnessKind) => string | undefined;
  /** The clock a flow's window is measured on. */
  readonly clock: { now(): number };
  /**
   * THIS PROCESS'S ENVIRONMENT, which the service sanitizes before any child sees it, so a sign-in started from inside
   * an agent session cannot authenticate against that session's login.
   */
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** What a person types to run this program, so a refusal names a command they actually have. */
  readonly clientName: string;
  /** The machine's declared account model, read when a flow starts: whether the host shares its loopback ports. */
  readonly declaredAccountModel: () => Promise<
    { readonly machine: Pick<AccountModel['machine'], 'browserPorts'> } | undefined
  >;
  /** Told when a sign-in completes, so an open app learns the logins and runtimes moved. */
  readonly configChanges: ConfigChangeSink;
}

export const fleetLoginModule: DaemonModule<void, FleetLoginNeeds, HarnessLoginService> = {
  id: 'fleetLogin',
  build: needs => {
    // Driving a harness's own sign-in from a browser, holding no token: the harness's own login against
    // one credential's store. It is given THIS PROCESS'S ENVIRONMENT, which the service sanitizes before
    // any child sees it, so a sign-in started from inside an agent session cannot authenticate against
    // that session's login. Who may start one is the route's `fleet.configure`, which holds a caller
    // off this host behind the passkey step-up.
    const harnessLogin = new HarnessLoginService({
      credentialTargets: {
        target: async id => needs.credentials.signInTarget(await needs.credentials.entry(id)),
      },
      locate: needs.locate,
      clock: needs.clock,
      mintId: () => crypto.randomUUID().replaceAll('-', '').slice(0, 22),
      spawn: spawnHarnessLoginChild,
      deliverCallback: deliverCodexCallback,
      environment: needs.environment,
      timer: harnessLoginTimer,
      sharedHost: async () => ((await needs.declaredAccountModel())?.machine.browserPorts ?? 'random') !== 'random',
      portHolders: systemPortHolders(),
      clientName: needs.clientName,
      onSignedIn: () => needs.configChanges.announce(['credentials', 'runtimes']),
    });
    return {
      id: 'fleetLogin',
      provides: harnessLogin,
      jobs: {},
      contributes: harnessLoginContribution(harnessLogin),
    };
  },
};
