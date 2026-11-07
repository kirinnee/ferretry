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
 *   closes without sending. ‹ › page through the agenda, ✕ / Esc go back.
 * - While an item is open the pill and the row's chips are hidden — only the composer stays under the view — and what
 *   is typed goes with the item's reference (`withReferencePrefix`), said in the composer's placeholder ("Reply to
 *   Piper…"). ✕ or Esc is plain chat. A send, or a quick-reply tap, sends AND closes the view, and the conversation
 *   returns to the new message. A quick reply carries the composer's text as its note.
 * - A FORM is filled in here exactly as in the Inbox: the same fields on the card, the same picks (the Inbox's key for
 *   the item), and the composer's Send answers it (`sendForm`) instead of chatting. The view stays until the answer
 *   lands, so a refusal is read on the card; once it has, a "Sent to …" line above the composer says what was picked.
 * - The same items, in four filters (Needs you · Resting · Snoozed · Resolved), are this ferret's Agenda tab in Info
 *   (`tab`): the agenda has no side bar of its own. Overview carries only a one-line count that opens the tab.
 * - `?agenda=A5` or `?attention=A5` (a notification tap, a proved `!A5`) arrives as a `focus` request, and EVERY id
 *   the ledger holds opens the same view, agenda mode or not: an open item to answer, a parked one with "Back to my
 *   list", a resolved one read-only (`agenda-settled.tsx`). A proved link is never a dead click; only an id the
 *   ledger does not hold is said out loud as no longer open.
 */

import type {
  AgendaId,
  AgendaItem,
  AgendaListRecord,
  AgendaListSnapshot,
  ResolvedAgendaItem,
} from '@ferretry/core-asks/contract';
import { CircleAlert, CircleCheck, X } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useAgendaInbox } from '../../hooks/use-agenda-inbox.ts';
import { type InboxAction, withAskVersion } from '../../lib/agenda-answers.ts';
import { cardModel } from '../../lib/agenda-card-model.ts';
import { agendaCounts, agendaItems } from '../../lib/agenda-chat.ts';
import { type AgendaTabFilter, agendaTabModel } from '../../lib/agenda-tab.ts';
import type { DaemonAgendaClient } from '../../lib/agenda-client.ts';
import { storedHistory } from '../../lib/agenda-conversation.ts';
import { sendForm } from '../../lib/agenda-form-send.ts';
import { itemHistory } from '../../lib/agenda-history.ts';
import { actionSentence, inboxCardKey, snoozeAction, UNSNOOZE_ACTION } from '../../lib/agenda-inbox.ts';
import { composerNoteFor, inputDraftDiscarded, withComposerNote } from '../../lib/agenda-reply.ts';
import { sendAgendaAction } from '../../lib/agenda-send.ts';
import { sortAgenda } from '../../lib/agenda-status.ts';
import type { AgendaLoadStatus } from '../../lib/agenda-store.ts';
import type { DaemonConnection } from '../../shell.ts';
import { type DaemonSessionScope, daemonSessionKey } from '../../shell.ts';
import { laneEditDestination } from '../../lib/lane-edit.ts';
import { composerQuoteTarget } from '../../shell.ts';
import type { TranscriptEntry } from '../../lib/transcript.ts';
import { RendererView, useOptionalRouter } from '../../shell.ts';
import { browserClipboardWriter } from '../../shell.ts';
import { askRendererFor, INPUT_RENDERER } from './ask-renderers.tsx';
import { agendaReference } from './agenda-board.tsx';
import { AgendaDeliveryContext, agendaHeading, deliveringIds } from './agenda-delivery.tsx';
import { AgendaItemView } from './agenda-item-view.tsx';
import { AgendaDrawer, AgendaLine } from './agenda-line.tsx';
import { agendaProse } from './agenda-prose.tsx';
import { AgendaSettled, isResolved } from './agenda-settled.tsx';
import { AgendaTab } from './agenda-tab.tsx';
import { useItemLifecycle } from './use-item-lifecycle.ts';
import { useAgendaItem } from './use-agenda-item.ts';

/**
 * An input card's form, drawn by the input-request owner's renderer (`ask:input`). While the card holds the view (a Send
 * on its way, a follow-up offer on screen) the view stays open, and a card that leaves the view (another version picked,
 * the view paged away) lets its hold go with it.
 *
 * GAP(input-hold): `onHold` is where the owner's card says it holds the view or is done (`settled`, in its own words).
 * No contract carries that from a renderer yet, so only this half calls it today: the hold the view keeps is the one
 * this card was told of, and it is let go when the card goes.
 */
export function AgendaInputCard({
  daemon,
  value,
  held,
  onHold,
}: {
  readonly daemon: string;
  readonly value: unknown;
  readonly held: boolean;
  readonly onHold: (held: boolean, settled?: string) => void;
}) {
  const latest = useRef({ held, onHold });
  latest.current = { held, onHold };
  useEffect(
    () => () => {
      if (latest.current.held) latest.current.onHold(false);
    },
    [],
  );
  return <RendererView daemon={daemon} rendererKey={INPUT_RENDERER} value={value} />;
}

/** What the chat sends of the agenda client, and nothing else of it. */
export type AgendaActionClient = Pick<
  DaemonAgendaClient,
  'dismiss' | 'respond' | 'resolve' | 'needsInfo' | 'discuss' | 'progress' | 'snooze' | 'unsnooze'
> &
  Partial<Pick<DaemonAgendaClient, 'merge'>>;

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

const locateAgenda = (snapshot: AgendaListSnapshot | null, id: AgendaId): AgendaLocation => {
  if (snapshot === null) return 'pending';
  if (snapshot.items.some(item => item.id === id)) return 'open';
  if (snapshot.resolved.some(item => item.id === id)) return 'resolved';
  return 'unknown';
};

/**
 * Every id in this session's Agenda LEDGER — open and resolved. This is what proves a `!A3`: an answered
 * item is still on the record, so a reference to it in older chat stays a link instead of decaying into prose.
 */
export const agendaLedgerIds = (snapshot: AgendaListSnapshot | null): readonly AgendaId[] =>
  snapshot === null ? [] : [...snapshot.items.map(item => item.id), ...snapshot.resolved.map(item => item.id)];

/** Ticks or unticks one step of an item on this session's machine, from its full card. */
const stepTicker =
  (client: AgendaActionClient, connection: DaemonConnection, scope: DaemonSessionScope, id: AgendaId) =>
  (step: number, done: boolean): Promise<void> =>
    client.progress(connection, scope, id, step, done);

const NO_ITEMS: readonly AgendaItem[] = [];
/** How long the "Sent to …" line of a form answered here stays above the composer. */
const SENT_FORM_MS = 12_000;

/**
 * An item the daemon closes the moment its request ends: an input card (typed, sent, cancelled or expired) and an
 * approve-on-phone card. Its view closes with it rather than sit on a closed record (#B147).
 */
const endsItself = (item: AgendaItem | ResolvedAgendaItem): boolean =>
  item.kind === 'input' || item.phoneApproval !== undefined;

/** What the line above the composer says when such an item closed under its open view. */
const endedWords = (item: ResolvedAgendaItem): string =>
  item.resolutionNote === null || item.resolutionNote.trim() === ''
    ? `${agendaReference(item.id)} is closed.`
    : `${agendaReference(item.id)} is closed. ${item.resolutionNote}`;
const NO_RECORDS: readonly AgendaListRecord[] = [];
const NO_HOLDS: ReadonlySet<AgendaId> = new Set();
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
  /** The board project this session works in, so a standing rule can be limited to it. */
  readonly projectId?: string;
  /** Absent when this host has no Attention subscription: nothing can be answered from here. */
  readonly client: AgendaActionClient | undefined;
  readonly snapshot: AgendaListSnapshot | null;
  readonly status: AgendaLoadStatus;
  /** The ferret works in agenda mode: only then does the chat draw an agenda. */
  readonly agendaMode: boolean;
  /** The ferret's spoken name, for "2 with Johnnie". */
  readonly ferret: string;
  /** The latest request to show one item; `null` while nothing was asked. */
  readonly focus?: AgendaFocus | null;
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
  /**
   * An item's card came up here, however it was opened (a row, a `!A3`, a notification tap, paging): its alerts come
   * down on this device and the owner's others (docs/notifications.md § When an alert is cleared).
   */
  readonly onItemOpened?: (daemon: DaemonConnection, sessionId: string, agendaId: string) => unknown;
  /**
   * Where Edit on a lane-proposal card goes: Board's lane editor for a project, spelt by the host (this half hard-codes
   * no Board path). Absent: the answer is sent and the page stays.
   */
  readonly laneEditor?: (projectId: string) => string | undefined;
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
  /** Shuts the drawer and the item view, leaving the conversation as it was. */
  readonly close: () => void;
  /** The line takes `live` itself, so the transcript must not draw it a second time. */
  readonly hostsLive: boolean;
  /** The line's slot for the transcript's Jump-to-latest pill; `null` while the line is not drawn. */
  readonly jumpHost: HTMLElement | null;
  /**
   * The ferret's agenda as Info's Agenda tab: four filters, each row opening the same view.
   * `afterOpen` runs when a row opened its card, so a phone's Info sheet can get out of the card's way; `lead` says
   * where a sub-ferret's items live. `null` while this ferret is not in agenda mode and its ledger is empty.
   */
  readonly tab: (afterOpen?: () => void, lead?: { readonly name: string; readonly open: () => void }) => ReactNode;
  /** The tab's counts for Overview's one line, each the length of that filter's rows; `null` where `tab` is. */
  readonly counts: (() => Readonly<Record<AgendaTabFilter, number>>) | null;
  /** The ids the next message is about: the open item. */
  readonly references: () => readonly AgendaId[];
  /** The composer's placeholder while an item is open ("Reply to Piper…"); absent in plain chat. */
  readonly placeholder: string | undefined;
  /** Wire this into the Composer: a message went, so the open item closes. */
  readonly composer: {
    readonly onSent: () => void;
    /** The open item is a form: Send answers it with this instead of chatting (`useFormComposer`). */
    readonly answerForm?: () => void;
    /** The open form's picks key, present with `answerForm`. */
    readonly formKey?: string;
    /** Escape in the composer goes back to the chat; absent while no item is open. */
    readonly onEscape?: () => void;
  };
}

export const useAgenda = ({
  connection,
  scope,
  projectId,
  client,
  snapshot,
  status,
  agendaMode,
  ferret,
  focus = null,
  repliesSlot,
  swipeable,
  live,
  entries = NO_ENTRIES,
  onAnswered,
  onItemOpened,
  laneEditor,
  now,
}: UseAgendaInput): Agenda => {
  const domId = useId();
  const router = useOptionalRouter();
  const drawerId = `${domId}-drawer`;
  const scopeKey = daemonSessionKey(scope);
  const board = snapshot?.items ?? NO_ITEMS;
  const records = snapshot?.resolved ?? NO_RECORDS;
  // What the owner can page through, whatever the mode: a `!A5` opens even when the chat draws no agenda line.
  const openItems = useMemo(() => sortAgenda(agendaItems(board)), [board]);
  const agenda = agendaMode ? openItems : NO_ITEMS;
  const byId = useMemo(() => new Map(openItems.map(item => [item.id, item])), [openItems]);

  // What was opened belongs to the conversation it was opened in.
  const [shown, setShown] = useState<{
    readonly key: string;
    readonly drawer: boolean;
    readonly card: AgendaId | null;
    readonly opening: number;
  }>({ key: scopeKey, drawer: false, card: null, opening: 0 });
  const here = shown.key === scopeKey ? shown : { key: scopeKey, drawer: false, card: null, opening: 0 };
  // Every change of the card shown is a NEW opening of the view: what an earlier opening saw or held is not this one's.
  const openings = useRef(0);
  const update = useCallback(
    (change: (current: typeof here) => Partial<typeof here>): void =>
      setShown(current => {
        const base = current.key === scopeKey ? current : { key: scopeKey, drawer: false, card: null, opening: 0 };
        const next = { ...base, ...change(base) };
        return next.card === base.card ? next : { ...next, opening: ++openings.current };
      }),
    [scopeKey],
  );

  // ANY ID THE LEDGER HOLDS: an open item to answer, a parked or notice one outside the pager, a resolved record.
  const selectedItem =
    here.card === null
      ? undefined
      : (byId.get(here.card) ??
        board.find(item => item.id === here.card) ??
        records.find(item => item.id === here.card));
  const detail = useAgendaItem(connection, scope, selectedItem);
  const shownItem = detail.item;
  const cardId = shownItem?.id ?? null;
  const closed = shownItem !== undefined && isResolved(shownItem);
  const aboutRef = useRef<readonly AgendaId[]>([]);
  // A resolved item is read-only: what is typed while it is open is plain chat.
  aboutRef.current = cardId === null || closed ? [] : [cardId];

  const [busy, setBusy] = useState<ReadonlyMap<AgendaId, string | null>>(new Map());
  const [announcement, setAnnouncement] = useState('');
  // A form answered from here, said above the composer once it has landed: the view closing is not the confirmation.
  const [sentForm, setSentForm] = useState<{
    readonly id: AgendaId;
    readonly text: string;
    readonly tone?: 'ok' | 'info';
  } | null>(null);
  useEffect(() => {
    if (sentForm === null) return undefined;
    const timer = setTimeout(() => setSentForm(null), SENT_FORM_MS);
    return () => clearTimeout(timer);
  }, [sentForm]);
  const [jumpHost, setJumpHost] = useState<HTMLElement | null>(null);
  // A form's Send is its answer, not a message: the view waits for the answer to land (`act` closes it).
  const answering = useRef(false);
  const onSent = useCallback((): void => {
    if (answering.current) {
      answering.current = false;
      return;
    }
    update(() => ({ card: null }));
  }, [update]);

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
    const sent = withAskVersion(withComposerNote(action, note), item);
    setCard(item.id, null);
    setAnnouncement('');
    sendAgendaAction(client, connection, scope, item.id, sent).then(
      () => {
        setCard(item.id, undefined);
        setAnnouncement(actionSentence(sent, item.id));
        if (sent.kind === 'respond' && sent.response.kind === 'form')
          setSentForm({ id: item.id, text: `Sent to ${ferret}: ${sent.label}` });
        if (note.trim() !== '' || inputDraftDiscarded(item, composer)) spendDraft(scope);
        // The answer is a message in the conversation: the view closes and the chat returns to it.
        update(current => (current.card === item.id ? { card: null } : {}));
        onAnswered?.();
        // Edit on a lane proposal: the answer is sent, now the editor opens.
        const editor = laneEditDestination(item, action, laneEditor);
        if (editor !== undefined) router?.navigate(editor);
      },
      (reason: unknown) => setCard(item.id, failure(reason)),
    );
  };

  // An input card holds its view while a Send from it is on its way or a follow-up offer is on screen (`onHold`).
  // Holds belong to the opening that made them: a card that went with its opening leaves nothing behind in the next.
  const [held, setHeld] = useState<{ readonly opening: number; readonly ids: ReadonlySet<AgendaId> }>({
    opening: here.opening,
    ids: new Set(),
  });
  const holding = held.opening === here.opening ? held.ids : NO_HOLDS;
  const latestOpening = useRef(here.opening);
  latestOpening.current = here.opening;
  // Whether the item was still open during THIS opening of the view: only then does it close by itself when it ends,
  // never a closed record the owner opened from the history to read, nor one opened again after it ended.
  const seenOpen = useRef<number | null>(null);
  if (selectedItem === undefined || seenOpen.current !== here.opening) seenOpen.current = null;
  if (shownItem !== undefined && !closed) seenOpen.current = here.opening;
  const closeEnded = (id: AgendaId, text: string, tone: 'ok' | 'info'): void => {
    update(current => (current.card === id ? { card: null } : {}));
    setSentForm({ id, text, tone });
    setAnnouncement(text);
    onAnswered?.();
  };
  const holdFor =
    (id: AgendaId) =>
    (isHeld: boolean, settled?: string): void => {
      const opening = here.opening;
      // A card from an earlier opening speaks for nothing now.
      if (opening !== latestOpening.current) return;
      setHeld(current => {
        const ids = current.opening === opening ? current.ids : NO_HOLDS;
        if (ids.has(id) === isHeld) return current.opening === opening ? current : { opening, ids };
        const next = new Set(ids);
        if (isHeld) next.add(id);
        else next.delete(id);
        return { opening, ids: next };
      });
      // Sent from here with nothing more to show: the card's own words, at once, before any board says so.
      if (!isHeld && settled !== undefined) closeEnded(id, settled, 'ok');
    };
  const ended =
    shownItem !== undefined &&
    isResolved(shownItem) &&
    endsItself(shownItem) &&
    seenOpen.current === here.opening &&
    !holding.has(shownItem.id)
      ? shownItem
      : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the item that ended under the view is the one trigger
  useEffect(() => {
    if (ended !== undefined) closeEnded(ended.id, endedWords(ended), 'info');
  }, [ended?.id]);

  const openCard = (item: AgendaItem | AgendaListRecord): void => {
    setSentForm(null);
    update(() => ({ card: item.id, drawer: false }));
  };

  // A REQUEST IS HONOURED ONCE, when it can be: after the board that says where the item is has been read.
  const handled = useRef<number | null>(null);
  const focusTarget = focus?.target ?? null;
  const focusSeq = focus?.seq ?? null;
  const focusOnEntry = focus?.onEntry === true;
  // The item a link or a notification tap opened: it opens at its ask, so the owner lands on what to do.
  const [askAt, setAskAt] = useState<{ readonly id: AgendaId; readonly tap: number } | null>(null);
  // Paging or closing leaves the item the request was for: the next time the owner opens one it starts at the top.
  const askedFor = askAt?.id;
  useEffect(() => {
    if (askedFor !== undefined && here.card !== askedFor) setAskAt(null);
  }, [askedFor, here.card]);
  const inbox = useAgendaInbox();
  const howToTestFor = useCallback(
    (card: string): string | null | undefined => inbox?.howToTestFor?.(connection.daemonId, card),
    [inbox, connection.daemonId],
  );
  const location = focusTarget === null ? null : locateAgenda(snapshot, focusTarget);
  useEffect(() => {
    if (focusTarget === null || focusSeq === null || handled.current === focusSeq) return;
    if (location === 'pending') return;
    handled.current = focusSeq;
    if (location === 'unknown') return;
    setAskAt(focusOnEntry ? { id: focusTarget, tap: focusSeq } : null);
    update(() => ({ card: focusTarget, drawer: false }));
  }, [focusTarget, focusSeq, focusOnEntry, location, update]);
  const missing = focusTarget !== null && location === 'unknown';

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
      {sentForm === null ? null : (
        <p className="fy-agenda-note" data-agenda-sent={sentForm.id} data-tone={sentForm.tone ?? 'ok'}>
          {sentForm.tone === 'info' ? (
            <CircleAlert aria-hidden="true" size={14} />
          ) : (
            <CircleCheck aria-hidden="true" size={14} />
          )}
          <span className="fy-agenda-note__text">{sentForm.text}</span>
          <button
            aria-label="Dismiss"
            className="fy-agenda-note__close"
            onClick={() => setSentForm(null)}
            type="button"
          >
            <X aria-hidden="true" size={14} />
          </button>
        </p>
      )}
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
        jumpSlot={setJumpHost}
        open={drawerOpen}
        sending={{ count: sendingCount, headings: sendingHeadings }}
        {...(counts === undefined || cardId !== null ? {} : { counts })}
        {...(live === undefined ? {} : { live })}
        {...(repliesSlot === undefined ? {} : { repliesSlot })}
      />
    </AgendaDeliveryContext.Provider>
  );

  const cardItem = shownItem;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the item whose card came up, on this board, is the one trigger
  useEffect(() => {
    if (cardItem !== undefined) onItemOpened?.(connection, scope.sessionId, cardItem.id);
  }, [cardItem?.id, scopeKey]);
  // Only an open item pages; a parked, notice or resolved one is shown on its own.
  const paged = cardItem !== undefined && !isResolved(cardItem) ? openItems.indexOf(cardItem) : -1;
  const previous = paged > 0 ? openItems[paged - 1] : undefined;
  const next = paged >= 0 && paged < openItems.length - 1 ? openItems[paged + 1] : undefined;
  const lifecycle = useItemLifecycle({ connection, scope, client, item: cardItem, board: openItems, records });
  const history = useMemo(
    () =>
      cardItem === undefined
        ? []
        : lifecycle.conversation === null
          ? itemHistory(cardItem, entries)
          : storedHistory(cardItem, lifecycle.conversation, lifecycle.conversationGap),
    [cardItem, entries, lifecycle.conversation, lifecycle.conversationGap],
  );
  const cardError = cardItem === undefined ? null : busy.get(cardItem.id);
  // A question the owner replied to is not answered by the reply: its options stay live under the "replied" line.
  const questionKept =
    cardItem !== undefined &&
    !closed &&
    cardItem.parked?.reason === 'replied' &&
    cardModel(cardItem).shape !== 'info' &&
    cardModel(cardItem).shape !== 'input';
  // An input card that holds the view keeps its form on screen, closed or not: what it says after a Send is in there.
  const cardHeld = cardItem !== undefined && holding.has(cardItem.id);
  const standing =
    cardItem === undefined || cardHeld || (!closed && cardItem.parked === undefined) ? undefined : (
      <AgendaSettled
        busy={busyIds.has(cardItem.id)}
        error={typeof cardError === 'string' ? cardError : null}
        ferret={ferret}
        item={cardItem}
        {...(now === undefined ? {} : { now })}
        {...(client === undefined || closed ? {} : { onBringBack: () => act(cardItem, UNSNOOZE_ACTION, '') })}
      />
    );
  // The card's fields are live wherever the composer's Send can answer them: an open (or replied-to) form, with a client.
  const formItem =
    cardItem !== undefined &&
    !closed &&
    client !== undefined &&
    cardItem.kind === 'form' &&
    (standing === undefined || questionKept)
      ? cardItem
      : undefined;
  const formKey = formItem === undefined ? undefined : inboxCardKey(connection.daemonId, scope.sessionId, formItem.id);
  const answerForm =
    formItem === undefined || formKey === undefined
      ? undefined
      : (): void =>
          sendForm(formKey, formItem, composerDraft(scope), action => {
            answering.current = true;
            act(formItem, action, '');
          });
  // What another plugin draws inside the card: its owner's renderer, by key (§5.2), never that owner's component.
  const owned =
    cardItem === undefined
      ? undefined
      : askRendererFor(cardItem, { ferret: scope.sessionId, ferretName: ferret, projectId });
  const ownerForms =
    cardItem === undefined || owned === undefined
      ? {}
      : owned.slot === 'input'
        ? {
            inputForm: (
              <AgendaInputCard
                daemon={connection.daemonId}
                held={holding.has(cardItem.id)}
                onHold={holdFor(cardItem.id)}
                value={owned.value}
              />
            ),
          }
        : {
            planForm: <RendererView daemon={connection.daemonId} rendererKey={owned.key} value={owned.value} />,
          };
  const view =
    cardItem === undefined ? (
      selectedItem === undefined ? null : (
        <div
          className="fy-item-view"
          data-agenda-item-reading=""
          role="dialog"
          aria-modal="true"
          aria-label={selectedItem.title ?? selectedItem.subject}
        >
          <p role={detail.error === undefined ? 'status' : 'alert'}>{detail.error ?? 'Reading agenda item…'}</p>
          {detail.error === undefined ? null : (
            <button type="button" onClick={detail.retry}>
              Try again
            </button>
          )}
          <button type="button" onClick={() => update(() => ({ card: null }))}>
            Close
          </button>
        </div>
      )
    ) : (
      <AgendaDeliveryContext.Provider value={deliveryState}>
        <AgendaItemView
          busy={busyIds.has(cardItem.id)}
          error={typeof cardError === 'string' ? cardError : null}
          ferret={ferret}
          history={history}
          item={cardItem}
          itemKey={inboxCardKey(connection.daemonId, scope.sessionId, cardItem.id)}
          key={cardItem.id}
          {...(lifecycle.versions === undefined ? {} : { versions: lifecycle.versions })}
          {...(lifecycle.merge === undefined ? {} : { merge: lifecycle.merge })}
          {...(lifecycle.lineageTitles === undefined ? {} : { lineageTitles: lifecycle.lineageTitles })}
          {...(askAt?.id === cardItem.id ? { startAt: 'ask' as const, startTap: askAt.tap } : {})}
          howToTestFor={howToTestFor}
          onAct={action => act(cardItem, action, composerDraft(scope))}
          onClose={() => update(() => ({ card: null }))}
          position={paged >= 0 ? { index: paged, total: openItems.length } : { index: 0, total: 1 }}
          renderProse={agendaProse(copyWriter)}
          {...(formKey === undefined ? {} : { formKey })}
          {...ownerForms}
          swipeable={swipeable}
          {...(standing === undefined || questionKept
            ? // A ferret's rule suggestion is never snoozed: the ferret reads its own board (C2).
              cardItem.signInRuleSuggestion === undefined
              ? { onSnooze: (until: string) => act(cardItem, snoozeAction(until), '') }
              : {}
            : { settled: standing })}
          {...(standing !== undefined && questionKept ? { parkedNote: standing } : {})}
          {...(now === undefined ? {} : { now })}
          {...(previous === undefined ? {} : { onPrevious: () => update(() => ({ card: previous.id })) })}
          {...(next === undefined ? {} : { onNext: () => update(() => ({ card: next.id })) })}
          {...(client === undefined || closed
            ? {}
            : { onProgress: stepTicker(client, connection, scope, cardItem.id) })}
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

  const hasTab = agendaMode || board.some(item => item.notice !== true) || records.length > 0;
  const modelNow = (): ReturnType<typeof agendaTabModel> =>
    agendaTabModel({ items: board, resolved: records, ferret, now: now ?? Date.now() });
  const tab = (afterOpen?: () => void, lead?: { readonly name: string; readonly open: () => void }): ReactNode =>
    hasTab ? (
      <AgendaDeliveryContext.Provider value={deliveryState}>
        <AgendaTab
          model={modelNow()}
          onOpen={item => {
            openCard(item);
            afterOpen?.();
          }}
          {...(lead === undefined ? {} : { lead })}
        />
      </AgendaDeliveryContext.Provider>
    ) : null;
  const tabCounts = hasTab
    ? () => {
        const { rows } = modelNow();
        return {
          'needs-you': rows['needs-you'].length,
          resting: rows.resting.length,
          snoozed: rows.snoozed.length,
          resolved: rows.resolved.length,
        };
      }
    : null;

  return {
    above,
    view,
    scrim,
    covered: selectedItem !== undefined,
    close: () => update(() => ({ drawer: false, card: null })),
    hostsLive,
    jumpHost,
    tab,
    counts: tabCounts,
    references: () => aboutRef.current,
    placeholder:
      cardId === null || closed
        ? undefined
        : formItem === undefined
          ? `Reply to ${ferret}…`
          : `Anything else for ${ferret}?`,
    composer: {
      onSent,
      ...(answerForm === undefined || formKey === undefined ? {} : { answerForm, formKey }),
      ...(cardId === null ? {} : { onEscape: () => update(() => ({ card: null })) }),
    },
  };
};
