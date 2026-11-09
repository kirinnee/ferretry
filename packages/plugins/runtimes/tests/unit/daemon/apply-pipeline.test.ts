/**
 * The apply pipeline over a fake config writer.
 *
 * GAP(kernel): plugins have no config write port, so every write goes through `RuntimeConfigWriter`. These tests prove the
 * pipeline against a fake one: the documents land first (they are the source of truth), the plan follows with no documents
 * of its own, a refusing writer fails the apply in a sentence, and a configuration that moved after the preview is refused.
 */
import { fakeLoginChanges, fakeLogins } from '@ferretry/plugin-logins/contract/testing';
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
import { builtInModelCatalogs, builtInPresets } from '../lib/fixtures/built-ins.ts';

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

/** One read of the configuration: what stands in in it and the revision it was read at (the world's, when not given). */
interface Reading {
  readonly unreadable?: string[];
  /** The logins whose variables stand in, in this read (the model's one runtime uses `claude-you`). */
  readonly stoodInLogins?: { readonly id: string; readonly because: string }[];
  readonly revision?: string;
}

interface World {
  readonly order: string[];
  readonly written: { path: string; content: string }[][];
  readonly plans: { documents: number }[];
  revision: string;
  /** What the NEXT reads of the configuration answer, one entry per read (then the last repeats). */
  readings: Reading[];
  /** How many times the configuration was read. */
  reads: number;
  service: FleetCatalogService;
}

function world(
  configWriter: RuntimeConfigWriter | 'fake' = 'fake',
  executors?: FleetCatalogServiceDeps['executors'],
  extra: Partial<FleetCatalogServiceDeps> = {},
): World {
  const order: string[] = [];
  const written: World['written'] = [];
  const plans: World['plans'] = [];
  const state = { revision: 'rev-1', readings: [{}] as Reading[], reads: 0 };
  const fake: RuntimeConfigWriter = {
    write: async documents => {
      order.push('documents');
      written.push(documents.map(document => ({ path: document.path, content: document.content })));
    },
  };
  const base = unavailableCatalogDeps(() => 1_794_052_800_000, fakeLogins(), fakeLoginChanges());
  const deps: FleetCatalogServiceDeps = {
    ...base,
    document: async () => {
      // Each read answers its OWN stand-ins (the list for read N, the last list once they run out) and the revision
      // that goes with them: a reading that stands in is never the reading that does not.
      const reading = state.readings[Math.min(state.reads, state.readings.length - 1)] ?? {};
      state.reads += 1;
      const unreadable = reading.unreadable ?? [];
      const stoodInLogins = reading.stoodInLogins ?? [];
      const standing = [...unreadable, ...stoodInLogins.map(login => login.id)];
      return {
        format: 'present',
        model: MODEL,
        revision:
          reading.revision ?? (standing.length === 0 ? state.revision : `${state.revision}+${standing.join('|')}`),
        unreadable,
        stoodInLogins,
        documents: next => [
          {
            path: '/fy/config/runtimes/claude-default.yaml',
            content: `# ${JSON.stringify(next.machine.agentPermissions)}\n`,
            mode: 0o600,
            expect: 'absent',
          },
        ],
      };
    },
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
    ...extra,
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
    get readings() {
      return state.readings;
    },
    set readings(value: Reading[]) {
      state.readings = value;
      state.reads = 0;
    },
    get reads() {
      return state.reads;
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

  it('C2 should ask the preflight before ANY document is written, and write nothing when it refuses', async () => {
    // Arrange: a preflight that refuses (a part of the model stands in), so a sentence saying "nothing was changed" must be true.
    const w = world('fake', undefined, {
      preflight: async () => {
        throw new Error('nothing was changed: a part of this machine could not be read');
      },
    });
    const staged = await w.service.propose(CHANGE);

    // Act
    const failure = await w.service.apply(staged.id, OWNER).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert: refused in that sentence, with no document written and no plan published.
    should(failure).be.instanceOf(FleetCatalogRefusal);
    should((failure as FleetCatalogRefusal).code).equal('fleet_change_refused');
    should((failure as FleetCatalogRefusal).message).containEql('nothing was changed');
    should(w.order).deepEqual([]);
    should(w.written).deepEqual([]);
  });

  const STANDING_IN = ['the mcp component "github" could not be read from the part of Ferretry that owns it'];
  const refusedApply = async (w: World, id: string): Promise<FleetCatalogRefusal> => {
    const failure = await w.service.apply(id, OWNER).then(
      () => undefined,
      (error: unknown) => error,
    );
    should(failure).be.instanceOf(FleetCatalogRefusal);
    return failure as FleetCatalogRefusal;
  };

  it('C1 should refuse an apply whose plan was made from a reading that stood in, even when the live reading is clean', async () => {
    // Arrange: the plan is made while a part stands in; by the time it is applied every read is clean again (and, as a
    // stand-in is part of the revision in real life, the revision is held equal here so only the plan's own list can refuse).
    const w = world();
    w.readings = [{ unreadable: STANDING_IN, revision: 'rev-1' }];
    const staged = await w.service.propose(CHANGE);
    w.readings = [{}];

    // Act
    const failure = await refusedApply(w, staged.id);

    // Assert: the plan answers for itself: refused in a sentence, with nothing written anywhere.
    should(failure.code).equal('fleet_change_refused');
    should(failure.message).containEql('nothing was changed');
    should(failure.message).containEql('github');
    should(w.order).deepEqual([]);
    should(w.written).deepEqual([]);
  });

  it('C1 should refuse an apply when a part stands in on the read made just before the write, and write nothing', async () => {
    // Arrange: a clean plan; the first read of the apply (the staleness check) is clean, the last look before the write is not.
    const w = world();
    const staged = await w.service.propose(CHANGE);
    w.readings = [{}, { unreadable: STANDING_IN }];

    // Act
    const failure = await refusedApply(w, staged.id);

    // Assert
    should(failure.code).equal('fleet_change_refused');
    should(failure.message).containEql('github');
    should(w.order).deepEqual([]);
    should(w.written).deepEqual([]);
  });

  it('C1 should refuse an apply as stale when the read made just before the write is not the reading the plan was made from', async () => {
    // Arrange: both reads are clean, but the last look sees a configuration that moved since the first.
    const w = world();
    const staged = await w.service.propose(CHANGE);
    w.readings = [{}, { revision: 'rev-2' }];

    // Act
    const failure = await refusedApply(w, staged.id);

    // Assert
    should(failure.code).equal('fleet_change_stale');
    should(w.order).deepEqual([]);
    should(w.written).deepEqual([]);
  });

  it('C1 should apply when the reading the plan was made from is the reading just before the write', async () => {
    const w = world();
    const staged = await w.service.propose(CHANGE);
    w.readings = [{}, {}];

    const outcome = await w.service.apply(staged.id, OWNER);

    should(outcome).match({ outcome: 'applied', apply: { outcome: 'committed' } });
    should(w.order).deepEqual(['documents', 'plan']);
  });

  it('C2 should ask the preflight before a setup or a clone runs its own writes too, and run nothing when it refuses', async () => {
    // Arrange: an executor that would write settings files and a preflight that refuses.
    const ran: string[] = [];
    const executor = {
      describe: async () => 'import it',
      execute: async () => {
        ran.push('execute');
        return 'imported';
      },
    };
    const w = world('fake', { setup: executor, clone: executor } as never, {
      preflight: async () => {
        throw new Error('nothing was changed: a part of this machine could not be read');
      },
    });
    const staged = await w.service.propose({ kind: 'setup.import' } as never);

    // Act
    const failure = await w.service.apply(staged.id, OWNER).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    should(failure).be.instanceOf(FleetCatalogRefusal);
    should((failure as FleetCatalogRefusal).message).containEql('nothing was changed');
    should(ran).deepEqual([]);
  });

  it('C2 should name the configuration files that stay written when the plan fails after them', async () => {
    // Arrange: the documents land, then the provisioner fails with a sentence that knows nothing of them.
    const w = world('fake', undefined, {
      provisioner: {
        preview: async plan => ({ ...plan, sharedHistory: [] }),
        apply: async () => {
          throw new Error('the manifest could not be written');
        },
      },
    });
    const staged = await w.service.propose(CHANGE);

    // Act
    const failure = await w.service.apply(staged.id, OWNER).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert: the sentence says the file is on disk, not that nothing changed.
    should((failure as FleetCatalogRefusal).code).equal('fleet_change_failed');
    should((failure as FleetCatalogRefusal).message).containEql('the manifest could not be written');
    should((failure as FleetCatalogRefusal).message).containEql('/fy/config/runtimes/claude-default.yaml');
    should((failure as FleetCatalogRefusal).message).containEql('NOT rolled back with the fleet');
    should(w.written).have.length(1);
  });

  describe('m1-R2 a republish is never made from a reading that stands in', () => {
    /** A world whose catalogs are wired (so a republish plans) and whose provisioner counts what it is asked to apply. */
    const republishWorld = () => {
      const applied: number[] = [];
      const w = world('fake', undefined, {
        modelCatalogs: async () => ({ catalogs: builtInModelCatalogs(), presets: builtInPresets() }),
        publishedManifest: async () => undefined,
        provisioner: {
          preview: async plan => ({ ...plan, sharedHistory: [] }),
          apply: async plan => {
            applied.push(plan.operations.length);
            return {
              accountCount: plan.manifest.accounts.length,
              operationCount: plan.operations.length,
              manifestPath: '/fy/fleet/manifest.json',
              prunedWrappers: [],
              sharedHistory: [],
            };
          },
        },
      });
      return { w, applied };
    };
    const refusal = async (w: World): Promise<FleetCatalogRefusal> => {
      const failure = await w.service.republish().then(
        () => undefined,
        (error: unknown) => error,
      );
      should(failure).be.instanceOf(FleetCatalogRefusal);
      return failure as FleetCatalogRefusal;
    };

    it('m1-R2 should refuse a republish while a component stands in, and never call the provisioner', async () => {
      const { w, applied } = republishWorld();
      w.readings = [{ unreadable: STANDING_IN }];

      const failure = await refusal(w);

      should(failure.code).equal('fleet_change_refused');
      should(failure.message).containEql('github');
      should(applied).deepEqual([]);
    });

    it('m1-R2 should refuse a republish while a login a runtime uses stands in, and never call the provisioner', async () => {
      const { w, applied } = republishWorld();
      w.readings = [
        { stoodInLogins: [{ id: 'claude-you', because: '${secret:NAME} templates, which Logins withheld' }] },
      ];

      const failure = await refusal(w);

      should(failure.code).equal('fleet_change_refused');
      should(failure.message).containEql('login "claude-you"');
      should(applied).deepEqual([]);
    });

    it('m1-R2 should still republish a clean reading, and one whose stood-in login no runtime uses', async () => {
      const { w, applied } = republishWorld();
      w.readings = [{ stoodInLogins: [{ id: 'unused', because: '${secret:NAME} templates, which Logins withheld' }] }];

      const outcome = await w.service.republish();

      should(outcome).equal('applied');
      should(applied).have.length(1);
    });
  });

  it('M5 should run a republish one at a time with applies, and a login change republishes from inside its apply without waiting on itself', async () => {
    // Arrange: a provisioner that records how many calls overlap.
    let running = 0;
    let overlapped = false;
    const w = world('fake', undefined, {
      modelCatalogs: async () => ({ catalogs: builtInModelCatalogs(), presets: builtInPresets() }),
      provisioner: {
        preview: async plan => ({ ...plan, sharedHistory: [] }),
        apply: async plan => {
          running += 1;
          overlapped ||= running > 1;
          await new Promise(resolve => setTimeout(resolve, 5));
          running -= 1;
          return {
            accountCount: plan.manifest.accounts.length,
            operationCount: plan.operations.length,
            manifestPath: '/fy/fleet/manifest.json',
            prunedWrappers: [],
            sharedHistory: [],
          };
        },
      },
    });
    const staged = await w.service.propose(CHANGE);

    // Act: an apply and two republishes arrive together.
    await Promise.all([w.service.apply(staged.id, OWNER), w.service.republish(), w.service.republish()]);

    // Assert: none of the three overlapped another inside the provisioner.
    should(overlapped).equal(false);
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

  describe('BG-027 a proposal refused before any write is kept; one that began to write is spent', () => {
    const settle = async (w: World, id: string): Promise<{ ok: true } | { ok: false; error: FleetCatalogRefusal }> =>
      await w.service.apply(id, OWNER).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error: error as FleetCatalogRefusal }),
      );
    const spent = (result: { ok: true } | { ok: false; error: FleetCatalogRefusal }): void => {
      should(result.ok).equal(false);
      should(result.ok ? '' : result.error.message).containEql('already been applied');
    };
    const LATE = ['the mcp component "github" could not be read from the part of Ferretry that owns it'];

    it('BG-027 PR1b should keep a proposal refused for a stand-in seen only on the last look, and apply it once when that clears', async () => {
      // Arrange: the staleness check is clean; the last look before the write is not.
      const w = world();
      const staged = await w.service.propose(CHANGE);
      w.readings = [{}, { unreadable: LATE }];

      // Act + Assert: refused, nothing written, and the retry is refused the same true way (not "already applied").
      const first = await settle(w, staged.id);
      should(first.ok ? '' : first.error.code).equal('fleet_change_refused');
      w.readings = [{}, { unreadable: LATE }];
      const retry = await settle(w, staged.id);
      should(retry.ok ? '' : retry.error.code).equal('fleet_change_refused');
      should(w.written).have.length(0);

      // The stand-in clears: the same proposal applies once, and is then spent.
      w.readings = [{}, {}];
      should((await settle(w, staged.id)).ok).equal(true);
      spent(await settle(w, staged.id));
      should(w.written).have.length(1);
    });

    it('BG-027 PR3 should keep a proposal spent when a refusal-coded error is thrown AFTER the documents were written', async () => {
      // Arrange: the plan, after the documents landed, throws an error that carries a refusal code.
      const w = world('fake', undefined, {
        provisioner: {
          preview: async plan => ({ ...plan, sharedHistory: [] }),
          apply: async () => {
            throw new FleetCatalogRefusal('fleet_change_refused', 'refused in the middle of the plan');
          },
        },
      });
      const staged = await w.service.propose(CHANGE);

      // Act
      const first = await settle(w, staged.id);

      // Assert: answered as a failed change that names the file that landed, never restored for a replay.
      should(first.ok ? '' : first.error.code).equal('fleet_change_failed');
      should(first.ok ? '' : first.error.message).containEql('/fy/config/runtimes/claude-default.yaml');
      spent(await settle(w, staged.id));
      should(w.written).have.length(1);
    });

    it('BG-027 PR3b should keep a proposal spent when the config writer throws a stale-coded refusal, wrapped as a failed change', async () => {
      // Arrange: the writer itself refuses as stale, after the apply began to write.
      let writes = 0;
      const w = world({
        write: async () => {
          writes += 1;
          throw new FleetCatalogRefusal('fleet_change_stale', 'stale inside the writer');
        },
      });
      const staged = await w.service.propose(CHANGE);

      // Act
      const first = await settle(w, staged.id);

      // Assert
      should(first.ok ? '' : first.error.code).equal('fleet_change_failed');
      spent(await settle(w, staged.id));
      should(writes).equal(1);
    });

    it('BG-027 PR4b two applies of one proposal at once, the first refused before writing: the second applies, once', async () => {
      // Arrange: the first apply's last look before the write stands in; every look after it is clean.
      const w = world();
      const staged = await w.service.propose(CHANGE);
      w.readings = [{}, { unreadable: LATE }, {}, {}];

      // Act: both are asked at the same time.
      const results = await Promise.all([settle(w, staged.id), settle(w, staged.id)]);

      // Assert: exactly one wins and writes once (the other never hears "already applied" about a restored proposal).
      should(results.map(result => result.ok).toSorted()).eql([false, true]);
      should(w.written).have.length(1);
      spent(await settle(w, staged.id));
    });
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

  it('should answer a read in a sentence when the daemon has no host seam wired', async () => {
    // Arrange
    const service = assembleServices(
      unavailableCatalogDeps(() => 0, fakeLogins(), fakeLoginChanges()),
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
