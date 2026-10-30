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
  SearchX,
  ShieldAlert,
  Sparkles,
  SquareTerminal,
  Terminal,
} from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useInputModality } from '../hooks/use-input-modality.ts';
import { isTaskMenuLabel } from './composer-autocomplete-providers.ts';
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

/**
 * An agent's status as a dot, from the status word the agent row already carries as its badge:
 * working green, waiting amber, anything else quiet. The word stays beside it, so colour is never the
 * only signal.
 */
export const agentStatusTone = (badge: string | undefined): 'ok' | 'warn' | 'idle' => {
  if (badge === undefined) return 'idle';
  if (/running|working|starting|thinking/u.test(badge)) return 'ok';
  if (/wait|awaiting|interrupted|limited/u.test(badge)) return 'warn';
  return 'idle';
};

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
      className={`fy-ac-row${refused ? ' fy-ac-row-refused' : ''}`}
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
      {candidate.kind === 'agent' ? (
        <span aria-hidden="true" className="fy-ac-dot" data-tone={agentStatusTone(candidate.badge)} />
      ) : (
        <Icon aria-hidden="true" className="fy-ac-icon" size={14} />
      )}
      <span className="fy-ac-name">{candidate.label}</span>
      {detail === undefined ? null : <span className="fy-ac-detail">{detail}</span>}
      {candidate.badge === undefined ? null : <span className="fy-ac-badge">{candidate.badge}</span>}
    </div>
  );
}

/**
 * The `@` ladder, inline in the header: every tier, the one the caret is in marked. It is teaching
 * material rather than navigation — repeating the sigil is what selects a family.
 */
function TierLadder({
  legend,
  activeTier,
}: {
  readonly legend: readonly ComposerReferenceTierLegendItem[] | undefined;
  readonly activeTier: number | undefined;
}) {
  if (legend === undefined) return null;
  return (
    <span className="fy-ac-ladder" title="The ladder: one more @ moves to the next kind">
      {legend.map((item, index) => (
        <span
          className="fy-ac-tier"
          data-active={item.trigger.length === activeTier || undefined}
          data-tier={item.tier}
          key={item.trigger}
        >
          {index === 0 ? null : ' · '}
          {item.trigger} {item.label.toLowerCase()}
        </span>
      ))}
    </span>
  );
}

/**
 * The footer's one line: the keys, and on the ladder what one more `@` reaches. A touch screen has
 * no arrow keys, Tab or Escape to name, so there it is only the ladder — or nothing at all.
 */
export const autocompleteFooterHint = (
  legend: readonly ComposerReferenceTierLegendItem[] | undefined,
  activeTier: number | undefined,
  active: ComposerAutocompleteCandidate | undefined,
  touch = false,
): string | null => {
  const next = legend?.find(item => item.tier === (activeTier ?? 0) + 1);
  const ladder = next === undefined ? null : `type @ again for ${next.label.toLowerCase()}`;
  if (touch) return ladder;
  const keys = active === undefined ? '↑↓ choose · esc' : `↵ inserts ${active.replacement} · ⇥ complete · esc`;
  return ladder === null ? keys : `${keys} · ${ladder}`;
};

/**
 * The rendered half of the composer's autocomplete. It reads a controller
 * snapshot and writes back exactly one thing: an accepted index.
 *
 * ONE SMALL POPOVER ABOVE THE CARET: a header (what this list is, and the ladder when there is one),
 * at most six rows of icon · name · one-line hint, and a footer naming the keys. On a phone the same
 * popover spans the composer just above the keyboard, and its rows keep the 44px touch floor.
 */
/** The task menu's one switch: asks the human did not make stay out of it until this is on. */
export interface AgentTasksSwitch {
  readonly included: boolean;
  readonly onToggle: () => void;
}

function AgentTasksToggle({ included, onToggle }: AgentTasksSwitch) {
  const pointer = useRef<number | null>(null);
  return (
    <button
      aria-checked={included}
      className="fy-ac-switch"
      data-agent-tasks-switch=""
      onClick={event => {
        // A keyboard or assistive click has no pointer id; a pointer's own click is handled on lift.
        if (event.detail === 0) onToggle();
      }}
      onPointerCancel={() => {
        pointer.current = null;
      }}
      onPointerDown={event => {
        pointer.current = event.pointerId;
        event.preventDefault();
      }}
      onPointerUp={event => {
        if (pointer.current === event.pointerId) onToggle();
        pointer.current = null;
      }}
      role="switch"
      tabIndex={-1}
      type="button"
    >
      <span aria-hidden="true" className="fy-ac-switch-track" data-on={included || undefined} />
      Include agent tasks
    </button>
  );
}

export function ComposerAutocompletePopover({
  surface,
  agentTasks,
}: {
  readonly surface: ComposerAutocompleteSurface;
  readonly agentTasks?: AgentTasksSwitch | undefined;
}) {
  const { activeIndex, candidates, contextLabel, error, listboxId, match, notice, open, provider, status } = surface;
  // A touch screen gets no key names it cannot press.
  const { touchAffected } = useInputModality();
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
  const ready = status === 'ready' && candidates.length > 0;
  const footer = autocompleteFooterHint(
    provider?.legend,
    match?.referenceTier,
    ready ? candidates[activeIndex] : undefined,
    touchAffected,
  );
  return (
    <>
      <span aria-atomic="true" aria-live="polite" className="sr-only">
        {open ? announcement(status, candidates.length) : ''}
      </span>
      {open ? (
        <div
          className="fy-ac-pop"
          data-composer-autocomplete={provider?.label ?? 'Suggestions'}
          onPointerDown={event => {
            event.preventDefault();
          }}
        >
          <div className="fy-ac-head">
            <span className="fy-ac-title">{contextLabel ?? provider?.label}</span>
            {provider?.legend === undefined ? (
              candidates.length === 0 ? null : (
                <span className="fy-ac-count">{candidates.length}</span>
              )
            ) : (
              <TierLadder activeTier={match?.referenceTier} legend={provider.legend} />
            )}
          </div>
          {agentTasks === undefined || !isTaskMenuLabel(contextLabel) ? null : <AgentTasksToggle {...agentTasks} />}
          <div
            {...(ready ? { 'aria-label': provider?.label ?? 'Suggestions', role: 'listbox' } : {})}
            className="fy-ac-list"
            id={listboxId}
          >
            {status === 'loading' ? (
              <div className="fy-ac-state" role="status">
                <Loader2 aria-hidden="true" className="animate-spin motion-reduce:animate-none" size={14} />
                Searching…
              </div>
            ) : status === 'error' ? (
              <div className="fy-ac-state fy-ac-state-error" role="alert">
                <ShieldAlert aria-hidden="true" size={14} />
                {error ?? 'Suggestions unavailable'}
              </div>
            ) : candidates.length === 0 ? (
              <div className="fy-ac-state" role="status">
                <SearchX aria-hidden="true" size={14} />
                {notice ?? 'Nothing matches yet'}
              </div>
            ) : (
              candidateSections(candidates).map((section, _index, sections) =>
                section.group === undefined ? (
                  rows(section)
                ) : (
                  <fieldset aria-label={section.group} className="m-0 min-w-0 border-0 p-0" key={section.group}>
                    {/* One group needs no heading: the header above already names the list. */}
                    {sections.length === 1 ? null : (
                      <div aria-hidden="true" className="fy-ac-group">
                        {section.group}
                      </div>
                    )}
                    {rows(section)}
                  </fieldset>
                ),
              )
            )}
          </div>
          {notice === undefined || candidates.length === 0 ? null : (
            <div className="fy-ac-notice" role="status">
              {notice}
            </div>
          )}
          {footer === null ? null : <div className="fy-ac-foot">{footer}</div>}
        </div>
      ) : null}
    </>
  );
}
