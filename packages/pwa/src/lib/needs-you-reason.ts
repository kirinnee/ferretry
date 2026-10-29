/**
 * HOW TO CLEAR A "NEEDS YOU" ROW FROM THE ROW.
 *
 * Needs you is exactly the sessions with open Attention items (`state.attention`), so a row's reason is
 * always one of three: its items are on the deck (Done / Dismiss them), their board is still being read, or
 * the machine reports an open item it cannot list (an older daemon). Every case carries an action that
 * leaves the row, so none can be stuck. A pending question or permission arrives as a real Attention item.
 *
 * Pure and total: facts in, one reason out.
 */

import type { SessionView } from '@ferretry/protocol';
import type { InboxCard } from './attention-inbox.ts';
import type { DaemonId } from './daemon-connection.ts';
import { daemonSessionPath } from './pages/routes.ts';

export type NeedsYouReason =
  | { readonly kind: 'attention'; readonly card: InboxCard; readonly more: number }
  | { readonly kind: 'reading' }
  | { readonly kind: 'stale' };

/**
 * `cards` is the inbox deck for this session. `reading` is true while its board is still being read: the
 * summary says open and the items are not here yet, so the row says it is reading, not "needs an update".
 */
export const needsYouReason = (cards: readonly InboxCard[], reading: boolean): NeedsYouReason => {
  const [first, ...rest] = cards;
  if (first !== undefined) return { kind: 'attention', card: first, more: rest.length };
  return reading ? { kind: 'reading' } : { kind: 'stale' };
};

export const NEEDS_YOU_SENTENCE: Readonly<Record<NeedsYouReason['kind'], string>> = {
  attention: 'A ferret asked for you',
  reading: 'Reading what it asked…',
  stale: 'This machine needs an update — it reports an item it cannot list',
};

/** The one thing a button on the row does. */
export type NeedsYouAction =
  | { readonly kind: 'done' | 'dismiss'; readonly label: string; readonly card: InboxCard }
  | { readonly kind: 'open'; readonly label: string; readonly to: string }
  | { readonly kind: 'hide'; readonly label: string };

/** Never empty: every reason can be left. */
export const needsYouActions = (
  reason: NeedsYouReason,
  daemonId: DaemonId,
  view: SessionView,
): readonly NeedsYouAction[] => {
  const open: NeedsYouAction = { kind: 'open', label: 'Open', to: daemonSessionPath(daemonId, view.config.id) };
  switch (reason.kind) {
    case 'attention':
      return [
        { kind: 'done', label: 'Done', card: reason.card },
        { kind: 'dismiss', label: 'Dismiss', card: reason.card },
      ];
    case 'stale':
      return [open, { kind: 'hide', label: 'Hide' }];
    case 'reading':
      return [open];
  }
};

/** The key a hidden stale row is remembered by: the session and the summary it hid. */
export const staleRowKey = (daemonId: DaemonId, view: SessionView): string =>
  JSON.stringify([daemonId, view.config.id, view.state.attention?.latestAt ?? '']);
