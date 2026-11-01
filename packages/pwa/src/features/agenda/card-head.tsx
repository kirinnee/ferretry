import { Info, X } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { AgendaSnoozeMenu } from './agenda-snooze-menu.tsx';
import { StackPager } from './stack-pager.tsx';

export interface CardHeadPager {
  readonly index: number;
  readonly total: number;
  /** What is stepped through, for the buttons' names: "Previous item". */
  readonly noun?: string;
  readonly onPrevious: (() => void) | undefined;
  readonly onNext: (() => void) | undefined;
}

interface CardHeadInfo {
  /** The id of the panel the ⓘ button opens. */
  readonly controls: string;
  readonly open: boolean;
  readonly onToggle: () => void;
}

interface CardHeadSnooze {
  /** Snooze the card until this instant (ISO). The head calls no action itself: the host decides what snoozing is. */
  readonly onSnooze: (until: string) => void;
  /** What the clock is called to a screen reader. */
  readonly label?: string;
  readonly disabled?: boolean;
  readonly now?: number;
}

interface CardHeadClose {
  readonly label: string;
  readonly onClick: () => void;
}

export interface CardHeadProps {
  /** The title, already one line (`MarqueeTitle`). */
  readonly title: ReactNode;
  /** Drawn between the title and the controls: where the card stands (the status dot). */
  readonly status?: ReactNode;
  /** Drawn between the title and the controls, after the status: a quiet fact such as how long the card has waited. */
  readonly meta?: ReactNode;
  readonly pager?: CardHeadPager;
  readonly info?: CardHeadInfo;
  readonly snooze?: CardHeadSnooze;
  readonly close?: CardHeadClose;
  readonly className?: string;
}

const TIGHT = 'fy-item-view__step fy-item-view__step--tight';

/**
 * THE ONE-ROW HEAD every card shares — an agenda item and a card to test, in the Inbox, the quick-answer run and the
 * chat: the title (one line; a marquee when too long), then `status · meta · ‹ n/N › · ⓘ · clock · ✕`. Every part but
 * the title is optional, so the controls are the same, in the same order and at the same size, wherever a card is
 * drawn; snoozing lives here and nowhere else on the card.
 */
export function CardHead({ title, status, meta, pager, info, snooze, close, className }: CardHeadProps): ReactElement {
  return (
    <div
      className={`fy-item-view__bar fy-card-head${className === undefined ? '' : ` ${className}`}`}
      data-card-head=""
    >
      {title}
      <div className="fy-item-view__pager">
        {status}
        {meta}
        {pager === undefined ? null : <StackPager compact {...pager} />}
        {info === undefined ? null : (
          <button
            aria-controls={info.controls}
            aria-expanded={info.open}
            aria-label="About this item"
            className={`${TIGHT} fy-item-view__info-toggle`}
            data-agenda-info-toggle=""
            onClick={info.onToggle}
            type="button"
          >
            <Info aria-hidden="true" size={18} />
          </button>
        )}
        {snooze === undefined ? null : (
          <AgendaSnoozeMenu
            {...(snooze.label === undefined ? {} : { label: snooze.label })}
            {...(snooze.now === undefined ? {} : { now: snooze.now })}
            disabled={snooze.disabled ?? false}
            onSnooze={snooze.onSnooze}
            triggerClass={`${TIGHT} fy-card-head__snooze`}
          />
        )}
        {close === undefined ? null : (
          <button
            aria-label={close.label}
            className={`${TIGHT} fy-item-view__close`}
            data-agenda-close=""
            onClick={close.onClick}
            type="button"
          >
            <X aria-hidden="true" size={18} />
          </button>
        )}
      </div>
    </div>
  );
}
