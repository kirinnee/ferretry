import { ApiErrorResponseSchema } from './common.ts';

/**
 * RIDING OUT A DAEMON RESTART — the client half of "the daemon may restart at any time"
 * (`docs/updating.md` § Ferrets keep running).
 *
 * A ferret lives in tmux, not in the daemon, so a restart does not stop it. What a restart DOES break
 * is every Ferretry call the ferret makes while the daemon is down: `fy wait`, `fy new`, `fy send`, the
 * MCP terminal and browser tools all reach a port nobody listens on. A client that is told to be
 * patient retries those for up to a minute — long enough for an update to build, swap and come back —
 * and says so once, so the agent sees one slow call instead of a failure it has to reason about.
 *
 * WHAT IS RETRIED, AND WHY THAT IS SAFE. A connection that was REFUSED never reached the daemon, so
 * sending it again is sending it once. A connection that was DROPPED mid-request may have been applied
 * before the daemon went down; it is repeated only when the caller says repeating it is harmless — a
 * read, or a request whose logical id the daemon applies once (every `FyApiClient` request carries one,
 * and the effects that matter — sends, starts, signals — are ledgered by it). Anything else (a timeout,
 * a cancellation, an HTTP answer) is never turned into a wait: the daemon answered, or the caller left.
 *
 * Pure: the clock, the sleep and the attempt itself are handed in, so the policy is tested without a
 * socket or a wall clock.
 */

/** How long one request waits for a restarting daemon, from its first failure. */
export const DAEMON_RESTART_PATIENCE_MS = 60_000;

/** The longest pause between two looks while waiting. */
const MAX_BACKOFF_MS = 2_000;
const FIRST_BACKOFF_MS = 250;

/** The pause before look `look` (0-based): 250 ms, 500 ms, 1 s, then every 2 s. */
export const daemonRestartBackoffMs = (look: number): number =>
  Math.min(MAX_BACKOFF_MS, FIRST_BACKOFF_MS * 2 ** Math.max(0, look));

/** How a request failed to reach the daemon, when it did. */
export type DaemonUnreachable = 'refused' | 'dropped';

/**
 * The error code a daemon answers every route with while it is still starting — a 503 from a daemon
 * that has bound its address but not yet mounted its routes. It ran nothing.
 */
export const DAEMON_STARTING_CODE = 'daemon_starting';

/** The code a client's {@link DaemonStartingError} carries, so the restart wait reads it as refused. */
const DAEMON_STARTING_ERROR = 'DaemonStarting';

/**
 * A daemon answered that it is still starting.
 *
 * A REFUSAL FOR EVERY PURPOSE THAT MATTERS: the daemon ran no route, so sending the request again is as
 * safe as after a refused connection — which is exactly what this same moment was before the daemon
 * bound its address first. A client that waits out restarts therefore waits this out too, and one that
 * does not says the daemon's own sentence (which names the boot step) instead of a bare 503.
 */
export class DaemonStartingError extends Error {
  readonly code = DAEMON_STARTING_ERROR;

  constructor(message: string) {
    super(message);
    this.name = 'DaemonStartingError';
  }
}

/**
 * The daemon's "still starting" answer as the {@link DaemonStartingError} it is; `undefined` for any
 * other response, which is left unread.
 *
 * EVERY CLIENT THAT WAITS OUT A RESTART READS ITS ANSWERS THROUGH THIS. A restarted daemon binds its
 * address before it mounts its routes, so the first thing a waiting client meets after the refused
 * connections is this 503 — and a client that took it for an answer would end its wait one boot step
 * short and hand the caller "ask again shortly" as a failure. The MCP tools did exactly that.
 */
export async function daemonStartingOf(response: Response): Promise<DaemonStartingError | undefined> {
  if (response.status !== 503) return undefined;
  const body = ApiErrorResponseSchema.safeParse(
    await response
      .clone()
      .json()
      .catch(() => undefined),
  );
  return body.success && body.data.code === DAEMON_STARTING_CODE ? new DaemonStartingError(body.data.error) : undefined;
}

const REFUSED_CODES: ReadonlySet<string> = new Set([
  DAEMON_STARTING_ERROR,
  // Bun's fetch.
  'ConnectionRefused',
  'FailedToOpenSocket',
  // Node's, and a Unix socket that is not there yet.
  'ECONNREFUSED',
  'ENOENT',
]);

const DROPPED_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ConnectionClosed',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
]);

const codeOf = (error: unknown): unknown => {
  if (typeof error !== 'object' || error === null) return undefined;
  const own = (error as { code?: unknown }).code;
  if (own !== undefined) return own;
  return codeOf((error as { cause?: unknown }).cause);
};

/**
 * Whether a transport error is the daemon being away, and which way. `undefined` for everything else
 * — a browser's `TypeError: Failed to fetch` included, which says nothing about why and is never
 * waited on.
 */
export function classifyDaemonUnreachable(error: unknown): DaemonUnreachable | undefined {
  const code = codeOf(error);
  if (typeof code !== 'string') return undefined;
  if (REFUSED_CODES.has(code)) return 'refused';
  if (DROPPED_CODES.has(code)) return 'dropped';
  return undefined;
}

/**
 * Whether, and how, a client waits for a restarting daemon. The composition root decides; the PWA
 * passes none, because a browser shows its own "reconnecting" and a person can press again.
 */
export interface DaemonRestartPatience {
  /**
   * Whether a daemon that cannot be reached is worth waiting for at all. A ferret's call always is —
   * a ferret only exists because a daemon ran it — and a person's only while a restart is known to be
   * underway, so `fy list` against a stopped daemon still fails at once.
   */
  expected(): boolean | Promise<boolean>;
  /** Told each time a request starts waiting. Saying it once per process is the caller's business. */
  waiting(): void;
  /** Defaults to {@link DAEMON_RESTART_PATIENCE_MS}. */
  readonly windowMs?: number;
}

/** What one attempt came to, as the waiting loop needs it. */
export type DaemonAttempt<T> =
  | { readonly kind: 'answered'; readonly value: T }
  | { readonly kind: 'unreachable'; readonly how: DaemonUnreachable; readonly error: unknown }
  | { readonly kind: 'failed'; readonly error: unknown };

export interface DaemonRestartWait<T> {
  /** One attempt. Never throws: every failure is a `DaemonAttempt`. */
  readonly attempt: () => Promise<DaemonAttempt<T>>;
  /** The attempt that already failed, which is what decides whether to wait. */
  readonly first: DaemonAttempt<T>;
  /** Whether a DROPPED request may be sent again. A refused one always may. */
  readonly repeatable: boolean;
  readonly patience: DaemonRestartPatience | undefined;
  readonly nowMs: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  /** A caller that leaves ends the wait at the next look. */
  readonly signal?: AbortSignal | undefined;
}

const waitable = <T>(outcome: DaemonAttempt<T>, repeatable: boolean): boolean =>
  outcome.kind === 'unreachable' && (outcome.how === 'refused' || repeatable);

/**
 * Attempts again, with backoff, while the daemon is away and patience allows; answers the last outcome.
 * A first outcome that is not worth waiting on is answered as it is, without asking `expected()`.
 */
export async function waitOutDaemonRestart<T>(wait: DaemonRestartWait<T>): Promise<DaemonAttempt<T>> {
  let outcome = wait.first;
  const patience = wait.patience;
  if (patience === undefined || !waitable(outcome, wait.repeatable)) return outcome;
  if (!(await patience.expected())) return outcome;
  const until = wait.nowMs() + (patience.windowMs ?? DAEMON_RESTART_PATIENCE_MS);
  // A function, not a read: the signal can abort while this awaits, which narrowing cannot see.
  const left = (): boolean => wait.signal?.aborted === true;
  patience.waiting();
  for (let look = 0; waitable(outcome, wait.repeatable); look += 1) {
    const remaining = until - wait.nowMs();
    if (remaining <= 0 || left()) break;
    await wait.sleep(Math.min(daemonRestartBackoffMs(look), remaining));
    if (left()) break;
    outcome = await wait.attempt();
  }
  return outcome;
}
