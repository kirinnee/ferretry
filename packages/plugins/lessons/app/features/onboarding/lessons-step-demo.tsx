/**
 * The scene in the step's demo column: a correction you typed becomes a rule that flies onto the Lessons shelf, or, when
 * the person chose not to learn, stays a correction and the shelf stays empty. Before any pick (`kept` is null) it claims
 * neither: the shelf says nothing is chosen yet. Neutral words, no tool names. Decorative
 * (the demo column is `aria-hidden`); the page's own words say the same thing. It replays when `kept` changes (the key),
 * and at rest, or with motion off, shows the finished picture so it is never blank (`lessons-step.css`).
 */

export function LessonDemo({ kept }: { readonly kept: boolean | null }) {
  return (
    <div className="fy-lsd" data-lessons-demo="" data-kept={kept === null ? 'none' : kept} key={String(kept)}>
      <div className="fy-lsd__said">Use the staging database</div>
      <div className="fy-lsd__shelf">
        <span className="fy-lsd__shelf-name">Lessons</span>
        {kept === null ? (
          <span className="fy-lsd__empty" data-lessons-unchosen="">
            Nothing chosen yet
          </span>
        ) : kept ? (
          <span className="fy-lsd__rule" data-lessons-rule="">
            Rule · Use the staging database
          </span>
        ) : (
          <span className="fy-lsd__empty">Nothing filed</span>
        )}
      </div>
    </div>
  );
}
