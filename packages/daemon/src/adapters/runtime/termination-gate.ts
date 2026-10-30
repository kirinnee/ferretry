/**
 * WHAT A TERMINATION SIGNAL MEANS, FROM THE FIRST INSTANT OF A BOOT.
 *
 * The daemon used to install its SIGINT/SIGTERM handlers only once the boot had finished and it began
 * waiting to be told to stop. `/healthz` answers well before that — the address is bound in the first
 * second — so a `fy daemon stop`, a restart or a service manager's stop that landed during the boot hit
 * the default action: the process vanished with none of its cleanups run, tmux clients and worker threads
 * included. And installing the same handlers earlier would be worse, not better: a boot that is stuck
 * would then IGNORE the signal until something kills it harder.
 *
 * So the gate distinguishes the two moments:
 *
 * - BEFORE the daemon is serving, a signal runs `early` — every cleanup registered so far, and every one
 *   the boot registers while that runs ({@link releaseAcquired}) — and the process exits with that
 *   answer: a boot interrupted promptly, and cleanly.
 * - ONCE it is serving (the boot has asked {@link TerminationGate.untilShutdown}), a signal resolves the
 *   wait, and the boot's own orderly shutdown runs exactly as it always did.
 */

/** The part of `process` the gate listens on, so a test can stand in a target of its own. */
export interface SignalTarget {
  once(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export interface TerminationGate {
  /** Marks the daemon serving, and resolves on the first termination signal from then on. */
  untilShutdown(): Promise<void>;
}

/** The exit code of a process ended by SIGTERM, as a shell reports it: 128 + 15. */
export const INTERRUPTED_BOOT_EXIT_CODE = 143;

/** The gate itself: listening from construction, serving once {@link untilShutdown} is asked. */
class SignalTerminationGate implements TerminationGate {
  #serving = false;
  #stopping = false;
  readonly #terminated: Promise<void>;
  readonly #resolve: () => void;

  constructor(
    private readonly early: () => Promise<void>,
    private readonly exit: (code: number) => void,
    target: SignalTarget,
  ) {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#terminated = promise;
    this.#resolve = resolve;
    for (const signal of ['SIGINT', 'SIGTERM'] as const) target.once(signal, () => this.#signalled());
  }

  untilShutdown(): Promise<void> {
    this.#serving = true;
    return this.#terminated;
  }

  #signalled(): void {
    if (this.#serving) {
      this.#resolve();
      return;
    }
    if (this.#stopping) return;
    this.#stopping = true;
    void this.early().then(
      () => this.exit(INTERRUPTED_BOOT_EXIT_CODE),
      () => this.exit(INTERRUPTED_BOOT_EXIT_CODE),
    );
  }
}

/**
 * Runs and removes every cleanup in `cleanups`, in order, until none is left — each in its own
 * try/catch, so one that fails never keeps the rest from running.
 *
 * UNTIL NONE IS LEFT, NOT THE ONES THERE WHEN IT STARTED. An early release runs while the boot it
 * interrupts is still going: `/healthz` answers and every route is mounted before the boot has armed
 * the session observer, so a stop in that stretch used to release the cleanups registered so far and
 * exit, while the boot went on to start the session workers and register their release into a list
 * nobody read again. Their tmux clients were then left to notice the exit, still detaching from the
 * server for a moment after the daemon had gone — and a `kill-server` in that moment keeps the server
 * AND the client running for good. Whatever the boot acquires while this runs is released here too.
 */
export async function releaseAcquired(cleanups: Array<() => void | Promise<void>>): Promise<void> {
  while (cleanups.length > 0)
    for (const cleanup of cleanups.splice(0)) {
      try {
        await cleanup();
      } catch {
        // Intentionally ignored: the process is ending either way.
      }
    }
}

/** A gate listening on `target` (the process itself unless a test stands one in). */
export function terminationGate(
  early: () => Promise<void>,
  exit: (code: number) => void,
  target: SignalTarget = process,
): TerminationGate {
  return new SignalTerminationGate(early, exit, target);
}
