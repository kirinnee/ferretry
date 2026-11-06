/**
 * ONE AGENDA ITEM, IN FOCUS — an OVERLAY over the MESSAGE LIST only. The agenda row and the real composer stay where
 * they are, visible and typeable, below it; the transcript stays mounted underneath (its scroll position is simply
 * kept) and nothing of it shows or takes focus while this is open.
 *
 * ONE COLUMN, the composer's own width at every breakpoint, top to bottom:
 *
 *   head     ONE row: the title (ONE line; a marquee when too long, cut at a word with the whole title a tap away where
 *            motion is reduced), how urgent it is (Blocking now, Needed by 17:00), ‹ n of N ›, ⋯ and ✕. Everything quiet
 *            is behind ⋯ (`agenda-item-menu.tsx`, a bottom sheet on a phone, a popover wider): the version picker,
 *            Changes, Snooze, Merge with…, Not needed and a host's quiet tools (the Inbox's Skip); a gate item or a
 *            notice drawn with its card rows keeps its summary there too
 *   card     the item in the spec's nine parts (`agenda-item-card.tsx`; the order is `agenda-item-sections.ts`'s): its
 *            description, state and stage chips, premise and context, the folded detailed context, the terms and
 *            references table, where we are now, what it needs from the owner (the ask and every card ask, each with
 *            its own buttons), the body (the full picture), then the log: the conversation and the folded activity
 *
 * OPENED AT ITS ASK (`startAt: 'ask'`): a Needs-you push and a link that names the item open it scrolled to "What I need
 * from you", with that part focused, so the owner lands on what to do; the keys still answer from there. Each tap
 * brings its own `startTap`, so a second push for the item already open at its ask scrolls there again.
 *
 * THE HEAD STICKS to the top of the scroller, and a one-row answer (choice, approval, to-do, notice, review) is drawn in
 * a DOCK that sticks to its bottom — the view's foot, whatever the card's height — so the title, the pager and the
 * buttons are in reach however long the card runs. A card answered in words (reply, mixed, form) has no dock: the
 * composer is its answer. An item with a card ask has no dock either: both button sets are inline, each under its own
 * heading. The scroller keeps room for both
 * (`scroll-padding`), so a focused field never lands behind one.
 *
 * The body is the ONE scroller (`overscroll-behavior: contain`). ✕ and Esc go back to the chat; ‹ › page through the
 * items without answering; ← ↑ → answer on a keyboard and ↓ is Skip (the next item, nothing changed), exactly as the swipes (a field or a button
 * keeps its own keys). Everything typed goes through the composer: this view has no text field of its own.
 */

import type { AgendaCardAnswer, AgendaItem } from '@ferretry/protocol';
import { GitCompareArrows, Merge } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { useQuoteMenu } from '../../components/quote-menu.tsx';
import { useDoneClose } from '../../hooks/use-done-close.ts';
import { answerAction } from '../../lib/agenda-answers.ts';
import { agendaCardHead } from '../../lib/agenda-card-head.ts';
import { cardModel } from '../../lib/agenda-card-model.ts';
import type { HistoryEvent } from '../../lib/agenda-history.ts';
import { DISMISS_ACTION, type InboxAction, swipeMap } from '../../lib/agenda-inbox.ts';
import { answersWithCardsForm, itemAskPlan, itemCardAsks } from '../../lib/agenda-item-sections.ts';
import type { LineageTitles } from '../../lib/agenda-merge.ts';
import { versionCount } from '../../lib/agenda-revisions.ts';
import { agendaAuthor, agendaStatus } from '../../lib/agenda-status.ts';
import type { DaemonId } from '../../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';
import { composerQuoteTarget } from '../../lib/quote.ts';
import { agendaHeading } from './agenda-delivery.tsx';
import { AgendaItemCard } from './agenda-item-card.tsx';
import { AgendaItemMenu, MenuGroup, SnoozeChoices, VersionPicker } from './agenda-item-menu.tsx';
import { AgendaStatusPill } from './agenda-status-pill.tsx';
import { CardHead } from './card-head.tsx';
import { MarqueeTitle } from './marquee-title.tsx';
import { useDoneCloseFlow } from './use-done-close-flow.ts';
import type { AgendaMergeView, AgendaVersionsView } from './use-item-lifecycle.ts';

export interface AgendaItemViewProps {
  readonly item: AgendaItem;
  readonly ferret: string;
  readonly now?: number;
  readonly history: readonly HistoryEvent[];
  readonly position: { readonly index: number; readonly total: number };
  readonly onPrevious?: () => void;
  readonly onNext?: () => void;
  /** Back to the chat. */
  readonly onClose: () => void;
  readonly busy: boolean;
  readonly error: string | null;
  /** The primary pointer is touch: answers swipe. */
  readonly swipeable: boolean;
  /** An answer; the host adds the composer's text as its note and closes the view once it is sent. */
  readonly onAct: (action: InboxAction) => void;
  readonly onProgress?: (step: number, done: boolean) => Promise<void>;
  /** Snooze the item until this instant; absent: the ⋯ menu offers no Snooze. */
  readonly onSnooze?: (until: string) => void;
  readonly renderProse: (text: string) => ReactNode;
  /**
   * The conversation whose composer takes a quote: select any text in the item and "Quote in composer" puts it
   * there, exactly as in the chat (`useQuoteMenu`). Absent: nothing to quote into.
   */
  readonly quoteScope?: DaemonSessionScope | null;
  /** The machine the item is on: with it, an item that offers to close its card draws "Done · closes &F12". */
  readonly daemonId?: DaemonId;
  /** What ✕ is called: "Back to the chat", unless the host is somewhere else (the Inbox). */
  readonly closeLabel?: string;
  /**
   * The item cannot be answered here — it is parked or resolved (`agenda-settled.tsx`): this is drawn in the answer
   * row's place, and the arrow keys answer nothing.
   */
  readonly settled?: ReactNode;
  /**
   * Where a question the owner replied to stands (`agenda-settled.tsx`): drawn above the answer row, which stays
   * live — the reply does not answer the question, so its own options stay answerable.
   */
  readonly parkedNote?: ReactNode;
  /** The form an `input` item is answered with (`InputCardHost`): drawn in the card, in the answer row's place. */
  readonly inputForm?: ReactNode;
  /** A ferret's paste plan (`CopyPlanHost`): drawn in the card, in the answer row's place. */
  readonly planForm?: ReactNode;
  /** The cards a machine notice is about (`AgendaCardsHost`): ONE form, a pick per card and one Send, which is the answer. */
  readonly cardsForm?: ReactNode;
  /** Names this item's form picks when a composer sends them (the Inbox, the chat); absent, a form is read, not filled in. */
  readonly formKey?: string;
  /** Quiet buttons kept behind ⋯ (the Inbox's Skip and Not needed), so the card body keeps the room. */
  readonly tools?: ReactNode;
  /**
   * Open scrolled to the item's ask ("What I need from you"), focused: a Needs-you push or a link naming the item.
   * Absent: the view opens at its top.
   */
  readonly startAt?: 'ask';
  /** Which tap asked for `startAt`: a new one scrolls to the ask again, though the item is already open. */
  readonly startTap?: number;
  /** A card's How to test, read from the board the app holds: a card ask on this item shows it. */
  readonly howToTestFor?: (cardId: string) => string | null | undefined;
  /** Names the item on this device (its machine, conversation and id), so its folded parts are remembered per item. */
  readonly itemKey?: string;
  /**
   * The host draws the box under the item and takes what is typed there as the answer to its one card ask (the Inbox's,
   * `typedCardAsk`). Only then is that ask Good-only; everywhere else it keeps its own buttons.
   */
  readonly typedAnswer?: boolean;
  /** The versions the machine keeps for the item (`useItemLifecycle`): the ⋯ menu's "Changes". Absent: none. */
  readonly versions?: AgendaVersionsView;
  /** "Merge with…" (`useItemLifecycle`), a row of the ⋯ menu. Absent: not offered. */
  readonly merge?: AgendaMergeView;
  /** The titles of the agendas the item was merged into or split from (`useItemLifecycle`). */
  readonly lineageTitles?: LineageTitles;
}

/** The urgent tones the head row says; where else the item stands is the card's state chip. */
const URGENT_TONES: ReadonlySet<string> = new Set(['blocking', 'will-block', 'needed-by']);

/** Keys that are a field's or a button's own. */
const ownsKeys = (target: EventTarget): boolean =>
  target instanceof HTMLElement &&
  target.closest('input, textarea, select, button, a, summary, [contenteditable]') !== null;

const KEY_DIRECTION: Readonly<Record<string, 'left' | 'up' | 'right'>> = {
  ArrowLeft: 'left',
  ArrowUp: 'up',
  ArrowRight: 'right',
};

/** Keeps the scroller's scroll padding at the height of the sticky head and dock, so nothing scrolled to hides behind them. */
function useScrollPadding(
  body: { readonly current: HTMLElement | null },
  head: { readonly current: HTMLElement | null },
  dock: HTMLElement | null,
): void {
  useEffect(() => {
    const scroller = body.current;
    const bar = head.current;
    if (scroller === null || bar === null || typeof ResizeObserver === 'undefined') return undefined;
    const apply = (): void => {
      scroller.style.scrollPaddingTop = `${bar.offsetHeight}px`;
      scroller.style.scrollPaddingBottom = `${dock?.offsetHeight ?? 0}px`;
    };
    apply();
    const watch = new ResizeObserver(apply);
    watch.observe(bar);
    if (dock !== null) watch.observe(dock);
    return () => watch.disconnect();
  }, [body, head, dock]);
}

export function AgendaItemView({
  item,
  ferret,
  now = Date.now(),
  history,
  position,
  onPrevious,
  onNext,
  onClose,
  busy,
  error,
  swipeable,
  onAct,
  onProgress,
  onSnooze,
  renderProse,
  closeLabel = 'Back to the chat',
  quoteScope = null,
  settled,
  parkedNote,
  inputForm,
  planForm,
  cardsForm,
  formKey,
  daemonId,
  tools,
  startAt,
  startTap,
  howToTestFor,
  itemKey,
  typedAnswer = false,
  versions,
  merge,
  lineageTitles,
}: AgendaItemViewProps) {
  const root = useRef<HTMLElement | null>(null);
  const body = useRef<HTMLDivElement | null>(null);
  const top = useRef<HTMLElement | null>(null);
  const [dock, setDock] = useState<HTMLDivElement | null>(null);
  const diffId = useId();
  // The ⋯ menu and what it opens belong to ONE item: paging to another starts them all closed, at its latest version.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [diffFor, setDiffFor] = useState<string | null>(null);
  const [mergeFor, setMergeFor] = useState<string | null>(null);
  const [picked, setPicked] = useState<{ readonly id: string; readonly version: number } | null>(null);
  const menuOpen = menuFor === item.id;
  const setMenuOpen = useCallback((open: boolean) => setMenuFor(open ? item.id : null), [item.id]);
  const count = versionCount(item);
  const shown = picked?.id === item.id ? Math.min(picked.version, count) : count;
  const latest = shown >= count;
  const showVersion = (version: number): void => setPicked(version >= count ? null : { id: item.id, version });
  useScrollPadding(body, top, dock);
  const quote = useQuoteMenu(root, quoteScope);
  // One card ask that IS the item's ask (a try-it) is answered by the arrows too, like any choice item.
  const swipes = latest
    ? itemAskPlan(item, itemCardAsks(item, howToTestFor), { typedHost: typedAnswer }).swipes
    : undefined;
  // A notice about cards answers with its one form's Send: no swipe or key says Got it past its picks.
  const map = answersWithCardsForm(item) ? {} : (swipes ?? swipeMap(item));
  const head = agendaCardHead(item);
  const status = agendaStatus(item, agendaAuthor(item, ferret), now);
  const urgent = status !== null && URGENT_TONES.has(status.tone) ? status : null;
  // The card draws the description under the title, whole. A gate item, whose card repeats nothing, and a notice drawn
  // with its card rows, which say its lines, keep it behind ⓘ instead.
  const infoDescription = item.gate === undefined && cardsForm === undefined ? null : head.description;
  const doneClose = useDoneCloseFlow(useDoneClose(daemonId, item), label => onAct({ kind: 'resolve', label }));
  const answerable = settled === undefined && !(inputForm !== undefined && item.kind === 'input');
  // Not needed: the host's own tools say it where it has them (the Inbox); otherwise the menu does, on an item that
  // can be put aside at all — not a gate, a notice, an input card, or one whose own answers already dismiss.
  const model = cardModel(item);
  const canDismiss =
    tools === undefined && answerable && latest && item.gate === undefined && !model.notice && model.dismissInMenu;
  const menuRows = (
    <ItemMenuRows
      busy={busy}
      count={count}
      description={infoDescription}
      diff={
        versions === undefined
          ? null
          : {
              id: diffId,
              open: diffFor === item.id,
              onToggle: () => {
                setDiffFor(diffFor === item.id ? null : item.id);
                setMenuOpen(false);
              },
            }
      }
      dismiss={
        canDismiss
          ? () => {
              setMenuOpen(false);
              if (!busy) onAct(DISMISS_ACTION);
            }
          : null
      }
      item={item}
      merge={
        merge === undefined || !latest
          ? null
          : () => {
              setMergeFor(item.id);
              setMenuOpen(false);
            }
      }
      now={now}
      onShowVersion={version => {
        showVersion(version);
        setMenuOpen(false);
      }}
      renderProse={renderProse}
      shown={shown}
      snooze={
        onSnooze === undefined
          ? null
          : (until: string) => {
              setMenuOpen(false);
              onSnooze(until);
            }
      }
      tools={tools ?? null}
      versionsKept={versions !== undefined}
    />
  );
  const hasMenu =
    infoDescription !== null ||
    tools !== undefined ||
    canDismiss ||
    count > 1 ||
    onSnooze !== undefined ||
    (merge !== undefined && latest);
  // Request changes IS the owner's words: sent with what the composer holds, or the owner is put in the composer first.
  const requestChanges = (answer: AgendaCardAnswer): void => {
    const composer = quoteScope === null ? null : composerQuoteTarget(quoteScope);
    const words = composer?.draft().trim() ?? '';
    if (words === '') {
      composer?.replaceDraft(composer.draft());
      return;
    }
    const action = answerAction(answer, words);
    if (action !== null) onAct(action);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: focus the dialog again whenever another item opens
  useEffect(() => {
    const ask = startAt === 'ask' ? body.current?.querySelector<HTMLElement>('[data-agenda-part="needs"]') : null;
    if (ask === null || ask === undefined) {
      root.current?.focus({ preventScroll: true });
      return;
    }
    // At its ask: the part scrolls to the top of the scroller (its padding keeps it clear of the sticky head) and takes
    // focus, so a screen reader starts there and the arrow keys still answer.
    ask.scrollIntoView?.({ block: 'start' });
    ask.focus({ preventScroll: true });
  }, [item.id, startAt, startTap]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    // The ⋯ menu's sheet is drawn over the page (a portal), yet its keys still bubble here: they are the sheet's.
    if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
    if (ownsKeys(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (busy || !answerable) return;
    if (event.key === 'ArrowDown') {
      if (onNext === undefined) return;
      event.preventDefault();
      onNext();
      return;
    }
    const direction = KEY_DIRECTION[event.key];
    const action = direction === undefined ? undefined : map[direction];
    if (action === undefined) return;
    event.preventDefault();
    onAct(action);
  };

  return (
    <section
      aria-label={agendaHeading(item)}
      aria-modal="true"
      className="fy-item-view"
      data-agenda-view={item.id}
      onKeyDown={onKeyDown}
      {...quote.handlers}
      ref={root}
      role="dialog"
      tabIndex={-1}
    >
      <div className="fy-item-view__body" data-agenda-body="" ref={body}>
        <div className="fy-item-view__column">
          <header className="fy-item-view__head" data-agenda-top="" ref={top}>
            <CardHead
              close={{ label: closeLabel, onClick: onClose }}
              // Nothing to step through when this is the only item: no arrows and no "1/1", so the title gets the room.
              {...(position.total > 1
                ? { pager: { index: position.index, total: position.total, onPrevious, onNext } }
                : {})}
              status={
                urgent === null ? null : (
                  <span className="fy-item-view__status" title={urgent.label}>
                    <AgendaStatusPill status={urgent} />
                  </span>
                )
              }
              title={<MarqueeTitle title={head.title} />}
              {...(hasMenu
                ? {
                    menu: (
                      <AgendaItemMenu onOpenChange={setMenuOpen} open={menuOpen}>
                        {menuRows}
                      </AgendaItemMenu>
                    ),
                  }
                : {})}
            />
          </header>
          <AgendaItemCard
            busy={busy}
            error={error}
            ferret={ferret}
            item={item}
            now={now}
            onAct={onAct}
            renderProse={renderProse}
            swipeable={swipeable}
            answerDock={dock}
            shown={shown}
            onShowVersion={showVersion}
            diffId={diffId}
            diffOpen={diffFor === item.id}
            mergeOpen={mergeFor === item.id}
            onMergeClose={() => setMergeFor(null)}
            history={history}
            {...(itemKey === undefined ? {} : { itemKey })}
            {...(typedAnswer ? { typedAnswer } : {})}
            {...(versions === undefined ? {} : { versions })}
            {...(merge === undefined ? {} : { merge })}
            {...(lineageTitles === undefined ? {} : { lineageTitles })}
            {...(howToTestFor === undefined ? {} : { howToTestFor })}
            {...(onNext === undefined ? {} : { onSkip: onNext })}
            {...(onProgress === undefined ? {} : { onProgress })}
            {...(doneClose === undefined ? {} : { doneClose })}
            {...(settled === undefined ? {} : { settled })}
            {...(parkedNote === undefined ? {} : { parkedNote })}
            {...(inputForm === undefined ? {} : { inputForm })}
            {...(planForm === undefined ? {} : { planForm })}
            {...(cardsForm === undefined ? {} : { cardsForm })}
            {...(formKey === undefined ? {} : { formKey })}
            {...(quoteScope === null ? {} : { onRequestChanges: requestChanges })}
          />
          <div className="fy-item-view__dock" data-agenda-dock="" ref={setDock} />
        </div>
      </div>
      {quote.menu}
    </section>
  );
}

interface ItemMenuRowsProps {
  readonly item: AgendaItem;
  readonly now: number;
  readonly busy: boolean;
  readonly renderProse: (text: string) => ReactNode;
  /** A gate item's or a card notice's summary, which its card does not repeat. */
  readonly description: string | null;
  readonly count: number;
  readonly shown: number;
  /** The machine keeps versions, so the picker counts edits beside Changes. */
  readonly versionsKept: boolean;
  readonly onShowVersion: (version: number) => void;
  readonly diff: { readonly id: string; readonly open: boolean; readonly onToggle: () => void } | null;
  readonly snooze: ((until: string) => void) | null;
  readonly merge: (() => void) | null;
  readonly dismiss: (() => void) | null;
  readonly tools: ReactNode;
}

/** What the ⋯ menu holds, each group only when the item has it: about, version, snooze, merge, put aside. */
function ItemMenuRows({
  item,
  now,
  busy,
  renderProse,
  description,
  count,
  shown,
  versionsKept,
  onShowVersion,
  diff,
  snooze,
  merge,
  dismiss,
  tools,
}: ItemMenuRowsProps) {
  return (
    <>
      {description === null ? null : (
        <MenuGroup hook="about" title="About this item">
          <div className="fy-item-view__desc" data-agenda-ask="">
            {renderProse(description)}
          </div>
        </MenuGroup>
      )}
      {count > 1 || diff !== null ? (
        <MenuGroup hook="version" title="Version">
          <div className="fy-item-menu__row" data-agenda-version-slot="">
            {count > 1 ? (
              <VersionPicker asEdits={versionsKept} item={item} now={now} onShow={onShowVersion} shown={shown} />
            ) : null}
            {diff === null ? null : (
              <button
                aria-controls={diff.id}
                aria-expanded={diff.open}
                className="fy-item-menu__action"
                data-agenda-diff-toggle=""
                onClick={diff.onToggle}
                type="button"
              >
                <GitCompareArrows aria-hidden="true" size={16} />
                {diff.open ? 'Hide changes' : 'Changes'}
              </button>
            )}
          </div>
        </MenuGroup>
      ) : null}
      {snooze === null ? null : (
        <MenuGroup hook="snooze" title="Snooze until">
          <SnoozeChoices disabled={busy} now={now} onSnooze={snooze} />
        </MenuGroup>
      )}
      {merge === null && dismiss === null && tools === null ? null : (
        <MenuGroup hook="aside" title="Actions">
          <div className="fy-item-menu__row">
            {merge === null ? null : (
              <button className="fy-item-menu__action" data-agenda-merge-open="" onClick={merge} type="button">
                <Merge aria-hidden="true" size={16} />
                Merge with…
              </button>
            )}
            {dismiss === null ? null : (
              <button
                className="fy-item-menu__action"
                data-agenda-dismiss=""
                disabled={busy}
                onClick={dismiss}
                type="button"
              >
                Not needed
              </button>
            )}
            {tools}
          </div>
        </MenuGroup>
      )}
    </>
  );
}
