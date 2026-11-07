/**
 * A FOLDED PART OF THE ITEM VIEW (the detailed context, the activity log): a disclosure, closed by default, whose
 * open or closed state is remembered per item on this device (`agenda-fold.ts`). The heading IS the button, so a
 * keyboard and a screen reader open it as a finger does, and what it holds is not drawn at all while it is closed.
 */

import { ChevronRight } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { readFold, writeFold } from '../../lib/agenda-fold.ts';
import type { ItemViewPart } from '../../lib/agenda-item-sections.ts';

export function AgendaFold({
  part,
  itemKey,
  title,
  meta,
  children,
}: {
  readonly part: ItemViewPart;
  /** Names the item on this device (its machine, conversation and id), so each item keeps its own folds. */
  readonly itemKey: string;
  readonly title: string;
  /** A quiet fact beside the title while it is folded: how many lines the log holds. */
  readonly meta?: string;
  readonly children: ReactNode;
}) {
  const bodyId = useId();
  // Keyed by the item, so another item opening in the same view reads its own fold, not this one's.
  const [state, setState] = useState<{ readonly key: string; readonly open: boolean }>(() => ({
    key: itemKey,
    open: readFold(itemKey, part),
  }));
  const open = state.key === itemKey ? state.open : readFold(itemKey, part);
  const toggle = (): void => {
    const next = !open;
    writeFold(itemKey, part, next);
    setState({ key: itemKey, open: next });
  };
  return (
    <section className="fy-card__part fy-card__fold" data-agenda-part={part} data-open={open || undefined}>
      <h4 className="fy-card__fold-head">
        <button
          aria-controls={bodyId}
          aria-expanded={open}
          className="fy-card__fold-toggle"
          data-agenda-fold={part}
          onClick={toggle}
          type="button"
        >
          <ChevronRight aria-hidden="true" className="fy-card__fold-chevron" size={14} />
          <span className="fy-card__label">{title}</span>
          {meta === undefined ? null : <span className="fy-card__fold-meta">{meta}</span>}
        </button>
      </h4>
      <div className="fy-card__fold-body" hidden={!open} id={bodyId}>
        {open ? children : null}
      </div>
    </section>
  );
}
