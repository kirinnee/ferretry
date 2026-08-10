import type {
  AttentionId,
  AttentionItem,
  AttentionResponse,
  AttentionSnapshot,
  ResolvedAttentionItem,
} from '@ferretry/protocol';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  CircleAlert,
  Clock3,
  LoaderCircle,
  Radio,
  UserRoundCheck,
  X,
} from 'lucide-react';
import { useEffect, useId, useState } from 'react';

import { Markdown } from '../../components/markdown.tsx';
import { useReferenceSurface } from '../../components/reference-surface.tsx';
import { cn } from '../../lib/class-names.ts';
import type { DaemonAttentionClient } from '../../lib/attention-client.ts';
import type { AttentionLoadStatus } from '../../lib/attention-store.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';
import { BottomSheet } from '../../shell/bottom-sheet.tsx';
import { Button } from '../../shell/primitives.tsx';
import { AttentionAnswerControls } from './attention-answer-controls.tsx';
import {
  attentionAge,
  attentionKindMeta,
  attentionReference,
  collapsesByDefault,
  describeResponse,
  resolutionBadge,
  sourceLabel,
} from './attention-board.tsx';

export type AttentionActionClient = Pick<DaemonAttentionClient, 'dismiss' | 'respond' | 'resolve'>;

export interface AttentionActionTriggerProps {
  /** Stable id, so a host can return focus here when the opener is gone. */
  readonly id: string;
  readonly count: number;
  readonly loading?: boolean;
  readonly expanded: boolean;
  readonly controls: string;
  readonly onOpen: (opener: HTMLElement) => void;
}

/** The session chrome's dedicated entry point. Attention is never a bento tab. */
export function AttentionActionTrigger({
  id,
  count,
  loading = false,
  expanded,
  controls,
  onOpen,
}: AttentionActionTriggerProps) {
  const label = loading ? 'Checking attention' : count === 0 ? 'Attention' : `Answer attention (${count})`;
  return (
    <button
      id={id}
      type="button"
      aria-controls={controls}
      aria-expanded={expanded}
      aria-label={label}
      className="kt-attn-action-trigger"
      data-active={count > 0 || undefined}
      onClick={event => onOpen(event.currentTarget)}
      title={label}
    >
      <span className="kt-attn-action-trigger__radio" aria-hidden="true">
        {loading ? <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" /> : <Radio size={14} />}
      </span>
      <span>Attention</span>
      {count > 0 ? <span className="kt-attn-action-trigger__count">{count > 99 ? '99+' : count}</span> : null}
    </button>
  );
}

export interface AttentionActionModalProps {
  /** The sheet's DOM id — the same one the trigger's `aria-controls` names. */
  readonly id: string;
  readonly connection: DaemonConnection;
  readonly scope: DaemonSessionScope;
  readonly client: AttentionActionClient;
  readonly snapshot: AttentionSnapshot | null;
  readonly status: AttentionLoadStatus;
  readonly open: boolean;
  readonly targetId?: AttentionId | null;
  readonly swipeEnabled: boolean;
  readonly onClose: () => void;
}

type AttentionOperation =
  | { readonly kind: 'respond'; readonly response: AttentionResponse }
  | { readonly kind: 'resolve' }
  | { readonly kind: 'dismiss' };

/**
 * ONE array for "this session has no board yet".
 *
 * `snapshot?.items ?? []` allocates a fresh empty array on every render, and the
 * episode effect below depends on the list — so an unhydrated session would
 * re-run that effect forever.
 */
const NO_ITEMS: readonly AttentionItem[] = [];
const NO_RESOLVED: readonly ResolvedAttentionItem[] = [];

/**
 * The row the READER stepped to, remembered against the reference it was chosen
 * under. A new `!A<n>` arriving while the sheet is open is a new pointer at a
 * new decision, so it supersedes a choice made for the previous one instead of
 * being silently overruled by it.
 */
interface DeckChoice {
  readonly target: AttentionId | null;
  readonly id: AttentionId;
}

/**
 * One ask at a time, in the app's radio-call visual language: the ask, why it
 * matters, the requested outcome, then nothing but valid actions. The daemon's
 * returned snapshot remains authoritative; a successful action removes the item
 * from this deck in the same render that records it in the audit ledger.
 */
export function AttentionActionModal({
  id: dialogId,
  connection,
  scope,
  client,
  snapshot,
  status,
  open,
  targetId = null,
  swipeEnabled,
  onClose,
}: AttentionActionModalProps) {
  const titleId = useId();
  const [deckChoice, setDeckChoice] = useState<DeckChoice | null>(null);
  const [busyId, setBusyId] = useState<AttentionId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const references = useReferenceSurface();
  const items = snapshot?.items ?? NO_ITEMS;
  const resolved = snapshot?.resolved ?? NO_RESOLVED;

  // An explicit reference (`!A<n>` from the transcript) is a pointer at ONE
  // decision. It opens on that item, and if a resolve race clears that row
  // between the click and the authoritative snapshot, it says so for THAT item —
  // it never silently hands the reader a different active decision. A null
  // `targetId` opens the deck oldest-first and keeps the reader's chosen row, as
  // before.
  const explicitTarget = targetId ?? null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: items and explicitTarget are the deliberate refusal-reset triggers, see below
  useEffect(() => {
    if (!open) {
      // CLOSING DISCARDS THE EPISODE. One component instance serves every
      // session the reader visits, so a success sentence, a refusal, or a chosen
      // ask left behind here would reappear over a DIFFERENT session's board the
      // next time the sheet opens — reporting an action that never happened
      // there. The notice survives for as long as this sheet stays open, and no
      // longer.
      setDeckChoice(null);
      setBusyId(null);
      setError(null);
      setNotice(null);
      return;
    }
    // A refusal belongs to the snapshot and the reference it was raised under;
    // a newer board, or a new `!A<n>`, is a different question being asked.
    setError(null);
  }, [items, open, explicitTarget]);

  // WHICH ITEM IS ON SCREEN IS DERIVED DURING RENDER, never in an effect.
  // `BottomSheet` installs the dialog's focus in a LAYOUT effect, so the first
  // committed dialog is already the one a keyboard or a screen reader is handed;
  // a target selected in a passive effect would let that first commit announce a
  // DIFFERENT item's label and expose its actions under a proved `!A7`.
  const navigatedId =
    deckChoice !== null && deckChoice.target === explicitTarget && items.some(item => item.id === deckChoice.id)
      ? deckChoice.id
      : null;
  // `items[0]` is the DECK's opening row and only the deck's. In explicit-target
  // mode there is no first-item fallback at any point — not on the first commit,
  // not while the ledger is unread, and not when a resolution race empties the
  // target out from under the click.
  const activeId = navigatedId ?? explicitTarget ?? items[0]?.id ?? null;
  // True only against an AUTHORITATIVE snapshot — a target that left the active
  // deck. While the ledger is still unread we cannot know, so this stays false
  // and the loading/unavailable states keep priority over any "addressed" claim.
  const targetMissing = snapshot !== null && explicitTarget !== null && !items.some(item => item.id === explicitTarget);
  // The actionable item, if any. A missing explicit target renders `undefined`
  // here — the addressed panel takes over and no deck controls come with it.
  const selected = targetMissing ? undefined : items.find(item => item.id === activeId);
  const addressedRecord = targetMissing ? resolved.find(item => item.id === explicitTarget) : undefined;
  const selectedIndex = selected === undefined ? -1 : items.findIndex(item => item.id === selected.id);

  const act = async (operation: AttentionOperation): Promise<void> => {
    if (selected === undefined) return;
    setBusyId(selected.id);
    setError(null);
    setNotice(null);
    try {
      if (operation.kind === 'respond') {
        await client.respond(connection, scope, selected.id, operation.response);
        setNotice(`${attentionReference(selected.id)} answered. The response is in the resolution audit.`);
      } else if (operation.kind === 'dismiss') {
        await client.dismiss(connection, scope, selected.id);
        setNotice(`${attentionReference(selected.id)} dismissed and moved to the resolution audit.`);
      } else {
        await client.resolve(connection, scope, selected.id);
        setNotice(`${attentionReference(selected.id)} marked done and moved to the resolution audit.`);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The daemon did not accept this attention action.');
    } finally {
      setBusyId(null);
    }
  };

  const unavailable = status === 'error' && snapshot === null;
  const loading = (status === 'idle' || status === 'loading') && snapshot === null;
  const kind = selected === undefined ? null : attentionKindMeta(selected);
  const KindIcon = kind?.icon ?? CircleAlert;
  // The addressed state names the EXACT reference the reader followed; the deck
  // path keeps its "kind · reference" eyebrow and the subject as the title.
  const eyebrow = targetMissing
    ? `${attentionReference(explicitTarget)} · ${addressedRecord ? 'addressed' : 'no longer active'}`
    : `${kind?.label ?? 'Attention'} · ${selected === undefined ? scope.sessionId : attentionReference(selected.id)}`;
  const title = targetMissing
    ? (addressedRecord?.subject ?? 'This attention is no longer active')
    : (selected?.subject ?? 'Attention radio');

  return (
    <BottomSheet
      id={dialogId}
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      closeLabel="Close attention"
      maxHeight="min(92dvh, calc(var(--app-h, 100dvh) - var(--gap-sm)))"
      panelClassName="kt-attn-action-modal mx-auto max-w-2xl overflow-hidden bg-surface"
      zIndexClass="z-50"
    >
      <header className="kt-attn-action-modal__header">
        <div className="kt-attn kt-attn-action-modal__signal" data-kind={kind?.tone ?? 'none'} aria-hidden="true">
          <KindIcon size={17} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="kt-attn-action-modal__eyebrow">{eyebrow}</p>
          {/* WRAPS, never truncates. The subject IS the ask — "Approve this
              browser pairin…" on a 390px screen hides the one sentence the
              reader is being asked to decide about. */}
          <h2 id={titleId} className="m-0 break-words font-display text-title font-semibold tracking-display text-fg">
            {title}
          </h2>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="min-h-[44px] min-w-[44px]"
          aria-label="Close attention"
          onClick={onClose}
        >
          <X size={16} />
        </Button>
      </header>

      {/* EXACTLY ONE live region per outcome, always mounted and never also
          duplicated into an `sr-only` twin — a second copy of the same sentence
          is read out twice. The class swaps between visible and `sr-only`; the
          region itself never unmounts, which is what makes the announcement
          reliable rather than a race with the insertion. */}
      <p
        role="alert"
        className={
          error === null ? 'sr-only' : 'm-0 border-b border-err/30 bg-err/5 px-panel py-row-y text-cell text-err'
        }
      >
        {error === null ? '' : `Could not update attention: ${error}`}
      </p>
      <p
        role="status"
        aria-live="polite"
        className={
          notice === null ? 'sr-only' : 'm-0 border-b border-ok/30 bg-ok/5 px-panel py-row-y text-cell text-ok'
        }
      >
        {notice ?? ''}
      </p>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-panel pb-panel scroll-thin">
        {loading ? (
          <div className="flex min-h-56 items-center justify-center gap-xs text-cell text-muted" role="status">
            <LoaderCircle size={16} className="animate-spin motion-reduce:animate-none" />
            Checking this session's attention ledger…
          </div>
        ) : unavailable ? (
          <div className="py-10 text-center" role="alert">
            <CircleAlert size={20} className="mx-auto mb-sm text-err" />
            <p className="m-0 font-medium text-fg">Attention cannot be verified.</p>
            <p className="mx-auto mb-0 mt-xs max-w-md text-cell text-muted">
              Reconnect to this daemon before assuming the session needs nothing from you.
            </p>
          </div>
        ) : targetMissing ? (
          <div className="py-10 text-center" data-attention-addressed="">
            {/* The reference the reader followed is gone from the active deck.
                Name THAT item, show its audit evidence when the daemon recorded
                one, and offer no controls for the item that survived the race. */}
            <span
              className={cn(
                'mx-auto mb-sm inline-flex h-11 w-11 items-center justify-center rounded-full border',
                addressedRecord ? 'border-ok/40 bg-ok/10 text-ok' : 'border-border-soft bg-surface-2 text-muted',
              )}
              aria-hidden="true"
            >
              {addressedRecord ? <Check size={20} /> : <CircleAlert size={20} />}
            </span>
            <p className="m-0 font-display text-title font-semibold text-fg">
              {addressedRecord ? 'This attention was addressed.' : 'This attention is no longer active.'}
            </p>
            <p className="mx-auto mb-0 mt-xs max-w-md text-cell text-muted">
              {addressedRecord
                ? `${attentionReference(explicitTarget)} left the active deck before this view opened. The resolution audit records what happened to it.`
                : `${attentionReference(explicitTarget)} is not waiting for a decision in this session. It may have been cleared or expired before this view opened — no outcome is recorded, so none is claimed here.`}
            </p>
            {addressedRecord ? <AddressedAudit record={addressedRecord} /> : null}
            <Button type="button" className="mt-md min-h-[44px]" variant="primary" onClick={onClose}>
              Back to session
            </Button>
          </div>
        ) : selected === undefined ? (
          <div className="py-10 text-center" data-attention-clear="">
            <span className="mx-auto mb-sm inline-flex h-11 w-11 items-center justify-center rounded-full border border-ok/40 bg-ok/10 text-ok">
              <Check size={20} />
            </span>
            <p className="m-0 font-display text-title font-semibold text-fg">Radio clear.</p>
            <p className="m-0 mt-xs text-cell text-muted">No unresolved Attention remains in this session.</p>
            {/* An addressed item leaves the deck the moment the daemon's own
                snapshot says so — and it is still ON the record, which is what
                this line says out loud rather than leaving the reader to guess
                that the item was discarded. */}
            <p className="m-0 mt-xs text-meta text-faint" data-attention-resolved-count="">
              {resolved.length} recorded in the resolution audit.
            </p>
            <Button type="button" className="mt-md min-h-[44px]" variant="primary" onClick={onClose}>
              Back to session
            </Button>
          </div>
        ) : (
          <article className="kt-attn kt-attn-action-card" data-kind={kind?.tone ?? 'none'}>
            <div className="flex flex-wrap items-center gap-x-sm gap-y-xs border-b border-border-soft pb-sm text-meta text-faint">
              <span>{sourceLabel(selected.source)}</span>
              <span aria-hidden="true">·</span>
              <span className="inline-flex items-center gap-1">
                <Clock3 size={11} /> {attentionAge(selected.waitingSince)}
              </span>
              {items.length > 1 ? (
                <span className="mono ml-auto">
                  {selectedIndex + 1}/{items.length}
                </span>
              ) : null}
            </div>

            <section className="kt-attn-action-card__section" aria-labelledby={`${dialogId}-why`}>
              <p id={`${dialogId}-why`} className="kt-attn-action-card__label">
                Why it needs you now
              </p>
              {/* The SAME reference surface the transcript reads with, so a
                  `:callsign` or `@file` in Attention prose behaves exactly as it
                  does in a message — and stays prose when nothing proves it. */}
              <div className="min-w-0 text-cell leading-base text-muted">
                <Markdown text={selected.why} {...references} />
              </div>
            </section>

            {selected.context ? (
              <details className="kt-attn-action-card__context" open={!collapsesByDefault(selected.context)}>
                <summary className="flex min-h-[44px] cursor-pointer items-center gap-xs text-cell font-medium text-muted">
                  <BookOpen size={13} /> Background
                </summary>
                <div className="min-w-0 pb-sm text-meta leading-base text-muted">
                  <Markdown text={selected.context} {...references} />
                </div>
              </details>
            ) : null}

            <section className="kt-attn-action-card__decision" aria-labelledby={`${dialogId}-resolve`}>
              <p id={`${dialogId}-resolve`} className="kt-attn-action-card__label">
                What should happen
              </p>
              <div className="min-w-0 text-cell leading-base text-fg">
                <Markdown text={selected.howToResolve} {...references} />
              </div>
            </section>

            <section className="mt-md" aria-label="Attention actions">
              <p className="m-0 mb-xs text-meta text-faint">
                {kind?.action ?? 'Choose how to clear this item'}.
                {swipeEnabled && selected.ask?.kind !== 'open-question'
                  ? ' On this phone, swipe any labelled answer right or tap it.'
                  : ''}
              </p>
              {selected.ask === undefined ? (
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="primary"
                    className="min-h-[44px]"
                    disabled={busyId === selected.id}
                    onClick={() => void act({ kind: 'resolve' })}
                  >
                    {busyId === selected.id ? (
                      <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" />
                    ) : (
                      <UserRoundCheck size={14} />
                    )}
                    Mark done
                  </Button>
                </div>
              ) : (
                <AttentionAnswerControls
                  key={selected.id}
                  ask={selected.ask}
                  busy={busyId === selected.id}
                  swipeEnabled={swipeEnabled}
                  onRespond={response => void act({ kind: 'respond', response })}
                />
              )}
            </section>

            <footer className="mt-md flex flex-wrap items-center gap-x-sm gap-y-xs border-t border-border-soft pt-sm text-meta text-faint">
              <span>
                Raised by {selected.raisedBy === 'human' ? 'you' : (selected.raisedByName ?? selected.raisedBy)}
              </span>
              <button
                type="button"
                className="ml-auto inline-flex min-h-[44px] items-center gap-xs rounded-control px-cell-x hover:bg-surface-2 hover:text-fg disabled:opacity-50"
                disabled={busyId === selected.id}
                onClick={() => void act({ kind: 'dismiss' })}
              >
                <X size={13} /> Dismiss without answering
              </button>
            </footer>
          </article>
        )}
      </div>

      {selected !== undefined && items.length > 1 ? (
        <nav
          className="flex shrink-0 items-center justify-between border-t border-border-soft px-panel py-row-y"
          aria-label="Attention items"
        >
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="min-h-[44px]"
            disabled={selectedIndex <= 0}
            onClick={() => setDeckChoice({ target: explicitTarget, id: items[selectedIndex - 1]?.id ?? selected.id })}
          >
            <ArrowLeft size={14} /> Older
          </Button>
          <span className="text-meta text-faint">Oldest unresolved first</span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="min-h-[44px]"
            disabled={selectedIndex >= items.length - 1}
            onClick={() => setDeckChoice({ target: explicitTarget, id: items[selectedIndex + 1]?.id ?? selected.id })}
          >
            Newer <ArrowRight size={14} />
          </Button>
        </nav>
      ) : null}
    </BottomSheet>
  );
}

/**
 * The audit evidence for a reference that resolved out from under the click — the
 * SAME badge the resolution ledger uses, so "done by you" reads identically
 * whether the reader arrives from a `!A<n>` link or browses the audit. Read-only:
 * an addressed item exposes no controls, only what the daemon recorded about it.
 */
function AddressedAudit({ record }: { readonly record: ResolvedAttentionItem }) {
  const badge = resolutionBadge(record);
  const BadgeIcon = badge.icon;
  return (
    <div className="mx-auto mt-sm max-w-md border-l-2 border-border-soft pl-sm text-left text-meta leading-base">
      <p className="m-0 font-medium text-muted">{record.subject}</p>
      <p className="m-0 mt-xs flex flex-wrap items-center gap-x-sm gap-y-xs text-faint">
        <span
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider',
            badge.className,
          )}
        >
          <BadgeIcon size={11} aria-hidden="true" />
          {badge.label}
        </span>
        <span>
          {attentionReference(record.id)} · {new Date(record.resolvedAt).toLocaleString()}
        </span>
      </p>
      {record.response ? <p className="m-0 mt-xs font-medium text-muted">{describeResponse(record.response)}</p> : null}
      {record.resolutionNote ? (
        <p className="m-0 mt-xs whitespace-pre-wrap break-words text-faint">{record.resolutionNote}</p>
      ) : null}
    </div>
  );
}
