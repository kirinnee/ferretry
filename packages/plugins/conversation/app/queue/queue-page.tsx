// THE QUEUE VIEW: one ferret's queue, the `ferret.side` `queue` panel.
//
// Reads `GET /v1/ferrets/:ferretId/queue` plus this device's outbox, and draws one row per message with the sentence
// for why it waits. Edit and cancel go through the same `queueActions` the chat bubble uses: the outbox first (local),
// the daemon's PATCH/DELETE after.

import type { ReactNode } from 'react';
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { absoluteTime, ChatProse, clockOfInstant, useOptionalRouter, useScreenHref } from '@ferretry/app';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { z } from 'zod';
import { useConversationClient, useConversationDaemon } from '../client.ts';
import type { SendOutbox } from '../composer/send-outbox.ts';
import { useSendOutbox } from '../composer/send-outbox-wiring.ts';
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
} from './queue-view.ts';
import {
  extendQueueHistory,
  olderRequest,
  QueueActionError,
  type QueueHistory,
  type QueuePageRead,
  queueActions,
  readFerretQueuePage,
  refreshQueueHistory,
} from './send-queue.ts';
import './queue-page.css';

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
    <section aria-label={title} className="fy-queue-page scroll-thin" data-queue-page="">
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
    </section>
  );
}

const POLL_MS = 5000;
/** How often an older page is asked again after a poll restarted the walk under it. */
const OLDER_ATTEMPTS = 3;

// GAP(ferrets): the name a person calls a ferret, from Ferrets' summary (`GET /v1/ferrets/:ferretId`), read loosely.
const FerretNameSchema = z.object({ name: z.string().min(1) });

/** What a person calls the ferret: its name; its id when the read fails. */
const readFerretName = async (client: Pick<PluginClient, 'call'>, ferretId: string): Promise<string> => {
  try {
    const summary = FerretNameSchema.parse(await client.call('GET /v1/ferrets/:ferretId', { params: { ferretId } }));
    return summary.name;
  } catch {
    return ferretId;
  }
};

/** The never-changing outbox stand-in while the composer half has none for this daemon. */
const NO_OUTBOX: Pick<SendOutbox, 'subscribe' | 'snapshot'> = { subscribe: () => () => undefined, snapshot: () => [] };

/**
 * THE `queue` PANEL (slot `ferret.side`, order 10): today's queue page for one ferret, on the daemon this half was
 * built for. Today's "All queues" read every machine this browser paired; a half reaches one daemon, so the panel is
 * one ferret's queue and that view is not offered (GAP: no screen declares it).
 */
export function QueuePanel({ subject }: { readonly subject?: string }) {
  const client = useConversationClient();
  const daemon = useConversationDaemon();
  if (subject === undefined || daemon === undefined) return null;
  return <QueuePage client={client} daemon={daemon} ferretId={subject} />;
}

/** Reads the queue of one ferret and keeps it current. */
function QueuePage({
  client,
  daemon,
  ferretId,
}: {
  readonly client: Pick<PluginClient, 'call'>;
  readonly daemon: string;
  readonly ferretId: string;
}) {
  const router = useOptionalRouter();
  const href = useScreenHref();
  const outboxStore = useSendOutbox();
  const store = outboxStore ?? NO_OUTBOX;
  const outbox = useSyncExternalStore(store.subscribe, store.snapshot);
  const [ferret, setFerret] = useState(ferretId);
  const [queue, setQueue] = useState<QueueHistory | undefined>(undefined);
  // What the window held at the last read, so a poll keeps the older messages the person asked for.
  const held = useRef<QueueHistory | undefined>(undefined);
  // The number of the newest window poll started; see `read`.
  const generation = useRef(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderFailed, setOlderFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick(value => value + 1), []);
  const key = `${daemon}/${ferretId}`;

  useEffect(() => {
    let live = true;
    void readFerretName(client, ferretId).then(name => {
      if (live) setFerret(name);
    });
    return () => {
      live = false;
    };
  }, [client, ferretId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` re-reads after an edit or cancel.
  useEffect(() => {
    let live = true;
    const read = async (): Promise<void> => {
      // Every poll is numbered, and only the newest one still in the air may commit: a slower, older answer that
      // lands after a newer one has been applied must not put the window back the way it was.
      generation.current += 1;
      const mine = generation.current;
      let page: QueuePageRead | undefined;
      try {
        page = await readFerretQueuePage(client, ferretId);
      } catch {
        // An unreachable machine shows only what this device still holds for it.
      }
      if (!live || mine !== generation.current) return;
      // What is held is read NOW, after the answer: an older page the person loaded while this poll was in the air is
      // in it, and the window answered is applied over it rather than over what was held when the poll began.
      const next = page === undefined ? held.current : refreshQueueHistory(held.current, page);
      held.current = next;
      setQueue(next);
      setLoading(false);
    };
    void read();
    const timer = setInterval(() => void read(), POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [client, ferretId, tick]);

  const groups = useMemo<readonly QueueGroup[]>(
    () => [
      {
        key,
        daemonId: daemon,
        machine: daemon,
        ferretId,
        ferret,
        rows: ferretRows(daemon, ferretId, ferret, queue?.messages ?? [], outbox),
      },
    ],
    [daemon, ferret, ferretId, key, outbox, queue],
  );

  const handlers = useMemo<QueueRowHandlers>(() => {
    const actions = queueActions(client, ferretId, refresh, outboxStore ?? undefined);
    return {
      edit: async (row, text) => {
        await actions.edit({ sendId: row.id }, text);
      },
      cancel: async row => {
        await actions.cancel({ sendId: row.id });
      },
    };
  }, [client, ferretId, outboxStore, refresh]);

  // The ferret's queue reaches back through the machine's cursor when asked.
  const olderKeys = useMemo(() => new Set(queue !== undefined && queue.cursor !== null ? [key] : []), [key, queue]);
  const loadOlder = useCallback(async (): Promise<void> => {
    const first = held.current;
    if (first === undefined || olderRequest(first) === undefined) return;
    setLoadingOlder(true);
    setOlderFailed(false);
    try {
      // A page answers the walk and cursor it was asked from. A window poll that restarted the walk while it was in the
      // air hands back the history unchanged, so the page is asked again from where the history stands now.
      for (let attempt = 0; attempt < OLDER_ATTEMPTS; attempt += 1) {
        const from = olderRequest(held.current ?? first);
        if (from === undefined) break;
        const page = await readFerretQueuePage(client, ferretId, { before: from.cursor });
        const latest = held.current ?? first;
        const extended = extendQueueHistory(latest, page, from);
        if (extended === latest) continue;
        held.current = extended;
        setQueue(extended);
        break;
      }
    } catch {
      setOlderFailed(true);
    } finally {
      setLoadingOlder(false);
    }
  }, [client, ferretId]);

  return (
    <QueuePageView
      groups={groups}
      handlers={handlers}
      loading={loading}
      loadingOlder={loadingOlder ? key : null}
      olderFailed={olderFailed ? key : null}
      olderKeys={olderKeys}
      onLoadOlder={() => void loadOlder()}
      onOpenFerret={group => {
        const to = href(daemon, 'conversation', 'chat', { ferret: group.ferretId });
        if (to !== undefined) router?.navigate(to);
      }}
      showMachine={false}
      title={`Queue — ${ferret}`}
    />
  );
}
