import {
  type IFyApiClient,
  PACK_GUIDE_ACCEPT_PATH,
  PACK_GUIDE_DESCRIBE_PATH,
  PACK_GUIDE_SUGGEST_PATH,
  PACK_GUIDE_UNDO_PATH,
  PACK_INVENTORY_PATH,
  PACK_NEW_PATH,
  PACK_PATH,
  PACK_RECOMMEND_PATH,
  type PackGuideAcceptRequest,
  type PackGuideDescribeRequest,
  type PackGuideJobResult,
  PackGuideJobResultSchema,
  type PackGuideSuggestRequest,
  type PackGuideSuggestStart,
  PackGuideSuggestStartSchema,
  type PackGuideWriteResult,
  PackGuideWriteResultSchema,
  type PackInventory,
  PackInventorySchema,
  type PackNewOutcome,
  PackNewOutcomeSchema,
  type PackNewRequest,
  type PackRecommendation,
  PackRecommendationSchema,
  type PackRecommendRequest,
  type PackView,
  PackViewSchema,
  type SessionResult,
  SessionResultSchema,
} from '@ferretry/protocol';

/** The daemon calls the Pack commands make, and nothing else. */
export interface IPackGateway {
  /** The settings, the models guide in effect and every model the fleet knows (`GET /v1/pack`). */
  view(): Promise<PackView>;
  recommend(request: PackRecommendRequest): Promise<PackRecommendation>;
  /** The models guide generator (docs/pack-mode.md § Suggesting a guide). */
  inventory(): Promise<PackInventory>;
  suggest(request: PackGuideSuggestRequest): Promise<PackGuideSuggestStart>;
  job(id: string): Promise<PackGuideJobResult>;
  accept(request: PackGuideAcceptRequest): Promise<PackGuideWriteResult>;
  undo(): Promise<PackGuideWriteResult>;
  describe(request: PackGuideDescribeRequest): Promise<PackGuideWriteResult>;
  newChild(request: PackNewRequest): Promise<PackNewOutcome>;
  result(id: string): Promise<SessionResult>;
  stop(id: string, reason: string): Promise<void>;
}

/** A start probes each candidate (up to its timeout) before it launches, so it waits longer than a read. */
export const PACK_NEW_TIMEOUT_MS = 10 * 60_000;

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** Speaks the Pack routes through the protocol client, parsing every answer. */
export class ProtocolPackGateway implements IPackGateway {
  constructor(private readonly client: Pick<IFyApiClient, 'request' | 'stop'>) {}

  async view(): Promise<PackView> {
    return await this.client.request(PACK_PATH, PackViewSchema);
  }

  async inventory(): Promise<PackInventory> {
    return await this.client.request(PACK_INVENTORY_PATH, PackInventorySchema);
  }

  async suggest(request: PackGuideSuggestRequest): Promise<PackGuideSuggestStart> {
    // The start probes the runtime ("reply OK") before it launches the builder, so it waits like a start.
    return await this.client.request(
      PACK_GUIDE_SUGGEST_PATH,
      PackGuideSuggestStartSchema,
      json(request),
      PACK_NEW_TIMEOUT_MS,
    );
  }

  async job(id: string): Promise<PackGuideJobResult> {
    return await this.client.request(`/v1/pack/guide/jobs/${encodeURIComponent(id)}`, PackGuideJobResultSchema);
  }

  async accept(request: PackGuideAcceptRequest): Promise<PackGuideWriteResult> {
    return await this.client.request(PACK_GUIDE_ACCEPT_PATH, PackGuideWriteResultSchema, json(request));
  }

  async undo(): Promise<PackGuideWriteResult> {
    return await this.client.request(PACK_GUIDE_UNDO_PATH, PackGuideWriteResultSchema, json({}));
  }

  async describe(request: PackGuideDescribeRequest): Promise<PackGuideWriteResult> {
    return await this.client.request(PACK_GUIDE_DESCRIBE_PATH, PackGuideWriteResultSchema, json(request));
  }

  async recommend(request: PackRecommendRequest): Promise<PackRecommendation> {
    return await this.client.request(PACK_RECOMMEND_PATH, PackRecommendationSchema, json(request));
  }

  async newChild(request: PackNewRequest): Promise<PackNewOutcome> {
    return await this.client.request(PACK_NEW_PATH, PackNewOutcomeSchema, json(request), PACK_NEW_TIMEOUT_MS);
  }

  async result(id: string): Promise<SessionResult> {
    return await this.client.request(`/v1/sessions/${encodeURIComponent(id)}/result`, SessionResultSchema);
  }

  async stop(id: string, reason: string): Promise<void> {
    await this.client.stop(id, reason);
  }
}
