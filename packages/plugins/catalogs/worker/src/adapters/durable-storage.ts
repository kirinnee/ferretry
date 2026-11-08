/**
 * The Durable Object surface the link-store objects use, copied from today's
 * `packages/relay/src/adapters/hosted-control.ts` (its storage and namespace interfaces only). The link-store
 * Worker is deployed apart from the relay and imports no code from it; these are the Cloudflare shapes, typed.
 */

interface HostedRelayControlStorageRead {
  get<T>(key: string): Promise<T | undefined>;
  list<T>(options: {
    readonly prefix: string;
    readonly startAfter?: string;
    readonly limit: number;
  }): Promise<Map<string, T>>;
}

export interface HostedRelayControlStorageTransaction extends HostedRelayControlStorageRead {
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface HostedRelayControlStorage extends HostedRelayControlStorageTransaction {
  transaction<T>(closure: (transaction: HostedRelayControlStorageTransaction) => Promise<T>): Promise<T>;
}

export interface HostedRelayControlNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}
