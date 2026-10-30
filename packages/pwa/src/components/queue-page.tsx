// THE QUEUE VIEWS: one ferret's queue, and every queue at once.
//
// Reads each machine's `GET /v1/sessions/:id/queue` plus this device's outbox, and draws one row per message
// with the sentence for why it waits. Edit and cancel go through the same `queueActions` the chat bubble uses:
// the outbox first (local), the daemon's PATCH/DELETE after.

import type { QueuedMessage } from '@ferretry/protocol';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { daemonQueuePath, daemonSessionPath } from '../lib/pages/routes.ts';
import type { DaemonId } from '../lib/daemon-connection.ts';
import {
  ferretRows,
  isWaitingRow,
  type QueueGroup,
  type QueueRow,
  waitingCountLine,
  waitingGroups,
} from '../lib/queue-view.ts';
import { useRouter } from '../lib/router.tsx';
import { QueueActionError, queueActions, readSessionQueue } from '../lib/send-queue.ts';
import { useAppStore, useConnectionSnapshot } from '../lib/store.tsx';

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

function QueueRowView({ row, handlers }: { readonly row: QueueRow; readonly handlers: QueueRowHandlers }) {
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
    <li className="flex flex-col gap-1 px-3 py-2" data-queue-row={row.id} data-queue-state={row.state}>
      <div className="flex flex-wrap items-center gap-2 text-meta text-muted">
        <span data-queue-ticks={STATE_TICKS[row.state]}>{STATE_LABEL[row.state]}</span>
        {row.sender === undefined ? null : (
          <span className="rounded-control border border-border px-1.5" data-queue-sender="">
            {row.sender}
          </span>
        )}
        <span>{row.why}</span>
      </div>
      {editing ? (
        <div className="flex flex-col gap-2">
          <textarea
            aria-label="Message text"
            className="min-h-16 w-full rounded-control border border-border bg-surface-2 p-2"
            onChange={event => setText(event.target.value)}
            value={text}
          />
          <div className="flex gap-2">
            <button
              className="kt-btn kt-btn--sm"
              disabled={text.trim().length === 0}
              onClick={() => void act(() => handlers.edit(row, text.trim())).then(done => done && setEditing(false))}
              type="button"
            >
              Save
            </button>
            <button
              className="kt-btn kt-btn--sm"
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
        <p className="m-0 whitespace-pre-wrap break-words">{row.text}</p>
      )}
      {note === null ? null : (
        <p className="m-0 text-meta text-err" role="status">
          {note}
        </p>
      )}
      {row.editable && !editing ? (
        <div className="flex gap-1">
          <button
            className="kt-btn kt-btn--sm kt-btn--flush-start"
            data-variant="ghost"
            onClick={() => {
              setText(row.text);
              setEditing(true);
            }}
            type="button"
          >
            Edit
          </button>
          <button
            className="kt-btn kt-btn--sm"
            data-variant="ghost"
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
}

export function QueuePageView({
  title,
  groups,
  handlers,
  showMachine,
  onOpenFerret,
  onShowAll,
  loading,
}: QueuePageViewProps) {
  const waiting = groups.reduce((sum, group) => sum + group.rows.filter(isWaitingRow).length, 0);
  return (
    <main
      aria-label={title}
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain p-4 scroll-thin"
      data-queue-page=""
    >
      <header className="flex flex-wrap items-baseline gap-3">
        <h1 className="m-0 text-lg">{title}</h1>
        <span className="text-meta text-muted">{loading ? 'Reading the queues…' : waitingCountLine(waiting)}</span>
        {onShowAll === undefined ? null : (
          <button className="text-meta underline" onClick={onShowAll} type="button">
            All queues
          </button>
        )}
      </header>
      {groups.length === 0 && !loading ? <p className="m-0 text-muted">Nothing is waiting.</p> : null}
      {groups.map(group => (
        <section
          aria-label={group.ferret}
          className="kt-panel overflow-hidden"
          data-queue-group={group.key}
          key={group.key}
        >
          <h2 className="m-0 flex flex-wrap items-baseline gap-2 border-b border-border-soft px-3 py-2 text-base">
            <button className="underline" onClick={() => onOpenFerret(group)} type="button">
              {group.ferret}
            </button>
            {showMachine ? <span className="text-meta text-muted">{group.machine}</span> : null}
          </h2>
          <ul className="m-0 list-none divide-y divide-border-soft p-0">
            {group.rows.map(row => (
              <QueueRowView handlers={handlers} key={row.id} row={row} />
            ))}
          </ul>
        </section>
      ))}
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
    />
  );
}
