/**
 * THE CHAT'S CARD CHIP: `&F18 Board system · Plan/Design · ● active` in the header, a tap away from the card.
 *
 * No card is an amber `No card`, not a link: there is nowhere to go. Status is a dot and a word, never a
 * coloured edge.
 */

import { type ChatChip, chatChipSentence } from '../../lib/board-chat.ts';
import { RouteLink } from '../../shell/route-link.tsx';

export interface ChatCardChipProps {
  readonly chip: ChatChip;
  /** Where the card opens (`/d/<id>/board/<taskId>`). */
  readonly href: string;
  readonly onNavigate?: (to: string) => void;
}

export function ChatCardChip({ chip, href, onNavigate }: ChatCardChipProps) {
  if (chip.kind === 'none') {
    return (
      <span
        className="fy-card-chip"
        data-card-chip="none"
        data-tone="warn"
        title="This ferret has no card on the board yet"
      >
        No card
      </span>
    );
  }
  return (
    <RouteLink
      aria-label={`Card ${chatChipSentence(chip)}`}
      className="fy-card-chip"
      data-card-chip="card"
      data-card-id={chip.id}
      onNavigate={onNavigate}
      title={chatChipSentence(chip)}
      to={href}
    >
      <span className="fy-card-chip__ref">{chip.ref}</span>
      {chip.title === null ? null : <span className="fy-card-chip__title">{chip.title}</span>}
      {chip.lane === null ? null : (
        <span className="fy-card-chip__lane" data-part="lane">
          {chip.lane}
        </span>
      )}
      {chip.activity === null ? null : (
        <span className="fy-card-chip__activity" data-part="activity" data-tone={chip.tone}>
          <span aria-hidden="true" className="fy-card-chip__dot">
            ●
          </span>
          {chip.activity}
        </span>
      )}
    </RouteLink>
  );
}
