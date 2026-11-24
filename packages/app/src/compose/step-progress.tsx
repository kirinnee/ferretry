/**
 * STEP PROGRESS: one segment per stage of a stepper, the current one lit, and "<stage> · n of m" under the bar.
 *
 *   <StepProgress segments={[{ id: 'machine', label: 'Machine' }, { id: 'claude', label: 'Claude Code' }]}
 *     current="claude" step={3} of={7} />
 *
 * The bar is decorative; the one text line is what a screen reader hears (`role="progressbar"` carries `n of m`).
 * Segments before the current one are filled, so the bar reads left to right. Colour comes from theme tokens.
 * With `pages` the segments ARE the pages (one each), so the words "page n of m" and the bar are one reading.
 */

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
  /** Set when each segment is one page (the setup flow): the words then say "page n of m", n being the lit segment's place. */
  readonly pages?: true;
}

/**
 * The words under the bar: "Claude Code · 3 of 7", or "Claude Code · page 3 of 7" when every segment is a page (`pages`, the
 * setup flow): the word says what is counted.
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

export function StepProgress({ segments, current, step, of, pages }: StepProgressProps) {
  const at = segments.findIndex(segment => segment.id === current);
  const text = stepProgressText(segments, current, step, of, pages);
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
          >
            <span className="fy-sp-progress__label">{segment.label}</span>
          </span>
        ))}
      </div>
      <p className="fy-sp-progress__text">{text}</p>
    </div>
  );
}
