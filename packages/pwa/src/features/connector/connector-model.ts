/**
 * The words and pure rules of the Connectors panel. Nothing here touches a network or the DOM.
 *
 * Every sentence that a person may act on is written once, here, so a test can pin it and the panel cannot
 * word the same warning two ways.
 */

import { FyHttpError } from '@ferretry/protocol/client';
import type { ConnectorGrant, ConnectorPending, ConnectorScope } from './connector-api.ts';

/** How often the panel re-reads while it is open: a sign-in lives ten minutes and the person is waiting on it. */
export const CONNECTOR_POLL_MS = 2000;

/** The query word of the deep link the daemon's waiting page opens: `/?connector=<daemonId>`. */
export const CONNECTOR_LINK_PARAM = 'connector';

/** The panel id on the machine's Machine tab. */
export const CONNECTOR_PANEL = 'connector';

export const MATCH_CODE_WARNING = 'Only approve if this code is on the page you just opened from Claude.';

export const NOT_ENABLED_NOTE =
  'The connector is off. It can only be turned on at the machine, in its config/daemon.json — a phone cannot do it. See docs/mcp-connector.md.';

/** What a scope lets the app do, in the words a person decides by. */
export const SCOPE_WORDS: Readonly<Record<ConnectorScope, string>> = {
  'fleet:read': 'read your fleet',
  'fleet:write': 'control your ferrets',
};

/** "read your fleet and control your ferrets". */
export const scopeSentence = (scopes: readonly ConnectorScope[]): string => {
  const words = scopes.map(scope => SCOPE_WORDS[scope]);
  return words.length === 0
    ? 'do nothing'
    : new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(words);
};

export const pendingHeadline = (pending: ConnectorPending): string =>
  `${pending.clientName} wants to ${scopeSentence(pending.scopes)}`;

/** The one-line summary for the banner: how many are waiting, on which machine. */
export const bannerSentence = (count: number, machine: string): string =>
  count === 1
    ? `Claude wants to connect to ${machine}.`
    : `${String(count)} Claude sign-ins are waiting on ${machine}.`;

/** Who approved a grant, as words: `device:<id>` is a paired device, `admin-cli` is somebody at the machine. */
export const approvedByWords = (approvedBy: string): string =>
  approvedBy === 'admin-cli' ? 'at the machine' : approvedBy.startsWith('device:') ? 'a paired device' : approvedBy;

export const revokeConsequence = (grant: ConnectorGrant): string =>
  `${grant.clientName} stops working on its very next call. To use it again it has to sign in and be approved again.`;

/** Live grants first (newest first), revoked ones kept after, so "who has access now" is the top of the list. */
export const orderedGrants = (grants: readonly ConnectorGrant[]): readonly ConnectorGrant[] =>
  grants.toSorted((left, right) => {
    const liveLeft = left.revokedAt === undefined ? 0 : 1;
    const liveRight = right.revokedAt === undefined ? 0 : 1;
    return liveLeft - liveRight || Date.parse(right.createdAt) - Date.parse(left.createdAt);
  });

const REFUSALS: Readonly<Record<string, string>> = {
  grant_step_up_required: 'Nothing was changed: the passkey wasn’t confirmed. Try again and confirm it.',
  not_found: 'That sign-in is not waiting any more. Ask Claude to connect again if you still want it.',
  expired: 'That sign-in ran out of time. Ask Claude to connect again.',
  already_decided: 'That sign-in was already answered.',
};

/** One sentence for a refused or failed act; never a status, a stack or an error name. */
export const actFailureSentence = (error: unknown): string => {
  if (error instanceof FyHttpError) {
    const known = error.code === undefined ? undefined : REFUSALS[error.code];
    if (known !== undefined) return known;
    if (error.status === 403) return 'This machine did not allow that from this device.';
  }
  return 'This machine did not answer. Try again in a moment.';
};

/** Reads the target out of `?connector=<daemonId>`, or `null`. */
export const connectorTargetFromSearch = (search: string): string | null => {
  const value = new URLSearchParams(search).get(CONNECTOR_LINK_PARAM);
  return value === null || value === '' || value.length > 200 ? null : value;
};
