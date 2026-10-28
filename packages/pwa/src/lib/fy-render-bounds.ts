/**
 * The `fy-render` numbers, in a module with no other dependency.
 *
 * WHY THESE LIVE APART FROM THE GRAMMAR. The two sandbox shells' bootstraps
 * import these bounds and are hash-pinned, size-reviewed inline scripts; the
 * grammar imports the reference reader, whose module-level patterns a bundler
 * cannot prove side-effect free and would otherwise carry into every frame.
 * `fy-render.ts` re-exports both objects, so every other reader still has one
 * place to import them from.
 */

/**
 * Every cap in one place, so the renderer, the tests and `docs/fy-render.md`
 * cannot drift into quoting three different numbers for the same limit.
 */
export const FY_RENDER_LIMITS = {
  altCharacters: 200,
  htmlBytes: 200 * 1024,
  svgBytes: 100 * 1024,
  svgElements: 500,
  mermaidCharacters: 20_000,
  /** A `map` payload: JSON or YAML, a few markers and routes. Larger is a data dump, not an illustration. */
  mapBytes: 32 * 1024,
  /** A map draws at most this many pins, shapes (lines plus polygons) and vertices across all of them. */
  mapMarkers: 100,
  mapShapes: 50,
  mapVertices: 2000,
  /** A pin's label and its popup, cut to these rather than refused. */
  mapLabelCharacters: 80,
  mapPopupCharacters: 500,
  /** A `chart` payload: JSON or YAML in this package's own small chart language. */
  chartBytes: 64 * 1024,
  /** Series per chart (or per frame), and points per series. A chart past these is a table, not a picture. */
  chartSeries: 12,
  chartPoints: 500,
  /** Points across every series of every frame together — the most a chart can be made to draw at once. */
  chartTotalPoints: 10_000,
  /** Step-through frames, and the category labels on the x axis. */
  chartFrames: 30,
  chartLabels: 500,
  /** A title, an axis label, a series name and a category or frame label — refused past these, never cut. */
  chartTitleCharacters: 120,
  chartLabelCharacters: 80,
  lottieBytes: 1024 * 1024,
  lottieLayers: 500,
  lottieDepth: 64,
  imageBytes: 2 * 1024 * 1024,
  /** At most 32 filter primitives — the cheapest route to expensive rasterising. */
  svgFilterPrimitives: 32,
  /**
   * Neither axis of anything that reaches a decoder may exceed this, and the
   * product of the two may not exceed `maxPixels` (4096 × 4096, ≈64 MB at four
   * bytes per pixel). Both bounds are read from the payload's own declaration
   * BEFORE a decoder is handed it, because a 50-byte PNG can declare 65535 ×
   * 65535 and the input-size cap is no defence at all against that.
   */
  maxDimension: 8192,
  maxPixels: 16_777_216,
  /** How much authored source the source panel prints before it truncates. */
  sourcePreviewCharacters: 32 * 1024,
  /** A `src:` value, either form. Long enough for any real link, short enough to print. */
  srcCharacters: 2048,
  /**
   * A workspace file a media block may show. NOT A NUMBER THIS PACKAGE CHOSE:
   * it mirrors the daemon's own per-file view limit (`MAX_FILE_BYTES`), which
   * is what the session filesystem route serves. A larger file arrives as
   * `tooLarge` whatever this says, so a bigger number here would only be a lie.
   */
  workspaceMediaBytes: 1024 * 1024,
  /** An https image is fetched and admitted like an inline one, so it gets the inline cap. */
  httpsImageBytes: 2 * 1024 * 1024,
} as const;

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
   * reports. A transcript row is not the place for a 6000px document; the page
   * scrolls inside its frame past this, and fullscreen gives it the plane.
   */
  htmlInlineMaxHeightPx: 640,
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
