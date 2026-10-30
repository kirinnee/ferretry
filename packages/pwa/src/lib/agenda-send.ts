/**
 * ONE place that turns an owner's action into the request the daemon is asked for. The chat and the Inbox both
 * send answers; each kind of `InboxAction` is exactly one request through the ONE agenda client.
 */

import type { AgendaId } from '@ferretry/protocol';
import type { InboxAction } from './agenda-answers.ts';
import type { DaemonAgendaClient } from './agenda-client.ts';
import type { DaemonConnection } from './daemon-connection.ts';
import type { DaemonSessionScope } from './daemon-scope.ts';

/** The agenda client's answering methods, and nothing else of it. */
export type AgendaSender = Pick<
  DaemonAgendaClient,
  'dismiss' | 'respond' | 'resolve' | 'needsInfo' | 'discuss' | 'snooze' | 'unsnooze'
>;

/** Sends one action for one item, to the session on the machine `connection` reaches. */
export const sendAgendaAction = async (
  client: AgendaSender,
  connection: DaemonConnection,
  scope: DaemonSessionScope,
  id: AgendaId,
  action: InboxAction,
): Promise<void> => {
  if (action.kind === 'respond') await client.respond(connection, scope, id, action.response, action.note);
  else if (action.kind === 'dismiss') await client.dismiss(connection, scope, id, action.note);
  else if (action.kind === 'needs-info') await client.needsInfo(connection, scope, id, action.note);
  else if (action.kind === 'discuss') await client.discuss(connection, scope, id, action.note);
  else if (action.kind === 'snooze') await client.snooze(connection, scope, id, action.until);
  else if (action.kind === 'unsnooze') await client.unsnooze(connection, scope, id);
  else await client.resolve(connection, scope, id, action.note);
};
