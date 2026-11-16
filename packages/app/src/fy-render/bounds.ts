/**
 * The `fy-render` numbers, in a module with no other dependency.
 *
 * WHY THESE LIVE APART FROM THE GRAMMAR. The two sandbox shells' bootstraps
 * import these bounds and are hash-pinned, size-reviewed inline scripts; the
 * grammar (in `@ferretry/protocol/fy-render`, and the fence reader in
 * `fy-render.ts`) carries patterns and encoders a bundler cannot prove
 * side-effect free and would otherwise carry into every frame.
 * `fy-render.ts` re-exports both objects, so every other reader still has one
 * place to import them from.
 *
 * WHY THE CAPS ARE A RE-EXPORT. `FY_RENDER_LIMITS` is owned by
 * `@ferretry/protocol/fy-render-caps` — one fact, one owner, above every
 * consumer, because the daemon and the CLI read the same numbers when they
 * validate what the PWA will draw. It is re-exported unchanged from here (a
 * constants-only module, so the shells' import stays as small as it was), and
 * the sandbox-frame numbers below stay here beside the shells that read them.
 */

export { FY_RENDER_LIMITS } from '@ferretry/plugin-conversation/contract';

/**
 * The bounds on the sandbox frame — every number the parent and the shell must
 * agree on, in one place, for the same reason `FY_RENDER_LIMITS` exists.
 *
 * The two deadlines are NOT the same kind of thing and the difference is the
 * whole point. `readyDeadlineMs` bounds a handshake and is stood down when the
 * handshake completes. The lifetime bounds are the HARD watchdog: they are armed
 * when the frame mounts and no message the frame sends can clear them, because
 * the frame is exactly the thing they exist to bound. A `rendered` message that
 * could stop the timer would be a hostile payload's first move.
 */
export const FY_RENDER_SANDBOX_LIMITS = {
  /** How long the shell has to announce itself before the parent gives up. */
  readyDeadlineMs: 5_000,
  /**
   * Mermaid is a one-shot compile: the frame is destroyed as soon as it hands
   * back an SVG, so this bounds the whole of its life.
   */
  mermaidDeadlineMs: 15_000,
  /**
   * Lottie has to stay alive to keep playing, so its bound is a total frame
   * lifetime rather than a render deadline. It bounds how LONG a payload may
   * compute, never how hard — see the declared gap in `docs/fy-render.md`.
   */
  lottieLifetimeMs: 120_000,
  /**
   * An interactive `html` page's total life. Longer than Lottie's because a
   * reader may be working through an explanation rather than watching a loop,
   * and like Lottie's it bounds how LONG author code may run, never how hard.
   */
  htmlLifetimeMs: 600_000,
  /**
   * The tallest an `html` frame may grow INLINE, whatever height the page
   * reports. Inline the page never scrolls inside itself — the frame takes its
   * height — so this is generous: a visualization with its controls fits with
   * room to spare. A transcript row is still not the place for a 6000px
   * document; past this the page is clipped, and fullscreen gives it the plane.
   */
  htmlInlineMaxHeightPx: 1200,
  /**
   * How long an interactive page may go without its heartbeat, while the tab is visible, before it is
   * stopped as unresponsive. Five beats missed: long enough that one slow frame never trips it, short
   * enough that a page stuck in a loop does not keep the reader's machine busy for long.
   */
  htmlStallMs: 5_000,
  /** Every string the frame puts on the wire is cut to this. */
  messageCharacters: 300,
  /** The compiled diagram the frame hands back, which is generated, not authored. */
  mermaidSvgBytes: 512 * 1024,
  mermaidSvgElements: 4_000,
  /** Filters are the cheapest route to expensive rasterising, generated or not. */
  mermaidSvgFilterPrimitives: 64,
} as const;
