import type { z } from 'zod';
import {
  type PackCleanUpJobResult,
  PackCleanUpJobResultSchema,
  type PackCleanUpRequest,
  type PackCleanUpStart,
  PackCleanUpStartSchema,
  type PackInventory,
  PackInventorySchema,
  type PackRecommendation,
  PackRecommendationSchema,
  type PackRecommendRequest,
  type PackRoutingAcceptRequest,
  type PackRoutingWriteResult,
  PackRoutingWriteResultSchema,
  type PackTable,
  PackTableSchema,
  type PackView,
  PackViewSchema,
} from '../../contract/index.ts';

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
  /** A lead's one-table view of its pack. */
  table(id: string): Promise<PackTable>;
}

/** The generated client, narrowed to the one call the verbs make. */
export interface PackClient {
  call<Answer = unknown>(
    route: string,
    init?: {
      readonly params?: Readonly<Record<string, string>>;
      readonly query?: Readonly<Record<string, string>>;
      readonly body?: unknown;
    },
  ): Promise<Answer>;
}

/** Speaks the Pack routes through the plugin client, parsing every answer with the contract's schema. */
export class ClientPackGateway implements IPackGateway {
  constructor(private readonly client: PackClient) {}

  private async ask<S extends z.ZodType>(
    schema: S,
    route: string,
    init?: Parameters<PackClient['call']>[1],
  ): Promise<z.infer<S>> {
    return schema.parse(await this.client.call(route, init)) as z.infer<S>;
  }

  async view(): Promise<PackView> {
    return await this.ask(PackViewSchema, 'GET /v1/pack');
  }

  async inventory(): Promise<PackInventory> {
    return await this.ask(PackInventorySchema, 'GET /v1/pack/inventory');
  }

  async cleanUp(request: PackCleanUpRequest): Promise<PackCleanUpStart> {
    // The start checks the runtime (it resolves and its login is signed in; not yet today's "reply OK" run) before it
    // launches the clean-up ferret, so it waits like a start.
    return await this.ask(PackCleanUpStartSchema, 'POST /v1/pack/routing/clean-up', { body: request });
  }

  async job(id: string): Promise<PackCleanUpJobResult> {
    return await this.ask(PackCleanUpJobResultSchema, 'GET /v1/pack/routing/jobs/:jobId', { params: { jobId: id } });
  }

  async accept(request: PackRoutingAcceptRequest): Promise<PackRoutingWriteResult> {
    return await this.ask(PackRoutingWriteResultSchema, 'POST /v1/pack/routing/accept', { body: request });
  }

  async undo(): Promise<PackRoutingWriteResult> {
    return await this.ask(PackRoutingWriteResultSchema, 'POST /v1/pack/routing/undo', { body: {} });
  }

  async recommend(request: PackRecommendRequest): Promise<PackRecommendation> {
    return await this.ask(PackRecommendationSchema, 'POST /v1/pack/recommend', { body: request });
  }

  async table(id: string): Promise<PackTable> {
    return await this.ask(PackTableSchema, 'GET /v1/ferrets/:ferretId/pack', { params: { ferretId: id } });
  }
}
