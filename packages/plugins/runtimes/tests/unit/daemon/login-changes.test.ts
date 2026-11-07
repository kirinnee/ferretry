/**
 * Every `credential.*` change goes to Logins' change port; Runtimes stages none of them itself.
 *
 * A recording fake of Logins' `changes` shows each kind reach the matching Logins kind; the in-use refusal is Runtimes'
 * own, comes FIRST and never calls Logins (it cannot see runtime use); a Logins refusal reaches the caller with its
 * sentence unchanged; and a removal that moves runtimes applies them before it asks Logins to remove the login.
 */
import { LoginChangeError } from '@ferretry/plugin-logins/contract';
import { instantFromEpochMs } from '@ferretry/std';
import { fakeLogins, sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import { describe, it } from 'bun:test';
import should from 'should';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import {
  assembleServices,
  unavailableCatalogDeps,
  unavailableSetupDeps,
} from '../../../daemon/lib/service/assembly.ts';
import {
  FleetCatalogRefusal,
  type FleetCatalogService,
  type FleetCatalogServiceDeps,
} from '../../../daemon/lib/service/catalog-service.ts';
import { loginChangeOf } from '../../../daemon/lib/service/login-changes.ts';
import type { AccountChange } from '../../../contract/index.ts';

const MODEL = parseAccountModel({
  version: 1,
  credentials: {
    'claude-you': { harness: 'claude', store: 'host' },
    second: { harness: 'claude', store: 'ferretry' },
    spare: { harness: 'claude', store: 'ferretry' },
    glm: { harness: 'claude', store: 'environment', env: { ANTHROPIC_BASE_URL: 'http://localhost:4000' } },
  },
  components: {},
  profiles: { default: { layers: [] } },
  runtimes: {
    'claude-default': { credential: 'claude-you', profile: 'default', agent: true },
    'claude-local': { credential: 'glm', profile: 'default', agent: false },
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

const UNTIL = instantFromEpochMs(1_793_491_200_000);

const OWNER = { governed: false, decide: () => ({ allowed: true, refusal: 'granted' as const }) };

function world(options: { readonly failPlan?: boolean } = {}) {
  const order: string[] = [];
  const logins = fakeLogins([sampleLogin('claude-you')]);
  const base = unavailableCatalogDeps(() => 1_794_052_800_000, logins);
  const deps: FleetCatalogServiceDeps = {
    ...base,
    document: async () => ({
      format: 'present',
      model: MODEL,
      revision: 'rev-1',
      documents: () => [
        { path: '/fy/config/runtimes/claude-default.yaml', content: '# moved\n', mode: 0o600, expect: 'absent' },
      ],
    }),
    readAsset: async () => undefined,
    documentRevision: async () => 'absent',
    ids: async () => undefined,
    locate: () => '/usr/bin/claude',
    credentials: {
      list: () => logins.list(),
      changes: {
        stage: change => logins.changes.stage(change),
        apply: async id => {
          order.push('logins');
          return await logins.changes.apply(id);
        },
      },
    },
    configWriter: {
      write: async () => {
        order.push('documents');
      },
    },
    layout: LAYOUT,
    claudeStatusline: own => (own === undefined ? "'fy' statusline" : `'fy' statusline --then '${own}'`),
    fyCommand: '/opt/ferretry/bin/fy',
    provisioner: {
      preview: async plan => ({ ...plan, sharedHistory: [] }),
      apply: async plan => {
        order.push('plan');
        if (options.failPlan === true) throw new Error('the provisioner could not apply the plan');
        return {
          accountCount: plan.manifest.accounts.length,
          operationCount: plan.operations.length,
          manifestPath: '/fy/fleet/manifest.json',
          prunedWrappers: [],
          sharedHistory: [],
        };
      },
    },
  };
  const { catalog } = assembleServices(deps, unavailableSetupDeps);
  return { catalog: catalog as FleetCatalogService, logins, order };
}

const rejection = async (work: Promise<unknown>): Promise<unknown> =>
  await work.then(
    () => undefined,
    (error: unknown) => error,
  );

/** One change of each `credential.*` kind and the Logins change it must become. */
const KINDS = [
  [
    { kind: 'credential.add', id: 'fresh', harness: 'claude-code', label: 'Fresh' },
    { kind: 'login.add', id: 'fresh', harness: 'claude-code', label: 'Fresh' },
  ],
  [
    {
      kind: 'credential.env',
      id: 'glm',
      env: { ANTHROPIC_BASE_URL: 'http://localhost:4001', ANTHROPIC_AUTH_TOKEN: { keep: true } },
      cloudCredential: null,
    },
    {
      kind: 'login.env',
      id: 'glm',
      env: { ANTHROPIC_BASE_URL: 'http://localhost:4001', ANTHROPIC_AUTH_TOKEN: { keep: true } },
      cloudCredential: null,
    },
  ],
  [
    { kind: 'credential.label', id: 'second', label: 'Second' },
    { kind: 'login.label', id: 'second', label: 'Second' },
  ],
  [
    { kind: 'credential.remove', id: 'spare' },
    { kind: 'login.remove', id: 'spare' },
  ],
  [
    { kind: 'credential.signout', id: 'claude-you' },
    { kind: 'login.signout', id: 'claude-you' },
  ],
  [
    { kind: 'credential.disable', id: 'second', reason: 'Out of credit', until: UNTIL },
    { kind: 'login.disable', id: 'second', reason: 'Out of credit', until: UNTIL },
  ],
  [
    { kind: 'credential.enable', id: 'second' },
    { kind: 'login.enable', id: 'second' },
  ],
] as const satisfies readonly (readonly [AccountChange, unknown])[];

describe('credential changes go to Logins', () => {
  for (const [change, expected] of KINDS) {
    it(`should send ${change.kind} to Logins as ${expected.kind}, stage nothing of its own, and apply exactly what Logins held`, async () => {
      // Arrange
      const w = world();
      if (change.kind === 'credential.signout') {
        w.logins.setOutcome({ outcome: 'signed-out', login: sampleLogin('claude-you') });
      }

      // Act
      const view = await w.catalog.propose(change);
      const stagedBeforeApply = [...w.logins.staged];
      const outcome = await w.catalog.apply(view.id, OWNER);

      // Assert
      should(loginChangeOf(change as never)).deepEqual(expected);
      should(stagedBeforeApply).deepEqual([expected]);
      should(w.logins.applied).deepEqual(['change-1']);
      should(view.summary).equal(`fake ${expected.kind} ${expected.id}`);
      // Runtimes wrote no document and published no plan for it: the login file is Logins' to write.
      should(w.order).deepEqual(['logins']);
      should(outcome).match(
        change.kind === 'credential.signout'
          ? { outcome: 'signed-out' }
          : { outcome: 'login-changed', result: 'applied' },
      );
    });
  }

  it('should carry a secret as a reference only, and never as a value Runtimes holds', async () => {
    const w = world();

    await w.catalog.propose({
      kind: 'credential.add',
      id: 'keyed',
      harness: 'claude-code',
      store: 'environment',
      env: { ANTHROPIC_AUTH_TOKEN: '${secret:ZAI_API_KEY}' },
    });

    should(JSON.stringify(w.logins.staged)).containEql('${secret:ZAI_API_KEY}');
    should(w.logins.staged).have.length(1);
  });

  it('should answer a sign-out preview from what Logins says signing out does', async () => {
    const w = world();

    const view = await w.catalog.propose({ kind: 'credential.signout', id: 'claude-you' });

    should(view.preview).deepEqual({
      kind: 'sign-out',
      credential: 'claude-you',
      runtimesAffected: 0,
      signsOutTerminal: true,
    });
  });

  it('should list the runtimes a variable change lands on', async () => {
    const w = world();

    const view = await w.catalog.propose({ kind: 'credential.env', id: 'glm', env: { A: '1' } });

    should(view.preview).match({ kind: 'apply', operations: [], documents: [] });
    should(view.preview.kind === 'apply' ? view.preview.runtimes.map(runtime => runtime.name) : []).deepEqual([
      'claude-local',
    ]);
  });

  it('should report a change Logins held for the owner as held, with its sentences', async () => {
    const w = world();
    w.logins.setOutcome({
      outcome: 'held',
      sentences: ['login "spare"\'s daily hard limit in dollars is removed (was 5)'],
    });
    const view = await w.catalog.propose({ kind: 'credential.remove', id: 'spare' });

    const outcome = await w.catalog.apply(view.id, OWNER);

    should(outcome).deepEqual({
      outcome: 'login-changed',
      result: 'held',
      sentences: ['login "spare"\'s daily hard limit in dollars is removed (was 5)'],
    });
  });
});

describe('removing a login', () => {
  it("should refuse a login a runtime uses with today's sentence and never call Logins", async () => {
    // Arrange
    const w = world();

    // Act
    const failure = await rejection(w.catalog.propose({ kind: 'credential.remove', id: 'claude-you' }));

    // Assert
    should(failure).be.instanceOf(FleetCatalogRefusal);
    should((failure as FleetCatalogRefusal).code).equal('fleet_change_refused');
    should((failure as FleetCatalogRefusal).message).equal(
      '1 runtime still uses this login (claude-default). Move it to another login first.',
    );
    should(w.logins.staged).deepEqual([]);
    should(w.logins.applied).deepEqual([]);
  });

  it('should send an unused login through Logins', async () => {
    const w = world();

    const view = await w.catalog.propose({ kind: 'credential.remove', id: 'spare' });
    await w.catalog.apply(view.id, OWNER);

    should(w.logins.staged).deepEqual([{ kind: 'login.remove', id: 'spare' }]);
    should(w.logins.applied).deepEqual(['change-1']);
  });

  it("should apply the runtimes' move first, then ask Logins to remove the login", async () => {
    const w = world();
    const view = await w.catalog.propose({
      kind: 'credential.remove',
      id: 'claude-you',
      switchRuntimes: { 'claude-default': 'second' },
    });

    const outcome = await w.catalog.apply(view.id, OWNER);

    should(w.logins.staged).deepEqual([{ kind: 'login.remove', id: 'claude-you' }]);
    should(w.order).deepEqual(['documents', 'plan', 'logins']);
    should(outcome).match({ outcome: 'login-changed', result: 'applied' });
    should(view.consequences.join(' ')).match(/claude-default moves to login second/u);
  });

  it("should leave the login alone when the runtimes' move did not land", async () => {
    const w = world({ failPlan: true });
    const view = await w.catalog.propose({
      kind: 'credential.remove',
      id: 'claude-you',
      switchRuntimes: { 'claude-default': 'second' },
    });

    const failure = await rejection(w.catalog.apply(view.id, OWNER));

    should((failure as FleetCatalogRefusal).code).equal('fleet_change_failed');
    should(w.logins.applied).deepEqual([]);
  });
});

describe('a Logins refusal reaches the caller unchanged', () => {
  const REFUSALS = [
    ['login_change_refused', 'fleet_change_refused'],
    ['login_change_stale', 'fleet_change_stale'],
    ['login_change_failed', 'fleet_change_failed'],
  ] as const;

  for (const [code, mapped] of REFUSALS) {
    it(`should surface ${code} on staging with its sentence word for word`, async () => {
      const w = world();
      const sentence = 'work is already a login on this machine. Use work-2?';
      w.logins.refuseStage(new LoginChangeError(code, sentence));

      const failure = await rejection(w.catalog.propose({ kind: 'credential.add', id: 'work', harness: 'codex' }));

      should(failure).be.instanceOf(FleetCatalogRefusal);
      should((failure as FleetCatalogRefusal).message).equal(sentence);
      should((failure as FleetCatalogRefusal).code).equal(mapped);
    });
  }

  it('should surface a refusal at apply with its sentence, and let the same change be applied again', async () => {
    const w = world();
    const view = await w.catalog.propose({ kind: 'credential.enable', id: 'second' });
    const sentence = 'the logins on this machine changed after this change was previewed; review it again';
    w.logins.refuseApply(new LoginChangeError('login_change_stale', sentence));

    const failure = await rejection(w.catalog.apply(view.id, OWNER));
    w.logins.refuseApply(undefined);
    const again = await w.catalog.apply(view.id, OWNER);

    should((failure as FleetCatalogRefusal).message).equal(sentence);
    should((failure as FleetCatalogRefusal).code).equal('fleet_change_stale');
    should(again).match({ outcome: 'login-changed', result: 'applied' });
  });
});
