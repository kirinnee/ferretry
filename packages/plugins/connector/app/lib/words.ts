/**
 * THE WORDS AND PURE RULES of Settings › Claude connector. Nothing here touches the network or the DOM.
 *
 * Every sentence a person acts on is written once, here, so a test can pin it and the tab cannot word the same warning
 * two ways. Short, plain, one idea each (the owner reads on a phone, tired).
 */
import { isStepUpRefusal } from '@ferretry/app/ui';
import { CONNECTOR_REFUSAL_CODES, type ConnectorGrantView, type ConnectorScope } from '../../contract/index.ts';

/** How often the tab reads again while it is on screen: a sign-in lives ten minutes and the owner is waiting on a page that refreshes itself. */
export const CONNECTOR_POLL_MS = 2_000;

export const SWITCH_NAME = 'Let Claude connect';
export const SWITCH_HINT_OFF = 'Off. Nothing on this machine answers Claude.';
export const SWITCH_HINT_ON = 'On. You still approve each Claude sign-in with your passkey.';
/** The warning that is the phishing defence: said in the same breath as the code and the Approve button, never behind a disclosure. */
export const MATCH_CODE_WARNING = 'Only approve if this code is on the page you just opened from Claude.';
export const NO_PENDING = 'No sign-in is waiting. When Claude asks to connect, it shows up here with a match code.';
export const NO_GRANTS = 'Nothing is connected.';
export const ADDRESS_HELP = 'Add this address in Claude as a custom connector (Settings › Connectors).';
/** A machine that does not have the connector yet: the app ships before the daemon (architecture, "The app ships before the daemon"). */
export const NEEDS_UPDATE = 'This machine needs an update to use the Claude connector.';
export const LOAD_FAILURE =
  'This machine did not answer the list of connected apps. It will be tried again in a moment.';

/** Where the address Claude is given comes from, and the one thing to know about it. */
export const addressSourceWords = (source: 'configured' | 'tunnel' | undefined): string | null =>
  source === 'tunnel'
    ? 'This address is this machine’s built-in tunnel. If its hostname changes, Claude must be reconnected.'
    : source === 'configured'
      ? 'This address is set in config/connector.yaml, which always wins over the built-in tunnel.'
      : null;

/** What a scope lets the app do, in the words a person decides by. */
const SCOPE_WORDS: Readonly<Record<ConnectorScope, string>> = {
  'fleet:read': 'read your fleet',
  'fleet:write': 'control your ferrets',
};

/** "read your fleet and control your ferrets". */
export const scopeSentence = (scopes: readonly ConnectorScope[]): string =>
  scopes.length === 0
    ? 'do nothing'
    : new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(scopes.map(scope => SCOPE_WORDS[scope]));

/** Who approved a grant, as a whole phrase: a paired device, or somebody at the machine. */
export const approvedByWords = (approvedBy: string): string =>
  approvedBy === 'admin-cli'
    ? 'Approved at the machine'
    : approvedBy.startsWith('device:')
      ? 'Approved by a paired device'
      : `Approved by ${approvedBy}`;

export const revokeConsequence = (grant: ConnectorGrantView): string =>
  `${grant.clientName} stops working on its very next call. To use it again it has to sign in and be approved again.`;

/** Live grants first (newest first), revoked ones kept after, so "who has access now" is the top of the list. */
export const orderedGrants = (grants: readonly ConnectorGrantView[]): readonly ConnectorGrantView[] =>
  grants.toSorted((left, right) => {
    const liveLeft = left.revokedAt === undefined ? 0 : 1;
    const liveRight = right.revokedAt === undefined ? 0 : 1;
    return liveLeft - liveRight || Date.parse(right.createdAt) - Date.parse(left.createdAt);
  });

const plural = (count: number, unit: string): string => `${String(count)} ${unit}${count === 1 ? '' : 's'} ago`;

/** How long ago, in words ("just now", "5 minutes ago", "yesterday"). A time ahead of this clock reads as "just now". */
export const agoWords = (at: string, nowMs: number): string => {
  const instant = Date.parse(at);
  if (!Number.isFinite(instant)) return 'at an unknown time';
  const seconds = Math.max(0, Math.round((nowMs - instant) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return plural(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 24) return plural(hours, 'hour');
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : plural(days, 'day');
};

const REFUSALS: Readonly<Record<string, string>> = {
  [CONNECTOR_REFUSAL_CODES.notFound]:
    'That sign-in is not waiting any more. Ask Claude to connect again if you still want it.',
  [CONNECTOR_REFUSAL_CODES.expired]: 'That sign-in ran out of time. Ask Claude to connect again.',
  [CONNECTOR_REFUSAL_CODES.alreadyDecided]: 'That sign-in was already answered.',
  [CONNECTOR_REFUSAL_CODES.disabled]: 'The connector is off. Switch it on first.',
};

interface Refusal {
  readonly status: number;
  readonly code: string;
  readonly message?: unknown;
}

const refusalOf = (error: unknown): Refusal | null =>
  typeof error === 'object' &&
  error !== null &&
  'status' in error &&
  typeof error.status === 'number' &&
  'code' in error &&
  typeof error.code === 'string'
    ? (error as Refusal)
    : null;

/** Whether the daemon has no such route: a machine older than this app (a 404 `unknown_route`, or its plugin missing). */
export const isOutdatedMachine = (error: unknown): boolean => {
  const refusal = refusalOf(error);
  return refusal !== null && refusal.status === 404 && refusal.code === 'unknown_route';
};

/** One sentence for a refused or failed act: the daemon's own words when it gave them, never a status, a stack or an error name. */
export const actFailureSentence = (error: unknown): string => {
  if (isStepUpRefusal(error)) return 'Nothing was changed: the passkey wasn’t confirmed. Try again and confirm it.';
  const refusal = refusalOf(error);
  if (refusal !== null) {
    const known = REFUSALS[refusal.code];
    if (known !== undefined) return known;
    const said = typeof refusal.message === 'string' ? refusal.message.trim() : '';
    if (said !== '') return said;
    if (refusal.status === 403) return 'This machine did not allow that from this device.';
  }
  return 'This machine did not answer. Check it is awake and try again.';
};

/** The sign-in the waiting page's link names (`?request=cr_…`, a PUBLIC id), or `null`. */
export const requestFromSearch = (search: string): string | null => {
  const value = new URLSearchParams(search).get('request');
  return value !== null && /^cr_[a-z0-9]{10}$/u.test(value) ? value : null;
};
