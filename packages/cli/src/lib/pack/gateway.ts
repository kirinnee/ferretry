import {
  type IFyApiClient,
  PACK_CLEAN_UP_JOBS_PATH,
  PACK_CLEAN_UP_PATH,
  PACK_INVENTORY_PATH,
  PACK_NEW_PATH,
  PACK_PATH,
  PACK_RECOMMEND_PATH,
  PACK_ROUTING_ACCEPT_PATH,
  PACK_ROUTING_UNDO_PATH,
  type PackCleanUpJobResult,
  PackCleanUpJobResultSchema,
  type PackCleanUpRequest,
  type PackCleanUpStart,
  PackCleanUpStartSchema,
  type PackInventory,
  PackInventorySchema,
  type PackNewOutcome,
  PackNewOutcomeSchema,
  type PackNewRequest,
  type PackRecommendation,
  PackRecommendationSchema,
  type PackRecommendRequest,
  type PackRoutingAcceptRequest,
  type PackRoutingWriteResult,
  PackRoutingWriteResultSchema,
  type PackView,
  PackViewSchema,
  type SessionResult,
  SessionResultSchema,
} from '@ferretry/protocol';

/** The daemon calls the Pack commands make, and nothing else. */
export interface IPackGateway {
  /** The settings, the routing prompt in effect and the models usable now (`GET /v1/pack`). */
  view(): Promise<PackView>;
  recommend(request: PackRecommendRequest): Promise<PackRecommendation>;
  /** What Clean up is shown: every runtime and model, with readiness and quota. */
  inventory(): Promise<PackInventory>;
  /** Start the clean-up ferret; only a person's ask starts one. */
  cleanUp(request: PackCleanUpRequest): Promise<PackCleanUpStart>;
  job(id: string): Promise<PackCleanUpJobResult>;
  accept(request: PackRoutingAcceptRequest): Promise<PackRoutingWriteResult>;
  undo(): Promise<PackRoutingWriteResult>;
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

  async cleanUp(request: PackCleanUpRequest): Promise<PackCleanUpStart> {
    // The start probes the runtime ("reply OK") before it launches the clean-up ferret, so it waits like a start.
    return await this.client.request(PACK_CLEAN_UP_PATH, PackCleanUpStartSchema, json(request), PACK_NEW_TIMEOUT_MS);
  }

  async job(id: string): Promise<PackCleanUpJobResult> {
    return await this.client.request(
      `${PACK_CLEAN_UP_JOBS_PATH}/${encodeURIComponent(id)}`,
      PackCleanUpJobResultSchema,
    );
  }

  async accept(request: PackRoutingAcceptRequest): Promise<PackRoutingWriteResult> {
    return await this.client.request(PACK_ROUTING_ACCEPT_PATH, PackRoutingWriteResultSchema, json(request));
  }

  async undo(): Promise<PackRoutingWriteResult> {
    return await this.client.request(PACK_ROUTING_UNDO_PATH, PackRoutingWriteResultSchema, json({}));
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
