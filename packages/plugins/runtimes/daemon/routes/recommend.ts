import type { HarnessKey } from '@ferretry/core-ferrets/contract';
import {
  type ApiRequest,
  ApiError,
  type ApiResponse,
  jsonResponse,
  type RouteHandler,
} from '@ferretry/kernel/contract';
import { RECOMMENDER_UNCONFIGURED, RecommendationRequestSchema } from '../../contract/index.ts';
import { parseBody } from './body.ts';

/**
 * The team recommender: which account and model should take one task, and why.
 *
 * This is the route `fy recommend` speaks: `POST /v1/recommend`.
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

/** Why a recommendation could not be produced. */
export type RecommendFailure =
  /** The operator has written no routing catalog, or one the parser refuses. */
  'unconfigured';

/** One option the recommender names. GAP(packs): the recommender engine (`core/team.ts`) is not in this plugin; this is its output's shape. */
export interface RoleOption {
  readonly agent: HarnessKey;
  readonly accountId: string;
  readonly model: string;
  readonly tradeoff: string;
  readonly score: number;
  readonly caveat?: string;
}

/** What the recommender answers. `classification` is the recommender's own one-line reading of the task, already worded. */
export interface TeamRecommendation {
  readonly task: string;
  readonly classification: string;
  readonly reasoning: string;
  readonly roles: readonly {
    readonly role: string;
    readonly why: string;
    readonly count?: number;
    readonly primary: RoleOption;
    readonly alternatives: readonly RoleOption[];
  }[];
  readonly exclusions: readonly { readonly accountId: string; readonly agent: HarnessKey; readonly reason: string }[];
  readonly warnings: readonly string[];
}

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
    classification: recommendation.classification,
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
  if (error instanceof RecommendError) throw new ApiError(503, error.message, RECOMMENDER_UNCONFIGURED);
  throw error;
}

/** One task in, one team out. */
async function recommend(subsystem: RecommendSubsystem, request: ApiRequest): Promise<ApiResponse> {
  const body = await parseBody(request, RecommendationRequestSchema);
  return jsonResponse(view(await subsystem.recommend(body).catch(refuse)));
}

/**
 * The handler for `POST /v1/recommend`. The answer names every login in the fleet, its models and how spent each one
 * is, which is the operator's whole provisioning posture; the manifest's descriptor holds it at `operator`, and
 * `noStore` because a recommendation is decided partly on live quota.
 *
 * POST rather than GET even though nothing is created: the task description is prose of arbitrary length, and a task
 * in a query string is a task in every proxy log between here and the client.
 */
export function recommendRoutes(subsystem: RecommendSubsystem) {
  return {
    'POST /v1/recommend': async call => await recommend(subsystem, call.request),
  } satisfies Record<string, RouteHandler>;
}
