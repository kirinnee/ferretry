/**
 * A FERRET'S AGENDA INSIDE ITS CHAT. Nothing overlays the conversation without a tap and the composer never
 * moves: everything here is a SIBLING of the composer, drawn above it, or a layer over the transcript only.
 *
 * The agenda exists only while the ferret works in agenda mode (`agendaMode`, a switchable instruction
 * section, off by default). With it off the chat has no agenda line; what is on its way ("Sending…") still
 * shows on its own slim row. Plain notifications belong to the Inbox, never to the agenda.
 *
 * - ONE LINE above the composer counts what needs the owner and what waits on the ferret; tapping it opens a
 *   bounded DRAWER of rows upward (blocking → needs you → ferret's turn).
 * - A row's title opens the item's FULL CARD over the transcript (the header, the line and the composer stay);
 *   the drawer closes. ‹ › page through the agenda; an answer moves on to the next item that needs the owner.
 * - "＋ reply" adds a removable "re: <title>" chip — several allowed — and the next message carries the `!A5`
 *   references of its chips (`withReferencePrefix`), then clears them. An option picked on a row or the card
 *   carries the composer's text as its note and empties the composer when it was used.
 * - A wide screen with a mouse can DOCK the agenda beside the chat; the full card opens in the chat area.
 * - `?attention=A5` (a notification tap, a proved `!A5`) arrives as a `focus` request: an open item opens its
 *   full card, a resolved one opens in the resolved list, and an id the board does not hold is said out loud.
 */

import type { AttentionId, AttentionItem, AttentionSnapshot } from '@ferretry/protocol';
import { CircleAlert, PanelRight } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChatProse } from '../../components/chat-prose.tsx';
import { agendaCounts, agendaItems, nextOwnerItem, sortAgenda } from '../../lib/agenda-chat.ts';
import type { InboxAction } from '../../lib/attention-answers.ts';
import type { DaemonAttentionClient } from '../../lib/attention-client.ts';
import { actionSentence } from '../../lib/attention-inbox.ts';
import { withComposerNote } from '../../lib/attention-reply.ts';
import type { AttentionLoadStatus } from '../../lib/attention-store.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionKey } from '../../lib/daemon-scope.ts';
import { browserClipboardWriter } from '../onboarding/copy-button.tsx';
import { attentionReference } from './attention-board.tsx';
import {
  AttentionAgendaDrawer,
  AttentionAgendaLine,
  AttentionAgendaPanel,
  AttentionReferenceChips,
} from './attention-agenda-line.tsx';
import { useAgendaDock } from './attention-collapse.ts';
import { AttentionDeliveryContext, attentionHeading, deliveringIds } from './attention-delivery.tsx';
import { AttentionFullCard } from './attention-full-card.tsx';

/** What the chat sends of the attention client, and nothing else of it. */
export type AttentionActionClient = Pick<
  DaemonAttentionClient,
  'dismiss' | 'respond' | 'resolve' | 'needsInfo' | 'discuss' | 'progress'
>;

/** A request to show one item. `seq` makes a repeated request a new one. */
export interface AttentionFocus {
  readonly target: AttentionId | null;
  readonly seq: number;
}

/** Where an id sits on a board: answerable, on the record, absent, or not known until the board is read. */
type AttentionLocation = 'open' | 'resolved' | 'unknown' | 'pending';

const locateAttention = (snapshot: AttentionSnapshot | null, id: AttentionId): AttentionLocation => {
  if (snapshot === null) return 'pending';
  if (snapshot.items.some(item => item.id === id)) return 'open';
  if (snapshot.resolved.some(item => item.id === id)) return 'resolved';
  return 'unknown';
};

/**
 * Every id in this session's Attention LEDGER — open and resolved. This is what proves a `!A3`: an answered
 * item is still on the record, so a reference to it in older chat stays a link instead of decaying into prose.
 */
export const attentionLedgerIds = (snapshot: AttentionSnapshot | null): readonly AttentionId[] =>
  snapshot === null ? [] : [...snapshot.items.map(item => item.id), ...snapshot.resolved.map(item => item.id)];

/** Sends one answer, as the daemon is asked for it, to this session on this machine. */
const runAttentionAction = async (
  client: AttentionActionClient,
  connection: DaemonConnection,
  scope: DaemonSessionScope,
  id: AttentionId,
  action: InboxAction,
): Promise<void> => {
  if (action.kind === 'respond') await client.respond(connection, scope, id, action.response, action.note);
  else if (action.kind === 'dismiss') await client.dismiss(connection, scope, id, action.note);
  else if (action.kind === 'needs-info') await client.needsInfo(connection, scope, id, action.note);
  else if (action.kind === 'discuss') await client.discuss(connection, scope, id, action.note);
  else await client.resolve(connection, scope, id, action.note);
};

const NO_ITEMS: readonly AttentionItem[] = [];
const copyWriter = browserClipboardWriter();

const failure = (reason: unknown): string =>
  reason instanceof Error ? reason.message : 'The machine did not accept this answer.';

export interface UseAttentionAgendaInput {
  readonly connection: DaemonConnection;
  readonly scope: DaemonSessionScope;
  /** Absent when this host has no Attention subscription: nothing can be answered from here. */
  readonly client: AttentionActionClient | undefined;
  readonly snapshot: AttentionSnapshot | null;
  readonly status: AttentionLoadStatus;
  /** The ferret works in agenda mode: only then does the chat draw an agenda. */
  readonly agendaMode: boolean;
  /** The ferret's spoken name, for "2 with Johnnie". */
  readonly ferret: string;
  /** The latest request to show one item; `null` while nothing was asked. */
  readonly focus?: AttentionFocus | null;
  /** A request named a resolved item: open the resolved list at it. */
  readonly onOpenResolved?: (id: AttentionId) => void;
  /** Drawn on the line's right while the machine holds answers ("Sending in 8 s… / Send now"). */
  readonly repliesSlot?: ReactNode;
  /** A wide screen with a mouse: the agenda can be docked, and the card has no swipe arrows. */
  readonly desktop: boolean;
  /** The primary pointer is touch: the card can be swiped. */
  readonly swipeable: boolean;
  readonly now?: number;
}

export interface AttentionAgenda {
  /** The drawer, the line and the chips, in that order — siblings above the composer. `null`: nothing to say. */
  readonly above: ReactNode;
  /** The open item's full card, laid over the transcript only. */
  readonly card: ReactNode;
  /** The docked panel, beside the chat. */
  readonly side: ReactNode;
  /** The header's "Agenda" button that docks the panel (a wide screen only). */
  readonly dockButton: ReactNode;
  /** The ids the next message is about, in chip order. */
  readonly references: () => readonly AttentionId[];
  /** Wire these into the Composer. */
  readonly composer: {
    readonly onDraftChange: (text: string) => void;
    readonly clearSignal: number;
    /** A message went: its chips are spent. */
    readonly onSent: () => void;
  };
}

export const useAttentionAgenda = ({
  connection,
  scope,
  client,
  snapshot,
  status,
  agendaMode,
  ferret,
  focus = null,
  onOpenResolved,
  repliesSlot,
  desktop,
  swipeable,
  now,
}: UseAttentionAgendaInput): AttentionAgenda => {
  const domId = useId();
  const drawerId = `${domId}-drawer`;
  const scopeKey = daemonSessionKey(scope);
  const board = snapshot?.items ?? NO_ITEMS;
  const agenda = useMemo(() => (agendaMode ? sortAgenda(agendaItems(board)) : NO_ITEMS), [agendaMode, board]);
  const byId = useMemo(() => new Map(agenda.map(item => [item.id, item])), [agenda]);

  // What was opened belongs to the conversation it was opened in.
  const [shown, setShown] = useState<{
    readonly key: string;
    readonly drawer: boolean;
    readonly card: AttentionId | null;
    readonly chips: readonly AttentionId[];
  }>({ key: scopeKey, drawer: false, card: null, chips: [] });
  const here = shown.key === scopeKey ? shown : { key: scopeKey, drawer: false, card: null, chips: [] };
  const update = useCallback(
    (change: (current: typeof here) => Partial<typeof here>): void =>
      setShown(current => {
        const base = current.key === scopeKey ? current : { key: scopeKey, drawer: false, card: null, chips: [] };
        return { ...base, ...change(base) };
      }),
    [scopeKey],
  );

  const [dock, toggleDock] = useAgendaDock();
  const docked = desktop && dock;
  const cardId = here.card !== null && byId.has(here.card) ? here.card : null;
  const chipItems = here.chips.flatMap(id => {
    const item = byId.get(id);
    return item === undefined ? [] : [item];
  });
  const chipsRef = useRef<readonly AttentionId[]>([]);
  chipsRef.current = chipItems.map(item => item.id);

  const [busy, setBusy] = useState<ReadonlyMap<AttentionId, string | null>>(new Map());
  const [announcement, setAnnouncement] = useState('');
  const [clearSignal, setClearSignal] = useState(0);
  const text = useRef('');
  const onDraftChange = useCallback((next: string): void => {
    text.current = next;
  }, []);
  const onSent = useCallback((): void => update(() => ({ chips: [] })), [update]);

  const setCard = useCallback((id: AttentionId, state: string | null | undefined): void => {
    setBusy(current => {
      const next = new Map(current);
      if (state === undefined) next.delete(id);
      else next.set(id, state);
      return next;
    });
  }, []);

  const act = (item: AttentionItem, action: InboxAction): void => {
    if (client === undefined || busy.get(item.id) === null) return;
    const sent = withComposerNote(action, text.current);
    const order = agenda;
    const onCard = cardId === item.id;
    setCard(item.id, null);
    setAnnouncement('');
    runAttentionAction(client, connection, scope, item.id, sent).then(
      () => {
        setCard(item.id, undefined);
        setAnnouncement(actionSentence(sent, item.id));
        if (sent !== action) setClearSignal(signal => signal + 1);
        if (onCard) update(() => ({ card: nextOwnerItem(order, item.id)?.id ?? null }));
      },
      (reason: unknown) => setCard(item.id, failure(reason)),
    );
  };

  const addReply = (item: AttentionItem): void =>
    update(current => ({ chips: current.chips.includes(item.id) ? current.chips : [...current.chips, item.id] }));

  const openCard = (item: AttentionItem): void => update(() => ({ card: item.id, drawer: false }));

  // A REQUEST IS HONOURED ONCE, when it can be: after the board that says where the item is has been read.
  const handled = useRef<number | null>(null);
  const focusTarget = focus?.target ?? null;
  const focusSeq = focus?.seq ?? null;
  const location = focusTarget === null ? null : locateAttention(snapshot, focusTarget);
  const inAgenda = focusTarget !== null && byId.has(focusTarget);
  const isNotice = focusTarget !== null && board.some(item => item.id === focusTarget && item.notice === true);
  useEffect(() => {
    if (focusTarget === null || focusSeq === null || handled.current === focusSeq) return;
    if (location === 'pending') return;
    handled.current = focusSeq;
    if (location === 'resolved') onOpenResolved?.(focusTarget);
    else if (location === 'open' && inAgenda) update(() => ({ card: focusTarget, drawer: false }));
  }, [focusTarget, focusSeq, location, inAgenda, onOpenResolved, update]);
  const missing = agendaMode && focusTarget !== null && location === 'unknown' && !isNotice;

  const delivering = useMemo(() => deliveringIds(snapshot), [snapshot]);
  const sendingHeadings = [...delivering].flatMap(id => {
    const entry = board.find(open => open.id === id) ?? snapshot?.resolved.find(done => done.id === id);
    return entry === undefined ? [] : [attentionHeading(entry)];
  });
  const deliveryState = useMemo(() => ({ sending: delivering, ferret }), [delivering, ferret]);
  const busyIds = useMemo(() => new Set([...busy].filter(([, state]) => state === null).map(([id]) => id)), [busy]);

  const loading = snapshot === null && (status === 'idle' || status === 'loading');
  const unavailable = agendaMode && snapshot === null && status === 'error';
  const parseErrors = agendaMode ? (snapshot?.parseErrors ?? 0) : 0;
  const counts = agendaMode && agenda.length > 0 ? agendaCounts(agenda) : undefined;
  const drawerOpen = here.drawer && counts !== undefined && !docked;

  const rows = {
    ferret,
    busy: busyIds,
    referenced: chipsRef.current,
    onAct: act,
    onAddReply: addReply,
    onOpen: openCard,
    ...(now === undefined ? {} : { now }),
  };

  const above = loading ? (
    <p aria-live="polite" className="sr-only" role="status">
      {announcement}
    </p>
  ) : (
    <AttentionDeliveryContext.Provider value={deliveryState}>
      <p aria-live="polite" className="sr-only" role="status">
        {announcement}
      </p>
      {drawerOpen ? <AttentionAgendaDrawer id={drawerId} items={agenda} {...rows} /> : null}
      {missing && focusTarget !== null ? (
        <p className="fy-agenda-note" data-agenda-missing={focusTarget} role="status">
          <CircleAlert aria-hidden="true" size={14} />
          {attentionReference(focusTarget)} is no longer open.
        </p>
      ) : null}
      {parseErrors > 0 ? (
        <p className="fy-agenda-note" data-tone="err" role="alert">
          <CircleAlert aria-hidden="true" size={14} />
          The machine reported {parseErrors} damaged agenda records; repair them before trusting this list.
        </p>
      ) : null}
      {unavailable ? (
        <p className="fy-agenda-note" data-tone="err" role="alert">
          <CircleAlert aria-hidden="true" size={14} />
          The agenda cannot be read right now. Reconnect before assuming nothing needs you.
        </p>
      ) : null}
      <AttentionAgendaLine
        controls={drawerId}
        docked={docked}
        ferret={ferret}
        onToggle={() => update(current => ({ drawer: !current.drawer }))}
        open={drawerOpen}
        sending={{ count: repliesSlot === undefined ? delivering.size : 0, headings: sendingHeadings }}
        {...(counts === undefined ? {} : { counts })}
        {...(repliesSlot === undefined ? {} : { repliesSlot })}
      />
      <AttentionReferenceChips
        items={chipItems}
        onRemove={id => update(current => ({ chips: current.chips.filter(chip => chip !== id) }))}
      />
    </AttentionDeliveryContext.Provider>
  );

  const cardItem = cardId === null ? undefined : byId.get(cardId);
  const at = cardItem === undefined ? -1 : agenda.indexOf(cardItem);
  const previous = at > 0 ? agenda[at - 1] : undefined;
  const next = at >= 0 && at < agenda.length - 1 ? agenda[at + 1] : undefined;
  const card =
    cardItem === undefined ? null : (
      <div className="fy-agenda-card" data-agenda-card={cardItem.id}>
        <AttentionDeliveryContext.Provider value={deliveryState}>
          <AttentionFullCard
            busy={busyIds.has(cardItem.id)}
            error={typeof busy.get(cardItem.id) === 'string' ? (busy.get(cardItem.id) ?? null) : null}
            ferret={ferret}
            item={cardItem}
            key={cardItem.id}
            onAct={action => act(cardItem, action)}
            onAddReply={() => addReply(cardItem)}
            onClose={() => update(() => ({ card: null }))}
            position={{ index: at, total: agenda.length }}
            renderProse={proseText => <ChatProse copyable={copyWriter} text={proseText} />}
            swipeable={swipeable}
            {...(now === undefined ? {} : { now })}
            {...(previous === undefined ? {} : { onPrevious: () => update(() => ({ card: previous.id })) })}
            {...(next === undefined ? {} : { onNext: () => update(() => ({ card: next.id })) })}
            {...(client === undefined
              ? {}
              : {
                  onProgress: (step: number, done: boolean) =>
                    client.progress(connection, scope, cardItem.id, step, done),
                })}
          />
        </AttentionDeliveryContext.Provider>
      </div>
    );

  const side = !docked ? null : (
    <AttentionDeliveryContext.Provider value={deliveryState}>
      <AttentionAgendaPanel items={agenda} onClose={toggleDock} {...rows} />
    </AttentionDeliveryContext.Provider>
  );

  const dockButton =
    !desktop || !agendaMode ? null : (
      <button
        aria-pressed={dock}
        className="fy-agenda-dock"
        data-agenda-dock=""
        onClick={toggleDock}
        title={dock ? 'Undock the agenda' : 'Dock the agenda beside the chat'}
        type="button"
      >
        <PanelRight aria-hidden="true" size={16} />
        Agenda
      </button>
    );

  return {
    above,
    card,
    side,
    dockButton,
    references: () => chipsRef.current,
    composer: { onDraftChange, clearSignal, onSent },
  };
};
