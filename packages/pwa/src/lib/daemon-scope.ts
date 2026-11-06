import type { AgendaId } from '@ferretry/protocol';
import type { DaemonConnection, DaemonId } from './daemon-connection.ts';

export interface DaemonSessionScope {
  readonly daemonId: DaemonId;
  readonly sessionId: string;
  /**
   * The DRAFT SLOT inside the session: the agenda item whose own composer this is (an Inbox card). Absent is
   * the session's chat — the draft every composer had before slots existed, which is why its key, its stored
   * drafts and its daemon route are exactly what they were.
   */
  readonly item?: AgendaId;
}

const requireSessionId = (value: string): string => {
  if (value.trim() === '') throw new Error('sessionId must not be empty');
  return value;
};

/** Creates the required `(daemonId, sessionId)` identity for UI state; `item` names an Inbox card's own draft slot. */
export const daemonSessionScope = (
  daemon: Pick<DaemonConnection, 'daemonId'>,
  sessionId: string,
  item?: AgendaId,
): DaemonSessionScope => ({
  daemonId: daemon.daemonId,
  sessionId: requireSessionId(sessionId),
  ...(item === undefined ? {} : { item }),
});

/**
 * A collision-safe key for persisted or in-memory session state. The chat's key is the two-part one it always
 * was, so drafts stored before slots read as the chat; an item slot adds a third part.
 */
export const daemonSessionKey = (scope: DaemonSessionScope): string =>
  JSON.stringify(
    scope.item === undefined ? [scope.daemonId, scope.sessionId] : [scope.daemonId, scope.sessionId, scope.item],
  );
