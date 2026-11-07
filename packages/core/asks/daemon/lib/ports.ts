/** The daemon ports the Asks engine takes (today's `daemon/src/lib/ports.ts`, the part Asks reads). */

/** Runs work one at a time per key, or exclusively across every key. */
export interface SerialExecutor {
  run<T>(key: string, work: () => Promise<T>): Promise<T>;
  runExclusive<T>(work: () => Promise<T>): Promise<T>;
}
