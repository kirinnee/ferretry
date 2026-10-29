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
  '  B -->|yes| D[Near the viewport?]',
  '  D -->|yes| F[Sandbox frame compiles]',
  '  F --> G[SVG re-admitted, shown inline]',
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

/**
 * An html fragment that tries everything a STATIC fragment must refuse. It holds no `<script>` and no
 * `on…` handler on purpose: either one routes an `html` block to the interactive frame instead
 * (`fyRenderHtmlRunsScript`), whose own corpus is `fy-render-html.security.test.ts`. Every payload
 * either sets `window.__fyPwned` if it runs (the `javascript:` link), or names `/beacon?<what>` on this
 * server if it loads, and the style rules aim at the HOST page — `fy-render-fragment.security.test.ts`
 * asserts none of it lands.
 */
const FRAGMENT_XSS = [
  '<p id="ok">fragment rendered</p>',
  '<img src="/beacon?img" alt="">',
  '<svg><circle r="2"/></svg>',
  '<a id="js" href="javascript:window.__fyPwned=\'js-href\'">js link</a>',
  '<a id="rel" href="/beacon?anchor">relative link</a>',
  '<div style="background: url(/beacon?style-url)">inline style</div>',
  '<style>@import url(/beacon?import); p { background: url(/beacon?style-element) } body { background: rgb(255, 0, 0) !important } #outside { color: rgb(255, 0, 0) !important }</style>',
  '<form action="/beacon?form"><input name="q" value="x"><button id="submit">go</button></form>',
  '<iframe srcdoc="<b>a frame</b>"></iframe>',
  '<object data="/beacon?object"></object><embed src="/beacon?embed">',
  '<meta http-equiv="refresh" content="0;url=/beacon?meta"><link rel="stylesheet" href="/beacon?link"><base href="/beacon/">',
  '<svg><foreignObject><img src="/beacon?foreign"></foreignObject><use href="/beacon?use#a"/></svg>',
  '<div id="overlay" style="position: fixed; inset: 0; background: rgba(255, 0, 0, 0.5)">overlay</div>',
].join('\n');

/** A fragment an agent would actually write: a comparison table and a note, in the theme. */
const FRAGMENT_TABLE = [
  '<table><thead><tr><th>Option</th><th>Cold start</th><th>Steady state</th></tr></thead>',
  '<tbody><tr><td>Sandbox frame</td><td>~400 ms</td><td>live</td></tr>',
  '<tr><td>Inline fragment</td><td>0 ms</td><td>static</td></tr></tbody></table>',
  '<details><summary>Why static?</summary><p>No script can run, so nothing needs a frame.</p></details>',
].join('');

/** Markers with popups and a route between them: what an agent shows for "where is it, and how do I get there". */
const MAP = [
  'markers:',
  '  - {at: [51.5007, -0.1246], label: Big Ben, popup: "Start here: the clock tower at Westminster.", color: red}',
  '  - {at: [51.5033, -0.1195], label: London Eye, popup: "A ten minute walk along the river."}',
  '  - {at: [51.5081, -0.0759], label: Tower Bridge, color: green}',
  'lines:',
  '  - {points: [[51.5007, -0.1246], [51.5033, -0.1195], [51.5075, -0.1135], [51.5081, -0.0759]], label: Route, color: blue}',
].join('\n');

/** The brief's own example: a stacked bar chart of spend, money on the value axis, one series muted. */
const CHART_BAR = [
  'kind: bar',
  'title: Warden spend',
  'x: [22 Oct, 23 Oct, 24 Oct, 25 Oct, 26 Oct, 27 Oct, 28 Oct]',
  'y: { label: USD, format: money }',
  'stacked: true',
  'series:',
  '  - name: Investigations',
  '    data: [1.8, 2.4, 2.1, 2.9, 2.1, 2.2, 2.0]',
  '  - name: Reports',
  '    data: [0.6, 0.5, 0.9, 0.7, 0.8, 0.6, 0.7]',
  '  - name: First-pass filter',
  '    data: [0.3, 0.3, 0.31, 0.28, 0.3, 0.3, 0.29]',
  '    tone: muted',
].join('\n');

/** A step-through story: an area chart whose frames each override the series and the title. */
const CHART_FRAMES = [
  'kind: area',
  'title: Queue depth',
  'x: [0s, 10s, 20s, 30s, 40s, 50s, 60s]',
  'y: { label: Jobs, format: number }',
  'series:',
  '  - name: Waiting',
  '    data: [4, 9, 16, 22, 27, 31, 34]',
  '  - name: Running',
  '    data: [2, 4, 4, 4, 4, 4, 4]',
  '    tone: good',
  'frames:',
  '  - label: One worker',
  '  - label: Four workers',
  '    title: Queue depth, four workers',
  '    series:',
  '      - {name: Waiting, data: [4, 7, 9, 8, 6, 4, 2]}',
  '      - {name: Running, data: [2, 8, 12, 14, 14, 12, 9], tone: good}',
  '  - label: Autoscaled',
  '    title: Queue depth, autoscaled',
  '    series:',
  '      - {name: Waiting, data: [4, 5, 4, 2, 1, 0, 0]}',
  '      - {name: Running, data: [2, 10, 18, 16, 9, 5, 3], tone: good}',
].join('\n');

/** Share of a whole: one ring, a slice per label, every slice from the palette in order. */
const CHART_DOUGHNUT = [
  'kind: doughnut',
  'title: Where the tokens went',
  'x: [Planning, Implementation, Review, Chores]',
  'y: { format: percent }',
  'series:',
  '  - name: Share',
  '    data: [18, 52, 21, 9]',
].join('\n');

/** An author who tried to paint: refused by the language, so it falls back to its source. */
const CHART_PAINTED = ['kind: line', 'series:', '  - {name: Red line, data: [1, 2, 3], color: "#ff0000"}'].join('\n');

/**
 * A diagram whose author tried to repaint it. The theme is the page's: `theme`, `themeVariables` and
 * `themeCSS` are on the shell's `secure` list, so the directive does not reach them.
 */
const MERMAID_THEME_DIRECTIVE = `%%{init: {"theme": "forest", "themeVariables": {"primaryColor": "#ff0000", "lineColor": "#ff0000"}, "themeCSS": ".node rect { fill: #ff0000 }"}}%%\n${MERMAID}`;

/** The same attempt through Mermaid's front matter, the other way a diagram carries its own config. */
const MERMAID_THEME_FRONTMATTER = [
  '---',
  'config:',
  '  theme: forest',
  '  themeVariables:',
  '    primaryColor: "#ff0000"',
  '    lineColor: "#ff0000"',
  '---',
  MERMAID,
].join('\n');

export const FY_RENDER_VISUAL_CASES: Record<string, string> = {
  'chart-bar': fence('chart', 'Warden spend per day, by kind of work', CHART_BAR),
  'chart-doughnut': fence('chart', 'Where the tokens went', CHART_DOUGHNUT),
  'chart-frames': fence('chart', 'Queue depth as workers are added', CHART_FRAMES),
  'chart-painted': fence('chart', 'A chart whose author tried to colour it', CHART_PAINTED),
  'fragment-table': fence('html', 'A comparison of rendering options', FRAGMENT_TABLE),
  'fragment-xss': fence('html', 'A fragment carrying every refused construct', FRAGMENT_XSS),
  'init-directive': fence('mermaid', 'A diagram whose author asked for HTML labels', MERMAID_INIT_DIRECTIVE),
  lottie: fence('lottie', 'A blue dot travelling across the frame', LOTTIE),
  map: fence('map', 'A walk from Big Ben to Tower Bridge', MAP),
  mermaid: fence('mermaid', 'How an fy-render block reaches the reader', MERMAID),
  'mermaid-theme-directive': fence('mermaid', 'A diagram whose author tried to repaint it', MERMAID_THEME_DIRECTIVE),
  'mermaid-theme-frontmatter': fence(
    'mermaid',
    'A diagram whose front matter tried to repaint it',
    MERMAID_THEME_FRONTMATTER,
  ),
  'mermaid-failure': fence('mermaid', 'A diagram that cannot be drawn', MERMAID_BROKEN),
};
