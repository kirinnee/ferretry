/**
 * A synthetic machine with one Claude and one Codex runtime (host logins), for a test that plans the fleet through
 * `FleetCatalogService`. Nothing is read from the host: every port is a fake and every path is invented.
 */
import { fakeLoginChanges, fakeLogins, sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import { parseAccountModel } from '../../daemon/lib/account/schema.ts';
import type { FleetApplyPlan } from '../../daemon/lib/provisioning.ts';
import { unavailableCatalogDeps } from '../../daemon/lib/service/assembly.ts';
import { FleetCatalogService, type FleetCatalogServiceDeps } from '../../daemon/lib/service/catalog-service.ts';

const NOW = 1_794_052_800_000;

const MODEL = parseAccountModel({
  version: 1,
  credentials: { 'claude-you': { harness: 'claude', store: 'host' }, 'codex-you': { harness: 'codex', store: 'host' } },
  components: { instructions: { notes: { file: 'components/instructions/notes.md' } } },
  profiles: { default: { layers: ['instructions/notes'] } },
  runtimes: {
    'claude-default': { credential: 'claude-you', profile: 'default' },
    'codex-default': { credential: 'codex-you', profile: 'default' },
  },
});

const LAYOUT = {
  stateHome: '/fy',
  userHome: '/home/person',
  fleetDirectory: '/fy/fleet',
  binDirectory: '/fy/fleet/bin',
  homesDirectory: '/fy/fleet/homes',
  assetsDirectory: '/fy/fleet/assets',
  manifestPath: '/fy/fleet/manifest.json',
  defaultHomeDirectories: { claude: '/home/person/.claude', codex: '/home/person/.codex' },
} as const;

/** The service over fakes, and every plan it handed the provisioner to apply. */
export function twoHarnessWorld(overrides: Partial<FleetCatalogServiceDeps> = {}) {
  const plans: FleetApplyPlan[] = [];
  const logins = fakeLogins([sampleLogin('claude-you'), sampleLogin('codex-you')]);
  const changes = fakeLoginChanges();
  const deps: FleetCatalogServiceDeps = {
    ...unavailableCatalogDeps(() => NOW, logins, changes),
    document: async () => ({
      format: 'present',
      model: MODEL,
      revision: 'rev-1',
      unreadable: [],
      stoodInLogins: [],
      documents: () => [],
    }),
    readAsset: async path => (path.endsWith('notes.md') ? '# notes' : undefined),
    documentRevision: async () => 'absent',
    ids: async () => undefined,
    credentials: logins,
    loginChanges: changes,
    configWriter: { write: async () => undefined },
    layout: LAYOUT,
    hostCodexHome: '/home/person/.codex',
    claudeStatusline: () => "'fy' statusline",
    fyCommand: '/opt/ferretry/bin/fy',
    provisioner: {
      preview: async plan => ({ ...plan, sharedHistory: [] }),
      apply: async plan => {
        plans.push(plan);
        return {
          accountCount: plan.manifest.accounts.length,
          operationCount: plan.operations.length,
          manifestPath: LAYOUT.manifestPath,
          prunedWrappers: [],
          sharedHistory: [],
        };
      },
    },
    ...overrides,
  };
  return { service: new FleetCatalogService(deps), plans };
}

/** The text of the wrapper a plan writes for `runtime`. */
export function wrapperText(plan: FleetApplyPlan, runtime: string): string {
  const operation = plan.operations.find(
    candidate => candidate.kind === 'file' && candidate.path.endsWith(`/${runtime}`),
  );
  if (operation === undefined || operation.kind !== 'file') throw new Error(`no wrapper for ${runtime}`);
  return operation.content;
}
