import { type FleetApprovalMint, FleetApprovalMintSchema } from '@ferretry/protocol';
import type { FleetApiClient, IFleetAuthorizationGateway, IRecommendationGateway } from './ports.ts';
import {
  type RecommendationRequest,
  RecommendationRequestSchema,
  type TeamRecommendation,
  TeamRecommendationSchema,
} from './wire.ts';

/** The recommender route. */
export const RECOMMEND_PATH = '/v1/recommend';

/**
 * Probing every account's quota is slow — several provider round trips — so the recommender gets
 * longer than a plain JSON call before the client gives up on it.
 */
export const RECOMMEND_TIMEOUT_MS = 60_000;

/** Speaks the recommender route through the protocol client, parsing the response. */
export class ProtocolRecommendationGateway implements IRecommendationGateway {
  constructor(private readonly client: FleetApiClient) {}

  async recommend(request: RecommendationRequest): Promise<TeamRecommendation> {
    const body = RecommendationRequestSchema.parse(request);
    return await this.client.request(
      RECOMMEND_PATH,
      TeamRecommendationSchema,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
      RECOMMEND_TIMEOUT_MS,
    );
  }
}

/** Where the daemon keeps the changes a paired browser has proposed but may not itself apply. */
export const FLEET_PROPOSALS_PATH = '/v1/fleet/proposals';

/**
 * Where this host approves one of them.
 *
 * The PROPOSAL ID is in the path and the CODE never is, which is the same rule pairing states at
 * `pairingCodePath`: a path is a URL and a URL reaches the daemon's access log, so a code in a log
 * is a code that outlives its two minutes. The id is a non-secret handle the browser is already
 * displaying, so it is safe here — and putting it here is what lets the mint be bodyless.
 */
export function fleetAuthorizePath(proposalId: string): string {
  return `${FLEET_PROPOSALS_PATH}/${encodeURIComponent(proposalId)}/authorize`;
}

/**
 * Mints the approval for one proposed change, through the protocol client.
 *
 * The route is host-scoped, so the credential that reaches it is the one the CLI already resolved
 * for this daemon — the owner-only token file for a loopback daemon, an explicit `FY_TOKEN` for a
 * remote one. Nothing new is discovered, stored or widened here: a device token cannot mint, and the
 * bearer this sends is never printed, echoed or returned.
 */
export class ProtocolFleetAuthorizationGateway implements IFleetAuthorizationGateway {
  constructor(private readonly client: FleetApiClient) {}

  /**
   * Bodyless, and on the default deadline.
   *
   * Bodyless because everything the daemon needs is the id in the path and the credential the client
   * already carries; the handler reads no body, so sending one would be a shape nothing validates.
   * Default deadline because this touches no provider — unlike `recommend`, which probes live quota,
   * it is a memory-only mint — so it has no claim on a longer one.
   *
   * A blank id is refused HERE rather than sent, because the daemon would otherwise be asked for an
   * empty path segment and answer something less useful than the truth.
   */
  async authorize(proposalId: string): Promise<FleetApprovalMint> {
    const id = proposalId.trim();
    if (id === '') throw new Error('name the proposal to approve: fy fleet authorize <proposal-id>');
    return await this.client.request(fleetAuthorizePath(id), FleetApprovalMintSchema, { method: 'POST' });
  }
}
