import type { SessionAttachTarget } from '@ferretry/protocol';
import { hasSafeTerminalPaneIdentity, type RegisteredTerminalPane, terminalPaneIdentityMatches } from '../reap.ts';
import type { RegisteredPaneObserver, TerminalPaneRegistry } from '../reap-service.ts';

/** Every fail-closed reason an attach target can be withheld. */
export type SessionAttachFailure =
  | 'missing_registration'
  | 'ambiguous_registration'
  | 'invalid_registration'
  | 'pane_unavailable'
  | 'identity_mismatch';

export class SessionAttachError extends Error {
  constructor(
    readonly failure: SessionAttachFailure,
    message: string,
  ) {
    super(message);
    this.name = 'SessionAttachError';
  }
}

function exactRegistration(
  daemonId: string,
  sessionId: string,
  registrations: readonly RegisteredTerminalPane[],
): RegisteredTerminalPane {
  const matches = registrations.filter(
    registration => registration.daemonId === daemonId && registration.sessionId === sessionId,
  );
  if (matches.length === 0)
    throw new SessionAttachError(
      'missing_registration',
      `session ${sessionId} has no pane registration owned by this daemon`,
    );
  if (matches.length !== 1)
    throw new SessionAttachError(
      'ambiguous_registration',
      `session ${sessionId} has ${matches.length} pane registrations owned by this daemon`,
    );
  // The two cardinality refusals above prove this indexed access; the assertion only teaches
  // TypeScript that array bounds did not change between those checks and this read.
  const registration = matches[0] as RegisteredTerminalPane;
  if (!hasSafeTerminalPaneIdentity(registration))
    throw new SessionAttachError(
      'invalid_registration',
      `session ${sessionId} has a pane registration without a complete process identity`,
    );
  return registration;
}

/**
 * Resolves a short-lived attach proof from one daemon's durable pane registry.
 *
 * A name is never a candidate. The session must have exactly one registration for this daemon, and
 * the complete pane id, pid and process-start incarnation must still match a fresh observation from
 * the daemon's private tmux server. Missing or contradictory evidence is always a refusal.
 */
export class SessionAttachService {
  constructor(
    private readonly daemonId: string,
    private readonly socketPath: string,
    private readonly registry: TerminalPaneRegistry,
    private readonly observer: RegisteredPaneObserver,
  ) {}

  async resolve(sessionId: string): Promise<SessionAttachTarget> {
    if (this.daemonId === '' || !this.socketPath.startsWith('/') || sessionId === '')
      throw new SessionAttachError('invalid_registration', 'the daemon attach identity is incomplete');
    let registrations: readonly RegisteredTerminalPane[];
    try {
      registrations = await this.registry.list(this.daemonId);
    } catch (error) {
      throw new SessionAttachError(
        'invalid_registration',
        `session ${sessionId}'s durable pane registration could not be validated: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const registration = exactRegistration(this.daemonId, sessionId, registrations);
    const observed = await this.observer.observe(registration);
    if (observed === undefined)
      throw new SessionAttachError(
        'pane_unavailable',
        `session ${sessionId}'s registered pane is not live on this daemon`,
      );
    if (!terminalPaneIdentityMatches(registration, observed))
      throw new SessionAttachError(
        'identity_mismatch',
        `session ${sessionId}'s live pane no longer matches its durable registration`,
      );
    return {
      socketPath: this.socketPath,
      tmuxSession: registration.tmuxSession,
      paneId: registration.paneId,
      pid: registration.pid,
      processStartTicks: registration.processStartTicks,
    };
  }
}
