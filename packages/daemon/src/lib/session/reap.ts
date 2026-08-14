/**
 * The decision boundary for reaping managed tmux panes.
 *
 * This deliberately knows nothing about listing tmux or killing processes. A caller has to hand
 * it durable registrations, durable session state, and an exact fresh observation; when any fact
 * is absent or disagrees it produces no target. A reused pane id is not our pane unless its process
 * incarnation agrees too.
 */

export type ReapTerminalStatus = 'completed' | 'failed' | 'stalled' | 'stopped' | 'kill_failed';

export interface RegisteredTerminalPane {
  readonly daemonId: string;
  readonly sessionId: string;
  readonly tmuxSession: string;
  readonly paneId: string;
  readonly pid: number;
  /** Linux `/proc/<pid>/stat` start ticks, which distinguish a reused PID. */
  readonly processStartTicks: number;
}

export interface DurableTerminalSession {
  readonly daemonId: string;
  readonly sessionId: string;
  readonly status: ReapTerminalStatus | string;
  /** A terminal status without this persisted instant is incomplete evidence. */
  readonly finishedAt?: string;
}

export interface ObservedTerminalPane {
  readonly tmuxSession: string;
  readonly paneId: string;
  readonly pid: number;
  readonly processStartTicks: number;
}

export type TerminalReapTarget = RegisteredTerminalPane;

export interface TerminalReapPlan {
  readonly targets: readonly TerminalReapTarget[];
}

const TERMINAL_STATUSES: ReadonlySet<ReapTerminalStatus> = new Set([
  'completed',
  'failed',
  'stalled',
  'stopped',
  'kill_failed',
]);

function sessionKey(daemonId: string, sessionId: string): string {
  return `${daemonId}\n${sessionId}`;
}

function paneKey(pane: Pick<RegisteredTerminalPane, 'tmuxSession' | 'paneId' | 'pid' | 'processStartTicks'>): string {
  return `${pane.tmuxSession}\n${pane.paneId}\n${pane.pid}\n${pane.processStartTicks}`;
}

export function hasSafeTerminalPaneIdentity(pane: ObservedTerminalPane | RegisteredTerminalPane): boolean {
  return (
    pane.tmuxSession.length > 0 &&
    /^%(?:0|[1-9][0-9]*)$/u.test(pane.paneId) &&
    Number.isSafeInteger(pane.pid) &&
    pane.pid > 1 &&
    Number.isSafeInteger(pane.processStartTicks) &&
    pane.processStartTicks > 0
  );
}

/** Whether a fresh observation still names the complete process incarnation that was registered. */
export function terminalPaneIdentityMatches(
  registration: RegisteredTerminalPane,
  observation: ObservedTerminalPane,
): boolean {
  return (
    hasSafeTerminalPaneIdentity(registration) &&
    hasSafeTerminalPaneIdentity(observation) &&
    registration.tmuxSession === observation.tmuxSession &&
    registration.paneId === observation.paneId &&
    registration.pid === observation.pid &&
    registration.processStartTicks === observation.processStartTicks
  );
}

/**
 * Whether this daemon's own documents PROVE the session is over.
 *
 * Exported because the reap is no longer the only reader: the resource-limit surface asks the same
 * question to decide which registered panes are still live enough to reconfigure, and a second copy
 * of the terminal-status set is exactly how two subsystems come to disagree about whether a session
 * has finished. Absent or unrecognised evidence answers `false` in both callers, which is the
 * conservative direction for each: the reap declines to kill, and the limits surface declines to
 * pass over a pane it cannot prove is gone.
 */
export function hasDurableTerminalEvidence(session: DurableTerminalSession): boolean {
  if (!TERMINAL_STATUSES.has(session.status as ReapTerminalStatus) || session.finishedAt === undefined) return false;
  return Number.isFinite(Date.parse(session.finishedAt));
}

/**
 * Selects only panes registered to this exact daemon and still proving the exact process
 * incarnation the daemon registered. Inputs are intentionally maps rather than tmux lists: a
 * reaper never discovers targets by pattern matching names.
 */
export function planTerminalReap(input: {
  readonly daemonId: string;
  readonly registrations: readonly RegisteredTerminalPane[];
  readonly sessions: readonly DurableTerminalSession[];
  readonly observations: readonly ObservedTerminalPane[];
}): TerminalReapPlan {
  if (input.daemonId.length === 0) return { targets: [] };

  const sessions = new Map<string, DurableTerminalSession>();
  const ambiguousSessions = new Set<string>();
  for (const session of input.sessions) {
    if (session.daemonId !== input.daemonId || session.sessionId.length === 0) continue;
    const key = sessionKey(session.daemonId, session.sessionId);
    if (sessions.has(key)) {
      sessions.delete(key);
      ambiguousSessions.add(key);
    } else if (!ambiguousSessions.has(key)) sessions.set(key, session);
  }

  const observations = new Map<string, ObservedTerminalPane>();
  const ambiguousObservations = new Set<string>();
  for (const observation of input.observations) {
    if (!hasSafeTerminalPaneIdentity(observation)) continue;
    const key = paneKey(observation);
    if (observations.has(key)) {
      observations.delete(key);
      ambiguousObservations.add(key);
    } else if (!ambiguousObservations.has(key)) observations.set(key, observation);
  }

  const registrations = new Map<string, RegisteredTerminalPane>();
  const ambiguousRegistrations = new Set<string>();
  for (const registration of input.registrations) {
    if (
      registration.daemonId !== input.daemonId ||
      registration.sessionId.length === 0 ||
      !hasSafeTerminalPaneIdentity(registration)
    )
      continue;
    const key = paneKey(registration);
    if (registrations.has(key)) {
      registrations.delete(key);
      ambiguousRegistrations.add(key);
    } else if (!ambiguousRegistrations.has(key)) registrations.set(key, registration);
  }

  const targets: TerminalReapTarget[] = [];
  for (const registration of registrations.values()) {
    const session = sessions.get(sessionKey(registration.daemonId, registration.sessionId));
    if (session === undefined || !hasDurableTerminalEvidence(session)) continue;
    if (!observations.has(paneKey(registration))) continue;
    targets.push(registration);
  }
  return { targets };
}
