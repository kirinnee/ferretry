/**
 * The apply pipeline over a fake config writer.
 *
 * GAP(kernel): plugins have no config write port, so every write goes through `RuntimeConfigWriter`. These tests prove the
 * pipeline against a fake one: the documents land first (they are the source of truth), the plan follows with no documents
 * of its own, a refusing writer fails the apply in a sentence, and a configuration that moved after the preview is refused.
 */
import { fakeLogins } from '@ferretry/plugin-logins/contract/testing';
import { describe, it } from 'bun:test';
import should from 'should';
import { FleetCatalogRefusal, type FleetCatalogService } from '../../../daemon/lib/service/catalog-service.ts';
import {
  assembleServices,
  UNAVAILABLE,
  unavailableCatalogDeps,
  unavailableSetupDeps,
} from '../../../daemon/lib/service/assembly.ts';
import {
  CONFIG_WRITE_UNAVAILABLE,
  refusingConfigWriter,
  type RuntimeConfigWriter,
} from '../../../daemon/lib/service/ports.ts';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import type { FleetCatalogServiceDeps } from '../../../daemon/lib/service/catalog-service.ts';

const MODEL = parseAccountModel({
  version: 1,
  credentials: { 'claude-you': { harness: 'claude', store: 'host' } },
  components: {},
  profiles: { default: { layers: [] } },
  runtimes: { 'claude-default': { credential: 'claude-you', profile: 'default', agent: true } },
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

interface World {
  readonly order: string[];
  readonly written: { path: string; content: string }[][];
  readonly plans: { documents: number }[];
  revision: string;
  service: FleetCatalogService;
}

function world(configWriter: RuntimeConfigWriter | 'fake' = 'fake'): World {
  const order: string[] = [];
  const written: World['written'] = [];
  const plans: World['plans'] = [];
  const state = { revision: 'rev-1' };
  const fake: RuntimeConfigWriter = {
    write: async documents => {
      order.push('documents');
      written.push(documents.map(document => ({ path: document.path, content: document.content })));
    },
  };
  const base = unavailableCatalogDeps(() => 1_794_052_800_000, fakeLogins());
  const deps: FleetCatalogServiceDeps = {
    ...base,
    document: async () => ({
      format: 'present',
      model: MODEL,
      revision: state.revision,
      documents: next => [
        {
          path: '/fy/config/runtimes/claude-default.yaml',
          content: `# ${JSON.stringify(next.machine.agentPermissions)}\n`,
          mode: 0o600,
          expect: 'absent',
        },
      ],
    }),
    readAsset: async () => undefined,
    documentRevision: async () => 'absent',
    ids: async () => undefined,
    locate: () => '/usr/bin/claude',
    credentials: fakeLogins(),
    configWriter: configWriter === 'fake' ? fake : configWriter,
    layout: LAYOUT,
    claudeStatusline: own => (own === undefined ? "'fy' statusline" : `'fy' statusline --then '${own}'`),
    fyCommand: '/opt/ferretry/bin/fy',
    provisioner: {
      preview: async plan => ({ ...plan, sharedHistory: [] }),
      apply: async (plan, documents = []) => {
        order.push('plan');
        plans.push({ documents: documents.length });
        return {
          accountCount: plan.manifest.accounts.length,
          operationCount: plan.operations.length,
          manifestPath: plan.manifest.generatedAt === '' ? '' : '/fy/fleet/manifest.json',
          prunedWrappers: [],
          sharedHistory: [],
        };
      },
    },
  };
  const { catalog } = assembleServices(deps, unavailableSetupDeps);
  return {
    order,
    written,
    plans,
    get revision() {
      return state.revision;
    },
    set revision(value: string) {
      state.revision = value;
    },
    service: catalog,
  };
}

const CHANGE = {
  kind: 'machine.settings',
  agentPermissions: 'skip',
  defaultRuntime: null,
  agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false, pageScripts: false },
  browserMode: 'headless',
  browserProxy: null,
  browserPorts: 'random',
  browserFirewallFailure: 'warn',
  autoResume: true,
  agendaMode: false,
  publicUsageFeed: false,
} as const;

const OWNER = { governed: false, decide: () => ({ allowed: true, refusal: 'granted' as const }) };

describe('the apply pipeline over a fake config writer', () => {
  it('should write the documents first and then publish the plan with no documents of its own', async () => {
    // Arrange
    const w = world();
    const staged = await w.service.propose(CHANGE);

    // Act
    const outcome = await w.service.apply(staged.id, OWNER);

    // Assert
    should(outcome).match({ outcome: 'applied', apply: { outcome: 'committed' } });
    should(w.order).deepEqual(['documents', 'plan']);
    should(w.written).have.length(1);
    should(w.written[0]?.[0]?.path).equal('/fy/config/runtimes/claude-default.yaml');
    should(w.plans).deepEqual([{ documents: 0 }]);
  });

  it('should refuse the apply in a sentence when no config writer is wired, and publish nothing', async () => {
    // Arrange
    const w = world(refusingConfigWriter);
    const staged = await w.service.propose(CHANGE);

    // Act
    const failure = await w.service.apply(staged.id, OWNER).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    should(failure).be.instanceOf(FleetCatalogRefusal);
    should((failure as FleetCatalogRefusal).code).equal('fleet_change_failed');
    should((failure as FleetCatalogRefusal).message).equal(CONFIG_WRITE_UNAVAILABLE);
    should(w.order).deepEqual([]);
  });

  it('should refuse a change whose configuration moved after the preview, and write nothing', async () => {
    // Arrange
    const w = world();
    const staged = await w.service.propose(CHANGE);
    w.revision = 'rev-2';

    // Act
    const failure = await w.service.apply(staged.id, OWNER).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    should((failure as FleetCatalogRefusal).code).equal('fleet_change_stale');
    should(w.order).deepEqual([]);
  });

  it('should spend a staged change once: a second apply is told it already happened', async () => {
    // Arrange
    const w = world();
    const staged = await w.service.propose(CHANGE);
    await w.service.apply(staged.id, OWNER);

    // Act
    const again = await w.service.apply(staged.id, OWNER).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    should((again as FleetCatalogRefusal).code).equal('fleet_change_consumed');
    should(w.written).have.length(1);
  });

  it('should refuse when this daemon cannot say who is asking, before anything is written', async () => {
    // Arrange
    const w = world();
    const staged = await w.service.propose(CHANGE);

    // Act
    const failure = await w.service.apply(staged.id, undefined).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    should(failure).match({ status: 403, code: 'forbidden' });
    should(w.order).deepEqual([]);
  });

  it('should refuse catalog sign-out because LoginsPort exposes reads only', async () => {
    const w = world();
    await should(w.service.propose({ kind: 'credential.signout', id: 'claude-you' })).be.rejectedWith(
      /Sign out through Logins/,
    );
    should(w.order).deepEqual([]);
  });

  it('should answer a read in a sentence when the daemon has no host seam wired', async () => {
    // Arrange
    const service = assembleServices(
      unavailableCatalogDeps(() => 0, fakeLogins()),
      unavailableSetupDeps,
    ).catalog;

    // Act
    const failure = await service.runtimes().then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    should((failure as FleetCatalogRefusal).code).equal('fleet_catalog_unreadable');
    should((failure as FleetCatalogRefusal).message).containEql(UNAVAILABLE);
  });
});
