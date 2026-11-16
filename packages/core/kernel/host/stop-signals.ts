/** The longest a stop may take (its jobs get 10 s of it, jobs.ts) before the process ends regardless. */
export const STOP_LIMIT_MS = 15_000;

/** The process's signal and exit seams, so a test drives them without signalling itself. */
export interface StopProcess {
  once(signal: 'SIGTERM' | 'SIGINT', handler: () => void): void;
  on(signal: 'SIGTERM' | 'SIGINT', handler: () => void): void;
  exit(code: number): void;
  after(ms: number, fn: () => void): void;
}

/**
 * Resolves once the first SIGTERM or SIGINT has been answered by `stop`. From that signal on, a SECOND signal, or a stop
 * still unfinished after `limitMs`, ends the process with 1: the last word, so a stop that waits on something that
 * never answers cannot leave a daemon that looks dead (listener closed) but holds its home.
 */
export async function stopOnSignal(
  stop: () => Promise<void>,
  proc: StopProcess,
  limitMs: number = STOP_LIMIT_MS,
): Promise<void> {
  await new Promise<void>(resolve => {
    // Both `once` handlers stay armed after the first signal; only the first one begins the stop.
    let begun = false;
    const begin = (): void => {
      if (begun) return;
      begun = true;
      proc.on('SIGTERM', () => proc.exit(1));
      proc.on('SIGINT', () => proc.exit(1));
      proc.after(limitMs, () => proc.exit(1));
      // A stop that rejects ends the process with 1 as well, rather than as an unhandled rejection.
      void stop().then(resolve, () => proc.exit(1));
    };
    proc.once('SIGTERM', begin);
    proc.once('SIGINT', begin);
  });
}

/** The real process's seams; the limit timer is unref'd, so it never keeps the process alive by itself. */
const realProcess: StopProcess = {
  once: (signal, handler) => void process.once(signal, handler),
  on: (signal, handler) => void process.on(signal, handler),
  exit: code => process.exit(code),
  after: (ms, fn) => void setTimeout(fn, ms).unref(),
};

/**
 * The daemon's stop: `stopOnSignal` over the real process, where a `stop` that rejects first says why through `report`
 * (`fyd: stopping failed: <message>`, one line) and then rethrows, so the process still ends with 1.
 */
export async function stopOnSignalReporting(
  stop: () => Promise<void>,
  report: (line: string) => void,
  proc: StopProcess = realProcess,
): Promise<void> {
  await stopOnSignal(
    () =>
      stop().catch((error: unknown) => {
        report(`fyd: stopping failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
        throw error;
      }),
    proc,
  );
}
