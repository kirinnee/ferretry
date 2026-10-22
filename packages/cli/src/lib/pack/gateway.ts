import {
  type IFyApiClient,
  PACK_NEW_PATH,
  PACK_PATH,
  PACK_RECOMMEND_PATH,
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
