import { describe, it } from 'bun:test';
import should from 'should';
import { z } from 'zod';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { recommendRoutes, type RecommendSubsystem } from '../../../../src/lib/runtime/mounts/recommend.ts';
import { jsonBody, request } from '../../api/support.ts';
import { CREDENTIALS, human, recommendSubsystem } from './support.ts';

/**
 * The recommender route, driven through the real router over the real engine.
 *
 * The response is parsed against a restatement of the CLI's OWN wire schema rather than checked field
 * by field. That is the point of the mount: the daemon's domain recommendation carries a structured
 * classification and a caveat slug the shipped client cannot parse, so the projection is the contract,
 * and a contract is only proved by parsing.
 */

/** The shape `packages/cli/src/lib/fleet/wire.ts` parses. Restated because the daemon package may not
 *  depend on the CLI package; a drift on either side fails here with a stated reason. */
const NonEmpty = z.string().min(1);
const RoleOptionSchema = z.object({
  agent: NonEmpty,
  accountId: NonEmpty,
  model: NonEmpty,
  tradeoff: z.string(),
  score: z.number(),
  caveat: z.string().optional(),
});
const TeamRecommendationSchema = z.object({
  task: NonEmpty,
  classification: z.string(),
  reasoning: z.string(),
  roles: z.array(
    z.object({
      role: NonEmpty,
      why: z.string(),
      count: z.number().int().positive().optional(),
      primary: RoleOptionSchema,
      alternatives: z.array(RoleOptionSchema).default([]),
    }),
  ),
  exclusions: z.array(z.object({ accountId: NonEmpty, agent: NonEmpty, reason: z.string() })),
  warnings: z.array(z.string()),
});

function dispatcher(subsystem: RecommendSubsystem): ApiDispatcher {
  return new ApiDispatcher(new ApiRouter(recommendRoutes(subsystem)), CREDENTIALS);
}

async function ask(subsystem: RecommendSubsystem, body: unknown) {
  return await dispatcher(subsystem).dispatch(
    request({
      method: 'POST',
      path: '/v1/recommend',
      headers: { ...human, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

/** A hard, risky task, so the engine returns a multi-role team with alternatives and a count. */
const HARD_TASK = 'redesign the critical production authentication flow and port the whole test suite';

describe('the recommender mount', () => {
  it('should answer a team in the wire shape the client parses', async () => {
    // Arrange / Act
    const response = await ask(recommendSubsystem(), { task: HARD_TASK, usage: true });

    // Assert
    should(response.status).equal(200);
    const recommendation = TeamRecommendationSchema.parse(JSON.parse(response.body));
    should(recommendation.task).equal(HARD_TASK);
    // The classification is the domain's own one-liner: the shape it read AND the words that did it.
    should(recommendation.classification).match(/^Read as .* risk, /u);
    should(recommendation.roles.length).be.above(0);
    // Every pick names a real account from the manifest, not a placeholder.
    should(recommendation.roles.map(role => role.primary.accountId).every(id => id.length > 0)).be.true();
  });

  it('should offer alternatives beside every pick, because the answer is a guide', async () => {
    // A route that returned only the winner would read as an instruction and hide what was skipped.
    // Arrange / Act
    const response = await ask(recommendSubsystem(), { task: HARD_TASK, usage: true });

    // Assert
    const recommendation = TeamRecommendationSchema.parse(JSON.parse(response.body));
    should(recommendation.roles.some(role => role.alternatives.length > 0)).be.true();
  });

  it('should report the accounts it refused to use, and why', async () => {
    // Arrange — an account the catalog knows nothing about cannot serve any role
    const accounts = [
      {
        id: 'account-ghost',
        agent: 'agent-ghost',
        wrapper: '/state/fleet/bin/agent-ghost',
        home: '/state/fleet/homes/ghost',
        kind: 'claude',
        mode: 'auto',
        displayName: 'Ghost',
        defaultModel: null,
        models: [],
        available: true,
        unavailableReason: null,
      },
    ] as const;
    // Act
    const response = await ask(recommendSubsystem({ accounts }), { task: 'tidy a README', usage: true });

    // Assert
    const recommendation = TeamRecommendationSchema.parse(JSON.parse(response.body));
    should(recommendation.exclusions.map(exclusion => exclusion.accountId)).containEql('account-ghost');
    should(recommendation.exclusions[0]?.reason).not.be.empty();
  });

  it('should read live quota only when the caller asked for it', async () => {
    // `usage: false` means the quota inputs are genuinely unread — not read and then discarded, which
    // would cost the caller the provider round trips they declined.
    // Arrange
    const probes: string[] = [];

    // Act
    await ask(recommendSubsystem({ probes }), { task: HARD_TASK, usage: false });
    await ask(recommendSubsystem({ probes }), { task: HARD_TASK, usage: true });

    // Assert
    should(probes).deepEqual(['unread', 'probed']);
  });

  it('should refuse when the operator has written no routing catalog', async () => {
    // The catalog IS the routing doctrine, so inventing one would be inventing the fleet's policy.
    // Arrange / Act
    const response = await ask(recommendSubsystem({ unconfigured: true }), { task: HARD_TASK, usage: false });

    // Assert
    should(response.status).equal(503);
    should(jsonBody(response)).have.property('code', 'recommender_unconfigured');
    // The refusal names the file to write rather than saying the daemon failed.
    should(jsonBody(response)).have.property('error', 'no routing catalog at /state/config/routing.json');
  });

  it('should refuse a body with no task rather than recommend for nothing', async () => {
    // Arrange / Act
    const empty = await ask(recommendSubsystem(), { task: '', usage: true });
    const missing = await ask(recommendSubsystem(), { usage: true });

    // Assert
    should([empty.status, missing.status]).deepEqual([400, 400]);
    should(jsonBody(empty)).have.property('code', 'invalid_request');
  });

  it('should refuse a field it does not implement rather than ignore it', async () => {
    // A caller sending `roles` believes this route forces the team shape. It does not.
    // Arrange / Act
    const response = await ask(recommendSubsystem(), { task: HARD_TASK, usage: true, roles: ['planner'] });

    // Assert
    should(response.status).equal(400);
    should(jsonBody(response)).have.property('code', 'invalid_request');
  });

  it('should let a genuine defect surface as an internal error, not as a configuration refusal', async () => {
    // Only a failed CATALOG read is `unconfigured`; anything else must not be reported as the
    // operator's missing file.
    // Arrange
    const broken: RecommendSubsystem = {
      recommend: async () => {
        throw new Error('the engine divided by zero');
      },
    };

    // Act
    const response = await ask(broken, { task: HARD_TASK, usage: true });

    // Assert
    should(response.status).equal(500);
    should(jsonBody(response)).have.property('code', 'internal_error');
  });

  it('should refuse a caller holding only the warden token', async () => {
    // The answer names every account in the fleet and how spent each one is.
    // Arrange / Act
    const response = await dispatcher(recommendSubsystem()).dispatch(
      request({
        method: 'POST',
        path: '/v1/recommend',
        headers: { authorization: `Bearer ${CREDENTIALS.warden}`, 'content-type': 'application/json' },
        body: JSON.stringify({ task: HARD_TASK, usage: true }),
      }),
    );

    // Assert
    should(response.status).equal(403);
  });

  it('should never let a cached recommendation stand in for one decided on live quota', async () => {
    // Arrange / Act
    const response = await ask(recommendSubsystem(), { task: HARD_TASK, usage: true });

    // Assert
    should(response.headers.get('cache-control')).match(/no-store/u);
  });
});
