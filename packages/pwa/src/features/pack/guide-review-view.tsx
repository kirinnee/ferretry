/**
 * REVIEWING A SUGGESTED GUIDE: the builder's draft laid against the guide in effect, one row per use case,
 * with a tick on each change. Nothing is written until a person presses Accept; the request the ticks mean is
 * built by `lib/pack/guide-review.ts`, the same diff and merge `fy guide suggest` uses.
 */

import type {
  GuideChange,
  GuideRouting,
  GuideUseCase,
  GuideUseCaseDiff,
  PackGuideAcceptRequest,
  PackGuideNote,
  PackGuideSuggestion,
} from '@ferretry/protocol';
import { type ReactNode, useMemo, useState } from 'react';
import { cn } from '../../lib/class-names.ts';
import {
  acceptRequest,
  allTicks,
  anyTicked,
  type GuideTicks,
  noteSubject,
  reviewOf,
  suggestedLine,
  ticked,
} from '../../lib/pack/guide-review.ts';
import { absoluteTime } from '../../lib/session-screens.ts';
import { Badge, type BadgeTone, Button } from '../../shell/primitives.tsx';

const STATUS: Readonly<Record<GuideChange, { readonly tone: BadgeTone; readonly label: string }>> = {
  added: { tone: 'ok', label: 'Added' },
  changed: { tone: 'warn', label: 'Changed' },
  removed: { tone: 'err', label: 'Removed' },
  same: { tone: 'pend', label: 'Same' },
};

export interface GuideReviewViewProps {
  readonly suggestion: PackGuideSuggestion;
  readonly busy: boolean;
  readonly onAccept: (request: PackGuideAcceptRequest) => void;
  /** Load the ticked result into the editor's draft instead of saving it. */
  readonly onEdit: (guide: { readonly useCases: readonly GuideUseCase[]; readonly routing?: GuideRouting }) => void;
  readonly onDiscard: () => void;
}

function Side({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1" data-review-side={label.toLocaleLowerCase()}>
      <span className="text-meta font-semibold uppercase tracking-wide text-muted">{label}</span>
      {children}
    </div>
  );
}

function UseCaseSide({
  label,
  useCase,
  missing,
}: {
  readonly label: string;
  readonly useCase: GuideUseCase | undefined;
  readonly missing: string;
}) {
  return (
    <Side label={label}>
      {useCase === undefined ? (
        <p className="m-0 text-meta text-muted">{missing}</p>
      ) : (
        <>
          <p className="m-0 break-words text-ui font-semibold">{useCase.title}</p>
          <ol className="m-0 flex list-none flex-col gap-1 p-0">
            {useCase.candidates.map((candidate, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a candidate has no identity but its rank
              <li key={index} className="min-w-0 text-meta leading-base" data-review-candidate="">
                <span className="font-semibold">#{index + 1}</span>{' '}
                <span className="mono break-all">{candidate.model}</span>
                {candidate.effort === undefined ? null : (
                  <span className="text-muted"> · effort {candidate.effort}</span>
                )}
                <span className="block break-words text-muted">{candidate.why}</span>
              </li>
            ))}
          </ol>
        </>
      )}
    </Side>
  );
}

function Tick({
  label,
  checked,
  disabled,
  onChange,
  attribute,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly attribute: string;
}) {
  return (
    <label className="flex min-h-[44px] shrink-0 cursor-pointer items-center gap-2 text-ui">
      <input
        type="checkbox"
        className="h-5 w-5"
        checked={checked}
        disabled={disabled}
        onChange={event => onChange(event.currentTarget.checked)}
        {...{ [attribute]: '' }}
      />
      {label}
    </label>
  );
}

function RowCard({
  row,
  accepted,
  disabled,
  onToggle,
}: {
  readonly row: GuideUseCaseDiff;
  readonly accepted: boolean;
  readonly disabled: boolean;
  readonly onToggle: (accepted: boolean) => void;
}) {
  const status = STATUS[row.status];
  return (
    <li className="kt-panel flex min-w-0 flex-col gap-2 p-3" data-review-row={row.id} data-review-status={row.status}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0">
        <Badge tone={status.tone}>{status.label}</Badge>
        <span className="mono min-w-0 flex-1 break-all text-meta text-muted">{row.id}</span>
        {row.status === 'same' ? null : (
          <Tick
            label="Accept"
            checked={accepted}
            disabled={disabled}
            onChange={onToggle}
            attribute="data-review-accept"
          />
        )}
      </div>
      {row.status === 'same' ? (
        <p className="m-0 min-w-0 break-words text-meta text-muted">{row.after?.title} — no change.</p>
      ) : (
        <>
          <div className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2">
            <UseCaseSide label="Before" useCase={row.before} missing="Not in the current guide." />
            <UseCaseSide label="After" useCase={row.after} missing="Taken out of the guide." />
          </div>
          {row.changes.length === 0 ? null : (
            <ul className="m-0 flex flex-col gap-0.5 pl-5 text-meta leading-base text-fg-soft" data-review-changes="">
              {row.changes.map(change => (
                <li key={change} className="break-words">
                  {change}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </li>
  );
}

function RoutingCard({
  before,
  after,
  differs,
  accepted,
  disabled,
  onToggle,
}: {
  readonly before: GuideRouting | undefined;
  readonly after: GuideRouting;
  readonly differs: boolean;
  readonly accepted: boolean;
  readonly disabled: boolean;
  readonly onToggle: (accepted: boolean) => void;
}) {
  return (
    <section
      className="kt-panel flex min-w-0 flex-col gap-2 p-3"
      data-review-routing={differs ? 'changed' : 'same'}
      aria-label="Routing guidance"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2">
        <Badge tone={differs ? 'warn' : 'pend'}>{differs ? 'Changed' : 'Same'}</Badge>
        <span className="min-w-0 flex-1 text-ui font-semibold">Routing guidance</span>
        {differs ? (
          <Tick
            label="Accept"
            checked={accepted}
            disabled={disabled}
            onChange={onToggle}
            attribute="data-review-accept-routing"
          />
        ) : null}
      </div>
      {differs ? (
        <div className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2">
          <RoutingSide label="Before" routing={before} />
          <RoutingSide label="After" routing={after} />
        </div>
      ) : (
        <p className="m-0 break-words text-meta text-muted">{after.short} — no change.</p>
      )}
    </section>
  );
}

function RoutingSide({ label, routing }: { readonly label: string; readonly routing: GuideRouting | undefined }) {
  return (
    <Side label={label}>
      {routing === undefined ? (
        <p className="m-0 text-meta text-muted">No routing guidance yet.</p>
      ) : (
        <>
          <p className="m-0 break-words text-ui font-semibold">{routing.short}</p>
          <p className="m-0 max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-meta leading-base text-fg-soft">
            {routing.prompt}
          </p>
        </>
      )}
    </Side>
  );
}

function Notes({
  title,
  notes,
  tone,
  attribute,
}: {
  readonly title: string;
  readonly notes: readonly PackGuideNote[];
  readonly tone: 'err' | 'warn';
  readonly attribute: string;
}) {
  if (notes.length === 0) return null;
  return (
    <section
      className={cn(
        'flex min-w-0 flex-col gap-1 rounded-control border px-3 py-2',
        tone === 'err' ? 'border-err-border bg-err-bg' : 'border-warn-border bg-warn-bg',
      )}
      {...{ [attribute]: '' }}
    >
      <h4 className={cn('m-0 text-ui font-semibold', tone === 'err' ? 'text-err' : 'text-warn')}>{title}</h4>
      <ul className="m-0 flex flex-col gap-1 pl-5 text-meta leading-base">
        {notes.map(note => (
          <li key={`${noteSubject(note)}\u0000${note.message}`} className="break-words">
            {noteSubject(note) === '' ? '' : <span className="font-semibold">{noteSubject(note)}: </span>}
            {note.message}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function GuideReviewView({ suggestion, busy, onAccept, onEdit, onDiscard }: GuideReviewViewProps) {
  const review = useMemo(() => reviewOf(suggestion), [suggestion]);
  const [ticks, setTicks] = useState<GuideTicks>(() => allTicks(review));
  const toggleRow = (id: string, on: boolean): void => {
    const accepted = new Set(ticks.accepted);
    if (on) accepted.add(id);
    else accepted.delete(id);
    setTicks({ ...ticks, accepted });
  };
  const some = anyTicked(review, ticks);
  const nothingChanges = review.changing.length === 0 && !review.routingDiffers;
  return (
    <div className="flex min-w-0 flex-col gap-3" data-guide-review="">
      <p className="m-0 text-ui font-semibold" data-review-header="">
        {suggestedLine(suggestion.suggested, absoluteTime(suggestion.suggested.at))}
      </p>
      {nothingChanges ? (
        <p className="m-0 text-meta text-muted">The builder suggests nothing that differs from the guide in effect.</p>
      ) : null}
      <RoutingCard
        before={suggestion.current.routing}
        after={suggestion.routing}
        differs={review.routingDiffers}
        accepted={ticks.routing}
        disabled={busy}
        onToggle={routing => setTicks({ ...ticks, routing })}
      />
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {review.rows.map(row => (
          <RowCard
            key={row.id}
            row={row}
            accepted={ticks.accepted.has(row.id)}
            disabled={busy}
            onToggle={on => toggleRow(row.id, on)}
          />
        ))}
      </ul>
      <Notes
        title="Dropped — not in any catalog"
        notes={suggestion.dropped}
        tone="err"
        attribute="data-review-dropped"
      />
      <Notes title="Flagged — kept, but check" notes={suggestion.flagged} tone="warn" attribute="data-review-flagged" />
      <div className="flex flex-wrap gap-2 border-t border-border-soft pt-3">
        <Button
          variant="primary"
          className="min-h-[44px]"
          disabled={busy || !some}
          onClick={() => onAccept(acceptRequest(suggestion, review, ticks))}
          data-review-action="accept-selected"
        >
          Accept selected
        </Button>
        <Button
          className="min-h-[44px]"
          disabled={busy || nothingChanges}
          onClick={() => onAccept(acceptRequest(suggestion, review, allTicks(review)))}
          data-review-action="accept-all"
        >
          Accept all
        </Button>
        <Button
          className="min-h-[44px]"
          disabled={busy || !some}
          onClick={() => onEdit(ticked(suggestion, review, ticks))}
          data-review-action="edit"
        >
          Edit
        </Button>
        <Button
          variant="ghost"
          className="min-h-[44px]"
          disabled={busy}
          onClick={onDiscard}
          data-review-action="discard"
        >
          Discard
        </Button>
      </div>
    </div>
  );
}
