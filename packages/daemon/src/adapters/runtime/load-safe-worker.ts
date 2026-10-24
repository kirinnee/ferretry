/**
 * A WORKER THAT IS NEVER ENDED WHILE IT IS STILL LOADING — every thread the daemon starts is one.
 *
 * Bun up to 1.3.14 crashes the WHOLE PROCESS when a worker is terminated while its module graph is still
 * being transpiled: the transpiler's thread pool finishes a job for the worker's freed VM and writes into
 * memory that is gone (`panic: Segmentation fault at address 0xFFFFFFFFFFFFFFF8`, in
 * `SavedSourceMap.putValue`, `Define.forIdentifier` and friends). A daemon that boots and is told to stop
 * inside a few hundred milliseconds does exactly that to the threads its boot started, and so did
 * `Integration Tests (daemon-runtime)`, every few runs. Ending a thread that started six workers and
 * terminated them 0–80 ms later crashed Bun 1.3.13 in 6 runs of 6; ending each only once it had
 * opened crashed none. Bun 1.4.0 no longer crashes either way.
 *
 * So `terminate()` here ends the thread at once when it has loaded, and otherwise as soon as it does:
 * `open` is dispatched after the entry module and its static imports are evaluated, and `error` when
 * loading fails. Until then the thread is as good as ended — a caller ignores what a thread it ended
 * posts, as every caller here already does for a thread it replaced. A module a worker imports
 * dynamically after it opened is not covered; none of the daemon's workers end while one loads.
 *
 * NOTHING POSTED BEFORE IT OPENS REACHES A THREAD ENDED FIRST. A message posted to a loading thread waits
 * in the thread's own queue and runs the moment the thread loads — before the main thread has even heard
 * `open` — so a thread ended late would still do whatever it was asked. A session worker did exactly
 * that: a stopping daemon's late-ended worker ran its queued `attach-session`, which started a tmux
 * server on a socket nobody served any more, and left it running. So messages are held here until the
 * thread opens, sent in order then, and dropped with the thread when it was ended first.
 */
export class LoadSafeWorker extends Worker {
  #loaded = false;
  #ending = false;
  /** What was posted before the thread opened, in order; sent when it does. */
  readonly #held: (() => void)[] = [];

  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    const loaded = (): void => {
      if (this.#loaded) return;
      this.#loaded = true;
      const held = this.#held.splice(0);
      if (this.#ending) {
        super.terminate();
        return;
      }
      for (const send of held) send();
    };
    this.addEventListener('open', loaded, { once: true });
    this.addEventListener('error', loaded, { once: true });
  }

  /** Sends `message` now if the thread has loaded, and when it opens if it has not. */
  override postMessage(message: unknown, transfer?: Bun.Transferable[] | Bun.StructuredSerializeOptions): void {
    const send = (): void => super.postMessage(message, transfer as Bun.StructuredSerializeOptions);
    if (this.#loaded) send();
    else this.#held.push(send);
  }

  /** Ends the thread now if it has loaded, and the moment it does if it has not, sending it nothing more. */
  override terminate(): void {
    if (this.#loaded) {
      super.terminate();
      return;
    }
    this.#ending = true;
  }
}
