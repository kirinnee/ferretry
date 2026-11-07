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
import {
  FleetCatalogFreshStepUpRequired,
  FleetCatalogRefusal,
  FleetCatalogService,
} from '../../../daemon/lib/service/catalog-service.ts';
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

function world(
  configWriter: RuntimeConfigWriter | 'fake' = 'fake',
  executors?: FleetCatalogServiceDeps['executors'],
): World {
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
  const { catalog } =
    executors === undefined
      ? assembleServices(deps, unavailableSetupDeps)
      : { catalog: new FleetCatalogService({ ...deps, executors }) };
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

/**
 * ONE PROOF, ONE WIDENING of what agents may control: the proof is CLAIMED in `apply`, before anything is written, never
 * read off the admission snapshot and spent after. The boundary hands `apply` a `claim` (Gate's `claimFreshStepUp`); of
 * two requests admitted on ONE proof exactly one takes it.
 */
describe('widening what agents may control takes the fresh proof before the write', () => {
  const REMOTE = { governed: true, decide: () => ({ allowed: true, refusal: 'granted' as const }) };
  /** What the boundary builds for a call: ONE proof shared by every request admitted on it. */
  const oneProof = () => {
    let held = true;
    let taken = 0;
    return {
      claim: () => {
        if (!held) return false;
        held = false;
        taken += 1;
        return true;
      },
      taken: () => taken,
    };
  };
  const on = (proof: ReturnType<typeof oneProof>, agent = false) => ({ claim: proof.claim, agent });
  /** `ferretrySettings` is off by default, so turning it on is a widening (terminals, browsers and files already are on). */
  const WIDENING = { ...CHANGE, agentControl: { ...CHANGE.agentControl, ferretrySettings: true } };
  const NARROWING = {
    ...CHANGE,
    agentControl: { terminals: false, browsers: false, files: false, ferretrySettings: false, pageScripts: false },
  };
  const refused = (work: Promise<unknown>) =>
    work.then(
      () => undefined,
      (error: unknown) => error,
    );

  it('should let exactly one of two applies admitted on one fresh proof widen, and write nothing for the other', async () => {
    // Arrange — two staged widenings, both admitted as fresh before either runs.
    const w = world();
    const proof = oneProof();
    const first = await w.service.propose(WIDENING);
    const second = await w.service.propose(WIDENING);

    // Act
    const results = await Promise.all([
      refused(w.service.apply(first.id, REMOTE, on(proof))),
      refused(w.service.apply(second.id, REMOTE, on(proof))),
    ]);

    // Assert
    const applied = results.filter(result => result === undefined);
    const asked = results.filter(result => result instanceof FleetCatalogFreshStepUpRequired);
    should([applied.length, asked.length]).deepEqual([1, 1]);
    should(w.written).have.length(1);
    should(w.plans).have.length(1);
    should(proof.taken()).equal(1);
  });

  it('should let exactly one act when another act claims the same proof first, and leave the staged change to apply again', async () => {
    // Arrange — the other act (a config loosening, a pairing mint) takes the proof through the same claim.
    const w = world();
    const proof = oneProof();
    const staged = await w.service.propose(WIDENING);
    const other = proof.claim();

    // Act
    const failure = await refused(w.service.apply(staged.id, REMOTE, on(proof)));
    const later = await w.service.apply(staged.id, REMOTE, on(oneProof()));

    // Assert — claim lost → the step-up refusal and nothing done; the PROPOSAL (not the proof) is put back.
    should(other).be.true();
    should(failure).be.instanceOf(FleetCatalogFreshStepUpRequired);
    should(proof.taken()).equal(1);
    should(later).match({ outcome: 'applied' });
    should(w.written).have.length(1);
  });

  it('should widen on one fresh proof and leave the proof gone', async () => {
    // Arrange
    const w = world();
    const proof = oneProof();
    const first = await w.service.propose(WIDENING);
    const next = await w.service.propose(WIDENING);

    // Act
    const outcome = await w.service.apply(first.id, REMOTE, on(proof));
    const again = await refused(w.service.apply(next.id, REMOTE, on(proof)));

    // Assert
    should(outcome).match({ outcome: 'applied' });
    should(again).be.instanceOf(FleetCatalogFreshStepUpRequired);
    should(proof.taken()).equal(1);
    should(w.written).have.length(1);
  });

  it('should hand a clone executor the boundary’s own claim, so two copies turning controls on take ONE proof between them', async () => {
    // Arrange — the clone executor claims where it writes (`setup-service`), so `apply` itself must take nothing for it.
    const proof = oneProof();
    const claimed: boolean[] = [];
    const clone = {
      describe: async () => 'a copy',
      execute: async (_change: unknown, caller?: { claim(): boolean }) => {
        claimed.push(caller?.claim() === true);
        return 'copied';
      },
    };
    const w = world('fake', { clone } as never);
    const change = { kind: 'clone.import', mode: 'update', bundle: {} } as const;
    const first = await w.service.propose(change);
    const second = await w.service.propose(change);

    // Act
    await Promise.all([w.service.apply(first.id, REMOTE, on(proof)), w.service.apply(second.id, REMOTE, on(proof))]);

    // Assert
    should(claimed.sort()).deepEqual([false, true]);
    should(proof.taken()).equal(1);
  });

  it('should claim nothing for the owner at the machine, a narrowing from a device, or a ferret (refused before any claim)', async () => {
    // Arrange
    const w = world();
    const proof = oneProof();
    const widening = await w.service.propose(WIDENING);
    const narrowing = await w.service.propose(NARROWING);
    const byFerret = await w.service.propose(WIDENING);

    // Act
    const atMachine = await w.service.apply(widening.id, OWNER, on(proof));
    const narrowed = await w.service.apply(narrowing.id, REMOTE, on(proof));
    const ferret = await refused(w.service.apply(byFerret.id, REMOTE, on(proof, true)));

    // Assert
    should([atMachine, narrowed]).match([{ outcome: 'applied' }, { outcome: 'applied' }]);
    should(ferret).match({ status: 403, code: 'owner_only' });
    should(proof.taken()).equal(0);
  });
});
