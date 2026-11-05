/**
 * The `fy-render` caps, in a module with no other dependency.
 *
 * WHY THIS LIVES IN PROTOCOL. The daemon, the CLI and the PWA must all read the
 * same numbers — a save the daemon refuses must be a block the PWA would have
 * refused, and a cap the CLI prints must be the cap either side enforces — and
 * protocol is the package every one of them already depends on
 * (docs/standards/fact-ownership: one fact, one owner, above every consumer).
 * Nothing else may move here with them: the sandbox shells' bootstraps import
 * this module and are hash-pinned, size-reviewed inline scripts, so it stays a
 * constants-only file — no patterns, no encoders, no grammar.
 *
 * WHY THE PWA STILL HAS A BOUNDS MODULE. `packages/pwa/src/lib/fy-render-bounds.ts`
 * keeps the sandbox-frame numbers beside the shells that read them and re-exports
 * this object, so every PWA reader still has one place to import both from.
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
  /** A `card` or `board` payload: card references, nothing else. A board lists at most `embedCards` of them. */
  embedBytes: 2 * 1024,
  embedCards: 12,
  /** A board built from a parent card draws at most this many of its children; the rest are counted, not drawn. */
  embedChildren: 24,
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
