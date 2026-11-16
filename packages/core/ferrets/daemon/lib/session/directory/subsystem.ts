import type { SessionView } from '../../protocol/session.ts';

// Today's daemon/src/lib/runtime/mounts/sessions.ts domain half: the session reads the session code depends on.
/** Why one session could not be read. */
export type SessionReadFailure =
  /** The id is not one the state-home layout would accept, so it must never become a path. */
  | 'invalid'
  /** The documents exist and the protocol schema refused them. */
  | 'unusable';

/** A refusal raised by the composition root's reader, in a taxonomy `src/lib` may name. */
export class SessionReadError extends Error {
  constructor(
    readonly failure: SessionReadFailure,
    message: string,
  ) {
    super(message);
    this.name = 'SessionReadError';
  }
}

/**
 * The authoritative session set, as these routes need it.
 *
 * `list` returns only the sessions whose documents parsed; `get` distinguishes "no such session"
 * (`undefined`) from "the documents would not parse" (a `SessionReadError`), because collapsing the
 * second into the first would report a session the index holds as one that never existed.
 */
export interface SessionDirectorySubsystem {
  list(): Promise<readonly SessionView[]>;
  get(sessionId: string): Promise<SessionView | undefined>;
}
