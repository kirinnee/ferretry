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
 * - The same rows, with the parked and resolved ones, are this ferret's one list in Info (`section`): the agenda has
 *   no side bar of its own.
 * - `?agenda=A5` or `?attention=A5` (a notification tap, a proved `!A5`) arrives as a `focus` request, and EVERY id
 *   the ledger holds opens the same view, agenda mode or not: an open item to answer, a parked one with "Back to my
 *   list", a resolved one read-only (`agenda-settled.tsx`). A proved link is never a dead click; only an id the
 *   ledger does not hold is said out loud as no longer open.
 */

import type { AgendaId, AgendaItem, AgendaSnapshot, ResolvedAgendaItem } from '@ferretry/protocol';
import { CircleAlert } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { InboxAction } from '../../lib/agenda-answers.ts';
import { cardModel } from '../../lib/agenda-card-model.ts';
import { agendaCounts, agendaItems } from '../../lib/agenda-chat.ts';
import type { DaemonAgendaClient } from '../../lib/agenda-client.ts';
import { itemHistory } from '../../lib/agenda-history.ts';
import { actionSentence, snoozeAction, UNSNOOZE_ACTION } from '../../lib/agenda-inbox.ts';
import { composerNoteFor, inputDraftDiscarded, withComposerNote } from '../../lib/agenda-reply.ts';
import { sendAgendaAction } from '../../lib/agenda-send.ts';
import { sortAgenda } from '../../lib/agenda-status.ts';
import type { AgendaLoadStatus } from '../../lib/agenda-store.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionKey } from '../../lib/daemon-scope.ts';
import { laneEditDestination } from '../../lib/lane-proposal-link.ts';
import { composerQuoteTarget } from '../../lib/quote.ts';
import { useOptionalRouter } from '../../lib/router.tsx';
import type { TranscriptEntry } from '../../lib/session-screens.ts';
import { InputCardHost } from '../input-request/input-card-host.tsx';
import { PhoneApprovalHost } from '../input-request/phone-approval-host.tsx';
import { TwoFactorSeedHost } from '../input-request/two-factor-seed-host.tsx';
import { browserClipboardWriter } from '../onboarding/copy-button.tsx';
import { CopyPlanHost } from '../secure-copy/copy-plan-host.tsx';
import { SignInRuleSuggestionHost } from '../secure-copy/sign-in-rule-suggestion-host.tsx';
import { TaskPlanHost } from '../secure-copy/task-plan-host.tsx';
import { agendaReference } from './agenda-board.tsx';
import { AgendaDeliveryContext, agendaHeading, deliveringIds } from './agenda-delivery.tsx';
import { AgendaInfoList } from './agenda-info-list.tsx';
import { AgendaItemView } from './agenda-item-view.tsx';
import { AgendaDrawer, AgendaLine } from './agenda-line.tsx';
import { agendaProse } from './agenda-prose.tsx';
import { byNewestResolution } from './agenda-resolved.tsx';
import { AgendaSettled, isResolved } from './agenda-settled.tsx';

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
const NO_RECORDS: readonly ResolvedAgendaItem[] = [];
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
  /** Shuts the drawer and the item view, leaving the conversation as it was. */
  readonly close: () => void;
  /** The line takes `live` itself, so the transcript must not draw it a second time. */
  readonly hostsLive: boolean;
  /** The line's slot for the transcript's Jump-to-latest pill; `null` while the line is not drawn. */
  readonly jumpHost: HTMLElement | null;
  /**
   * The ferret's agenda as its one list in Info: open, parked and resolved, each row opening the same view.
   * `afterOpen` runs when a row opened its card, so a phone's Info sheet can get out of the card's way.
   * `null` while this ferret is not in agenda mode and its ledger is empty.
   */
  readonly section: (afterOpen?: () => void) => ReactNode;
  /** The ids the next message is about: the open item. */
  readonly references: () => readonly AgendaId[];
  /** The composer's placeholder while an item is open ("Reply to Piper…"); absent in plain chat. */
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

  // ANY ID THE LEDGER HOLDS: an open item to answer, a parked or notice one outside the pager, a resolved record.
  const shownItem: AgendaItem | ResolvedAgendaItem | undefined =
    here.card === null
      ? undefined
      : (byId.get(here.card) ??
        board.find(item => item.id === here.card) ??
        records.find(item => item.id === here.card));
  const cardId = shownItem?.id ?? null;
  const closed = shownItem !== undefined && isResolved(shownItem);
  const aboutRef = useRef<readonly AgendaId[]>([]);
  // A resolved item is read-only: what is typed while it is open is plain chat.
  aboutRef.current = cardId === null || closed ? [] : [cardId];

  const [busy, setBusy] = useState<ReadonlyMap<AgendaId, string | null>>(new Map());
  const [announcement, setAnnouncement] = useState('');
  const [jumpHost, setJumpHost] = useState<HTMLElement | null>(null);
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

  const openCard = (item: AgendaItem | ResolvedAgendaItem): void => update(() => ({ card: item.id, drawer: false }));

  // A REQUEST IS HONOURED ONCE, when it can be: after the board that says where the item is has been read.
  const handled = useRef<number | null>(null);
  const focusTarget = focus?.target ?? null;
  const focusSeq = focus?.seq ?? null;
  const location = focusTarget === null ? null : locateAgenda(snapshot, focusTarget);
  useEffect(() => {
    if (focusTarget === null || focusSeq === null || handled.current === focusSeq) return;
    if (location === 'pending') return;
    handled.current = focusSeq;
    if (location !== 'unknown') update(() => ({ card: focusTarget, drawer: false }));
  }, [focusTarget, focusSeq, location, update]);
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
  // Only an open item pages; a parked, notice or resolved one is shown on its own.
  const paged = cardItem !== undefined && !isResolved(cardItem) ? openItems.indexOf(cardItem) : -1;
  const previous = paged > 0 ? openItems[paged - 1] : undefined;
  const next = paged >= 0 && paged < openItems.length - 1 ? openItems[paged + 1] : undefined;
  const history = useMemo(() => (cardItem === undefined ? [] : itemHistory(cardItem, entries)), [cardItem, entries]);
  const cardError = cardItem === undefined ? null : busy.get(cardItem.id);
  // A question the owner replied to is not answered by the reply: its options stay live under the "replied" line.
  const questionKept =
    cardItem !== undefined &&
    !closed &&
    cardItem.parked?.reason === 'replied' &&
    cardModel(cardItem).shape !== 'info' &&
    cardModel(cardItem).shape !== 'input';
  const standing =
    cardItem === undefined || (!closed && cardItem.parked === undefined) ? undefined : (
      <AgendaSettled
        busy={busyIds.has(cardItem.id)}
        error={typeof cardError === 'string' ? cardError : null}
        ferret={ferret}
        item={cardItem}
        {...(now === undefined ? {} : { now })}
        {...(client === undefined || closed ? {} : { onBringBack: () => act(cardItem, UNSNOOZE_ACTION, '') })}
      />
    );
  const view =
    cardItem === undefined ? null : (
      <AgendaDeliveryContext.Provider value={deliveryState}>
        <AgendaItemView
          busy={busyIds.has(cardItem.id)}
          daemonId={connection.daemonId}
          error={typeof cardError === 'string' ? cardError : null}
          ferret={ferret}
          history={history}
          item={cardItem}
          key={cardItem.id}
          onAct={action => act(cardItem, action, composerDraft(scope))}
          onClose={() => update(() => ({ card: null }))}
          position={paged >= 0 ? { index: paged, total: openItems.length } : { index: 0, total: 1 }}
          quoteScope={scope}
          renderProse={agendaProse(copyWriter)}
          {...(cardItem.copyPlan !== undefined
            ? {
                planForm: (
                  <CopyPlanHost
                    agentName={ferret}
                    connection={connection}
                    item={cardItem}
                    sessionId={scope.sessionId}
                  />
                ),
              }
            : {})}
          {...(cardItem.taskPlan !== undefined
            ? {
                planForm: (
                  <TaskPlanHost
                    agentName={ferret}
                    connection={connection}
                    item={cardItem}
                    sessionId={scope.sessionId}
                  />
                ),
              }
            : {})}
          {...(cardItem.signInRuleSuggestion !== undefined
            ? {
                planForm: <SignInRuleSuggestionHost agentName={ferret} connection={connection} item={cardItem} />,
              }
            : {})}
          {...(cardItem.phoneApproval !== undefined
            ? {
                planForm: (
                  <PhoneApprovalHost
                    approvalId={cardItem.phoneApproval.id}
                    connection={connection}
                    sessionId={scope.sessionId}
                  />
                ),
              }
            : {})}
          {...(cardItem.twoFactorSeed !== undefined
            ? { planForm: <TwoFactorSeedHost connection={connection} item={cardItem} /> }
            : {})}
          {...(cardItem.kind === 'input'
            ? {
                inputForm: (
                  <InputCardHost
                    agentName={ferret}
                    connection={connection}
                    item={cardItem}
                    sessionId={scope.sessionId}
                  />
                ),
              }
            : {})}
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

  const section = (afterOpen?: () => void): ReactNode => {
    const parked = board.filter(item => item.parked !== undefined && item.notice !== true);
    if (!agendaMode && openItems.length + parked.length + records.length === 0) return null;
    return (
      <AgendaDeliveryContext.Provider value={deliveryState}>
        <AgendaInfoList
          ferret={ferret}
          onOpen={item => {
            openCard(item);
            afterOpen?.();
          }}
          open={openItems}
          parked={parked}
          resolved={[...records].sort(byNewestResolution)}
          {...(now === undefined ? {} : { now })}
        />
      </AgendaDeliveryContext.Provider>
    );
  };

  return {
    above,
    view,
    scrim,
    covered: cardItem !== undefined,
    close: () => update(() => ({ drawer: false, card: null })),
    hostsLive,
    jumpHost,
    section,
    references: () => aboutRef.current,
    placeholder: cardId === null || closed ? undefined : `Reply to ${ferret}…`,
    composer: { onSent, ...(cardId === null ? {} : { onEscape: () => update(() => ({ card: null })) }) },
  };
};
