/**
 * The configuration directory's watcher: it notices that a file changed and loads the configuration
 * again, so a broken file is reported in the daemon log the moment it is saved and a fixed one is in
 * effect without anyone reading it first.
 *
 * WHY IT POLLS. A platform file watcher that follows a whole tree misses a file created in a directory
 * that did not exist when the watch began (`components/mcp/` on a fresh machine) on the runtime this
 * daemon ships on, and a missed save is a broken file nobody is told about. A fingerprint of the tree —
 * each file's size and modification time — read once a second costs a handful of `stat` calls, sees
 * every change, and cannot miss a new directory.
 *
 * WHY IT DEBOUNCES. An editor saves through a temporary file and a rename, and a person saves twice in
 * a second; one load after the tree has been quiet for {@link CONFIG_WATCH_DEBOUNCE_MS} answers all of
 * it, and never evaluates a file caught half way through a save.
 */

/** How often the tree's fingerprint is read. */
export const CONFIG_WATCH_INTERVAL_MS = 1_000;
/** How long the tree must be quiet before it is loaded. */
export const CONFIG_WATCH_DEBOUNCE_MS = 300;

/** The timers the watcher runs on, so a test drives time itself. */
export interface ConfigWatchTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ConfigWatchOptions {
  /** A value that changes whenever any file in the tree does. */
  fingerprint(): Promise<string>;
  /** Called once the tree has changed and then been quiet. */
  onChange(): Promise<void>;
  /** Told when a fingerprint or a load fails; the watcher keeps going. */
  onError(error: unknown): void;
  readonly timers: ConfigWatchTimers;
  readonly intervalMs?: number;
  readonly debounceMs?: number;
}

/** Start watching. Answers the stop. The first fingerprint is the baseline, not a change. */
export function watchConfigFiles(options: ConfigWatchOptions): () => void {
  const { timers } = options;
  let last: string | undefined;
  let pending: unknown;
  let stopped = false;
  let busy = false;
  const settle = (): void => {
    pending = undefined;
    if (stopped) return;
    options.onChange().catch(options.onError);
  };
  const poll = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      const now = await options.fingerprint();
      if (last !== undefined && now !== last && !stopped) {
        if (pending !== undefined) timers.clearTimeout(pending);
        pending = timers.setTimeout(settle, options.debounceMs ?? CONFIG_WATCH_DEBOUNCE_MS);
      }
      last = now;
    } catch (error) {
      options.onError(error);
    } finally {
      busy = false;
    }
  };
  void poll();
  const interval = timers.setInterval(() => void poll(), options.intervalMs ?? CONFIG_WATCH_INTERVAL_MS);
  return () => {
    stopped = true;
    timers.clearInterval(interval);
    if (pending !== undefined) timers.clearTimeout(pending);
  };
}
