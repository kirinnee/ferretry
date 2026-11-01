/**
 * THE GROUND A SWIPE UNCOVERS: while a card is pulled down, the area it leaves bare names what letting go would do —
 * the compass (`agenda-compass.ts`): ↓ Skip, ↓← Skip, ↓→ Not needed, ↓↓ Snooze and its three lengths.
 */

import { Clock, type LucideIcon, SkipForward, X } from 'lucide-react';
import { SNOOZE_LENGTHS } from './agenda-compass.ts';

const COMPASS_ARROWS: Readonly<Record<string, string>> = { skip: '↓←', 'not-needed': '↓→', snooze: '↓↓' };

/**
 * THE COMPASS (see `agenda-compass.ts`), drawn on the same ground: ↓← Skip, ↓→ Not needed, ↓↓ Snooze, and — once the
 * drag is that far down — the three lengths of ↓↓↓. `slot` is the compass's reading (`down`, `down-left`, `down-right`,
 * `down-down`, `down-down-1h`…); the one it names is lit. A direction the host cannot do is not drawn.
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
  const lengths = slot.startsWith('down-down') && slot !== 'down-down' ? slot.slice('down-down-'.length) : null;
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
          {SNOOZE_LENGTHS.map(length => (
            <span
              className="fy-swipe-compass__cell"
              data-active={lengths === length.id ? true : undefined}
              data-compass-length={length.id}
              key={length.id}
            >
              {length.label}
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}
