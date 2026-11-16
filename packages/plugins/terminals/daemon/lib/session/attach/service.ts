import type { SessionAttachTarget } from '../../protocol/session-processes.ts';
import {
  hasSafeTerminalPaneIdentity,
  type RegisteredPaneObserver,
  type RegisteredTerminalPane,
  terminalPaneIdentityMatches,
} from './identity.ts';

/** The pane the tmux runner recorded for a ferret (its runner handle and identity), or nothing. */
export interface TerminalPaneRegistry {
  paneOf(sessionId: string): Promise<RegisteredTerminalPane | undefined>;
}

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

function exactRegistration(sessionId: string, found: RegisteredTerminalPane | undefined): RegisteredTerminalPane {
  // One ferret, one runner handle: the runner records exactly one pane per ferret, so there is no second
  // registration to be ambiguous with. A ferret with none was never started here, or has stopped.
  if (found === undefined)
    throw new SessionAttachError(
      'missing_registration',
      `session ${sessionId} has no pane registration owned by this daemon`,
    );
  const registration = found;
  if (!hasSafeTerminalPaneIdentity(registration))
    throw new SessionAttachError(
      'invalid_registration',
      `session ${sessionId} has a pane registration without a complete process identity`,
    );
  return registration;
}

/**
 * Resolves a short-lived attach proof from the pane the tmux runner recorded for the ferret.
 *
 * A name is never a candidate. The ferret must have its one registration, and
 * the complete pane id, pid and process-start incarnation must still match a fresh observation from
 * the daemon's private tmux server. Missing or contradictory evidence is always a refusal.
 */
export class SessionAttachService {
  constructor(
    private readonly socketPath: string,
    private readonly registry: TerminalPaneRegistry,
    private readonly observer: RegisteredPaneObserver,
  ) {}

  async resolve(sessionId: string): Promise<SessionAttachTarget> {
    if (!this.socketPath.startsWith('/') || sessionId === '')
      throw new SessionAttachError('invalid_registration', 'the daemon attach identity is incomplete');
    let registered: RegisteredTerminalPane | undefined;
    try {
      registered = await this.registry.paneOf(sessionId);
    } catch (error) {
      throw new SessionAttachError(
        'invalid_registration',
        `session ${sessionId}'s durable pane registration could not be validated: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const registration = exactRegistration(sessionId, registered);
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
