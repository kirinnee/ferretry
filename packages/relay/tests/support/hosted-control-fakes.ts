import type { HostedRelayControlStorage, HostedRelayControlStorageTransaction } from '../../src/adapters/index.ts';

/**
 * Byte-ordered comparison, which is what Durable Object storage uses for both listing and `startAfter`.
 *
 * `localeCompare` is the trap here: it reports `'A' > 'a'`, bytes report the opposite, and daemon
 * fingerprints are base64url so mixed case is the norm rather than an edge case. Paging takes the last
 * key of a page as the next `startAfter`, so a double that sorted one way and filtered the other would
 * hand back pages whose last key is not the greatest — losing rows, and reporting a healthy census as
 * damaged for exactly the key shapes production actually stores.
 */
function byteOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Transactional Durable Object storage, with the ordering/pagination semantics this adapter uses. */
export class FakeHostedRelayControlStorage implements HostedRelayControlStorage {
  readonly values = new Map<string, unknown>();
  /** How many pages have been listed, so a test can tell a skipped sweep from a repeated one. */
  listCalls = 0;

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
    this.listCalls += 1;
    const entries = [...this.values.entries()]
      .filter(
        ([key]) => key.startsWith(options.prefix) && (options.startAfter === undefined || key > options.startAfter),
      )
      .sort(([left], [right]) => byteOrder(left, right))
      .slice(0, options.limit) as [string, T][];
    return new Map(entries);
  }

  async transaction<T>(closure: (transaction: HostedRelayControlStorageTransaction) => Promise<T>): Promise<T> {
    return closure(this);
  }
}
