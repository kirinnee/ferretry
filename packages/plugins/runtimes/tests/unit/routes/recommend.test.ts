import { describe, it } from 'bun:test';
import { wardenStanding } from '@ferretry/core-gate/contract/testing';
import should from 'should';
import { RecommendationSchema } from '../../../contract/index.ts';
import type { RuntimesAssembly } from '../../../daemon/index.ts';
import { RecommendError, type RecommendSubsystem, type TeamRecommendation } from '../../../daemon/routes/recommend.ts';
import { hostRuntimes } from './support.ts';

/**
 * The recommender route, driven through the kernel's test host.
 *
 * The engine behind it (the routing doctrine and the team advisor) is not part of this plugin (GAP(packs)), so the
 * subsystem here is a stub that answers a fixed team. What the route owns is the projection, and it is proved by
 * parsing the answer against the contract's own schema: the daemon's domain recommendation carries a structured
 * classification and a caveat slug the shipped client cannot parse, so the projection is the contract.
 */

const HARD_TASK = 'redesign the critical production authentication flow and port the whole test suite';

const TEAM: TeamRecommendation = {
  task: HARD_TASK,
  classification: 'Read as high risk, a rewrite of an authentication flow (words: redesign, critical, production).',
  reasoning: 'A risky change gets a planner and a reviewer.',
  roles: [
    {
      role: 'planner',
      why: 'The design is the risky part.',
      primary: {
        agent: 'claude-code',
        accountId: 'claude-default',
        model: 'opus',
        tradeoff: 'the strongest plan at the highest cost',
        score: 0.92,
      },
      alternatives: [
        {
          agent: 'codex',
          accountId: 'codex-default',
          model: 'gpt',
          tradeoff: 'cheaper, a little less careful',
          score: 0.8,
          caveat: 'below-doctrine-floor',
        },
      ],
    },
    {
      role: 'worker',
      why: 'The port is wide.',
      count: 3,
      primary: { agent: 'codex', accountId: 'codex-default', model: 'gpt', tradeoff: 'fast', score: 0.7 },
      alternatives: [],
    },
  ],
  exclusions: [{ accountId: 'account-ghost', agent: 'codex', reason: 'it has no model the catalog knows' }],
  warnings: [],
};

function assemblyOf(subsystem: RecommendSubsystem): RuntimesAssembly {
  return {
    catalog: {} as RuntimesAssembly['catalog'],
    setup: {} as RuntimesAssembly['setup'],
    recommend: subsystem,
    logins: {
      list: async () => ({ logins: [] }),
      signOut: async () => await Promise.reject(new Error('not used here')),
    },
  };
}

/** The recommender stub, noting whether live quota was asked for. */
function recommender(overrides: Partial<RecommendSubsystem> = {}, probes: string[] = []): RecommendSubsystem {
  return {
    recommend: async input => {
      probes.push(input.usage ? 'probed' : 'unread');
      return { ...TEAM, task: input.task };
    },
    ...overrides,
  };
}

async function ask(subsystem: RecommendSubsystem, body: unknown) {
  const { host } = await hostRuntimes(assemblyOf(subsystem));
  return await host.request('POST', '/v1/recommend', { body });
}

describe('the recommender mount', () => {
  it('should answer a team in the wire shape the client parses', async () => {
    // Arrange / Act
    const response = await ask(recommender(), { task: HARD_TASK, usage: true });

    // Assert
    should(response.status).equal(200);
    const recommendation = RecommendationSchema.parse(JSON.parse(response.body));
    should(recommendation.task).equal(HARD_TASK);
    // The classification is the domain's own one-liner: the shape it read AND the words that did it.
    should(recommendation.classification).match(/^Read as .* risk, /u);
    should(recommendation.roles.length).be.above(0);
    // Every pick names a real account, not a placeholder.
    should(recommendation.roles.map(role => role.primary.accountId).every(id => id.length > 0)).be.true();
  });

  it('should offer alternatives beside every pick, because the answer is a guide', async () => {
    // A route that returned only the winner would read as an instruction and hide what was skipped.
    // Arrange / Act
    const response = await ask(recommender(), { task: HARD_TASK, usage: true });

    // Assert
    const recommendation = RecommendationSchema.parse(JSON.parse(response.body));
    should(recommendation.roles.some(role => role.alternatives.length > 0)).be.true();
    should(recommendation.roles[0]?.alternatives[0]?.caveat).equal('below-doctrine-floor');
  });

  it('should report the accounts it refused to use, and why', async () => {
    // Arrange / Act
    const response = await ask(recommender(), { task: 'tidy a README', usage: true });

    // Assert
    const recommendation = RecommendationSchema.parse(JSON.parse(response.body));
    should(recommendation.exclusions.map(exclusion => exclusion.accountId)).containEql('account-ghost');
    should(recommendation.exclusions[0]?.reason).not.be.empty();
  });

  it('should keep exclusions and warnings on the wire even when they are empty', async () => {
    // A caller must be able to tell "nothing was excluded" from "exclusions were not reported".
    // Arrange / Act
    const response = await ask(recommender({ recommend: async () => ({ ...TEAM, exclusions: [], warnings: [] }) }), {
      task: HARD_TASK,
      usage: true,
    });

    // Assert
    const body = JSON.parse(response.body) as Record<string, unknown>;
    should(body.exclusions).deepEqual([]);
    should(body.warnings).deepEqual([]);
  });

  it('should read live quota only when the caller asked for it', async () => {
    // `usage: false` means the quota inputs are genuinely unread — not read and then discarded, which
    // would cost the caller the provider round trips they declined.
    // Arrange
    const probes: string[] = [];

    // Act
    await ask(recommender({}, probes), { task: HARD_TASK, usage: false });
    await ask(recommender({}, probes), { task: HARD_TASK, usage: true });

    // Assert
    should(probes).deepEqual(['unread', 'probed']);
  });

  it('should refuse when the operator has written no routing catalog', async () => {
    // The catalog IS the routing doctrine, so inventing one would be inventing the fleet's policy.
    // Arrange / Act
    const response = await ask(
      recommender({
        recommend: async () => {
          throw new RecommendError('unconfigured', 'no routing catalog at /state/config/routing.json');
        },
      }),
      { task: HARD_TASK, usage: false },
    );

    // Assert
    should(response.status).equal(503);
    should(response.json()).have.property('code', 'recommender_unconfigured');
    // The refusal names the file to write rather than saying the daemon failed.
    should(response.json()).have.property('error', 'no routing catalog at /state/config/routing.json');
  });

  it('should refuse a body with no task rather than recommend for nothing', async () => {
    // Arrange / Act
    const empty = await ask(recommender(), { task: '', usage: true });
    const missing = await ask(recommender(), { usage: true });

    // Assert
    should([empty.status, missing.status]).deepEqual([400, 400]);
    should(empty.json()).have.property('code', 'invalid_request');
  });

  it('should refuse a field it does not implement rather than ignore it', async () => {
    // A caller sending `roles` believes this route forces the team shape. It does not.
    // Arrange / Act
    const response = await ask(recommender(), { task: HARD_TASK, usage: true, roles: ['planner'] });

    // Assert
    should(response.status).equal(400);
    should(response.json()).have.property('code', 'invalid_request');
  });

  it('should let a genuine defect surface as an internal error, not as a configuration refusal', async () => {
    // Only a failed CATALOG read is `unconfigured`; anything else must not be reported as the
    // operator's missing file.
    // Arrange
    const broken = recommender({
      recommend: async () => {
        throw new Error('the engine divided by zero');
      },
    });

    // Act
    const response = await ask(broken, { task: HARD_TASK, usage: true });

    // Assert
    should(response.status).equal(500);
  });

  it('should refuse a caller holding only the warden token', async () => {
    // The answer names every account in the fleet and how spent each one is.
    // Arrange
    const hosted = await hostRuntimes(assemblyOf(recommender()));
    hosted.as(wardenStanding('w1' as never));

    // Act
    const response = await hosted.host.request('POST', '/v1/recommend', { body: { task: HARD_TASK, usage: true } });

    // Assert
    should(response.status).equal(403);
  });

  it('should never let a cached recommendation stand in for one decided on live quota', async () => {
    // Arrange / Act
    const response = await ask(recommender(), { task: HARD_TASK, usage: true });

    // Assert
    should(response.headers.get('cache-control')).match(/no-store/u);
  });
});
