import type { HostedRelayControlStorage, HostedRelayControlStorageTransaction } from '../../src/adapters/index.ts';

/** Transactional Durable Object storage, with the ordering/pagination semantics this adapter uses. */
export class FakeHostedRelayControlStorage implements HostedRelayControlStorage {
  readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  async list<T>(options: {
    readonly prefix: string;
    readonly startAfter?: string;
    readonly limit: number;
  }): Promise<Map<string, T>> {
    const entries = [...this.values.entries()]
      .filter(
        ([key]) => key.startsWith(options.prefix) && (options.startAfter === undefined || key > options.startAfter),
      )
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, options.limit) as [string, T][];
    return new Map(entries);
  }

  async transaction<T>(closure: (transaction: HostedRelayControlStorageTransaction) => Promise<T>): Promise<T> {
    return closure(this);
  }
}
