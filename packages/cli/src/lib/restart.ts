/**
 * RIDING OUT A DAEMON RESTART: the client half of "the daemon may restart at any time". A ferret lives in tmux, so a
 * restart does not stop it, but it breaks every call it makes while the daemon is down. A client told to be patient
 * retries for up to a minute. A REFUSED connection never reached the daemon, so sending again is sending once; a
 * DROPPED one is repeated only when the caller says repeating is harmless (a read). An HTTP answer is never waited on.
 * Copied from today's `daemon-restart.ts`. Pure: clock, sleep and attempt are handed in.
 */

export const DAEMON_RESTART_PATIENCE_MS = 60_000;
const MAX_BACKOFF_MS = 2_000;
const FIRST_BACKOFF_MS = 250;

/** The pause before look `look` (0-based): 250 ms, 500 ms, 1 s, then every 2 s. */
export const restartBackoffMs = (look: number): number =>
  Math.min(MAX_BACKOFF_MS, FIRST_BACKOFF_MS * 2 ** Math.max(0, look));

export type Unreachable = 'refused' | 'dropped';

/** The code a daemon answers every route with (503) while it has bound its address but not mounted its routes. */
export const DAEMON_STARTING_CODE = 'daemon_starting';
const STARTING_ERROR = 'DaemonStarting';

export class DaemonStartingError extends Error {
  readonly code = STARTING_ERROR;
  constructor(message: string) {
    super(message);
    this.name = 'DaemonStartingError';
  }
}

/** The "still starting" answer as an error; `undefined` for any other response, which is left unread. */
export async function daemonStartingOf(response: Response): Promise<DaemonStartingError | undefined> {
  if (response.status !== 503) return undefined;
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => undefined);
  if (typeof body !== 'object' || body === null) return undefined;
  const { code, error } = body as { code?: unknown; error?: unknown };
  return code === DAEMON_STARTING_CODE ? new DaemonStartingError(typeof error === 'string' ? error : 'starting') : undefined;
}

const REFUSED_CODES: ReadonlySet<string> = new Set([
  STARTING_ERROR,
  'ConnectionRefused',
  'FailedToOpenSocket',
  'ECONNREFUSED',
  'ENOENT',
]);
const DROPPED_CODES: ReadonlySet<string> = new Set(['ECONNRESET', 'ConnectionClosed', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED']);

const codeOf = (error: unknown): unknown => {
  if (typeof error !== 'object' || error === null) return undefined;
  const own = (error as { code?: unknown }).code;
  return own !== undefined ? own : codeOf((error as { cause?: unknown }).cause);
};

/** Whether a transport error is the daemon being away, and which way. Everything else (a timeout, an abort) is not. */
export function classifyUnreachable(error: unknown): Unreachable | undefined {
  const code = codeOf(error);
  if (typeof code !== 'string') return undefined;
  if (REFUSED_CODES.has(code)) return 'refused';
  if (DROPPED_CODES.has(code)) return 'dropped';
  return undefined;
}

export interface RestartPatience {
  /** Whether a daemon that cannot be reached is worth waiting for. A ferret's call always is. */
  expected(): boolean | Promise<boolean>;
  /** Told each time a request starts waiting; saying it once per process is the caller's business. */
  waiting(): void;
  readonly windowMs?: number;
}

export type Attempt<T> =
  | { readonly kind: 'answered'; readonly value: T }
  | { readonly kind: 'unreachable'; readonly how: Unreachable; readonly error: unknown }
  | { readonly kind: 'failed'; readonly error: unknown };

export interface RestartWait<T> {
  readonly attempt: () => Promise<Attempt<T>>;
  readonly first: Attempt<T>;
  readonly repeatable: boolean;
  readonly patience: RestartPatience | undefined;
  readonly nowMs: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly signal?: AbortSignal | undefined;
}

const waitable = <T>(outcome: Attempt<T>, repeatable: boolean): boolean =>
  outcome.kind === 'unreachable' && (outcome.how === 'refused' || repeatable);

/** Attempts again, with backoff, while the daemon is away and patience allows; answers the last outcome. */
export async function waitOutRestart<T>(wait: RestartWait<T>): Promise<Attempt<T>> {
  let outcome = wait.first;
  const patience = wait.patience;
  if (patience === undefined || !waitable(outcome, wait.repeatable)) return outcome;
  if (!(await patience.expected())) return outcome;
  const until = wait.nowMs() + (patience.windowMs ?? DAEMON_RESTART_PATIENCE_MS);
  const left = (): boolean => wait.signal?.aborted === true;
  patience.waiting();
  for (let look = 0; waitable(outcome, wait.repeatable); look += 1) {
    const remaining = until - wait.nowMs();
    if (remaining <= 0 || left()) break;
    await wait.sleep(Math.min(restartBackoffMs(look), remaining));
    if (left()) break;
    outcome = await wait.attempt();
  }
  return outcome;
}
