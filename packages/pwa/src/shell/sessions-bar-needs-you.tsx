/**
 * THE "NEEDS YOU" GROUP at the top of the sessions bar: every session with open Attention, newest
 * `latestAt` first. One machine's list passes its own sessions; the all-machines list also passes the
 * parked-on-a-person ones after them, each naming its machine (nothing around a pinned row does).
 * A row appears here INSTEAD of in its project group, never in both: the same ferret twice in one column
 * reads as two ferrets.
 *
 * EVERY ROW CAN BE CLEARED FROM THE ROW. Under each one sits the reason it is here and the action that
 * fits it (`needs-you-reason.ts`): Done / Dismiss for an open Attention item, and for a row whose items are
 * still being read, or that an older machine reports but cannot list, an Open (and a Hide for the latter).
 * Done and Dismiss go into the inbox's undo window like every other answer.
 */

import type { SessionView } from '@ferretry/protocol';
import { useState } from 'react';
import { useAttentionInbox } from '../hooks/use-attention-inbox.ts';
import { DISMISS_ACTION, DONE_ACTION } from '../lib/attention-inbox.ts';
import type { DaemonId } from '../lib/daemon-connection.ts';
import {
  NEEDS_YOU_SENTENCE,
  type NeedsYouAction,
  needsYouActions,
  needsYouReason,
  staleRowKey,
} from '../lib/needs-you-reason.ts';
import { RouteLink } from './route-link.tsx';
import { SessionsBarRow } from './sessions-bar-row.tsx';

export interface NeedsYouRow {
  readonly daemonId: DaemonId;
  readonly view: SessionView;
  /** Names the machine on the row. Absent on a single machine's list, where the heading says it. */
  readonly machine?: string;
}

export function SessionsBarNeedsYou({
  rows,
  isActive,
  learns,
  onNavigate,
}: {
  readonly rows: readonly NeedsYouRow[];
  readonly isActive: (row: NeedsYouRow) => boolean;
  readonly learns: (row: NeedsYouRow) => boolean;
  readonly onNavigate: (to: string) => void;
}) {
  const inbox = useAttentionInbox();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const shown = rows.filter(row => !hidden.has(staleRowKey(row.daemonId, row.view)));
  if (shown.length === 0) return null;
  return (
    <section aria-label="Needs you" className="fy-sbar__group fy-sbar__needs" data-sbar-needs-you-group="">
      <h2 className="fy-sbar__project">
        <span className="truncate">Needs you</span>
        <span className="fy-sbar__count">{shown.length}</span>
      </h2>
      <ul>
        {shown.map(row => {
          const cards =
            inbox?.cards.filter(card => card.daemonId === row.daemonId && card.view.config.id === row.view.config.id) ??
            [];
          const reason = needsYouReason(cards, inbox?.reading ?? false);
          const run = (action: NeedsYouAction): void => {
            if (action.kind === 'done') inbox?.deferred.schedule(action.card, DONE_ACTION);
            else if (action.kind === 'dismiss') inbox?.deferred.schedule(action.card, DISMISS_ACTION);
            else if (action.kind === 'hide')
              setHidden(current => new Set(current).add(staleRowKey(row.daemonId, row.view)));
          };
          return (
            <SessionsBarRow
              active={isActive(row)}
              daemonId={row.daemonId}
              key={`${row.daemonId}:${row.view.config.id}`}
              learningPassive={learns(row)}
              onNavigate={onNavigate}
              view={row.view}
              {...(row.machine === undefined ? {} : { machine: row.machine })}
            >
              <div className="fy-sbar__needs-row" data-needs-you-reason={reason.kind}>
                <span className="fy-sbar__needs-why">
                  {NEEDS_YOU_SENTENCE[reason.kind]}
                  {reason.kind === 'attention' && reason.more > 0 ? ` · ${reason.more} more` : ''}
                </span>
                <span className="fy-sbar__needs-actions">
                  {needsYouActions(reason, row.daemonId, row.view).map(action =>
                    action.kind === 'open' ? (
                      <RouteLink
                        className="kt-btn kt-btn--sm"
                        data-needs-you-action="open"
                        data-variant="ghost"
                        key={action.label}
                        onNavigate={onNavigate}
                        to={action.to}
                      >
                        {action.label}
                      </RouteLink>
                    ) : (
                      <button
                        className="kt-btn kt-btn--sm"
                        data-needs-you-action={action.kind}
                        data-variant={action.kind === 'done' ? 'primary' : 'ghost'}
                        key={action.label}
                        onClick={() => run(action)}
                        type="button"
                      >
                        {action.label}
                      </button>
                    ),
                  )}
                </span>
              </div>
            </SessionsBarRow>
          );
        })}
      </ul>
    </section>
  );
}
