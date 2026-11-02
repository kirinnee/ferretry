/**
 * INBOX FIND'S RESULTS: with words typed, one list across every tab, each row saying which tab it came from
 * (`lib/agenda-inbox-find.ts`). A row is a plain link to the item's conversation, or to the card on the Board;
 * an OPEN item opens here as the deck's card, like a tap on the Open list does.
 */

import { formatTaskRef } from '@ferretry/protocol';
import { Fragment } from 'react';
import { agendaConversationPath } from '../../lib/agenda-inbox.ts';
import type { FindRow, FindTone } from '../../lib/agenda-inbox-find.ts';
import { inboxRowTitle, inboxWho } from '../../lib/agenda-inbox-list.ts';
import { daemonBoardCardPath } from '../../lib/pages/routes.ts';
import { RouteLink } from '../../shell/route-link.tsx';
import { sessionsBarNames } from '../../shell/sessions-bar-model.ts';
import { agendaReference } from './agenda-board.tsx';

const WHERE_WORDS = 'Find looks in Open, Snoozed, Replied, Resolved and Cards to test.';

interface Line {
  readonly title: string;
  readonly more: readonly string[];
  readonly to: string;
  readonly open: string | null;
}

const lineOf = (row: FindRow): Line => {
  if (row.kind === 'agenda') {
    const who = inboxWho(row.card);
    return {
      title: inboxRowTitle(row.card.item),
      more: [who.ferret, who.machine, agendaReference(row.card.item.id)],
      to: agendaConversationPath(row.card.daemonId, row.card.view.config.id, row.card.item.id),
      open: row.chip.tone === 'open' ? row.card.key : null,
    };
  }
  if (row.kind === 'resolved') {
    const names = sessionsBarNames(row.row.view);
    return {
      title: row.row.record.title ?? row.row.record.subject,
      more: [names.ferret ?? names.title, row.row.machineName, agendaReference(row.row.record.id)],
      to: agendaConversationPath(row.row.daemonId, row.row.view.config.id, row.row.record.id),
      open: null,
    };
  }
  const { card, taskName } = row.row;
  return {
    title: card.task.title,
    more: [taskName, card.machine, formatTaskRef({ id: card.task.id })].filter((text): text is string => text !== null),
    to: daemonBoardCardPath(card.daemonId, card.task.id),
    open: null,
  };
};

function StateChip({ tone, label }: { readonly tone: FindTone; readonly label: string }) {
  return (
    <span className="fy-find-chip" data-find-chip={tone}>
      {label}
    </span>
  );
}

export function InboxFindResults({
  rows,
  reading,
  onNavigate,
  onOpen,
  onClear,
}: {
  readonly rows: readonly FindRow[];
  /** More conversations are still being read, so the list may grow. */
  readonly reading: boolean;
  readonly onNavigate: (to: string) => void;
  /** An open item was tapped: show it here as the deck's card. */
  readonly onOpen: (key: string) => void;
  readonly onClear: () => void;
}) {
  if (rows.length === 0)
    return (
      <div className="fy-attn-inbox__none" data-agenda-no-match="" data-inbox-find="empty">
        <span>{reading ? 'Looking in every tab…' : 'Nothing matches.'}</span>
        <button className="fy-attn-inbox__clear" onClick={onClear} type="button">
          Show everything
        </button>
      </div>
    );
  return (
    <div className="fy-attn-inbox__resolved" data-inbox-find="results">
      <ul aria-label="Find results" className="fy-parked-list">
        {rows.map(row => {
          const line = lineOf(row);
          const open = line.open;
          return (
            <li data-find-row={row.key} key={row.key}>
              <RouteLink
                className="fy-inbox-row"
                onNavigate={open === null ? onNavigate : () => onOpen(open)}
                to={line.to}
              >
                <span className="fy-inbox-row__top">
                  <span className="fy-inbox-row__title">{line.title}</span>
                  <StateChip label={row.chip.label} tone={row.chip.tone} />
                </span>
                <span className="fy-inbox-row__meta">
                  {line.more.map((text, index) => (
                    <Fragment key={text}>
                      {index === 0 ? null : <span aria-hidden="true">·</span>}
                      <span>{text}</span>
                    </Fragment>
                  ))}
                </span>
              </RouteLink>
            </li>
          );
        })}
      </ul>
      <p className="fy-attn-inbox__hint">
        {WHERE_WORDS}
        {reading ? ' Reading more…' : ''}
      </p>
    </div>
  );
}
