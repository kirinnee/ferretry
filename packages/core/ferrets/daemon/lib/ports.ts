/** Work queued per key, one at a time per key (today's `lib/ports.ts` `SerialExecutor`). */
export interface SerialExecutor {
  run<T>(key: string, work: () => Promise<T>): Promise<T>;
  runExclusive<T>(work: () => Promise<T>): Promise<T>;
}
