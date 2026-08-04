/**
 * The composer's visible candidate surface.
 *
 * The controller in `composer-autocomplete.ts` already decides everything a
 * completion needs — which trigger is active, which candidates rank, which row
 * is selected, and what a keystroke means. What it deliberately does not own is
 * a pixel. Until this component existed the composer therefore carried a
 * complete engine whose selection nobody could see: typing `/` opened a ready
 * list with an active row, and Enter accepted a candidate the reader had never
 * been shown. This renders that published state, and nothing else.
 *
 * Two invariants are load-bearing:
 *
 *   FOCUS NEVER MOVES. Rows are pointer targets that `preventDefault()` on
 *   pointerdown, so a tap keeps the caret — and a phone's on-screen keyboard —
 *   exactly where it was. Nothing here is focusable and nothing calls focus().
 *
 *   THIS SURFACE IS THE PERMISSION SLIP FOR ENTER. `composer.tsx` lets the
 *   controller consume Enter only while a row is both rendered and selected, so
 *   a list that is loading, empty or refused can never swallow a send.
 *
 * The rows container carries the controller's `listboxId`, because two other
 * contracts address that exact element: the textarea's `aria-controls` /
 * `aria-activedescendant`, and the controller's outside-click dismissal, which
 * looks the id up in the document. So a pointer on a row is recognised as the
 * list's own, while a click on the surrounding chrome is honestly "outside the
 * candidates" and dismisses — without taking the keyboard down with it, which
 * is what the chrome's own `preventDefault()` is for.
 */

import {
  Bell,
  Bot,
  FileText,
  Folder,
  ListChecks,
  Loader2,
  type LucideIcon,
  Pin,
  SearchX,
  ShieldAlert,
  Sparkles,
  SquareTerminal,
  Terminal,
} from 'lucide-react';
import { useEffect, useRef } from 'react';
import type {
  ComposerAutocompleteCandidate,
  ComposerAutocompleteController,
  ComposerAutocompleteKind,
  ComposerReferenceTierLegendItem,
} from './composer-autocomplete.ts';

/**
 * Exactly the controller facts a rendered list needs. Narrowing here keeps the
 * keyboard half (`handleKeyDown`, `syncSelection`, `textareaAria`) out of a
 * component that must never handle a key itself.
 */
export type ComposerAutocompleteSurface = Pick<
  ComposerAutocompleteController,
  | 'open'
  | 'status'
  | 'provider'
  | 'match'
  | 'candidates'
  | 'activeIndex'
  | 'contextLabel'
  | 'notice'
  | 'error'
  | 'listboxId'
  | 'accept'
>;

/** Total by construction: every candidate kind the engine can emit has a mark. */
const KIND_ICON: Record<ComposerAutocompleteKind, LucideIcon> = {
  command: Terminal,
  skill: Sparkles,
  agent: Bot,
  file: FileText,
  directory: Folder,
  task: ListChecks,
  attention: Bell,
  pin: Pin,
  // A surface is a live thing in this session; the square glyph reads as the pane
  // it lives in, which is what the reader is about to point an agent at.
  surface: SquareTerminal,
};

/** The id the textarea's `aria-activedescendant` already points at. */
const optionId = (listboxId: string, index: number): string => `${listboxId}-option-${index}`;

interface CandidateSection {
  readonly group?: string;
  readonly items: readonly { readonly candidate: ComposerAutocompleteCandidate; readonly index: number }[];
}

/**
 * Split a ranked list into rendered sections while preserving each candidate's
 * ORIGINAL index. Ranking is the engine's answer and the active row is
 * addressed by position, so grouping is allowed to reorder nothing.
 */
function candidateSections(candidates: readonly ComposerAutocompleteCandidate[]): readonly CandidateSection[] {
  const sections: { group?: string; items: { candidate: ComposerAutocompleteCandidate; index: number }[] }[] = [];
  candidates.forEach((candidate, index) => {
    const current = sections.at(-1);
    if (current === undefined || current.group !== candidate.group)
      sections.push({ group: candidate.group, items: [{ candidate, index }] });
    else current.items.push({ candidate, index });
  });
  return sections;
}

/** What a screen reader hears once the list settles, as one short sentence. */
function announcement(status: ComposerAutocompleteSurface['status'], count: number): string {
  if (status === 'loading') return 'Loading suggestions';
  if (status === 'error') return 'Suggestions unavailable';
  return count === 1 ? '1 suggestion' : `${count} suggestions`;
}

function CandidateRow({
  candidate,
  index,
  active,
  listboxId,
  onAccept,
}: {
  readonly candidate: ComposerAutocompleteCandidate;
  readonly index: number;
  readonly active: boolean;
  readonly listboxId: string;
  readonly onAccept: (index: number) => void;
}) {
  // One pointer id, so a drag that begins on a row and lifts somewhere else
  // never inserts the candidate the reader moved away from.
  const pointer = useRef<number | null>(null);
  const Icon = KIND_ICON[candidate.kind];
  const refused = candidate.disabled === true;
  const detail = refused ? (candidate.disabledReason ?? candidate.detail) : candidate.detail;
  return (
    <div
      aria-disabled={refused || undefined}
      aria-selected={active}
      className={`flex min-h-[44px] w-full select-none items-center gap-sm border-l-[3px] border-l-transparent px-control-x py-row-y text-left text-fg outline-none${active ? ' border-l-accent bg-accent-soft shadow-active' : ''}${refused ? ' cursor-not-allowed opacity-70' : ' cursor-pointer hover:bg-surface-2'}`}
      data-active={active || undefined}
      data-kind={candidate.kind}
      id={optionId(listboxId, index)}
      onPointerCancel={() => {
        pointer.current = null;
      }}
      onPointerDown={event => {
        pointer.current = event.pointerId;
        // The caret — and on a phone the keyboard — belongs to the textarea.
        event.preventDefault();
      }}
      onPointerUp={event => {
        if (!refused && pointer.current === event.pointerId) onAccept(index);
        pointer.current = null;
      }}
      role="option"
      tabIndex={-1}
      title={candidate.disabledReason}
    >
      <Icon aria-hidden="true" className="shrink-0 text-faint" size={15} />
      <span className="min-w-0 flex-1 leading-tight">
        <span className="mono block truncate font-medium text-current">{candidate.label}</span>
        {detail === undefined ? null : (
          <span className={`block truncate text-meta${refused ? ' text-warn' : ' text-muted'}`}>{detail}</span>
        )}
      </span>
      {candidate.badge === undefined ? null : (
        <span className="mono shrink-0 rounded-badge border border-border-soft bg-surface px-badge-x py-px text-2xs text-faint">
          {candidate.badge}
        </span>
      )}
    </div>
  );
}

/**
 * The `@` tier legend. It is teaching material rather than navigation:
 * repeating the sigil is what selects a family, so the tier the reader is
 * currently in is marked instead of made clickable.
 */
function TierLegend({
  legend,
  activeTier,
}: {
  readonly legend: readonly ComposerReferenceTierLegendItem[] | undefined;
  readonly activeTier: number | undefined;
}) {
  if (legend === undefined) return null;
  return (
    <div className="flex flex-wrap items-center gap-xs border-b border-border-soft px-control-x py-1">
      {legend.map(item => (
        <span
          className={`mono rounded-badge border px-badge-x py-px text-2xs${item.trigger.length === activeTier ? ' border-accent bg-accent-soft text-fg' : ' border-border-soft text-faint'}`}
          data-tier={item.tier}
          key={item.trigger}
        >
          {item.trigger} {item.label}
        </span>
      ))}
    </div>
  );
}

/**
 * The rendered half of the composer's autocomplete. It reads a controller
 * snapshot and writes back exactly one thing: an accepted index.
 */
export function ComposerAutocompletePopover({ surface }: { readonly surface: ComposerAutocompleteSurface }) {
  const { activeIndex, candidates, contextLabel, error, listboxId, match, notice, open, provider, status } = surface;
  const activeOptionId = open && activeIndex >= 0 ? optionId(listboxId, activeIndex) : undefined;
  // Arrow keys must not walk the selection out of the scroller. The row is
  // looked up by id rather than held in a ref because the active row moves.
  useEffect(() => {
    if (activeOptionId === undefined || typeof document === 'undefined') return;
    document.getElementById(activeOptionId)?.scrollIntoView({ block: 'nearest' });
  }, [activeOptionId]);
  const rows = (section: CandidateSection) =>
    section.items.map(item => (
      <CandidateRow
        active={item.index === activeIndex}
        candidate={item.candidate}
        index={item.index}
        key={item.candidate.id}
        listboxId={listboxId}
        onAccept={surface.accept}
      />
    ));
  return (
    <>
      <span aria-atomic="true" aria-live="polite" className="sr-only">
        {open ? announcement(status, candidates.length) : ''}
      </span>
      {open ? (
        <div
          className="absolute inset-x-0 bottom-[calc(100%+var(--gap-xs))] z-40 overflow-hidden rounded-panel border-panel border-border-strong bg-surface shadow-popover"
          data-composer-autocomplete={provider?.label ?? 'Suggestions'}
          onPointerDown={event => {
            event.preventDefault();
          }}
        >
          <div className="flex min-h-[34px] items-center gap-sm border-b border-border-soft bg-surface-2 px-control-x py-1">
            <span className="min-w-0 flex-1 truncate text-meta font-semibold uppercase tracking-label text-fg-soft">
              {contextLabel ?? provider?.label}
            </span>
            {candidates.length === 0 ? null : (
              <span className="mono shrink-0 text-2xs text-faint">{candidates.length}</span>
            )}
          </div>
          <TierLegend activeTier={match?.referenceTier} legend={provider?.legend} />
          <div
            {...(status === 'ready' && candidates.length > 0
              ? { 'aria-label': provider?.label ?? 'Suggestions', role: 'listbox' }
              : {})}
            className="relative max-h-[min(280px,max(88px,calc(var(--app-h,100dvh)*0.34)))] overflow-y-auto overscroll-contain scroll-thin [touch-action:pan-y]"
            id={listboxId}
          >
            {status === 'loading' ? (
              <div
                className="flex min-h-[44px] items-center gap-sm px-control-x py-row-y text-meta text-muted"
                role="status"
              >
                <Loader2 aria-hidden="true" className="animate-spin motion-reduce:animate-none" size={15} />
                Searching…
              </div>
            ) : status === 'error' ? (
              <div
                className="flex min-h-[44px] items-center gap-sm px-control-x py-row-y text-meta text-err"
                role="alert"
              >
                <ShieldAlert aria-hidden="true" size={15} />
                {error ?? 'Suggestions unavailable'}
              </div>
            ) : candidates.length === 0 ? (
              <div
                className="flex min-h-[44px] items-center gap-sm px-control-x py-row-y text-meta text-muted"
                role="status"
              >
                <SearchX aria-hidden="true" size={15} />
                {notice ?? 'Nothing matches yet'}
              </div>
            ) : (
              candidateSections(candidates).map(section =>
                section.group === undefined ? (
                  rows(section)
                ) : (
                  <fieldset aria-label={section.group} className="m-0 min-w-0 border-0 p-0" key={section.group}>
                    <div aria-hidden="true" className="kt-label px-control-x pb-xs pt-xs">
                      {section.group}
                    </div>
                    {rows(section)}
                  </fieldset>
                ),
              )
            )}
          </div>
          {notice === undefined || candidates.length === 0 ? null : (
            <div
              className="border-t border-border-soft bg-warn-bg px-control-x py-1 text-2xs leading-base text-warn"
              role="status"
            >
              {notice}
            </div>
          )}
        </div>
      ) : null}
    </>
  );
}
