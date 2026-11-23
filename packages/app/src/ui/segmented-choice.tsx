/**
 * SEGMENTED CHOICE — a labelled radio group drawn as one pill of segments: exactly one segment is on, and the reader
 * picks which. It is for a choice between a few named ways in ("New | Continue", "Folder | Project"), not for a switch
 * (that is `FastSwitch`) and not for a long list (that is a picker).
 *
 * It follows the WAI-ARIA radio-group pattern (https://www.w3.org/WAI/ARIA/apg/patterns/radio/):
 *  - the group is `role="radiogroup"` with a name, and each segment is `role="radio"` with `aria-checked`;
 *  - the group is ONE Tab stop: only the chosen segment is tabbable (`tabIndex` 0), the rest are -1;
 *  - arrow keys (and Home / End) move the choice, wrapping, and focus follows it — as with native radios, moving
 *    selects;
 *  - the focused segment draws a visible ring that does not depend on the selected fill.
 */

import { type HTMLAttributes, type KeyboardEvent, type ReactNode, useRef } from 'react';
import { cn } from './lib/class-names.ts';

export interface SegmentedChoiceOption<V extends string> {
  readonly value: V;
  readonly label: ReactNode;
}

export interface SegmentedChoiceProps<V extends string>
  extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange' | 'role' | 'children'> {
  /** What the group is called, spoken with the first segment on entry. Required: an unnamed radio group is not one. */
  readonly label: string;
  readonly options: readonly SegmentedChoiceOption<V>[];
  readonly value: V;
  readonly onChange: (value: V) => void;
  /** `fill` (default) shares the width equally, for a two-way choice at the top of a form; `fit` hugs its labels. */
  readonly layout?: 'fill' | 'fit';
}

/** The next index a key moves to, or `null` when the key is not one of the group's. */
const targetIndex = (key: string, from: number, count: number): number | null => {
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (from + 1) % count;
    case 'ArrowLeft':
    case 'ArrowUp':
      return (from - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
};

export function SegmentedChoice<V extends string>({
  label,
  options,
  value,
  onChange,
  layout = 'fill',
  className,
  ...rest
}: SegmentedChoiceProps<V>) {
  const segments = useRef<(HTMLButtonElement | null)[]>([]);
  const chosen = options.findIndex(option => option.value === value);
  // A value that names no segment still leaves one way into the group: the first.
  const tabbable = chosen === -1 ? 0 : chosen;

  const move = (event: KeyboardEvent<HTMLButtonElement>, from: number): void => {
    const to = targetIndex(event.key, from, options.length);
    if (to === null || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    const next = options[to];
    if (next === undefined) return;
    onChange(next.value);
    segments.current[to]?.focus();
  };

  return (
    <div
      {...rest}
      aria-label={label}
      className={cn(
        'gap-0.5 rounded-control border border-border bg-surface-2 p-0.5',
        layout === 'fill' ? 'grid' : 'inline-grid',
        className,
      )}
      role="radiogroup"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, ${layout === 'fill' ? '1fr' : 'auto'}))` }}
    >
      {options.map((option, index) => {
        const on = index === chosen;
        return (
          // biome-ignore lint/a11y/useSemanticElements: the APG radio pattern on buttons — a native radio cannot be drawn as a segment of one pill and keep this focus ring
          <button
            aria-checked={on}
            className={cn(
              'min-h-[44px] rounded-control px-2 text-center text-ui font-medium leading-tight transition-colors',
              'focus-visible:outline-focus focus-visible:outline-offset-focus',
              on
                ? 'border border-border-strong bg-surface text-fg shadow-control'
                : 'border border-transparent text-muted hover:text-fg',
            )}
            data-segment={option.value}
            key={option.value}
            onClick={() => {
              if (!on) onChange(option.value);
            }}
            onKeyDown={event => move(event, index)}
            ref={node => {
              segments.current[index] = node;
            }}
            role="radio"
            tabIndex={index === tabbable ? 0 : -1}
            type="button"
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
