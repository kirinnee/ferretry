/**
 * "UPDATED 5 MIN AGO" — what makes a card a living summary of its discussion. The button says when the ferret
 * last edited the item; pressing it opens a read-only list of the earlier versions (newest first: when, who,
 * which fields changed and what each said before). It is a disclosure under the button, not a route.
 * Nothing here edits anything.
 */

import type { AgendaItem } from '@ferretry/protocol';
import { ChevronDown, History } from 'lucide-react';
import { type KeyboardEvent, useId, useRef, useState } from 'react';
import { decidedSummary, revisionAuthor, revisionList, revisionStamp, updatedAgo } from '../../lib/agenda-revisions.ts';
import { PointForm } from './agenda-brief.tsx';

/** The one line "3 decided · 2 still open", when the item carries either list. */
export function AgendaDecidedSummary({ item }: { readonly item: AgendaItem }) {
  const line = decidedSummary(item);
  return line === null ? null : (
    <span className="fy-attn-summary text-meta text-muted" data-agenda-summary="">
      {line}
    </span>
  );
}

/** The earlier versions of an item, newest first: when, who, which fields changed and what each said before. */
function AgendaRevisions({
  item,
  now,
  id,
}: {
  readonly item: Pick<AgendaItem, 'revisions'>;
  readonly now: number;
  readonly id?: string;
}) {
  const entries = revisionList(item);
  return (
    <section aria-label="Earlier versions" className="fy-attn-revisions" data-agenda-revisions="" id={id}>
      <ol className="fy-attn-revisions__list">
        {entries.map(entry => (
          <li className="fy-attn-revisions__item" data-agenda-revision={entry.at} key={`${entry.at}-${entry.by}`}>
            <p className="fy-attn-revisions__head m-0">
              <time dateTime={entry.at}>{revisionStamp(entry.at, now)}</time>
              <span>
                {revisionAuthor(entry.by)} changed {entry.changed.map(change => change.label).join(', ')}
              </span>
            </p>
            <dl className="fy-attn-revisions__fields m-0">
              {entry.changed.map(change => (
                <div key={change.field}>
                  {change.before === null ? (
                    <dt>{change.label} was empty</dt>
                  ) : (
                    <>
                      <dt>{change.label} was</dt>
                      <dd className="m-0">
                        <PointForm text={change.before} />
                      </dd>
                    </>
                  )}
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function AgendaUpdated({
  item,
  now,
  compact = false,
}: {
  readonly item: Pick<AgendaItem, 'revisions'>;
  /** The instant "5 min ago" counts from. Default: when this was first drawn. */
  readonly now?: number;
  /** Drawn as a quiet link on a chat message rather than on a card. */
  readonly compact?: boolean;
}) {
  const [drawnAt] = useState(() => Date.now());
  const [open, setOpen] = useState(false);
  const listId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const label = updatedAgo(item, now ?? drawnAt);
  if (label === null) return null;
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape' || !open) return;
    event.stopPropagation();
    setOpen(false);
    button.current?.focus();
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the keydown handler only routes Esc to the list inside it
    <span className="fy-attn-updated" data-compact={compact || undefined} onKeyDown={onKeyDown}>
      <button
        aria-controls={open ? listId : undefined}
        aria-expanded={open}
        className="kt-btn kt-btn--sm fy-attn-updated__button"
        data-agenda-updated=""
        onClick={() => setOpen(current => !current)}
        ref={button}
        title="See the earlier versions of this item"
        type="button"
      >
        <History aria-hidden="true" size={13} />
        {label}
        <ChevronDown aria-hidden="true" className="fy-attn-updated__chevron" size={13} />
      </button>
      {open ? <AgendaRevisions id={listId} item={item} now={now ?? drawnAt} /> : null}
    </span>
  );
}
