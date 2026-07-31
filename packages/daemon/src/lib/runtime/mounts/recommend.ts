import { z } from 'zod';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import type { ApiResponse } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import { describeClassification } from '../../core/classification.ts';
import type { RoleOption, TeamRecommendation } from '../../core/team.ts';

/**
 * The team recommender: which account and model should take one task, and why.
 *
 * This is the route `fy recommend` already speaks — `POST /v1/recommend` — and the daemon answered
 * `unknown_route` to it. The engine behind it was built and fully tested, and the composition root
 * even CONSTRUCTED a `TeamAdvisor` in the world: nothing ever called it, so the recommendation the
 * product advertised did not exist.
 *
 * Unlike most of what this daemon mounts, this one answers with real content on a fresh install: its
 * inputs are the fleet manifest the provisioner publishes and the operator's routing catalog, not a
 * session index that only a mounted session start could fill.
 *
 * THE ANSWER IS A GUIDE, NOT AN ORDER, and the wire shape says so — every role carries its
 * alternatives, and every account the recommender refused to use carries the reason. That is why the
 * projection below keeps `exclusions` and `warnings` even when they are empty: a caller must be able
 * to tell "nothing was excluded" from "exclusions were not reported".
 *
 * WHAT IS DELIBERATELY NOT SERVED HERE. The recommender does not start anything. It names a team; the
 * human then runs `fy start` themselves. A route that launched what it recommended would be the
 * session-lifecycle mount, which does not exist yet, wearing this one's clothes.
 */

/** What the client asks. Strict: an unknown field is a caller who thinks this route does more. */
const RecommendationRequestSchema = z.strictObject({
  task: z.string().min(1),
  /**
   * Whether to read live account quota before deciding.
   *
   * `false` is not "ignore the answer" — it means the quota inputs are genuinely UNREAD, and the
   * recommender then ranks every account as average rather than as empty. Probing anyway would cost
   * the caller several provider round trips they explicitly declined.
   */
  usage: z.boolean(),
});

/** Why a recommendation could not be produced. */
export type RecommendFailure =
  /** The operator has written no routing catalog, or one the parser refuses. */
  'unconfigured';

/** A refusal raised by the composition root's recommender, in a taxonomy `src/lib` may name. */
export class RecommendError extends Error {
  constructor(
    readonly failure: RecommendFailure,
    message: string,
  ) {
    super(message);
    this.name = 'RecommendError';
  }
}

/**
 * The recommender, as this route needs it.
 *
 * `TeamAdvisor` takes an `AdviceRequest` and a usage feed fixed at construction, so the composition
 * root — not this mount — decides what "read live quota" means for this deployment. The mount's
 * whole contract is the one boolean the client sends.
 */
export interface RecommendSubsystem {
  recommend(input: { readonly task: string; readonly usage: boolean }): Promise<TeamRecommendation>;
}

/** One option as the wire carries it: the account, the model, the trade-off and the caveat. */
function option(value: RoleOption): Record<string, unknown> {
  return {
    agent: value.agent,
    accountId: value.accountId,
    model: value.model,
    tradeoff: value.tradeoff,
    score: value.score,
    // The caveat is the domain's own slug — `below-doctrine-floor` and friends — passed through
    // rather than reworded here, so the reason an option stayed on the menu is the reason the engine
    // recorded.
    ...(value.caveat === undefined ? {} : { caveat: value.caveat }),
  };
}

/**
 * The recommendation as the client parses it.
 *
 * The classification is rendered by the DOMAIN's own one-liner, which names both the shape it read
 * and the words that produced it. Sending the structured classification instead would be a wire
 * change the shipped CLI cannot parse, and summarising it here in new words would be a second,
 * quieter description of the same judgement.
 */
function view(recommendation: TeamRecommendation): Record<string, unknown> {
  return {
    task: recommendation.task,
    classification: describeClassification(recommendation.classification),
    reasoning: recommendation.reasoning,
    roles: recommendation.roles.map(role => ({
      role: role.role,
      why: role.why,
      ...(role.count === undefined ? {} : { count: role.count }),
      primary: option(role.primary),
      alternatives: role.alternatives.map(option),
    })),
    exclusions: recommendation.exclusions.map(exclusion => ({
      accountId: exclusion.accountId,
      agent: exclusion.agent,
      reason: exclusion.reason,
    })),
    warnings: [...recommendation.warnings],
  };
}

/** Restates a recommender refusal in the HTTP vocabulary. */
function refuse(error: unknown): never {
  if (error instanceof RecommendError) throw new ApiError(503, error.message, 'recommender_unconfigured');
  throw error;
}

/** One task in, one team out. */
async function recommend(subsystem: RecommendSubsystem, context: RouteContext): Promise<ApiResponse> {
  const request = await parseBody(context.request, RecommendationRequestSchema);
  return jsonResponse(view(await subsystem.recommend(request).catch(refuse)));
}

/**
 * `admin` scope: the answer names every account in the fleet, its models and how spent each one is,
 * which is the operator's whole provisioning posture.
 *
 * `noStore` because a recommendation is decided partly on live quota; a cached one recommends an
 * account that has since run out.
 *
 * POST rather than GET even though nothing is created: the task description is prose of arbitrary
 * length, and a task in a query string is a task in every proxy log between here and the client.
 */
export function recommendRoutes(subsystem: RecommendSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'POST',
      path: '/v1/recommend',
      scope: 'admin',
      noStore: true,
      handle: async context => await recommend(subsystem, context),
    },
  ];
}
