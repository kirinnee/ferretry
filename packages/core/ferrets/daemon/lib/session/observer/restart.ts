/** How long the first restart of a crashed session worker waits; every further crash doubles it. */
export const SESSION_WORKER_RESTART_MS = 1_000;
/** The longest a restart waits. */
export const SESSION_WORKER_RESTART_CAP_MS = 60_000;
/** The window crashes are counted in. */
export const SESSION_WORKER_CRASH_WINDOW_MS = 10 * 60_000;
/** Crashes of one session within the window after which it is observed on the main thread instead. */
export const SESSION_WORKER_CRASH_LIMIT = 5;

/** What a session's crash history says to do next. */
export type SessionWorkerRestart =
  | { readonly kind: 'restart'; readonly afterMs: number }
  /** Observe it on the main thread until the daemon next starts: correct, only more expensive. */
  | { readonly kind: 'inline' };

/**
 * After a crash: restart with back-off — 1 s, 2 s, 4 s … capped at 60 s, by the crashes inside the window
 * — or, at the fifth crash within ten minutes, give up on a worker for that session (design §3.3).
 * `crashesAtMs` includes the crash being decided.
 */
export function sessionWorkerRestart(crashesAtMs: readonly number[], nowMs: number): SessionWorkerRestart {
  const recent = crashesAtMs.filter(at => nowMs - at < SESSION_WORKER_CRASH_WINDOW_MS).length;
  if (recent >= SESSION_WORKER_CRASH_LIMIT) return { kind: 'inline' };
  return {
    kind: 'restart',
    afterMs: Math.min(SESSION_WORKER_RESTART_MS * 2 ** Math.max(recent - 1, 0), SESSION_WORKER_RESTART_CAP_MS),
  };
}
