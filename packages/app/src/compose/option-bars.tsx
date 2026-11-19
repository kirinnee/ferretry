/**
 * OPTION BARS: a few short horizontal bars, one per quality, each with its label: how a voice engine scores on speed,
 * accuracy and size at a glance, in a fixed length so a column of options lines up.
 *
 *   <OptionBars label="Whisper small" bars={[{ label: 'Speed', value: 0.8 }, { label: 'Accuracy', value: 0.6 }]} />
 *
 * `value` is 0..1 (anything else is clamped; a non-number is 0). A bar may carry `text`, the value in words ("0.4 s",
 * "86 MB"): it is drawn at the end of the row and, when present, replaces the percentage in the spoken text, so a bar
 * whose length is only a scale never stands alone. The picture is decorative; the words are one `aria-label` on the
 * group ("Speed 80%, Accuracy 60%"), so a screen reader hears the numbers, not a row of divs.
 */

import { cn } from '../ui/lib/class-names.ts';

export interface OptionBar {
  readonly label: string;
  readonly value: number;
  /** The value in words, drawn after the bar and spoken in place of the percentage. */
  readonly text?: string;
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
  const parts = bars.map(bar => `${bar.label} ${bar.text ?? `${Math.round(barFill(bar.value) * 100)}%`}`).join(', ');
  return label === undefined ? parts : `${label}: ${parts}`;
}

export function OptionBars({ bars, label, className }: OptionBarsProps) {
  const texted = bars.some(bar => bar.text !== undefined);
  return (
    <div
      role="img"
      aria-label={optionBarsText(bars, label)}
      data-option-bars=""
      className={cn('grid w-full min-w-[12rem] gap-1', className)}
    >
      {bars.map(bar => (
        <div
          key={bar.label}
          aria-hidden="true"
          data-option-bar={bar.label.toLowerCase()}
          className={cn(
            'grid min-w-0 items-center gap-2 text-meta text-muted',
            texted ? 'grid-cols-[4.5rem_minmax(0,1fr)_5rem]' : 'grid-cols-[4.5rem_minmax(0,1fr)]',
          )}
        >
          <span className="truncate">{bar.label}</span>
          <span className="h-1.5 min-w-16 overflow-hidden rounded-badge bg-surface-3" data-option-bar-track="">
            <span
              className="block h-full rounded-badge bg-accent"
              style={{ width: `${Math.round(barFill(bar.value) * 100)}%` }}
              data-option-bar-fill=""
            />
          </span>
          {texted ? (
            <span className="truncate text-right text-fg" data-option-bar-text="">
              {bar.text ?? ''}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}
