/**
 * STEP PROGRESS: one segment per stage of a stepper, the current one lit, and "<stage> · n of m" under the bar.
 *
 *   <StepProgress segments={[{ id: 'machine', label: 'Machine' }, { id: 'claude', label: 'Claude Code' }]}
 *     current="claude" step={3} of={7} />
 *
 * The bar is decorative; the one text line is what a screen reader hears (`role="progressbar"` carries `n of m`).
 * Segments before the current one are filled, so the bar reads left to right. Colour comes from theme tokens.
 */

import type { CSSProperties } from 'react';

export interface StepSegment {
  readonly id: string;
  readonly label: string;
}

export interface StepProgressProps {
  readonly segments: readonly StepSegment[];
  /** The id of the segment the person is in. */
  readonly current: string;
  /** The page's place among the pages still ahead: `n` of `of` (skipped pages never count). */
  readonly step: number;
  readonly of: number;
  /**
   * Set when `step` / `of` count the pages INSIDE the current segment (the setup flow): the current segment then fills
   * `step` of `of` of its length, so the bar and the words say the same thing. Unset, every segment is one whole stage.
   */
  readonly fills?: true;
}

/**
 * The words under the bar: "Claude Code · 3 of 7", or "Claude Code · page 3 of 7" when the counter is the segment's own
 * pages (`pages`, the setup flow): the word says what is counted, so the bar's segments (stages) and the count (pages)
 * are never read as the same thing.
 */
export function stepProgressText(
  segments: readonly StepSegment[],
  current: string,
  step: number,
  of: number,
  pages?: true,
): string {
  const label = segments.find(segment => segment.id === current)?.label ?? '';
  const count = pages === true ? `page ${step} of ${of}` : `${step} of ${of}`;
  return label === '' ? count : `${label} · ${count}`;
}

export function StepProgress({ segments, current, step, of, fills }: StepProgressProps) {
  const at = segments.findIndex(segment => segment.id === current);
  const text = stepProgressText(segments, current, step, of, fills);
  return (
    <div className="fy-sp-progress" data-step-progress="">
      <div
        className="fy-sp-progress__bar"
        role="progressbar"
        aria-label="Progress"
        aria-valuemin={1}
        aria-valuemax={Math.max(1, of)}
        aria-valuenow={Math.min(Math.max(1, step), Math.max(1, of))}
        aria-valuetext={text}
      >
        {segments.map((segment, index) => (
          <span
            key={segment.id}
            className="fy-sp-progress__segment"
            data-state={index < at ? 'done' : index === at ? 'current' : 'ahead'}
            data-segment={segment.id}
            {...(fills === true && index === at
              ? {
                  'data-fills': '',
                  style: { '--fy-sp-fill': Math.min(1, Math.max(0, step / Math.max(1, of))) } as CSSProperties,
                }
              : {})}
          >
            <span className="fy-sp-progress__label">{segment.label}</span>
          </span>
        ))}
      </div>
      <p className="fy-sp-progress__text">{text}</p>
    </div>
  );
}
