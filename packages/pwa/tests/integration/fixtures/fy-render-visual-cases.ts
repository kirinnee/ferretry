/**
 * The `fy-render` evidence fixtures — ONE source of truth, read by both the
 * browser scene and the test that drives it.
 *
 * They live apart from the scene module because the test needs the same strings
 * (to name scenes and to assert on copy) while the scene needs them in the
 * browser. Duplicating them was how the old string-built scene worked, and a
 * fixture that differs between the driver and the page is evidence of nothing.
 *
 * Nothing here imports React or the DOM, so the test process can read this file
 * without pulling a component graph into the test runner.
 */

/**
 * A real animation with a real eased keyframe, because that is exactly what Slice
 * A's grammar used to refuse: it rejected any `"x"` key, and Lottie overloads that
 * key onto bezier easing handles. A fixture without one would pass a grammar that
 * cannot render most real Lottie.
 */
const LOTTIE = JSON.stringify({
  assets: [],
  ddd: 0,
  fr: 30,
  h: 240,
  ip: 0,
  layers: [
    {
      ao: 0,
      bm: 0,
      ddd: 0,
      ind: 1,
      ip: 0,
      ks: {
        a: { a: 0, k: [0, 0, 0] },
        o: { a: 0, k: 100 },
        p: {
          a: 1,
          k: [
            { i: { x: [0.833], y: [0.833] }, o: { x: [0.167], y: [0.167] }, s: [70, 120, 0], t: 0 },
            { s: [250, 120, 0], t: 45 },
          ],
        },
        r: {
          a: 1,
          k: [
            { i: { x: [0.5], y: [0.5] }, o: { x: [0.5], y: [0.5] }, s: [0], t: 0 },
            { s: [360], t: 45 },
          ],
        },
        s: { a: 0, k: [100, 100, 100] },
      },
      nm: 'dot',
      op: 45,
      shapes: [
        {
          it: [
            { p: { a: 0, k: [0, 0] }, s: { a: 0, k: [90, 90] }, ty: 'el' },
            { c: { a: 0, k: [0.36, 0.72, 0.94, 1] }, o: { a: 0, k: 100 }, ty: 'fl' },
            {
              a: { a: 0, k: [0, 0] },
              o: { a: 0, k: 100 },
              p: { a: 0, k: [0, 0] },
              r: { a: 0, k: 0 },
              s: { a: 0, k: [100, 100] },
              ty: 'tr',
            },
          ],
          ty: 'gr',
        },
      ],
      sr: 1,
      st: 0,
      ty: 4,
    },
  ],
  nm: 'eased',
  op: 45,
  v: '5.7.4',
  w: 320,
});

const MERMAID = [
  'graph TD',
  '  A[Reader opens a message] --> B{Is there an fy-render block?}',
  '  B -->|no| C[Ordinary markdown]',
  '  B -->|yes| D[Offer, do not render]',
  '  D --> E[Reader presses Render]',
  '  E --> F[Sandbox frame compiles]',
  '  F --> G[SVG re-admitted, shown as an image]',
].join('\n');

/** A jison parse error: the reachable Mermaid failure, and the ugliest wording. */
const MERMAID_BROKEN = 'graph TD\n  A[Unclosed --> B{{{';

/**
 * On paper this asks for HTML labels. Measured against the shipped strict config
 * it compiles byte-identically to the plain diagram with no `<foreignObject>`, so
 * the parent's refusal is a fail-closed guard against a future Mermaid release
 * rather than a path any reader walks.
 */
const MERMAID_INIT_DIRECTIVE = `%%{init: {"flowchart": {"htmlLabels": true}}}%%\n${MERMAID}`;

const fence = (type: string, alt: string, payload: string): string => `type: ${type}\nalt: ${alt}\n---\n${payload}`;

export const FY_RENDER_VISUAL_CASES: Record<string, string> = {
  'init-directive': fence('mermaid', 'A diagram whose author asked for HTML labels', MERMAID_INIT_DIRECTIVE),
  lottie: fence('lottie', 'A blue dot travelling across the frame', LOTTIE),
  mermaid: fence('mermaid', 'How an fy-render block reaches the reader', MERMAID),
  'mermaid-failure': fence('mermaid', 'A diagram that cannot be drawn', MERMAID_BROKEN),
};
