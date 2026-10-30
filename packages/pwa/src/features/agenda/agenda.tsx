/**
 * A FERRET'S AGENDA INSIDE ITS CHAT. Nothing overlays the conversation without a tap and the composer never
 * moves: everything here is a SIBLING of the composer, drawn above it, or a layer over the transcript only.
 *
 * The agenda exists only while the ferret works in agenda mode (`agendaMode`, a switchable instruction
 * section, off by default). With it off the chat has no agenda line; what is on its way ("Sending…") still
 * shows on its own slim row. Plain notifications belong to the Inbox, never to the agenda.
 *
 * - ONE ROW above the composer: what is running on its left, the agenda pill on its right. The pill opens a
 *   raised DRAWER of rows (blocking → needs you → ferret's turn) over a scrim on the chat; every row is one button.
 * - A row opens the item's VIEW: an OVERLAY over the MESSAGE LIST only (`agenda-item-view.tsx`) — sticky title and
 *   ask, one scrolling body, the quick replies directly above the composer. The row and the REAL composer stay
 *   visible and typeable. The transcript stays mounted underneath, so it is exactly where it was when the view
 *   closes without sending. ‹ › page through the agenda, ✕ / Esc / ↓ go back.
 * - While an item is open the pill and the row's chips are hidden — only the composer stays under the view — and what
 *   is typed goes with the item's reference (`withReferencePrefix`), said in the composer's placeholder ("Reply about
 *   !A5…"). ✕ or Esc is plain chat. A send, or a quick-reply tap, sends AND closes the view, and the conversation
 *   returns to the new message. A quick reply carries the composer's text as its note.
 * - The same rows are also a section of Info (`section`): the agenda has no side bar of its own.
 * - `?agenda=A5` or `?attention=A5` (a notification tap, a proved `!A5`) arrives as a `focus` request: an open
 *   item opens its card, a resolved one opens in the resolved list, and an id the board does not hold is said
 *   out loud.
 */

import type { AgendaId, AgendaItem, AgendaSnapshot } from '@ferretry/protocol';
import { CircleAlert } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChatProse } from '../../components/chat-prose.tsx';
import type { InboxAction } from '../../lib/agenda-answers.ts';
import { agendaCounts, agendaItems } from '../../lib/agenda-chat.ts';
import type { DaemonAgendaClient } from '../../lib/agenda-client.ts';
import { sendAgendaAction } from '../../lib/agenda-send.ts';
import { itemHistory } from '../../lib/agenda-history.ts';
import { actionSentence, snoozeAction } from '../../lib/agenda-inbox.ts';
import { composerNoteFor, inputDraftDiscarded, withComposerNote } from '../../lib/agenda-reply.ts';
import { sortAgenda } from '../../lib/agenda-status.ts';
import type { AgendaLoadStatus } from '../../lib/agenda-store.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionKey } from '../../lib/daemon-scope.ts';
import { laneEditDestination } from '../../lib/lane-proposal-link.ts';
import { composerQuoteTarget } from '../../lib/quote.ts';
import { useOptionalRouter } from '../../lib/router.tsx';
import type { TranscriptEntry } from '../../lib/session-screens.ts';
import { browserClipboardWriter } from '../onboarding/copy-button.tsx';
import { agendaReference } from './agenda-board.tsx';
import { AgendaDeliveryContext, agendaHeading, deliveringIds } from './agenda-delivery.tsx';
import { AgendaItemView } from './agenda-item-view.tsx';
import { AgendaDrawer, AgendaLine, AgendaPanelBody } from './agenda-line.tsx';

/** What the chat sends of the agenda client, and nothing else of it. */
export type AgendaActionClient = Pick<
  DaemonAgendaClient,
  'dismiss' | 'respond' | 'resolve' | 'needsInfo' | 'discuss' | 'progress' | 'snooze' | 'unsnooze'
>;

/** A request to show one item. `seq` makes a repeated request a new one. */
export interface AgendaFocus {
  readonly target: AgendaId | null;
  readonly seq: number;
  /**
   * The request arrived WITH the page (a `?agenda=` link, a notification tap), not from the owner clicking a
   * reference. Entering a chat shows only what is open: such a request never opens the resolved list.
   */
  readonly onEntry?: boolean;
}

/** Where an id sits on a board: answerable, on the record, absent, or not known until the board is read. */
type AgendaLocation = 'open' | 'resolved' | 'unknown' | 'pending';

const locateAgenda = (snapshot: AgendaSnapshot | null, id: AgendaId): AgendaLocation => {
  if (snapshot === null) return 'pending';
  if (snapshot.items.some(item => item.id === id)) return 'open';
  if (snapshot.resolved.some(item => item.id === id)) return 'resolved';
  return 'unknown';
};

/**
 * Every id in this session's Agenda LEDGER — open and resolved. This is what proves a `!A3`: an answered
 * item is still on the record, so a reference to it in older chat stays a link instead of decaying into prose.
 */
export const agendaLedgerIds = (snapshot: AgendaSnapshot | null): readonly AgendaId[] =>
  snapshot === null ? [] : [...snapshot.items.map(item => item.id), ...snapshot.resolved.map(item => item.id)];

/** Ticks or unticks one step of an item on this session's machine, from its full card. */
const stepTicker =
  (client: AgendaActionClient, connection: DaemonConnection, scope: DaemonSessionScope, id: AgendaId) =>
  (step: number, done: boolean): Promise<void> =>
    client.progress(connection, scope, id, step, done);

const NO_ITEMS: readonly AgendaItem[] = [];
const NO_ENTRIES: readonly TranscriptEntry[] = [];
const copyWriter = browserClipboardWriter();

/** What is typed in the composer right now: an answer carries it as its note. */
const composerDraft = (scope: DaemonSessionScope): string => composerQuoteTarget(scope)?.draft() ?? '';

/** The note an answer took is spent: the composer is emptied. */
const spendDraft = (scope: DaemonSessionScope): void => composerQuoteTarget(scope)?.replaceDraft('');

const failure = (reason: unknown): string =>
  reason instanceof Error ? reason.message : 'The machine did not accept this answer.';

export interface UseAgendaInput {
  readonly connection: DaemonConnection;
  readonly scope: DaemonSessionScope;
  /** Absent when this host has no Attention subscription: nothing can be answered from here. */
  readonly client: AgendaActionClient | undefined;
  readonly snapshot: AgendaSnapshot | null;
  readonly status: AgendaLoadStatus;
  /** The ferret works in agenda mode: only then does the chat draw an agenda. */
  readonly agendaMode: boolean;
  /** The ferret's spoken name, for "2 with Johnnie". */
  readonly ferret: string;
  /** The latest request to show one item; `null` while nothing was asked. */
  readonly focus?: AgendaFocus | null;
  /** A request named a resolved item: open the resolved list at it. */
  readonly onOpenResolved?: (id: AgendaId) => void;
  /** Drawn on the line's right while the machine holds answers ("Sending in 8 s… / Send now"). */
  readonly repliesSlot?: ReactNode;
  /** The primary pointer is touch: the card can be swiped. */
  readonly swipeable: boolean;
  /** What is running ("Pondering… 11s"), for the line's left half. Drawn there only while the line exists. */
  readonly live?: ReactNode;
  /** The conversation, so an item's view can show what was said about it. */
  readonly entries?: readonly TranscriptEntry[];
  /** An answer went and the view closed: the conversation returns to the newest message. */
  readonly onAnswered?: () => void;
  readonly now?: number;
}

export interface Agenda {
  /** The drawer, the line and the chips, in that order — siblings above the composer. `null`: nothing to say. */
  readonly above: ReactNode;
  /** The open item's view: an overlay over the message list only. */
  readonly view: ReactNode;
  /** The scrim behind the open drawer, over the chat only. */
  readonly scrim: ReactNode;
  /** A view is open: the message list underneath is hidden from sight and from the keyboard, but stays mounted. */
  readonly covered: boolean;
  /** The line takes `live` itself, so the transcript must not draw it a second time. */
  readonly hostsLive: boolean;
  /**
   * The ferret's agenda as a section of Info: the same rows as the drawer, under no header of their own.
   * `afterOpen` runs when a row opened its card, so a phone's Info sheet can get out of the card's way.
   * `null` while this ferret is not in agenda mode.
   */
  readonly section: (afterOpen?: () => void) => ReactNode;
  /** The ids the next message is about: the open item. */
  readonly references: () => readonly AgendaId[];
  /** The composer's placeholder while an item is open ("Reply about !A57…"); absent in plain chat. */
  readonly placeholder: string | undefined;
  /** Wire this into the Composer: a message went, so the open item closes. */
  readonly composer: {
    readonly onSent: () => void;
    /** Escape in the composer goes back to the chat; absent while no item is open. */
    readonly onEscape?: () => void;
  };
}

export const useAgenda = ({
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
  swipeable,
  live,
  entries = NO_ENTRIES,
  onAnswered,
  now,
}: UseAgendaInput): Agenda => {
  const domId = useId();
  const router = useOptionalRouter();
  const drawerId = `${domId}-drawer`;
  const scopeKey = daemonSessionKey(scope);
  const board = snapshot?.items ?? NO_ITEMS;
  const agenda = useMemo(() => (agendaMode ? sortAgenda(agendaItems(board)) : NO_ITEMS), [agendaMode, board]);
  const byId = useMemo(() => new Map(agenda.map(item => [item.id, item])), [agenda]);

  // What was opened belongs to the conversation it was opened in.
  const [shown, setShown] = useState<{
    readonly key: string;
    readonly drawer: boolean;
    readonly card: AgendaId | null;
  }>({ key: scopeKey, drawer: false, card: null });
  const here = shown.key === scopeKey ? shown : { key: scopeKey, drawer: false, card: null };
  const update = useCallback(
    (change: (current: typeof here) => Partial<typeof here>): void =>
      setShown(current => {
        const base = current.key === scopeKey ? current : { key: scopeKey, drawer: false, card: null };
        return { ...base, ...change(base) };
      }),
    [scopeKey],
  );

  const cardId = here.card !== null && byId.has(here.card) ? here.card : null;
  const aboutRef = useRef<readonly AgendaId[]>([]);
  aboutRef.current = cardId === null ? [] : [cardId];

  const [busy, setBusy] = useState<ReadonlyMap<AgendaId, string | null>>(new Map());
  const [announcement, setAnnouncement] = useState('');
  const onSent = useCallback((): void => update(() => ({ card: null })), [update]);

  const setCard = useCallback((id: AgendaId, state: string | null | undefined): void => {
    setBusy(current => {
      const next = new Map(current);
      if (state === undefined) next.delete(id);
      else next.set(id, state);
      return next;
    });
  }, []);

  const act = (item: AgendaItem, action: InboxAction, composer: string): void => {
    if (client === undefined || busy.get(item.id) === null) return;
    const note = composerNoteFor(item, composer);
    const sent = withComposerNote(action, note);
    setCard(item.id, null);
    setAnnouncement('');
    sendAgendaAction(client, connection, scope, item.id, sent).then(
      () => {
        setCard(item.id, undefined);
        setAnnouncement(actionSentence(sent, item.id));
        if (note.trim() !== '' || inputDraftDiscarded(item, composer)) spendDraft(scope);
        // The answer is a message in the conversation: the view closes and the chat returns to it.
        update(current => (current.card === item.id ? { card: null } : {}));
        onAnswered?.();
        // Edit on a lane proposal: the answer is sent, now the editor opens.
        const editor = laneEditDestination(connection.daemonId, item, action);
        if (editor !== undefined) router?.navigate(editor);
      },
      (reason: unknown) => setCard(item.id, failure(reason)),
    );
  };

  const openCard = (item: AgendaItem): void => update(() => ({ card: item.id, drawer: false }));

  // A REQUEST IS HONOURED ONCE, when it can be: after the board that says where the item is has been read.
  const handled = useRef<number | null>(null);
  const focusTarget = focus?.target ?? null;
  const focusSeq = focus?.seq ?? null;
  const location = focusTarget === null ? null : locateAgenda(snapshot, focusTarget);
  const inAgenda = focusTarget !== null && byId.has(focusTarget);
  const isNotice = focusTarget !== null && board.some(item => item.id === focusTarget && item.notice === true);
  useEffect(() => {
    if (focusTarget === null || focusSeq === null || handled.current === focusSeq) return;
    if (location === 'pending') return;
    handled.current = focusSeq;
    if (location === 'resolved') {
      if (focus?.onEntry !== true) onOpenResolved?.(focusTarget);
    } else if (location === 'open' && inAgenda) update(() => ({ card: focusTarget, drawer: false, plain: false }));
  }, [focusTarget, focusSeq, focus?.onEntry, location, inAgenda, onOpenResolved, update]);
  const missing =
    agendaMode &&
    focusTarget !== null &&
    (location === 'unknown' || (location === 'resolved' && focus?.onEntry === true)) &&
    !isNotice;

  const delivering = useMemo(() => deliveringIds(snapshot), [snapshot]);
  const sendingHeadings = [...delivering].flatMap(id => {
    const entry = board.find(open => open.id === id) ?? snapshot?.resolved.find(done => done.id === id);
    return entry === undefined ? [] : [agendaHeading(entry)];
  });
  const deliveryState = useMemo(() => ({ sending: delivering, ferret }), [delivering, ferret]);
  const busyIds = useMemo(() => new Set([...busy].filter(([, state]) => state === null).map(([id]) => id)), [busy]);

  const loading = snapshot === null && (status === 'idle' || status === 'loading');
  const unavailable = agendaMode && snapshot === null && status === 'error';
  const parseErrors = agendaMode ? (snapshot?.parseErrors ?? 0) : 0;
  const counts = agendaMode && agenda.length > 0 ? agendaCounts(agenda) : undefined;
  const drawerOpen = here.drawer && counts !== undefined;
  const closeDrawer = (): void => update(() => ({ drawer: false }));
  const sendingCount = repliesSlot === undefined ? delivering.size : 0;
  const hostsLive = !loading && (counts !== undefined || repliesSlot !== undefined || sendingCount > 0);

  const rows = {
    ferret,
    onOpen: openCard,
    ...(now === undefined ? {} : { now }),
  };

  const above = loading ? (
    <p aria-live="polite" className="sr-only" role="status">
      {announcement}
    </p>
  ) : (
    <AgendaDeliveryContext.Provider value={deliveryState}>
      <p aria-live="polite" className="sr-only" role="status">
        {announcement}
      </p>
      {drawerOpen ? (
        <AgendaDrawer counts={counts} id={drawerId} items={agenda} onClose={closeDrawer} {...rows} />
      ) : null}
      {missing && focusTarget !== null ? (
        <p className="fy-agenda-note" data-agenda-missing={focusTarget} role="status">
          <CircleAlert aria-hidden="true" size={14} />
          {agendaReference(focusTarget)} is no longer open.
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
      <AgendaLine
        controls={drawerId}
        ferret={ferret}
        onToggle={() => update(current => ({ drawer: !current.drawer }))}
        open={drawerOpen}
        sending={{ count: sendingCount, headings: sendingHeadings }}
        {...(counts === undefined || cardId !== null ? {} : { counts })}
        {...(live === undefined ? {} : { live })}
        {...(repliesSlot === undefined ? {} : { repliesSlot })}
      />
    </AgendaDeliveryContext.Provider>
  );

  const cardItem = cardId === null ? undefined : byId.get(cardId);
  const at = cardItem === undefined ? -1 : agenda.indexOf(cardItem);
  const previous = at > 0 ? agenda[at - 1] : undefined;
  const next = at >= 0 && at < agenda.length - 1 ? agenda[at + 1] : undefined;
  const history = useMemo(() => (cardItem === undefined ? [] : itemHistory(cardItem, entries)), [cardItem, entries]);
  const view =
    cardItem === undefined ? null : (
      <AgendaDeliveryContext.Provider value={deliveryState}>
        <AgendaItemView
          busy={busyIds.has(cardItem.id)}
          error={typeof busy.get(cardItem.id) === 'string' ? (busy.get(cardItem.id) ?? null) : null}
          ferret={ferret}
          history={history}
          item={cardItem}
          key={cardItem.id}
          onAct={action => act(cardItem, action, composerDraft(scope))}
          onClose={() => update(() => ({ card: null }))}
          onSnooze={until => act(cardItem, snoozeAction(until), '')}
          position={{ index: at, total: agenda.length }}
          quoteScope={scope}
          renderProse={proseText => <ChatProse copyable={copyWriter} text={proseText} />}
          swipeable={swipeable}
          {...(now === undefined ? {} : { now })}
          {...(previous === undefined ? {} : { onPrevious: () => update(() => ({ card: previous.id })) })}
          {...(next === undefined ? {} : { onNext: () => update(() => ({ card: next.id })) })}
          {...(client === undefined ? {} : { onProgress: stepTicker(client, connection, scope, cardItem.id) })}
        />
      </AgendaDeliveryContext.Provider>
    );

  const scrim = drawerOpen ? (
    <button
      aria-label="Close the agenda"
      className="fy-agenda-scrim"
      data-agenda-scrim=""
      onClick={closeDrawer}
      tabIndex={-1}
      type="button"
    />
  ) : null;

  const section = (afterOpen?: () => void): ReactNode =>
    !agendaMode ? null : (
      <AgendaDeliveryContext.Provider value={deliveryState}>
        <AgendaPanelBody
          items={agenda}
          {...rows}
          onOpen={item => {
            openCard(item);
            afterOpen?.();
          }}
        />
      </AgendaDeliveryContext.Provider>
    );

  return {
    above,
    view,
    scrim,
    covered: cardItem !== undefined,
    hostsLive,
    section,
    references: () => aboutRef.current,
    placeholder: cardId === null ? undefined : `Reply about ${agendaReference(cardId)}…`,
    composer: { onSent, ...(cardId === null ? {} : { onEscape: () => update(() => ({ card: null })) }) },
  };
};
