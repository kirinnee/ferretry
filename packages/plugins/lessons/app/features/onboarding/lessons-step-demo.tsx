/**
 * The little scene inside each card: a correction you typed, and what became of it. Decorative (the card hides it from
 * assistive tech); the words on the card say the same thing. It plays once when its card is selected (`lessons-step.css`),
 * and at rest shows the finished picture, so no card is ever blank.
 */

export function LessonDemo({ kept }: { readonly kept: boolean }) {
  return (
    <span className="fy-lsd" data-kept={kept}>
      <span className="fy-lsd__said">No — use bun</span>
      <span className="fy-lsd__arrow">→</span>
      <span className="fy-lsd__rule">{kept ? '✓ Rule saved' : 'Nothing kept'}</span>
    </span>
  );
}
