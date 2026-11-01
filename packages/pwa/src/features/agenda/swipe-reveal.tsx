/**
 * THE GROUND A SWIPE UNCOVERS: while a card is pulled, the area it leaves bare names what letting go would do, in the
 * same words and tones as the to-test rows' reveals. One list of {@link SwipeRevealSpec}s says what a slot reads; a new
 * gesture layer (↓← Skip, ↓→ Not needed, ↓↓ Snooze) is one more spec with its own slot, not a new component.
 */

import type { LucideIcon } from 'lucide-react';
import { SkipForward } from 'lucide-react';

export interface SwipeRevealSpec {
  /** What the gesture is called: `down`, and later `down-left`, `down-right`, `down-down`. */
  readonly slot: string;
  readonly label: string;
  readonly icon: LucideIcon;
  /** The tone family: `quiet` (nothing changes), `ok` or `err`. */
  readonly tone: 'quiet' | 'ok' | 'err';
}

/** What a card on the deck reveals today: only ↓, which is Skip. */
const DECK_REVEALS: readonly SwipeRevealSpec[] = [{ slot: 'down', label: 'Skip', icon: SkipForward, tone: 'quiet' }];

/** The reveal for `active` (a slot) is drawn; the others are not drawn at all. Decoration: the card carries the answer. */
export function SwipeReveal({
  reveals = DECK_REVEALS,
  active,
}: {
  readonly reveals?: readonly SwipeRevealSpec[];
  readonly active: string | null;
}) {
  const spec = reveals.find(reveal => reveal.slot === active);
  if (spec === undefined) return null;
  const Icon = spec.icon;
  return (
    <span aria-hidden="true" className="fy-swipe-reveal" data-swipe-reveal={spec.slot} data-tone={spec.tone}>
      <Icon size={16} />
      {spec.label}
    </span>
  );
}
