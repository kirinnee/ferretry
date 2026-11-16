/**
 * THE GROUND A SWIPE UNCOVERS: while a card is pulled down, the area it leaves bare names what letting go would do —
 * the compass (`agenda-compass.ts`): ↓ Skip, ↓← Skip, ↓→ Not needed, ↓↓ Snooze and its shared choices.
 */

import { Clock, type LucideIcon, SkipForward, X } from 'lucide-react';
import { snoozePicks } from '../../lib/agenda-snooze.ts';

const COMPASS_ARROWS: Readonly<Record<string, string>> = { skip: '↓←', 'not-needed': '↓→', snooze: '↓↓' };

/**
 * THE COMPASS (see `agenda-compass.ts`), drawn on the same ground: ↓← Skip, ↓→ Not needed, ↓↓ Snooze, and — once the
 * drag is that far down — the shared snooze choices of ↓↓↓ (1 hour, 4 hours, Tomorrow 9:00, Custom…). `slot` is the compass's reading (`down`, `down-left`, `down-right`,
 * `down-down`, `down-down-hour`…); the one it names is lit. A direction the host cannot do is not drawn.
 */
export function SwipeCompass({
  slot,
  notNeeded,
  snooze,
}: {
  readonly slot: string | null;
  readonly notNeeded: boolean;
  readonly snooze: boolean;
}) {
  if (slot === null) return null;
  const lit = (name: string): true | undefined =>
    (name === 'skip' && (slot === 'down' || slot === 'down-left')) ||
    (name === 'not-needed' && slot === 'down-right') ||
    (name === 'snooze' && slot.startsWith('down-down'))
      ? true
      : undefined;
  const picked = slot.startsWith('down-down') && slot !== 'down-down' ? slot.slice('down-down-'.length) : null;
  const cell = (name: 'skip' | 'not-needed' | 'snooze', Icon: LucideIcon, label: string) => (
    <span className="fy-swipe-compass__cell" data-active={lit(name)} data-compass-cell={name} key={name}>
      <Icon size={16} />
      <span>
        {COMPASS_ARROWS[name]} {label}
      </span>
    </span>
  );
  return (
    <span
      aria-hidden="true"
      className="fy-swipe-reveal fy-swipe-compass"
      data-swipe-compass=""
      data-swipe-reveal={slot}
      data-tone="quiet"
    >
      <span className="fy-swipe-compass__row">
        {cell('skip', SkipForward, 'Skip')}
        {notNeeded ? cell('not-needed', X, 'Not needed') : null}
      </span>
      {snooze ? <span className="fy-swipe-compass__row">{cell('snooze', Clock, 'Snooze')}</span> : null}
      {snooze && slot.startsWith('down-down') ? (
        <span className="fy-swipe-compass__row" data-compass-lengths="">
          {snoozePicks(Date.now()).map(pick => (
            <span
              className="fy-swipe-compass__cell"
              data-active={picked === pick.id ? true : undefined}
              data-compass-length={pick.id}
              key={pick.id}
            >
              {pick.label}
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}
