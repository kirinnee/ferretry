// THE QUEUE VIEWS: one ferret's queue, and every queue at once.
//
// Reads each machine's `GET /v1/sessions/:id/queue` plus this device's outbox, and draws one row per message
// with the sentence for why it waits. Edit and cancel go through the same `queueActions` the chat bubble uses:
// the outbox first (local), the daemon's PATCH/DELETE after.

import type { ReactNode } from 'react';
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { daemonQueuePath, daemonSessionPath } from '../lib/pages/routes.ts';
import type { DaemonId } from '../lib/daemon-connection.ts';
import { clockOfInstant } from '../lib/message-clock.ts';
import {
  DUE_NOW_COPY,
  ferretRows,
  fromLabel,
  groupNextSend,
  isWaitingRow,
  needsClamp,
  nextRowId,
  queuedAgo,
  type QueueGroup,
  type QueueRow,
  type RowSend,
  rowSend,
  TURN_ENDS_COPY,
  waitingCountLine,
  waitingGroups,
} from '../lib/queue-view.ts';
import { useRouter } from '../lib/router.tsx';
import { absoluteTime } from '../lib/session-screens.ts';
import {
  extendQueueHistory,
  QueueActionError,
  type QueueHistory,
  type QueuePageRead,
  queueActions,
  readSessionQueuePage,
  refreshQueueHistory,
} from '../lib/send-queue.ts';
import { useAppStore, useConnectionSnapshot } from '../lib/store.tsx';
import { ChatProse } from './chat-prose.tsx';
import { DaemonTaskReferences } from './daemon-task-references.tsx';

/** Where a message is, in words; a queued one is on the machine's queue, which is what this page is. */
const STATE_LABEL: Readonly<Record<QueueRow['state'], string>> = {
  saved: 'On this device',
  queued: '',
  typing: 'Typing',
  delivered: 'Typed',
  read: 'Read',
  unconfirmed: 'Typed, unconfirmed',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

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

/** "On this device · waiting for connection"; a message on the machine's queue says only why it waits. */
const statusLine = (row: QueueRow): string =>
  STATE_LABEL[row.state] === '' ? row.why : `${STATE_LABEL[row.state]} · ${row.why}`;

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

/** A message's words, drawn as the chat draws them, folded behind "Show more" when they run long. */
function QueueBody({ text }: { readonly text: string }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const clamped = needsClamp(text);
  return (
    <div className="fy-queue-message">
      <div
        className="fy-queue-body"
        data-queue-body=""
        data-queue-clamped={clamped && !open ? '' : undefined}
        id={bodyId}
      >
        <ChatProse text={text} />
      </div>
      {clamped ? (
        <button
          aria-controls={bodyId}
          aria-expanded={open}
          className="fy-queue-more"
          data-queue-more=""
          onClick={() => setOpen(current => !current)}
          type="button"
        >
          {open ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
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
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(row.text);
  const [note, setNote] = useState<string | null>(null);
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
      data-queue-row={row.id}
      data-queue-state={row.state}
    >
      {/* One quiet line, plain words. The ferret is the heading and the owner is the default sender, so
          neither is repeated; the kind shows only when it is not the ordinary `action`. */}
      <p className="fy-queue-meta" data-queue-ticks={STATE_TICKS[row.state]}>
        {next ? (
          <span className="fy-queue-next" data-queue-meta="next">
            Next up
          </span>
        ) : null}
        {row.sender === undefined ? null : <span data-queue-meta="from">{fromLabel(row)}</span>}
        {row.kind === 'action' ? null : (
          <span className="fy-queue-kind" data-queue-meta="kind" data-queue-tone={row.kind}>
            {row.kind}
          </span>
        )}
        <span data-queue-meta="status">{statusLine(row)}</span>
        {send === undefined ? null : <span data-queue-send={sendKey(send)}>{sendCopy(send, 'sends by')}</span>}
        {ago === '' ? null : (
          <time dateTime={row.at} title={absoluteTime(row.at)}>
            {ago}
          </time>
        )}
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
              onClick={() => void act(() => handlers.edit(row, text.trim())).then(done => done && setEditing(false))}
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
        <QueueBody text={row.text} />
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
  /** Ferrets (by group key) whose queue has older messages on the machine than the page shows. */
  readonly olderKeys?: ReadonlySet<string>;
  /** The ferret whose older messages are being read now, and the one whose read failed. */
  readonly loadingOlder?: string | null;
  readonly olderFailed?: string | null;
  readonly onLoadOlder?: (group: QueueGroup) => void;
  /** The clock the "… ago" times read; the page passes the present, a test passes a fixed instant. */
  readonly now?: number;
}

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
  olderKeys,
  loadingOlder = null,
  olderFailed = null,
  onLoadOlder,
}: QueuePageViewProps) {
  // A ferret with nothing in its queue has no card: the page says so once, whether it shows one ferret or all. One
  // whose newest window shows nothing (every message in it cancelled) but whose machine holds older messages keeps its
  // card, because "Show older messages" lives there and would otherwise be unreachable.
  const hasOlder = (group: QueueGroup): boolean => onLoadOlder !== undefined && olderKeys?.has(group.key) === true;
  const shown = groups.filter(group => group.rows.length > 0 || hasOlder(group));
  const loadOlder = onLoadOlder;
  const waiting = groups.reduce((sum, group) => sum + group.rows.filter(isWaitingRow).length, 0);
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
        {shown.length === 0 && !loading ? (
          <div className="fy-queue-empty kt-panel" data-queue-empty="">
            <p className="fy-queue-empty-title">Nothing is waiting</p>
            <p className="fy-queue-empty-hint">
              Messages for a ferret show up here while they wait for its turn, then leave once it has read them.
            </p>
            {onShowAll === undefined ? null : (
              <button className="kt-btn" onClick={onShowAll} type="button">
                See all queues
              </button>
            )}
          </div>
        ) : null}
        {shown.map(group => {
          const next = nextRowId(group.rows, now);
          // The older messages belong where they will appear: just above the finished ones, below what still waits.
          const olderBefore = group.rows.find(row => !isWaitingRow(row))?.id;
          const older =
            loadOlder !== undefined && hasOlder(group) ? (
              <li className="fy-queue-older" key="older">
                <button
                  className="kt-btn kt-btn--sm"
                  data-queue-older=""
                  disabled={loadingOlder === group.key}
                  onClick={() => loadOlder(group)}
                  type="button"
                >
                  {loadingOlder === group.key ? 'Reading older messages…' : 'Show older messages'}
                </button>
                {olderFailed === group.key ? (
                  <span className="fy-queue-note" role="status">
                    Older messages could not be read. Try again.
                  </span>
                ) : null}
              </li>
            ) : null;
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
                    <GroupNextSend group={group} now={now} />
                    {shown.length > 1 ? (
                      <span className="fy-queue-group-count">{`${group.rows.filter(isWaitingRow).length} waiting`}</span>
                    ) : null}
                  </h2>
                  <ul className="fy-queue-list">
                    {group.rows.map(row => (
                      <Fragment key={row.id}>
                        {row.id === olderBefore ? older : null}
                        <QueueRowView handlers={handlers} next={row.id === next} now={now} row={row} />
                      </Fragment>
                    ))}
                    {olderBefore === undefined ? older : null}
                  </ul>
                </section>,
              )}
            </Fragment>
          );
        })}
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
  const [queues, setQueues] = useState<ReadonlyMap<string, QueueHistory>>(new Map());
  // What each ferret's window held at the last read, so a poll keeps the older messages the person asked for.
  const held = useRef<ReadonlyMap<string, QueueHistory>>(new Map());
  // The number of the newest window poll started; see `read`.
  const generation = useRef(0);
  const [loadingOlder, setLoadingOlder] = useState<string | null>(null);
  const [olderFailed, setOlderFailed] = useState<string | null>(null);
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
      // Every poll is numbered, and only the newest one still in the air may commit: a slower, older answer that
      // lands after a newer one has been applied must not put the window back the way it was.
      generation.current += 1;
      const mine = generation.current;
      const answers = new Map<string, QueuePageRead>();
      await Promise.all(
        targets.map(async target => {
          try {
            const client = await store.clients.client(target.connection);
            answers.set(
              `${target.connection.daemonId}/${target.sessionId}`,
              await readSessionQueuePage(client, target.sessionId),
            );
          } catch {
            // An unreachable machine shows only what this device still holds for it.
          }
        }),
      );
      if (!live || mine !== generation.current) return;
      // What is held is read NOW, after the answers: an older page the person loaded while this poll was in the air is
      // in it, and the window answered is applied over it rather than over what was held when the poll began.
      const next = new Map<string, QueueHistory>();
      for (const target of targets) {
        const key = `${target.connection.daemonId}/${target.sessionId}`;
        const page = answers.get(key);
        const history = page === undefined ? held.current.get(key) : refreshQueueHistory(held.current.get(key), page);
        if (history !== undefined) next.set(key, history);
      }
      held.current = next;
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
        rows: ferretRows(
          target.connection.daemonId,
          target.sessionId,
          target.ferret,
          queues.get(key)?.messages ?? [],
          outbox,
        ),
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
    return sessionId === undefined ? waitingGroups(out) : out;
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

  // The queues of the page's own ferret reach back through the machine's cursor when asked. All queues lists only what
  // waits, and everything that waits is always in the machine's window, so it never needs older pages.
  const olderKeys = useMemo(
    () => new Set([...queues].filter(([, history]) => history.cursor !== null).map(([key]) => key)),
    [queues],
  );
  const loadOlder = useCallback(
    async (group: QueueGroup): Promise<void> => {
      const history = held.current.get(group.key);
      const connection = connections.find(item => item.daemonId === group.daemonId);
      if (history?.cursor == null || connection === undefined) return;
      setLoadingOlder(group.key);
      setOlderFailed(null);
      try {
        const client = await store.clients.client(connection);
        const page = await readSessionQueuePage(client, group.sessionId, { before: history.cursor });
        const latest = held.current.get(group.key) ?? history;
        const extended = extendQueueHistory(latest, page);
        held.current = new Map(held.current).set(group.key, extended);
        setQueues(held.current);
      } catch {
        setOlderFailed(group.key);
      } finally {
        setLoadingOlder(null);
      }
    },
    [connections, store.clients],
  );

  const title = sessionId === undefined ? 'All queues' : `Queue — ${groups[0]?.ferret ?? 'ferret'}`;
  return (
    <QueuePageView
      groups={groups}
      handlers={handlers}
      loading={loading}
      loadingOlder={loadingOlder}
      olderFailed={olderFailed}
      olderKeys={olderKeys}
      onLoadOlder={sessionId === undefined ? undefined : group => void loadOlder(group)}
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
