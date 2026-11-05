// THE QUEUE VIEWS: one ferret's queue, and every queue at once.
//
// Reads each machine's `GET /v1/sessions/:id/queue` plus this device's outbox, and draws one row per message
// with the sentence for why it waits. Edit and cancel go through the same `queueActions` the chat bubble uses:
// the outbox first (local), the daemon's PATCH/DELETE after.

import type { QueuedMessage } from '@ferretry/protocol';
import type { ReactNode } from 'react';
import { Fragment, useCallback, useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react';
import { daemonQueuePath, daemonSessionPath } from '../lib/pages/routes.ts';
import type { DaemonId } from '../lib/daemon-connection.ts';
import {
  ferretRows,
  fromLabel,
  isWaitingRow,
  needsClamp,
  nextRowId,
  queuedAgo,
  type QueueGroup,
  type QueueRow,
  waitingCountLine,
  waitingGroups,
} from '../lib/queue-view.ts';
import { useRouter } from '../lib/router.tsx';
import { absoluteTime } from '../lib/session-screens.ts';
import { QueueActionError, queueActions, readSessionQueue } from '../lib/send-queue.ts';
import { useAppStore, useConnectionSnapshot } from '../lib/store.tsx';
import { ChatProse } from './chat-prose.tsx';
import { DaemonTaskReferences } from './daemon-task-references.tsx';

const STATE_LABEL: Readonly<Record<QueueRow['state'], string>> = {
  saved: 'On this device',
  queued: 'On the machine’s queue',
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

export interface QueueRowHandlers {
  readonly edit: (row: QueueRow, text: string) => Promise<void>;
  readonly cancel: (row: QueueRow) => Promise<void>;
}

const KIND_TONE: Readonly<Record<QueueRow['kind'], 'err' | 'accent' | undefined>> = {
  blocker: 'err',
  action: 'accent',
  fyi: undefined,
};

function Chip({
  children,
  tone,
  part,
  title,
}: {
  readonly children: string;
  readonly tone?: 'err' | 'accent' | 'ok' | 'warn' | undefined;
  readonly part: string;
  readonly title?: string;
}) {
  return (
    <span
      className="kt-badge fy-queue-chip"
      data-queue-chip={part}
      {...(tone === undefined ? {} : { 'data-tone': tone })}
      title={title}
    >
      {children}
    </span>
  );
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
      <div className="fy-queue-chips">
        {next ? (
          <Chip part="next" tone="ok">
            Next up
          </Chip>
        ) : null}
        <Chip part="to">{`To ${row.ferret}`}</Chip>
        <Chip part="from">{`From ${fromLabel(row)}`}</Chip>
        <Chip part="kind" tone={KIND_TONE[row.kind]}>
          {row.kind}
        </Chip>
        <time className="fy-queue-time" dateTime={row.at} title={absoluteTime(row.at)}>
          {queuedAgo(row.at, now)}
        </time>
      </div>
      <p className="fy-queue-why" data-queue-ticks={STATE_TICKS[row.state]}>
        <span className="fy-queue-state">{STATE_LABEL[row.state]}</span>
        <span aria-hidden="true"> · </span>
        {row.why}
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
            className="kt-btn"
            onClick={() => {
              setText(row.text);
              setEditing(true);
            }}
            type="button"
          >
            Edit
          </button>
          <button
            className="kt-btn"
            data-variant="danger"
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
  /** The clock the "Queued … ago" chips read; the page passes the present, a test passes a fixed instant. */
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
}: QueuePageViewProps) {
  // A ferret with nothing in its queue has no card: the page says so once, whether it shows one ferret or all.
  const shown = groups.filter(group => group.rows.length > 0);
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
          return (
            <Fragment key={group.key}>
              {wrapGroup(
                group,
                <section aria-label={group.ferret} className="kt-panel fy-queue-group" data-queue-group={group.key}>
                  <h2 className="fy-queue-group-head">
                    <button className="fy-queue-ferret" onClick={() => onOpenFerret(group)} type="button">
                      {group.ferret}
                    </button>
                    {showMachine ? <span className="fy-queue-machine">{group.machine}</span> : null}
                    <span className="fy-queue-group-count" title="Messages waiting for this ferret">
                      {group.rows.filter(isWaitingRow).length}
                    </span>
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
