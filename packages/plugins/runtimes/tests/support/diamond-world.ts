import { fakeLoginChanges, fakeLogins, sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import { parseAccountModel } from '../../daemon/lib/account/schema.ts';
import { unavailableCatalogDeps } from '../../daemon/lib/service/assembly.ts';
import { FleetCatalogService, type FleetCatalogServiceDeps } from '../../daemon/lib/service/catalog-service.ts';
import { REAL_KITS } from './real-kits.ts';

// The catalogue service over fakes of its ports, with a lattice of shared profile bases as its model: shared by the
// diamond tests of the unit tier (a small lattice) and the perf tier (the 20-deep one).

const NOW = 1_794_052_800_000;

/** Two profiles per level, each naming BOTH profiles of the next level and one item of its own: 2^depth paths. */
export function latticeDocument(depth: number) {
  const profiles: Record<string, { layers: string[] }> = {};
  const mcp: Record<string, { command: string }> = {};
  for (let level = 0; level <= depth; level++)
    for (const side of ['a', 'b']) {
      const name = `${side}${String(level)}`;
      mcp[name] = { command: 'srv-bin' };
      profiles[name] = {
        layers:
          level === depth
            ? [`mcp/${name}`]
            : [`profile/a${String(level + 1)}`, `profile/b${String(level + 1)}`, `mcp/${name}`],
      };
    }
  return {
    version: 1,
    credentials: { 'claude-you': { harness: 'claude', store: 'ferretry' } },
    components: { mcp },
    profiles,
    runtimes: {
      work: { credential: 'claude-you', profile: 'a0' },
      second: { credential: 'claude-you', profile: 'b1' },
    },
  };
}

const LAYOUT = {
  stateHome: '/fy',
  userHome: '/home/person',
  fleetDirectory: '/fy/fleet',
  binDirectory: '/fy/fleet/bin',
  homesDirectory: '/fy/fleet/homes',
  assetsDirectory: '/fy/fleet/assets',
  manifestPath: '/fy/fleet/manifest.json',
  defaultHomeDirectories: ['/home/person/.claude', '/home/person/.codex'],
} as const;

export function world(depth: number) {
  const model = parseAccountModel(latticeDocument(depth));
  const logins = fakeLogins([sampleLogin('claude-you')]);
  const changes = fakeLoginChanges();
  const base = unavailableCatalogDeps(() => NOW, logins, changes);
  const deps: FleetCatalogServiceDeps = {
    ...base,
    document: async () => ({
      format: 'present',
      model,
      revision: 'rev-1',
      unreadable: [],
      stoodInLogins: [],
      documents: () => [],
    }),
    readAsset: async () => undefined,
    documentRevision: async () => 'absent',
    ids: async () => undefined,
    locate: () => '/usr/bin/claude',
    credentials: logins,
    loginChanges: changes,
    configWriter: { write: async () => undefined },
    layout: LAYOUT,
    claudeStatusline: () => "'fy' statusline",
    fyCommand: '/opt/ferretry/bin/fy',
    kits: () => REAL_KITS,
    modelCatalogs: async () => ({ catalogs: {}, presets: [] }),
    provisioner: {
      preview: async plan => ({ ...plan, sharedHistory: [] }),
      apply: async plan => ({
        accountCount: plan.manifest.accounts.length,
        operationCount: plan.operations.length,
        manifestPath: '/fy/fleet/manifest.json',
        prunedWrappers: [],
        sharedHistory: [],
      }),
    },
  };
  return new FleetCatalogService(deps);
}
