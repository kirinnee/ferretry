/**
 * OPTION BARS: a few short horizontal bars, one per quality, each with its label: how a voice engine scores on speed,
 * accuracy and size at a glance, in a fixed length so a column of options lines up.
 *
 *   <OptionBars label="Whisper small" bars={[{ label: 'Speed', value: 0.8 }, { label: 'Accuracy', value: 0.6 }]} />
 *
 * `value` is 0..1 (anything else is clamped; a non-number is 0). The picture is decorative; the words are one
 * `aria-label` on the group ("Speed 80%, Accuracy 60%"), so a screen reader hears the numbers, not a row of divs.
 */

import { cn } from '../ui/lib/class-names.ts';

export interface OptionBar {
  readonly label: string;
  readonly value: number;
}

export interface OptionBarsProps {
  readonly bars: readonly OptionBar[];
  /** Names what the bars describe, so the spoken text reads "<label>: Speed 80%". */
  readonly label?: string;
  readonly className?: string;
}

/** A bar's fill, 0..1: out-of-range values are clamped and a non-finite one is empty. */
export const barFill = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

/** The words a screen reader gets for the whole group. */
export function optionBarsText(bars: readonly OptionBar[], label?: string): string {
  const parts = bars.map(bar => `${bar.label} ${Math.round(barFill(bar.value) * 100)}%`).join(', ');
  return label === undefined ? parts : `${label}: ${parts}`;
}

export function OptionBars({ bars, label, className }: OptionBarsProps) {
  return (
    <div
      role="img"
      aria-label={optionBarsText(bars, label)}
      data-option-bars=""
      className={cn('grid min-w-0 gap-1', className)}
    >
      {bars.map(bar => (
        <div
          key={bar.label}
          aria-hidden="true"
          className="grid min-w-0 grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 text-meta text-muted"
        >
          <span className="truncate">{bar.label}</span>
          <span className="h-1.5 overflow-hidden rounded-badge bg-surface-3" data-option-bar-track="">
            <span
              className="block h-full rounded-badge bg-accent"
              style={{ width: `${Math.round(barFill(bar.value) * 100)}%` }}
              data-option-bar-fill=""
            />
          </span>
        </div>
      ))}
    </div>
  );
}
