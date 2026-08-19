/**
 * The two presentation decisions every configuration panel kept getting wrong, in one place.
 *
 * This started as `features/fleet/fleet-typography.tsx`, solving both for ONE panel. Every other
 * Settings panel had the same two problems and had not been through the same pass, so the answers
 * live here now — in the shell, beside `ChoiceRail` — and Fleet is one caller among several rather
 * than the owner. Promoting it is the whole point: a second panel solving these again beside this
 * file is how one screen ends up with two visual languages.
 *
 * **A PATH IS ONE TOKEN.** `break-all` on a monospace path inside a narrow column produced
 *
 *     /Users/ern
 *     g/.ferretr
 *     y/fleet/bi
 *     n/claude-pe
 *     rsonal
 *
 * which is unreadable and, worse, looks broken — a reader cannot tell a wrapped path from a corrupted
 * one. So a path scrolls inside its own box instead of being torn apart. The box is `max-w-full`, so the
 * PAGE never scrolls sideways to accommodate it, which is the trade that makes this safe on a phone.
 *
 * **UPPERCASE IS A SPICE.** `kt-label` is the app's eyebrow role: display font, letter-spaced, and
 * uppercase under most themes. Used on every field label in a form it removes the hierarchy it exists to
 * create — HARNESS, PROVIDER ACCOUNT NAME, LANE, DISPLAY NAME, MODE and six more all shouting equally,
 * with nowhere for the eye to land. Field labels use {@link FIELD_LABEL} instead: sentence case, one step
 * down from a section heading, and darker than the prose beneath them. `kt-label` is kept for exactly one
 * role — a section eyebrow — which is what it was for.
 *
 * Both are the SHARED system's own tokens. Nothing here invents a scale: the type sizes, weights and
 * colours are the same ones `grants-settings.tsx` reads for the same jobs.
 */

/**
 * A form field's label. Sentence case, and the hierarchy is: panel title → section heading → THIS →
 * prose. Weight and colour carry it, not capitals.
 */
export const FIELD_LABEL = 'mb-1 block text-cell font-medium text-fg';

/**
 * ONE OPTICAL SIZE PER ICON ROLE, because six of them were in use with no rule behind which was which —
 * 12, 13, 14, 15, 16 and 18 — and a column of icons down the left of a panel visibly failed to line up.
 *
 *   18  IDENTITY  the panel's own mark, inside its boxed square
 *   16  HEADING   every card and section title's icon
 *   14  INLINE    beside prose, or inside a small control
 *   12  BADGE     inside a `kt-badge`, whose type is smaller than everything else
 *
 * A NAVIGATION RAIL uses HEADING, and takes the fixed slot `ChoiceRail` draws for it rather than sizing
 * itself: a rail whose rows each indent their own label by whatever glyph they happen to carry has a
 * ragged left edge, which is what "the icons were uneven" was describing.
 *
 * Kept as a comment rather than four exported constants: `size` is a number prop on every lucide icon in
 * the app, and a constant here would be a fifth vocabulary for something the whole PWA already spells
 * inline.
 */

/** A section eyebrow — the one role uppercase is kept for. */
export const EYEBROW = 'kt-label m-0';

/**
 * A path, a wrapper name or an identifier, WHOLE and never broken mid-token.
 *
 * It scrolls in its own box, with no `tabindex` and no ARIA — the same treatment every scrollable `<pre>`
 * in these panels already has, which is the convention this follows rather than inventing a second one.
 * The value is never LOST by the clipping: the text is complete in the DOM so a screen reader reads all of
 * it, `title` gives a pointer the whole thing without scrolling, and a selection copies the whole thing.
 * The residual limit is a sighted keyboard-only reader on a column narrower than the value, who has the
 * tooltip and the full text but cannot scroll the box — the same limit the code blocks beside it have.
 *
 * `inline-block` rather than `block`, so the same component works mid-sentence — "Manifest published at
 * <path>" — as well as on its own line.
 */
export function PanelPath({
  value,
  className = '',
  label,
}: {
  readonly value: string;
  /** Size, weight and colour for the CONTEXT. Overflow and wrapping are not negotiable and are set here. */
  readonly className?: string;
  /** An accessible name, when this path is a control's own value rather than labelled prose beside it. */
  readonly label?: string;
}) {
  return (
    <code
      className={`inline-block max-w-full overflow-x-auto whitespace-nowrap align-bottom font-mono ${className}`}
      title={value}
      data-panel-path=""
      {...(label === undefined ? {} : { 'aria-label': `${label}: ${value}` })}
    >
      {value}
    </code>
  );
}
