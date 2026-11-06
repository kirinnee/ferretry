// THE QUEUE VIEWS: one ferret's queue, and every queue at once.
//
// Reads each machine's `GET /v1/sessions/:id/queue` plus this device's outbox and draws one compact line per message
// (status, sender, first line, time; a tap opens the rest). It opens on what has not been delivered; delivered and
// read messages sit behind the Sent toggle, and a search narrows either list. Edit and cancel go through the same
// `queueActions` the chat bubble uses: the outbox first (local), the daemon's PATCH/DELETE after.

import type { QueuedMessage } from '@ferretry/protocol';
import type { ReactNode } from 'react';
import { AlertTriangle, Check, CheckCheck, Clock, Search, Send, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Fragment, useCallback, useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react';
import { daemonQueuePath, daemonSessionPath } from '../lib/pages/routes.ts';
import type { DaemonId } from '../lib/daemon-connection.ts';
import { clockOfInstant } from '../lib/message-clock.ts';
import {
  countRows,
  DUE_NOW_COPY,
  ferretRows,
  firstLine,
  fromLabel,
  groupNextSend,
  isWaitingRow,
  limitRows,
  listingGroups,
  nextRowId,
  queuedAgo,
  type QueueGroup,
  type QueueListing,
  type QueueRow,
  type RowSend,
  type RowStatus,
  rowSend,
  rowStatus,
  STATUS_LABEL,
  TURN_ENDS_COPY,
  waitingCountLine,
} from '../lib/queue-view.ts';
import { useRouter } from '../lib/router.tsx';
import { absoluteTime } from '../lib/session-screens.ts';
import { QueueActionError, queueActions, readSessionQueue } from '../lib/send-queue.ts';
import { useAppStore, useConnectionSnapshot } from '../lib/store.tsx';
import { ChatProse } from './chat-prose.tsx';
import { DaemonTaskReferences } from './daemon-task-references.tsx';

const STATE_TICKS: Readonly<Record<QueueRow['state'], number>> = {
  saved: 1,
  queued: 2,
  typing: 2,
  delivered: 3,
  unconfirmed: 3,
  read: 4,
  cancelled: 0,
  failed: 0,
};

/** The icon beside each status word: a shape of its own, so the state never rests on colour alone. */
const STATUS_ICON: Readonly<Record<RowStatus, LucideIcon>> = {
  waiting: Clock,
  sending: Send,
  delivered: Check,
  read: CheckCheck,
  failed: AlertTriangle,
  cancelled: X,
};

/** "On this device · waiting for connection"; a message on the machine's queue says only why it waits. */
const whyLine = (row: QueueRow): string => (row.state === 'saved' ? `On this device · ${row.why}` : row.why);

/** "sends by 11:20" / "due now" / "when its turn ends", on the reader's clock. */
const sendCopy = (send: RowSend, lead: string): string => {
  if ('due' in send) return DUE_NOW_COPY;
  if ('turn' in send) return TURN_ENDS_COPY;
  const clock = clockOfInstant(send.at);
  return clock === undefined ? TURN_ENDS_COPY : `${lead} ${clock.short}`;
};

/** The machine-readable twin of the copy: `due`, `turn`, or the hold's instant. */
const sendKey = (send: RowSend): string => ('due' in send ? 'due' : 'turn' in send ? 'turn' : send.at);

export interface QueueRowHandlers {
  readonly edit: (row: QueueRow, text: string) => Promise<void>;
  readonly cancel: (row: QueueRow) => Promise<void>;
}

/** The status word with its icon: the first thing on every row. */
function StatusLabel({ status }: { readonly status: RowStatus }) {
  const Icon = STATUS_ICON[status];
  return (
    <span className="fy-queue-status" data-queue-meta="status" data-queue-status={status}>
      <Icon aria-hidden="true" className="fy-queue-status-icon" size={14} strokeWidth={2.25} />
      <span>{STATUS_LABEL[status]}</span>
    </span>
  );
}

function QueueRowView({
  row,
  handlers,
  next,
  now,
}: {
  readonly row: QueueRow;
  readonly handlers: QueueRowHandlers;
  readonly next: boolean;
  readonly now: number;
}) {
  const ago = queuedAgo(row.at, now);
  const send = rowSend(row, now);
  const status = rowStatus(row);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(row.text);
  const [note, setNote] = useState<string | null>(null);
  const detailId = useId();
  const expanded = open || editing;
  const act = async (run: () => Promise<void>): Promise<boolean> => {
    setNote(null);
    try {
      await run();
      return true;
    } catch (cause) {
      setNote(cause instanceof QueueActionError || cause instanceof Error ? cause.message : 'That did not work.');
      return false;
    }
  };
  return (
    <li
      className="fy-queue-row"
      data-queue-kind={row.kind}
      data-queue-next={next ? '' : undefined}
      data-queue-open={expanded ? '' : undefined}
      data-queue-row={row.id}
      data-queue-state={row.state}
      data-queue-ticks={STATE_TICKS[row.state]}
    >
      {/* ONE line: status, sender, the first line of the words, how long ago. Tapping it opens the rest. */}
      <button
        aria-controls={expanded ? detailId : undefined}
        aria-expanded={expanded}
        className="fy-queue-line"
        data-queue-line=""
        disabled={editing}
        onClick={() => setOpen(current => !current)}
        type="button"
      >
        {next ? (
          <span className="sr-only" data-queue-sr="">
            Next up.
          </span>
        ) : null}
        <StatusLabel status={status} />
        <span className="fy-queue-sender" data-queue-meta="from">
          {fromLabel(row)}
        </span>
        <span className="fy-queue-snippet" data-queue-snippet="">
          {firstLine(row.text)}
        </span>
        {ago === '' ? (
          <span />
        ) : (
          <time className="fy-queue-ago" dateTime={row.at} title={absoluteTime(row.at)}>
            {ago}
          </time>
        )}
      </button>
      {expanded ? (
        <div className="fy-queue-detail" data-queue-detail="" id={detailId}>
          <p className="fy-queue-facts">
            {next ? (
              <span className="fy-queue-next" data-queue-meta="next">
                Next up
              </span>
            ) : null}
            {row.kind === 'action' ? null : (
              <span className="fy-queue-kind" data-queue-meta="kind" data-queue-tone={row.kind}>
                {row.kind}
              </span>
            )}
            <span data-queue-meta="why">{whyLine(row)}</span>
            {send === undefined ? null : <span data-queue-send={sendKey(send)}>{sendCopy(send, 'sends by')}</span>}
          </p>
          {editing ? (
            <div className="fy-queue-edit">
              <textarea
                aria-label="Message text"
                className="fy-queue-textarea"
                onChange={event => setText(event.target.value)}
                value={text}
              />
              <div className="fy-queue-actions">
                <button
                  className="kt-btn"
                  data-variant="primary"
                  disabled={text.trim().length === 0}
                  onClick={() =>
                    void act(() => handlers.edit(row, text.trim())).then(done => done && setEditing(false))
                  }
                  type="button"
                >
                  Save
                </button>
                <button
                  className="kt-btn"
                  onClick={() => {
                    setText(row.text);
                    setEditing(false);
                  }}
                  type="button"
                >
                  Keep as is
                </button>
              </div>
            </div>
          ) : (
            <div className="fy-queue-body" data-queue-body="">
              <ChatProse text={row.text} />
            </div>
          )}
          {note === null ? null : (
            <p className="fy-queue-note" role="status">
              {note}
            </p>
          )}
          {row.editable && !editing ? (
            <div className="fy-queue-actions">
              <button
                className="fy-queue-action"
                onClick={() => {
                  setText(row.text);
                  setOpen(true);
                  setEditing(true);
                }}
                type="button"
              >
                Edit
              </button>
              <button
                className="fy-queue-action"
                data-tone="danger"
                onClick={() => void act(() => handlers.cancel(row))}
                type="button"
              >
                Cancel message
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** The earliest next send of one ferret, beside its name. */
function GroupNextSend({ group, now }: { readonly group: QueueGroup; readonly now: number }) {
  const next = groupNextSend(group, now);
  if (next === undefined) return null;
  return (
    <span className="fy-queue-group-next" data-queue-group-send={sendKey(next)}>
      {sendCopy(next, 'next send')}
    </span>
  );
}

export interface QueuePageViewProps {
  readonly title: string;
  readonly groups: readonly QueueGroup[];
  readonly handlers: QueueRowHandlers;
  /** Named machine headings only matter when more than one machine shows. */
  readonly showMachine: boolean;
  readonly onOpenFerret: (group: QueueGroup) => void;
  readonly onShowAll?: () => void;
  readonly loading: boolean;
  /** Wraps one ferret's card — the host puts what its messages' references need (a machine's cards) around it. */
  readonly wrapGroup?: (group: QueueGroup, content: ReactNode) => ReactNode;
  /** The clock the "… ago" times read; the page passes the present, a test passes a fixed instant. */
  readonly now?: number;
}

/** How many sent messages show before "Show older": the list stays light however long the history is. */
const SENT_STEP = 100;

const LISTING_LABEL: Readonly<Record<QueueListing, string>> = { unsent: 'Not sent', sent: 'Sent' };

export function QueuePageView({
  title,
  groups,
  handlers,
  showMachine,
  onOpenFerret,
  onShowAll,
  loading,
  wrapGroup = (_group, content) => content,
  now = Date.now(),
}: QueuePageViewProps) {
  const [listing, setListing] = useState<QueueListing>('unsent');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(SENT_STEP);
  const waiting = groups.reduce((sum, group) => sum + group.rows.filter(isWaitingRow).length, 0);
  // The rows each list would show for this search, so each toggle can say how many it holds.
  const lists = useMemo(
    () => ({ unsent: listingGroups(groups, 'unsent', query), sent: listingGroups(groups, 'sent', query) }),
    [groups, query],
  );
  const counts: Readonly<Record<QueueListing, number>> = {
    unsent: countRows(lists.unsent),
    sent: countRows(lists.sent),
  };
  const searching = query.trim() !== '';
  const other: QueueListing = listing === 'unsent' ? 'sent' : 'unsent';
  const total = counts[listing];
  const shown = listing === 'sent' ? limitRows(lists.sent, limit) : lists.unsent;
  const choose = (next: QueueListing) => {
    setListing(next);
    setLimit(SENT_STEP);
  };
  const search = (value: string) => {
    setQuery(value);
    setLimit(SENT_STEP);
  };
  return (
    <main aria-label={title} className="fy-queue-page scroll-thin" data-queue-page="">
      <div className="fy-queue-column">
        <header className="fy-queue-head">
          <h1 className="fy-queue-title">{title}</h1>
          <span className="fy-queue-count">{loading ? 'Reading the queues…' : waitingCountLine(waiting)}</span>
          {onShowAll === undefined ? null : (
            <button className="kt-btn kt-btn--sm" onClick={onShowAll} type="button">
              All queues
            </button>
          )}
        </header>
        <div className="fy-queue-controls">
          <fieldset aria-label="Which messages" className="fy-queue-toggle">
            {(['unsent', 'sent'] as const).map(item => (
              <button
                aria-pressed={listing === item}
                className="fy-queue-toggle-button"
                data-queue-listing={item}
                key={item}
                onClick={() => choose(item)}
                type="button"
              >
                <span>{LISTING_LABEL[item]}</span>
                <span className="fy-queue-toggle-count" data-queue-listing-count={item}>
                  {counts[item]}
                </span>
              </button>
            ))}
          </fieldset>
          <search className="fy-queue-search">
            <Search aria-hidden="true" className="fy-queue-search-icon" size={16} />
            <input
              aria-label="Search messages and senders"
              autoComplete="off"
              className="fy-queue-search-input"
              data-queue-search=""
              onChange={event => search(event.target.value)}
              placeholder="Search messages or senders"
              type="search"
              value={query}
            />
            {query === '' ? null : (
              <button
                aria-label="Clear search"
                className="fy-queue-search-clear"
                data-queue-search-clear=""
                onClick={() => search('')}
                type="button"
              >
                <X aria-hidden="true" size={16} />
              </button>
            )}
          </search>
        </div>
        {total === 0 && !loading ? (
          searching ? (
            <div className="fy-queue-empty kt-panel" data-queue-no-matches="">
              <p className="fy-queue-empty-title">{`Nothing in ${LISTING_LABEL[listing]} matches “${query.trim()}”`}</p>
              {counts[other] > 0 ? (
                <p className="fy-queue-empty-hint">{`${counts[other]} match in ${LISTING_LABEL[other]}.`}</p>
              ) : null}
              <button className="kt-btn" onClick={() => search('')} type="button">
                Clear search
              </button>
            </div>
          ) : listing === 'sent' ? (
            <div className="fy-queue-empty kt-panel" data-queue-empty="">
              <p className="fy-queue-empty-title">Nothing sent yet</p>
              <p className="fy-queue-empty-hint">Delivered and read messages show up here, newest first.</p>
            </div>
          ) : (
            <div className="fy-queue-empty kt-panel" data-queue-empty="">
              <p className="fy-queue-empty-title">Nothing is waiting</p>
              <p className="fy-queue-empty-hint">
                Messages show up here while they wait for a ferret's turn. Once delivered they move to Sent.
              </p>
              {onShowAll === undefined ? null : (
                <button className="kt-btn" onClick={onShowAll} type="button">
                  See all queues
                </button>
              )}
            </div>
          )
        ) : null}
        {shown.map(group => {
          // Next up is the ferret's whole queue's next send, found before any search narrowed the rows.
          const next = nextRowId(groups.find(item => item.key === group.key)?.rows ?? group.rows, now);
          return (
            <Fragment key={group.key}>
              {wrapGroup(
                group,
                <section aria-label={group.ferret} className="fy-queue-group" data-queue-group={group.key}>
                  <h2 className="fy-queue-group-head">
                    <button className="fy-queue-ferret" onClick={() => onOpenFerret(group)} type="button">
                      {group.ferret}
                    </button>
                    {showMachine ? <span className="fy-queue-machine">{group.machine}</span> : null}
                    {listing === 'unsent' ? <GroupNextSend group={group} now={now} /> : null}
                    {shown.length > 1 ? (
                      <span className="fy-queue-group-count">{`${group.rows.length} ${listing === 'sent' ? 'sent' : 'not sent'}`}</span>
                    ) : null}
                  </h2>
                  <ul className="fy-queue-list">
                    {group.rows.map(row => (
                      <QueueRowView handlers={handlers} key={row.id} next={row.id === next} now={now} row={row} />
                    ))}
                  </ul>
                </section>,
              )}
            </Fragment>
          );
        })}
        {listing === 'sent' && countRows(shown) < total ? (
          <button
            className="kt-btn fy-queue-older"
            data-queue-older=""
            onClick={() => setLimit(current => current + SENT_STEP)}
            type="button"
          >
            {`Show older messages (${total - countRows(shown)} more)`}
          </button>
        ) : null}
      </div>
    </main>
  );
}

const POLL_MS = 5000;

/** Reads the queues for the route: one ferret, or every ferret on every machine this browser knows. */
export function QueuePage({ daemonId, sessionId }: { readonly daemonId: DaemonId; readonly sessionId?: string }) {
  const store = useAppStore();
  const { navigate } = useRouter();
  const { connections } = useConnectionSnapshot();
  const fleet = useSyncExternalStore(store.fleet.subscribe, store.fleet.getSnapshot);
  const outbox = useSyncExternalStore(store.outbox.subscribe, store.outbox.snapshot);
  const [queues, setQueues] = useState<ReadonlyMap<string, readonly QueuedMessage[]>>(new Map());
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick(value => value + 1), []);

  const targets = useMemo(() => {
    const picked = sessionId === undefined ? connections : connections.filter(item => item.daemonId === daemonId);
    return picked.flatMap(connection => {
      const sessions = fleet.daemons.get(connection.daemonId)?.sessions ?? [];
      return sessions
        .filter(view => sessionId === undefined || view.config.id === sessionId)
        .map(view => ({
          connection,
          sessionId: view.config.id,
          ferret: view.config.teammate ?? view.config.name,
        }));
    });
  }, [connections, daemonId, fleet, sessionId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` re-reads after an edit or cancel.
  useEffect(() => {
    let live = true;
    const read = async (): Promise<void> => {
      const next = new Map<string, readonly QueuedMessage[]>();
      await Promise.all(
        targets.map(async target => {
          try {
            const client = await store.clients.client(target.connection);
            next.set(
              `${target.connection.daemonId}/${target.sessionId}`,
              await readSessionQueue(client, target.sessionId),
            );
          } catch {
            // An unreachable machine shows only what this device still holds for it.
          }
        }),
      );
      if (!live) return;
      setQueues(next);
      setLoading(false);
    };
    void read();
    const timer = setInterval(() => void read(), POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [store.clients, targets, tick]);

  const groups = useMemo<readonly QueueGroup[]>(() => {
    const seen = new Set<string>();
    const out: QueueGroup[] = targets.map(target => {
      const key = `${target.connection.daemonId}/${target.sessionId}`;
      seen.add(key);
      return {
        key,
        daemonId: target.connection.daemonId,
        machine: target.connection.daemonName ?? target.connection.baseUrl,
        sessionId: target.sessionId,
        ferret: target.ferret,
        rows: ferretRows(target.connection.daemonId, target.sessionId, target.ferret, queues.get(key) ?? [], outbox),
      };
    });
    // A message saved on this device for a ferret this browser has not listed (a machine still offline) still shows.
    for (const entry of outbox) {
      const key = `${entry.daemonId}/${entry.sessionId}`;
      if (seen.has(key) || (sessionId !== undefined && entry.sessionId !== sessionId)) continue;
      const connection = connections.find(item => item.daemonId === entry.daemonId);
      if (connection === undefined) continue;
      seen.add(key);
      out.push({
        key,
        daemonId: entry.daemonId,
        machine: connection.daemonName ?? connection.baseUrl,
        sessionId: entry.sessionId,
        ferret: entry.sessionId,
        rows: ferretRows(entry.daemonId, entry.sessionId, entry.sessionId, [], outbox),
      });
    }
    return out;
  }, [connections, outbox, queues, sessionId, targets]);

  const handlers = useMemo<QueueRowHandlers>(() => {
    const actionsFor = async (row: QueueRow) => {
      const connection = connections.find(item => item.daemonId === row.daemonId);
      const client = connection === undefined ? null : await store.clients.client(connection);
      return queueActions(client, row.sessionId, refresh, store.outbox);
    };
    return {
      edit: async (row, text) => {
        await (await actionsFor(row)).edit({ sendId: row.id }, text);
      },
      cancel: async row => {
        await (await actionsFor(row)).cancel({ sendId: row.id });
      },
    };
  }, [connections, refresh, store.clients, store.outbox]);

  const title = sessionId === undefined ? 'All queues' : `Queue — ${groups[0]?.ferret ?? 'ferret'}`;
  return (
    <QueuePageView
      groups={groups}
      handlers={handlers}
      loading={loading}
      onOpenFerret={group => navigate(daemonSessionPath(group.daemonId as DaemonId, group.sessionId))}
      onShowAll={sessionId === undefined ? undefined : () => navigate(daemonQueuePath(daemonId))}
      showMachine={connections.length > 1}
      title={title}
      wrapGroup={(group, content) => (
        <DaemonTaskReferences
          connection={connections.find(item => item.daemonId === group.daemonId)}
          onNavigate={navigate}
        >
          {content}
        </DaemonTaskReferences>
      )}
    />
  );
}
