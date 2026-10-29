/**
 * THE FOLDED PINNED CARD: one slim line above the composer — "● Needs you · <title> · N more ›". It is
 * the way back, not an answer: pressing it (or Enter / Space on it) unfolds the card, and nothing was told
 * to the ferret while it was folded.
 */

import type { AttentionItem } from '@ferretry/protocol';
import { attentionTitle, hasOwnTitle } from '@ferretry/protocol';
import { ChevronDown } from 'lucide-react';

/** The heading the expanded card shows for this item. */
const attentionHeading = (item: AttentionItem): string =>
  hasOwnTitle(item) ? attentionTitle(item) : item.subject.trim();

export interface AttentionCollapseButtonProps {
  readonly controls: string;
  readonly onCollapse: () => void;
}

/** The ⌄ in the header of the expanded card. */
export function AttentionCollapseButton({ controls, onCollapse }: AttentionCollapseButtonProps) {
  return (
    <button
      aria-controls={controls}
      aria-expanded="true"
      aria-label="Fold this card"
      className="fy-attn-collapse"
      data-attention-collapse=""
      onClick={onCollapse}
      title="Fold this card"
      type="button"
    >
      <ChevronDown aria-hidden="true" size={16} />
    </button>
  );
}

export interface AttentionCollapsedLineProps {
  readonly item: AttentionItem;
  /** Open items beyond the one named. */
  readonly more: number;
  readonly controls: string;
  readonly onExpand: () => void;
}

export function AttentionCollapsedLine({ item, more, controls, onExpand }: AttentionCollapsedLineProps) {
  return (
    <button
      aria-controls={controls}
      aria-expanded="false"
      className="fy-attn-collapsed"
      data-attention-collapsed=""
      onClick={onExpand}
      type="button"
    >
      <span aria-hidden="true" className="fy-attn-collapsed__dot" />
      <span className="fy-attn-collapsed__lead">Needs you</span>
      <span aria-hidden="true" className="fy-attn-collapsed__sep">
        ·
      </span>
      <span className="fy-attn-collapsed__title" data-attention-collapsed-title="">
        {attentionHeading(item)}
      </span>
      {more > 0 ? (
        <>
          <span aria-hidden="true" className="fy-attn-collapsed__sep">
            ·
          </span>
          <span className="fy-attn-collapsed__more" data-attention-collapsed-more="">
            {more} more
          </span>
        </>
      ) : null}
      <span aria-hidden="true" className="fy-attn-collapsed__go">
        ›
      </span>
    </button>
  );
}
