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
 */
export class LoadSafeWorker extends Worker {
  #loaded = false;
  #ending = false;

  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    const loaded = (): void => {
      if (this.#loaded) return;
      this.#loaded = true;
      if (this.#ending) super.terminate();
    };
    this.addEventListener('open', loaded, { once: true });
    this.addEventListener('error', loaded, { once: true });
  }

  /** Ends the thread now if it has loaded, and the moment it does if it has not. */
  override terminate(): void {
    if (this.#loaded) {
      super.terminate();
      return;
    }
    this.#ending = true;
  }
}
