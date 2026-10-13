import type { FleetApiClient, IRecommendationGateway } from './ports.ts';
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
