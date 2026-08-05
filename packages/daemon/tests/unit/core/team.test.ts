import type { AccountUsage } from '@ferretry/protocol';
import { describe, it } from 'bun:test';
import should from 'should';
import {
  classifyTask,
  indexCatalog,
  primaryFloor,
  recommendTeam,
  roleShape,
  type Budget,
  type RecommendTeamRequest,
  type RoutingCatalog,
  type TeamRecommendation,
  type TeamRole,
} from '../../../src/lib/core/index.ts';
import { account, catalog, inventory } from './fixtures.ts';

const recommend = (task: string, overrides: Partial<RecommendTeamRequest> = {}): TeamRecommendation =>
  recommendTeam({ task, accounts: inventory, catalog, ...overrides });

const roleOf = (recommendation: TeamRecommendation, role: TeamRole) =>
  recommendation.roles.find(item => item.role === role);

const usage = (agent: string, overrides: Partial<AccountUsage> = {}): AccountUsage => ({ agent, ...overrides });

describe('roleShape', () => {
  it.each([
    { label: 'hard work gets a planner', task: 'rewrite the protocol layer', role: 'planner' },
    { label: 'research gets a researcher', task: 'investigate the retry path', role: 'researcher' },
    { label: 'a chore gets a fan-out', task: 'rename the helper in every file', role: 'fan-out' },
    { label: 'ordinary work gets an implementer', task: 'add the field', role: 'implementer' },
  ])('should decide that $label', ({ task, role }) => {
    // Arrange / Act
    const shape = roleShape(classifyTask(task), 'balanced');

    // Assert
    should(shape).containEql(role);
  });

  it('should not put a single implementer next to a swarm doing the same work', () => {
    // Arrange / Act
    const shape = roleShape(classifyTask('rename the helper in every file'), 'balanced');

    // Assert
    should(shape).not.containEql('implementer');
  });

  it('should fan out a large migration while keeping its implementer', () => {
    // Arrange / Act
    const shape = roleShape(classifyTask('migrate the entire codebase to the new client'), 'balanced');

    // Assert
    should(shape).containEql('fan-out');
    should(shape).containEql('implementer');
  });

  it('should not send a review task an implementer', () => {
    // Arrange / Act
    const shape = roleShape(classifyTask('review the diff'), 'balanced');

    // Assert
    should(shape).deepEqual(['implementer', 'reviewer'].filter(role => role === 'reviewer'));
  });

  it('should staff the fullest shape when the caller is buying quality', () => {
    // Arrange / Act
    const shape = roleShape(classifyTask('add the field'), 'max');

    // Assert
    should(shape).deepEqual(['planner', 'implementer', 'reviewer']);
  });

  it('should drop the planner and reviewer from cheap unambiguous low-risk work', () => {
    // Arrange / Act
    const shape = roleShape(classifyTask('rename the helper'), 'cheap');

    // Assert
    should(shape).deepEqual(['implementer']);
  });

  it('should keep a planner on cheap work that is genuinely ambiguous', () => {
    // Arrange / Act
    const shape = roleShape(classifyTask('figure out how the retry should work'), 'cheap');

    // Assert
    should(shape).containEql('planner');
  });

  it('should plan critical work even when nothing about it reads as hard', () => {
    // Arrange / Act
    const shape = roleShape(classifyTask('add the billing endpoint'), 'balanced');

    // Assert
    should(shape).containEql('planner');
  });

  it('should always name at least one role', () => {
    // Arrange — a cheap low-risk chore that is its own fan-out
    const shape = roleShape(classifyTask('rename the helper in every file'), 'cheap');

    // Assert
    should(shape.length).be.above(0);
  });
});

describe('primaryFloor', () => {
  const index = indexCatalog(catalog);

  it.each([
    { label: 'a fan-out worker has no floor', role: 'fan-out' as const, task: 'rename in every file', expected: 0 },
    { label: 'a reviewer has its own floor', role: 'reviewer' as const, task: 'add the field', expected: 70 },
    { label: 'a planner has its own floor', role: 'planner' as const, task: 'add the field', expected: 88 },
  ])('should decide that $label', ({ role, task, expected }) => {
    // Arrange / Act
    const floor = primaryFloor(index, role, classifyTask(task), 'balanced');

    // Assert
    should(floor).equal(expected);
  });

  it('should demand the top tier for hard work that is also critical', () => {
    // Arrange / Act
    const floor = primaryFloor(index, 'implementer', classifyTask('rewrite the production auth layer'), 'balanced');

    // Assert
    should(floor).equal(96);
  });

  it('should demand the top tier for hard work at scale', () => {
    // Arrange / Act
    const floor = primaryFloor(index, 'implementer', classifyTask('rewrite the whole codebase'), 'balanced');

    // Assert
    should(floor).equal(96);
  });

  it('should hold a high floor for hard work on its own', () => {
    // Arrange / Act
    const floor = primaryFloor(index, 'implementer', classifyTask('rewrite the parser'), 'balanced');

    // Assert
    should(floor).equal(88);
  });

  it('should hold a floor under ordinary mid work', () => {
    // Arrange / Act
    const floor = primaryFloor(index, 'implementer', classifyTask('add the field'), 'balanced');

    // Assert
    should(floor).equal(40);
  });

  it('should let a chore be done by anyone', () => {
    // Arrange / Act
    const floor = primaryFloor(index, 'implementer', classifyTask('rename the helper'), 'balanced');

    // Assert
    should(floor).equal(0);
  });

  it('should raise the floor a tier when the caller buys quality', () => {
    // Arrange / Act
    const floor = primaryFloor(index, 'implementer', classifyTask('add the field'), 'max');

    // Assert
    should(floor).equal(88);
  });

  it('should not waste the top tier on a chore even when buying quality', () => {
    // Arrange / Act
    const floor = primaryFloor(index, 'implementer', classifyTask('rename the helper'), 'max');

    // Assert
    should(floor).equal(0);
  });
});

describe('recommendTeam', () => {
  it('should staff hard ambiguous work with a planner and a top-tier implementer', () => {
    // Arrange / Act
    const recommendation = recommend('rewrite the protocol layer');

    // Assert
    should(roleOf(recommendation, 'planner')?.primary.model).equal('apex');
    should(roleOf(recommendation, 'implementer')?.primary.model).equal('forge');
  });

  it('should review from the other harness family than the one that wrote the code', () => {
    // Arrange / Act
    const recommendation = recommend('rewrite the protocol layer');
    const implementer = roleOf(recommendation, 'implementer');
    const reviewer = roleOf(recommendation, 'reviewer');

    // Assert
    should(reviewer?.primary.family).not.equal(implementer?.primary.family);
  });

  it('should warn rather than pretend when only one family is left to review from', () => {
    // Arrange — only the codex account is in the inventory, so implementer and reviewer must share it
    const single = inventory.filter(entry => entry.id === 'account-secondary');

    // Act
    const recommendation = recommend('rewrite the protocol layer', { accounts: single });

    // Assert
    should(recommendation.warnings.join(' ')).containEql('no cross-family reviewer');
  });

  it('should never lead product-facing work with a model the doctrine bars from it', () => {
    // Arrange / Act
    const recommendation = recommend('restyle the customer landing page', { budget: 'cheap' });
    const implementer = roleOf(recommendation, 'implementer');

    // Assert
    should(implementer?.primary.model).not.equal('chore');
  });

  it('should keep the barred specialist on the menu, marked, rather than hide real advice', () => {
    // Arrange
    const wide: RoutingCatalog = { ...catalog, weights: { ...catalog.weights, alternativesShown: 5 } };

    // Act
    const recommendation = recommend('restyle the customer landing page', { budget: 'cheap', catalog: wide });
    const barred = roleOf(recommendation, 'implementer')?.alternatives.find(option => option.model === 'chore');

    // Assert
    should(barred?.caveat).equal('not-for-product-facing');
  });

  it('should let the cheap budget change the answer, not merely the ordering', () => {
    // Arrange / Act
    const balanced = recommend('add the field', { roles: ['planner'] });
    const cheap = recommend('add the field', { budget: 'cheap', roles: ['planner'] });

    // Assert
    should(balanced.roles[0]?.primary.model).equal('apex');
    should(cheap.roles[0]?.primary.model).equal('steady');
  });

  it('should exclude an account the manifest declares down, whatever the catalog offers', () => {
    // Arrange — the defect that misrouted real work: configuration said down, a table said available
    const accounts = inventory.map(entry =>
      entry.id === 'account-secondary'
        ? { ...entry, available: false, unavailableReason: 'every credential is returning an error' }
        : entry,
    );

    // Act
    const recommendation = recommend('rewrite the protocol layer', { accounts });

    // Assert
    should(recommendation.exclusions).containEql({
      accountId: 'account-secondary',
      agent: 'agent-secondary',
      reason: 'every credential is returning an error',
    });
    should(recommendation.roles.every(role => role.primary.accountId !== 'account-secondary')).be.true();
  });

  it('should give a reason even when the manifest declared none', () => {
    // Arrange
    const accounts = [account({ id: 'account-primary', agent: 'agent-primary', available: false })];

    // Act
    const recommendation = recommend('add the field', { accounts });

    // Assert
    should(recommendation.exclusions[0]?.reason).equal('declared unavailable by the fleet manifest');
  });

  it('should never recommend a model the account itself declares unavailable', () => {
    // Arrange
    const accounts = inventory.map(entry =>
      entry.id === 'account-secondary'
        ? {
            ...entry,
            models: [
              { id: 'forge', available: false as const, unavailableReason: 'down' },
              { id: 'swift', available: true as const },
            ],
          }
        : entry,
    );

    // Act
    const recommendation = recommend('rewrite the protocol layer', { accounts });

    // Assert
    should(recommendation.roles.every(role => role.primary.model !== 'forge')).be.true();
  });

  it('should exclude an account the catalog reserves, with the catalog’s own reason', () => {
    // Arrange
    const accounts = [...inventory, account({ id: 'account-personal', agent: 'agent-personal' })];

    // Act
    const recommendation = recommend('add the field', { accounts });

    // Assert
    should(recommendation.exclusions.map(item => item.reason)).containEql(
      'reserved for its owner — never route work here',
    );
  });

  it('should refuse to route to an account the catalog says nothing about', () => {
    // Arrange
    const accounts = [...inventory, account({ id: 'unknown-account', agent: 'agent-unknown' })];

    // Act
    const recommendation = recommend('add the field', { accounts });

    // Assert
    should(recommendation.exclusions.map(item => item.reason)).containEql(
      'no routing entry for this account — route it manually',
    );
  });

  it('should exclude a rejected account with a remedy its authentication mode can achieve', () => {
    // Arrange / Act
    const recommendation = recommend('add the field', {
      usage: [usage('agent-primary', { authOk: false })],
      authModes: { 'account-primary': 'oauth' },
    });

    // Assert
    should(recommendation.exclusions[0]?.reason).containEql('fy fleet login');
  });

  it.each([
    {
      label: 'an account at its limit',
      row: usage('agent-primary', { atLimit: true }),
      expected: 'at its usage limit',
    },
    {
      label: 'an unavailable provider',
      row: usage('agent-primary', { unavailable: true, unavailableReason: 'cooldown' }),
      expected: 'cooling down',
    },
  ])('should exclude $label with a reason the reader can act on', ({ row, expected }) => {
    // Arrange / Act
    const recommendation = recommend('add the field', { usage: [row] });

    // Assert
    should(recommendation.exclusions.map(item => item.reason).join(' ')).containEql(expected);
  });

  it('should prefer the less spent of two accounts offering the same tier', () => {
    // Arrange
    const twin = account({
      id: 'account-twin',
      agent: 'agent-twin',
      kind: 'codex',
      displayName: 'Twin',
      models: [{ id: 'forge', available: true as const }],
    });
    const catalogWithTwin: RoutingCatalog = {
      ...catalog,
      accounts: [
        ...catalog.accounts,
        { accountId: 'account-twin', preferredSpend: false, options: [{ model: 'forge' }] },
      ],
    };

    // Act
    const recommendation = recommend('rewrite the protocol layer', {
      accounts: [...inventory, twin],
      catalog: catalogWithTwin,
      usage: [usage('agent-secondary', { fiveHourPercent: 90 }), usage('agent-twin', { fiveHourPercent: 1 })],
    });

    // Assert
    should(roleOf(recommendation, 'implementer')?.primary.accountId).equal('account-twin');
  });

  describe('an account the feed cannot score', () => {
    // Two accounts offering the same model, so the spend adjustment is the only thing between them.
    const twin = account({
      id: 'account-twin',
      agent: 'agent-twin',
      kind: 'codex',
      displayName: 'Twin',
      models: [{ id: 'forge', available: true as const }],
    });
    const catalogWithTwin: RoutingCatalog = {
      ...catalog,
      accounts: [
        ...catalog.accounts,
        { accountId: 'account-twin', preferredSpend: false, options: [{ model: 'forge' }] },
      ],
    };
    const implementerFor = (usageRows: readonly AccountUsage[]): string | undefined =>
      roleOf(
        recommend('rewrite the protocol layer', {
          accounts: [...inventory, twin],
          catalog: catalogWithTwin,
          usage: usageRows,
        }),
        'implementer',
      )?.primary.accountId;

    it('should lose to an account measured with real headroom', () => {
      // Arrange — the source scored an unknown reading as 0%, the best possible, so unmeasured won
      // Act / Assert
      should(implementerFor([usage('agent-secondary', { fiveHourPercent: 0 })])).equal('account-secondary');
    });

    it('should still beat an account measured as nearly exhausted', () => {
      // Arrange — unknown is not "fully spent" either; a freshly added account must stay reachable
      // Act / Assert
      should(implementerFor([usage('agent-secondary', { fiveHourPercent: 95 })])).equal('account-twin');
    });

    it('should not be promoted by its own collection failing', () => {
      // Arrange — a failed probe reports numbers nobody can trust, so quotaFromUsage discards them
      const rows = [
        usage('agent-secondary', { fiveHourPercent: 0 }),
        usage('agent-twin', { ok: false, fiveHourPercent: 99 }),
      ];

      // Act / Assert — the failure must not hand the twin the zero-penalty best case
      should(implementerFor(rows)).equal('account-secondary');
    });

    it('should be penalised by the catalog weight rather than a number in the algorithm', () => {
      // Arrange — an operator who declares unknown to be pessimistic gets pessimistic ordering
      const pessimistic: RoutingCatalog = {
        ...catalogWithTwin,
        weights: { ...catalogWithTwin.weights, unknownSpentPercent: 100 },
      };

      // Act
      const recommendation = recommend('rewrite the protocol layer', {
        accounts: [...inventory, twin],
        catalog: pessimistic,
        usage: [usage('agent-secondary', { fiveHourPercent: 95 })],
      });

      // Assert
      should(roleOf(recommendation, 'implementer')?.primary.accountId).equal('account-secondary');
    });
  });

  it('should list one entry per model rather than the same model on every account', () => {
    // Arrange
    const twin = account({
      id: 'account-twin',
      agent: 'agent-twin',
      kind: 'codex',
      displayName: 'Twin',
      models: [{ id: 'forge', available: true as const }],
    });
    const catalogWithTwin: RoutingCatalog = {
      ...catalog,
      accounts: [
        ...catalog.accounts,
        { accountId: 'account-twin', preferredSpend: false, options: [{ model: 'forge' }] },
      ],
    };

    // Act
    const recommendation = recommend('rewrite the protocol layer', {
      accounts: [...inventory, twin],
      catalog: catalogWithTwin,
    });
    const implementer = roleOf(recommendation, 'implementer');
    const models = [implementer?.primary.model, ...(implementer?.alternatives ?? []).map(option => option.model)];

    // Assert
    should(new Set(models).size).equal(models.length);
  });

  it('should drag a planner onto the team when the implementer may not plan its own work', () => {
    // Arrange — only the plan-follower is available for implementation
    const accounts = inventory.map(entry => {
      if (entry.id === 'account-secondary') return { ...entry, models: [{ id: 'swift', available: true as const }] };
      if (entry.id === 'account-primary') return { ...entry, models: [{ id: 'apex', available: true as const }] };
      return entry;
    });

    // Act
    const recommendation = recommend('add the field, following the plan, to the worker queue', { accounts });

    // Assert
    should(roleOf(recommendation, 'implementer')?.primary.model).equal('swift');
    should(recommendation.roles[0]?.role).equal('planner');
    should(recommendation.roles[0]?.why).containEql('implements only against a plan');
  });

  it('should say plainly when the chain needs a planner and none is available', () => {
    // Arrange — a lone plan-following account, so nothing can write the plan
    const accounts = [
      account({
        id: 'account-secondary',
        agent: 'agent-secondary',
        kind: 'codex',
        displayName: 'Secondary',
        models: [{ id: 'swift', available: true as const }],
      }),
    ];

    // Act
    const recommendation = recommend('add the field, following the plan, to the worker queue', { accounts });

    // Assert
    should(recommendation.warnings.join(' ')).containEql('must not plan its own work');
  });

  it('should fall back below the floor with a warning rather than staff nobody', () => {
    // Arrange — only a below-floor account is available for hard critical work
    const accounts = inventory
      .filter(entry => entry.id === 'account-secondary')
      .map(entry => ({ ...entry, models: [{ id: 'swift', available: true as const }] }));

    // Act
    const recommendation = recommend('rewrite the production auth layer', { accounts, roles: ['implementer'] });

    // Assert
    should(recommendation.warnings.join(' ')).containEql('treat its output as provisional');
    should(roleOf(recommendation, 'implementer')?.primary.caveat).equal('below-doctrine-floor');
  });

  it('should warn when a role cannot be filled at all', () => {
    // Arrange / Act
    const recommendation = recommend('add the field', { accounts: [], roles: ['implementer'] });

    // Assert
    should(recommendation.warnings).deepEqual(['no usable account could fill the implementer role']);
    should(recommendation.roles).be.empty();
  });

  it('should honour a caller who names the shape themselves', () => {
    // Arrange / Act
    const recommendation = recommend('add the field', { roles: ['reviewer'] });

    // Assert
    should(recommendation.roles.map(role => role.role)).deepEqual(['reviewer']);
  });

  it('should size a fan-out to the scope in front of it', () => {
    // Arrange / Act
    const large = recommend('rename the helper in 40 files');
    const small = recommend('add the field', { roles: ['fan-out'] });

    // Assert
    should(roleOf(large, 'fan-out')?.count).equal(4);
    should(roleOf(small, 'fan-out')?.count).equal(2);
  });

  it('should mark an alternative that merely shares the leader’s family', () => {
    // Arrange / Act
    const recommendation = recommend('rewrite the protocol layer');
    const reviewer = roleOf(recommendation, 'reviewer');

    // Assert
    should(reviewer?.alternatives.some(option => option.caveat === 'same-model-family')).be.true();
  });

  it('should show no more alternatives than the catalog allows', () => {
    // Arrange
    const narrow: RoutingCatalog = { ...catalog, weights: { ...catalog.weights, alternativesShown: 1 } };

    // Act
    const recommendation = recommend('rewrite the protocol layer', { catalog: narrow });

    // Assert
    should(roleOf(recommendation, 'implementer')?.alternatives.length).be.belowOrEqual(1);
  });

  it('should describe the reading and the shape it produced', () => {
    // Arrange / Act
    const recommendation = recommend('rewrite the production auth layer');

    // Assert
    should(recommendation.reasoning).containEql('critical risk');
    should(recommendation.reasoning).containEql('Team shape: planner →');
  });

  it('should say the shape is empty when nothing could be staffed', () => {
    // Arrange / Act
    const recommendation = recommend('add the field', { accounts: [] });

    // Assert
    should(recommendation.reasoning).containEql('Team shape: none.');
  });

  it('should carry the spend preference and the account default into the tradeoff line', () => {
    // Arrange / Act
    const recommendation = recommend('add the field', { roles: ['planner'] });
    const primary = roleOf(recommendation, 'planner')?.primary;

    // Assert
    should(primary?.tradeoff).containEql('preferred-spend account');
    should(primary?.modelFlag).be.undefined();
  });

  it('should carry the override flag when a model is reached through one', () => {
    // Arrange
    const accounts = inventory.map(entry =>
      entry.id === 'account-primary' ? { ...entry, models: [{ id: 'steady', available: true as const }] } : entry,
    );

    // Act
    const recommendation = recommend('add the field', { accounts, roles: ['planner'] });

    // Assert
    should(roleOf(recommendation, 'planner')?.primary.modelFlag).equal('steady-1');
  });

  it('should apply a specialist bonus declared for a kind of work', () => {
    // Arrange — the catalog declares the chore tier a debugging specialist
    const scoreOfChore = (task: string): number | undefined =>
      roleOf(recommend(task, { budget: 'cheap', roles: ['implementer'] }), 'implementer')?.alternatives.find(
        option => option.model === 'chore',
      )?.score;

    // Act
    const specialism = scoreOfChore('the worker keeps crashing on retry');
    const ordinary = scoreOfChore('add the field');

    // Assert
    should(specialism).be.above(ordinary as number);
  });

  it('should push a short-reach researcher down on large-scope research', () => {
    // Arrange / Act
    const recommendation = recommend('research how the whole codebase handles retries');
    const researcher = roleOf(recommendation, 'researcher');

    // Assert
    should(['apex', 'forge']).containEql(researcher?.primary.model);
  });

  it('should ignore a routing entry whose model the catalog does not describe', () => {
    // Arrange — a hand-built catalog, the shape `parseRoutingCatalog` would have refused
    const dangling: RoutingCatalog = {
      ...catalog,
      accounts: [{ accountId: 'account-primary', preferredSpend: false, options: [{ model: 'ghost' }] }],
    };

    // Act
    const recommendation = recommend('add the field', {
      accounts: inventory.filter(entry => entry.id === 'account-primary'),
      catalog: dangling,
      roles: ['implementer'],
    });

    // Assert
    should(recommendation.warnings).deepEqual(['no usable account could fill the implementer role']);
  });

  it('should apply no cost penalty at all when the caller is buying quality', () => {
    // Arrange
    const budgets: readonly Budget[] = ['cheap', 'balanced', 'max'];

    // Act
    const scores = budgets.map(
      budget => recommend('add the field', { budget, roles: ['planner'] }).roles[0]?.primary.score,
    );

    // Assert — the same model, ranked strictly higher as the penalty falls away
    should(scores[2]).be.above(scores[1] as number);
    should(scores[1]).be.above(scores[0] as number);
  });

  it('should treat an unknown budget as carrying no penalty rather than failing', () => {
    // Arrange
    const withoutBalanced: RoutingCatalog = { ...catalog, costPenalty: { cheap: catalog.costPenalty.cheap ?? {} } };

    // Act
    const recommendation = recommend('add the field', { catalog: withoutBalanced, roles: ['planner'] });

    // Assert
    should(recommendation.roles[0]?.primary.model).equal('apex');
  });
});

describe('the scoring adjustments the catalog declares', () => {
  it('should prefer reaching a model through an account default over an override flag', () => {
    // Arrange — the same model on two accounts, one of which needs --model to get there
    const twin = account({
      id: 'account-twin',
      agent: 'agent-twin',
      kind: 'codex',
      displayName: 'Twin',
      models: [{ id: 'forge', available: true as const }],
    });
    const withTwin: RoutingCatalog = {
      ...catalog,
      accounts: [
        ...catalog.accounts.map(entry =>
          entry.accountId === 'account-secondary'
            ? {
                ...entry,
                options: [
                  { model: 'forge', modelFlag: 'forge-1' },
                  { model: 'swift', modelFlag: 'swift-1' },
                ],
              }
            : entry,
        ),
        { accountId: 'account-twin', preferredSpend: false, options: [{ model: 'forge' }] },
      ],
    };
    const request = { accounts: [...inventory, twin], catalog: withTwin, roles: ['implementer'] as const };

    // Act
    const preferred = recommend('rewrite the protocol layer', request);
    const indifferent = recommend('rewrite the protocol layer', {
      ...request,
      catalog: { ...withTwin, weights: { ...withTwin.weights, accountDefaultBonus: 0 } },
    });

    // Assert — the bonus decides it; with the bonus removed the tie falls back to listing order
    should(roleOf(preferred, 'implementer')?.primary.accountId).equal('account-twin');
    should(roleOf(indifferent, 'implementer')?.primary.accountId).equal('account-secondary');
  });

  it('should push a plan-following implementer down when the caller is buying cheap', () => {
    // Arrange — a plan follower drags a planner onto the team, the priciest teammate on a cheap budget
    const request = { budget: 'cheap' as const, roles: ['implementer'] as const };

    // Act
    const penalised = recommend('add the field', request);
    const unpenalised = recommend('add the field', {
      ...request,
      catalog: { ...catalog, weights: { ...catalog.weights, needsPlanCheapPenalty: 0 } },
    });

    // Assert
    should(roleOf(penalised, 'implementer')?.primary.model).not.equal('swift');
    should(roleOf(unpenalised, 'implementer')?.primary.model).equal('swift');
  });

  it('should not push a plan follower down on any other budget', () => {
    // Arrange / Act
    const balanced = recommend('add the field', { roles: ['implementer'] });
    const unpenalised = recommend('add the field', {
      roles: ['implementer'],
      catalog: { ...catalog, weights: { ...catalog.weights, needsPlanCheapPenalty: 0 } },
    });

    // Assert — identical scores, so the penalty is genuinely gated on the cheap budget
    should(roleOf(balanced, 'implementer')?.primary.score).equal(roleOf(unpenalised, 'implementer')?.primary.score);
  });

  it('should dock a researcher that cannot reach far enough for large-scope work', () => {
    // Arrange — only the below-reach account is available, so the penalty is visible in its score
    const accounts = inventory.filter(entry => entry.id === 'account-primary');
    const request = { accounts, roles: ['researcher'] as const };
    const scoreOf = (weights: RoutingCatalog['weights'], task: string): number | undefined =>
      roleOf(recommend(task, { ...request, catalog: { ...catalog, weights } }), 'researcher')?.alternatives.find(
        option => option.model === 'steady',
      )?.score;
    const unpenalised = { ...catalog.weights, smallResearcherPenalty: 0 };

    // Act — the same account, on a large-scope research task, with and without the penalty
    const large = 'research and survey every module in the entire monorepo across all packages';

    // Assert
    should((scoreOf(unpenalised, large) ?? 0) - (scoreOf(catalog.weights, large) ?? 0)).equal(20);
  });

  it('should leave a short-reach researcher alone on small-scope work', () => {
    // Arrange
    const accounts = inventory.filter(entry => entry.id === 'account-primary');
    const scoreOf = (weights: RoutingCatalog['weights']): number | undefined =>
      roleOf(
        recommend('research one flag', { accounts, roles: ['researcher'], catalog: { ...catalog, weights } }),
        'researcher',
      )?.alternatives.find(option => option.model === 'steady')?.score;

    // Act / Assert — the penalty is scope-gated, so removing it must change nothing here
    should(scoreOf({ ...catalog.weights, smallResearcherPenalty: 0 })).equal(scoreOf(catalog.weights));
  });

  it('should name the product-facing bar, not the power floor, when that is what emptied the menu', () => {
    // Arrange — the chore tier meets the mid floor (power 40) but is barred from product-facing work
    const accounts = inventory.filter(entry => entry.id === 'account-chore');

    // Act
    const recommendation = recommend('restyle the customer landing page', { accounts, roles: ['implementer'] });

    // Assert — the source blamed the floor here, sending the reader after a more capable model
    should(recommendation.warnings.join(' ')).containEql('barred from product-facing work');
    should(recommendation.warnings.join(' ')).not.containEql('no available account meets');
    should(roleOf(recommendation, 'implementer')?.primary.caveat).equal('not-for-product-facing');
  });

  it('should still blame the floor when nothing is capable enough', () => {
    // Arrange — a reviewer floor this account cannot reach, and reviewers face no product bar
    const demanding: RoutingCatalog = { ...catalog, floors: { ...catalog.floors, reviewer: 99 } };
    const accounts = inventory.filter(entry => entry.id === 'account-secondary');

    // Act
    const recommendation = recommend('add the field', { accounts, catalog: demanding, roles: ['reviewer'] });

    // Assert
    should(recommendation.warnings.join(' ')).containEql('no available account meets the reviewer floor');
    should(recommendation.warnings.join(' ')).not.containEql('barred from product-facing');
  });
});
