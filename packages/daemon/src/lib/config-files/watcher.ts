/**
 * The configuration directory's watcher: it notices that a file changed and loads the configuration
 * again, so a broken file is reported in the daemon log the moment it is saved and a fixed one is in
 * effect without anyone reading it first.
 *
 * WHY IT IS EVENT-DRIVEN, AND HOW. A fingerprint of the tree — each file's size and modification time —
 * sees every change and cannot miss a new directory, but read once a second it was ~1,000 `stat` calls
 * every 20 seconds on an idle daemon. Given {@link ConfigTreeEvents}, the fingerprint is read only when a
 * directory of the tree reports an event, and on a slow {@link CONFIG_WATCH_BACKSTOP_MS} backstop for an
 * event the platform lost. A platform watcher that follows a whole tree misses a file created in a
 * directory that did not exist when the watch began (`components/mcp/` on a fresh machine), so the tree
 * is not watched recursively: every directory in it is watched on its own, and the set is renewed
 * BEFORE each fingerprint — a new directory is seen by its parent's event, watched, and only then
 * fingerprinted, so nothing written into it in between can be missed.
 *
 * Without events it polls the fingerprint every {@link CONFIG_WATCH_INTERVAL_MS}, as it always did.
 *
 * WHY IT DEBOUNCES. An editor saves through a temporary file and a rename, and a person saves twice in
 * a second; one load after the tree has been quiet for {@link CONFIG_WATCH_DEBOUNCE_MS} answers all of
 * it, and never evaluates a file caught half way through a save.
 */

/** How often the tree's fingerprint is read when nothing tells the watcher a file changed. */
export const CONFIG_WATCH_INTERVAL_MS = 1_000;
/** How often the tree's fingerprint is read anyway when file events drive the watcher. */
export const CONFIG_WATCH_BACKSTOP_MS = 30_000;
/** How long the tree must be quiet before it is loaded. */
export const CONFIG_WATCH_DEBOUNCE_MS = 300;

/** The timers the watcher runs on, so a test drives time itself. */
export interface ConfigWatchTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The tree's directories, and a way to hear that one of them changed (the file-event hub is one). */
export interface ConfigTreeEvents {
  /** Every directory of the tree as of now, its root included. */
  directories(): Promise<readonly string[]>;
  subscribeDirectory(path: string, listener: () => void): { close(): void };
}

export interface ConfigWatchOptions {
  /** A value that changes whenever any file in the tree does. */
  fingerprint(): Promise<string>;
  /**
   * Told the moment the tree may have changed — a directory's file event, or a fingerprint that moved —
   * before the debounce, so a reader can stop trusting the last load straight away.
   */
  onEvent?(): void;
  /** Called once the tree has changed and then been quiet. */
  onChange(): Promise<void>;
  /** Told when a fingerprint or a load fails; the watcher keeps going. */
  onError(error: unknown): void;
  readonly timers: ConfigWatchTimers;
  /** When given, the fingerprint is read on an event and on the backstop instead of every interval. */
  readonly events?: ConfigTreeEvents;
  readonly intervalMs?: number;
  readonly debounceMs?: number;
}

/** Start watching. Answers the stop. The first fingerprint is the baseline, not a change. */
export function watchConfigFiles(options: ConfigWatchOptions): () => void {
  const { timers, events } = options;
  const watched = new Map<string, { close(): void }>();
  let last: string | undefined;
  let pending: unknown;
  let stopped = false;
  let busy = false;
  let again = false;
  const settle = (): void => {
    pending = undefined;
    if (stopped) return;
    options.onChange().catch(options.onError);
  };
  /** Watch exactly the directories the tree has now. */
  const renew = async (tree: ConfigTreeEvents): Promise<void> => {
    const current = new Set(await tree.directories());
    if (stopped) return;
    for (const [directory, subscription] of watched)
      if (!current.has(directory)) {
        subscription.close();
        watched.delete(directory);
      }
    for (const directory of current)
      if (!watched.has(directory))
        watched.set(
          directory,
          tree.subscribeDirectory(directory, () => {
            options.onEvent?.();
            void poll(true);
          }),
        );
  };
  // An event during a read is not dropped: it runs one more read once this one is done.
  const poll = async (requested = false): Promise<void> => {
    if (busy) {
      again ||= requested;
      return;
    }
    busy = true;
    try {
      if (events !== undefined) await renew(events);
      const now = await options.fingerprint();
      if (last !== undefined && now !== last && !stopped) {
        options.onEvent?.();
        if (pending !== undefined) timers.clearTimeout(pending);
        pending = timers.setTimeout(settle, options.debounceMs ?? CONFIG_WATCH_DEBOUNCE_MS);
      }
      last = now;
    } catch (error) {
      options.onError(error);
    } finally {
      busy = false;
    }
    if (again && !stopped) {
      again = false;
      await poll(true);
    }
  };
  void poll();
  const interval = timers.setInterval(
    () => void poll(),
    options.intervalMs ?? (events === undefined ? CONFIG_WATCH_INTERVAL_MS : CONFIG_WATCH_BACKSTOP_MS),
  );
  return () => {
    stopped = true;
    timers.clearInterval(interval);
    if (pending !== undefined) timers.clearTimeout(pending);
    for (const subscription of watched.values()) subscription.close();
    watched.clear();
  };
}
