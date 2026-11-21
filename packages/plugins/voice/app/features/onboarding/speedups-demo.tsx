/**
 * A small CSS scene for the Speed-ups page: the words as they were said, then the same words cleaned up. It plays once and
 * rests on its last frame; with motion off, by the OS or by Settings, it is only the last frame. Decorative.
 */
import './voice-step.css';

export function SpeedupsDemo() {
  return (
    <div className="fy-vd fy-vd--clean" data-speedups-demo="" aria-hidden="true">
      <span className="fy-vd__said">um move the the deploy to friday</span>
      <span className="fy-vd__cleaned">Move the deploy to Friday.</span>
    </div>
  );
}
