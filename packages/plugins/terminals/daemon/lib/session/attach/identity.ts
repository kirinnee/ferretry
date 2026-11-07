/**
 * A ferret's pane, as the tmux runner recorded it when it started or attached the pane (today's
 * `RegisteredTerminalPane` from `lib/session/reap.ts`): the private server's session, the pane id, its pid and the
 * pid's start, which tells a reused pid apart.
 */
export interface RegisteredTerminalPane {
  readonly tmuxSession: string;
  readonly paneId: string;
  readonly pid: number;
  /** `ProcessIncarnation`'s start value (Linux `/proc/<pid>/stat` start ticks, macOS epoch seconds). */
  readonly processStartTicks: number;
}

/** The same pane, as a fresh look at the private tmux server finds it now. */
export interface ObservedTerminalPane {
  readonly tmuxSession: string;
  readonly paneId: string;
  readonly pid: number;
  readonly processStartTicks: number;
}

/** Reads only a pane the runner itself recorded; answers `undefined` when it is not live. */
export interface RegisteredPaneObserver {
  observe(registration: RegisteredTerminalPane): Promise<ObservedTerminalPane | undefined>;
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
