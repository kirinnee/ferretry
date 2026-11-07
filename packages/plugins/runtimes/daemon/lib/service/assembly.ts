/**
 * Putting the services together over a set of collaborators, and the collaborators a daemon has before any host seam
 * is wired: every one of them refuses with {@link UNAVAILABLE}, in a sentence, so a route answers a plain `409`
 * instead of failing. The real collaborators come from the adapters (`daemon/adapters`) as the kernel opens the files
 * they need; this file never touches a disk.
 *
 * GAP(kernel): `permissions.roots` is empty and `RootName` is a fixed set, so a plugin cannot reach the state home's
 * `fleet/` folder, the user's home or a harness's own home; nothing here can read or write a runtime's files yet.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { HarnessKind } from '../manifest.ts';
import { type FleetCatalogServiceDeps, FleetCatalogService } from './catalog-service.ts';
import { createFleetSetupSubsystem, type FleetSetupService, type FleetSetupServiceDeps } from './setup-service.ts';
import { LoginRefusal, refusingConfigWriter } from './ports.ts';

/** What every unreachable collaborator says. It names the state, not an internal. */
export const UNAVAILABLE =
  "this version of Ferretry cannot reach this machine's runtime setup files from the Runtimes plugin yet";

const unavailable = async (): Promise<never> => await Promise.reject(new Error(UNAVAILABLE));

/** The catalogue's collaborators when no host seam is wired: reading refuses, so every read and change answers `UNAVAILABLE`. */
export function unavailableCatalogDeps(now: () => number): FleetCatalogServiceDeps {
  const nowhere = '';
  return {
    document: unavailable,
    readAsset: unavailable,
    documentRevision: unavailable,
    ids: unavailable,
    locate: () => undefined,
    commandExists: () => false,
    sessionStatuses: async () => [],
    machineName: () => 'this machine',
    credentials: {
      list: async () => await Promise.reject(new LoginRefusal(UNAVAILABLE)),
      signOut: async () => await Promise.reject(new LoginRefusal(UNAVAILABLE)),
    },
    configWriter: refusingConfigWriter,
    provisioner: { preview: unavailable, apply: unavailable },
    // Never read: every method reads the configuration first, and that refuses.
    layout: {
      stateHome: nowhere,
      userHome: nowhere,
      fleetDirectory: nowhere,
      binDirectory: nowhere,
      homesDirectory: nowhere,
      assetsDirectory: nowhere,
      manifestPath: nowhere,
      defaultHomeDirectories: { claude: nowhere, codex: nowhere } satisfies Record<HarnessKind, string>,
    },
    mint: () => crypto.randomUUID(),
    mintId: () => crypto.randomUUID().replaceAll('-', '').slice(0, 22),
    now,
    claudeStatusline: () => {
      throw new Error(UNAVAILABLE);
    },
    fyCommand: 'fy',
    acceptsAutoPermissionMode: true,
  };
}

/** The setup service's collaborators when no host seam is wired. */
export function unavailableSetupDeps(catalog: FleetCatalogServiceDeps): FleetSetupServiceDeps {
  return {
    catalog,
    scan: unavailable,
    tools: {
      plans: () => {
        throw new Error(UNAVAILABLE);
      },
      install: unavailable,
    },
    secrets: { names: unavailable, held: unavailable, put: unavailable },
    readFolder: unavailable,
    skillItems: unavailable,
    digest: text => createHash('sha256').update(text).digest('hex'),
    daemonId: () => undefined,
    randomBytes: length => new Uint8Array(randomBytes(length)),
    exportKeys: { read: unavailable, write: unavailable },
    cloneBase: { read: unavailable, update: unavailable },
  };
}

/** The two services, joined the way the daemon joins them: the catalogue runs the setup's import and clone as its own changes. */
export function assembleServices(
  catalog: FleetCatalogServiceDeps,
  setup: (catalog: FleetCatalogServiceDeps) => FleetSetupServiceDeps,
): { readonly catalog: FleetCatalogService; readonly setup: FleetSetupService } {
  const setupService = createFleetSetupSubsystem(setup(catalog));
  return {
    catalog: new FleetCatalogService({ ...catalog, executors: setupService.executors }),
    setup: setupService,
  };
}
