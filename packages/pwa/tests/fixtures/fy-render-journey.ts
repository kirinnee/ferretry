/**
 * The `fy-render` sandbox journey as DATA, so two engines are measured against
 * one definition instead of two that drift.
 *
 * WHY IT LIVES UNDER `tests/fixtures/` AND NOT UNDER `harness/`. Both coverage
 * ledgers ignore every `packages/<name>/tests` tree, so a driver that imports it adds
 * nothing to either LCOV population; `harness/**` is ignored by neither, and one
 * int-tier test importing a harness module would fail the int gate on a PATH
 * rather than on a test. The Safari driver is a Bun program under `harness/`, and
 * an eventual Chromium driver is an int-tier test — this file is the only place
 * they may both reach.
 *
 * IT CONTAINS NO DRIVER CODE AND NO ASSERTION. Every entry names a property, the
 * step that exercises it, who observes it, and the OUTCOME that decides it.
 * Turning that into a check is each driver's job, because the observation
 * surfaces genuinely differ: Chromium can name the blocking directive from the
 * console and Safari cannot, so the verdicts here are written as outcomes that
 * both engines can produce — nothing persisted, nothing evaluated, nothing
 * arrived at the server.
 *
 * THE VERDICT PROSE IS PART OF THE CONTRACT. It is what the evidence artifact
 * prints next to each result, so a reviewer reads the rule and the outcome side
 * by side rather than inferring the rule from the code that ran.
 */

/**
 * The journey's steps, in the order one browser session runs them.
 *
 * Safari hosts exactly one WebDriver session at a time, so this is a sequence
 * and never a matrix. The two controls come first and last for a reason:
 * `positive-control` proves the request ledger can see a request BEFORE any
 * empty leak set is accepted as evidence, and `policy-control` proves the frame
 * could have reached the server had its policy allowed it — which is what
 * separates "CSP blocked it" from "nothing tried".
 */
export const FY_RENDER_JOURNEY_STEPS = [
  'positive-control',
  'production-bridge',
  'mermaid-correct-hash',
  'mermaid-wrong-hash',
  'mermaid-init-directive',
  'lottie',
  'probe-egress',
  'policy-control',
  'never-ready',
  'watchdog',
] as const;

export type FyRenderJourneyStep = (typeof FY_RENDER_JOURNEY_STEPS)[number];

/**
 * Every sink the frame is made to aim at the harness server, one path each.
 *
 * They are the ONLY reason an unguessable path space exists: the frame learns
 * these URLs from the probe bootstrap alone, so a request that arrives under the
 * frame's nonce cannot have come from anywhere else. The parent never holds the
 * frame's nonce, which is why the positive control uses a different one.
 *
 * `websocket` is here even though a WebSocket is not an ordinary fetch: the
 * upgrade is an HTTP request, so a server with no WebSocket handler records it
 * exactly like the rest.
 */
export const FY_RENDER_LEAK_PROBES = [
  'external-script',
  'image',
  'stylesheet',
  'css-import',
  'nested-iframe',
  'prefetch',
  'fetch',
  'xhr',
  'websocket',
  'beacon',
  'anchor-ping',
  'top-nav',
  'popup',
  'download',
] as const;

export type FyRenderLeakProbe = (typeof FY_RENDER_LEAK_PROBES)[number];

/**
 * The two requests that are SUPPOSED to arrive, and the only ones exempt from
 * "zero leak requests".
 *
 * `control` is issued by the parent under its own nonce and proves the recorder
 * works. `policy-control` is issued by the FRAME under the frame's nonce, from a
 * probe document whose policy differs from the production one by one directive,
 * and proves the frame's silence everywhere else is the policy rather than an
 * inert probe.
 */
export const FY_RENDER_LEDGER_CONTROLS = ['control', 'policy-control'] as const;

export type FyRenderLedgerControl = (typeof FY_RENDER_LEDGER_CONTROLS)[number];

export interface FyRenderJourneyProperty {
  /** Stable identifier; the evidence artifact is keyed on it. */
  readonly id: string;
  readonly title: string;
  /** Every step whose observations feed this property. */
  readonly steps: readonly FyRenderJourneyStep[];
  /**
   * Who sees it. `ledger` is the server's ordered request log, `driver` is a
   * WebDriver call the page cannot influence, `parent` is the top document and
   * `frame` is the sandboxed document reporting over the capability port.
   */
  readonly observers: readonly ('parent' | 'frame' | 'ledger' | 'driver')[];
  /** The outcome that decides it. Never an exception type and never a message. */
  readonly verdict: string;
}

/**
 * The properties, one entry each. There are eighteen: the seventeen the design
 * settled on, plus the Mermaid init-directive case, which only real Mermaid can
 * parse and which therefore cannot be reached from any unit test.
 *
 * Deliberately absent, and each absence is a decision:
 *
 * - **Self-navigation, prerender and WebRTC.** Those are the proven Slice C
 *   egress channels. No AUTHOR code runs in the frame, so no author reaches them —
 *   but a compromised trusted library is code inside the frame and could, which is
 *   the residual the documentation declares. Measuring them here would either
 *   produce a red for a threat this slice does not have or — worse — a green that
 *   reads as "Slice C is safe in Safari".
 * - **Element fullscreen.** A WebDriver click is a real user activation, but
 *   Safari's fullscreen policy layer plus an Automation window is exactly the
 *   shape that silently does nothing and passes.
 * - **A resized desktop window as "mobile Safari".** `safaridriver` has no
 *   device emulation at all. Mobile behaviour needs a simulator or a device, and
 *   a 390px-wide Mac window is not either one.
 * - **Any assertion naming a CSP directive.** Safari offers no console access
 *   from outside the page, so a directive name would be read from an in-frame
 *   `securitypolicyviolation` event — which is corroboration recorded for a
 *   human, never a check, because a check on an absent field passes.
 */
export const FY_RENDER_JOURNEY_PROPERTIES: readonly FyRenderJourneyProperty[] = [
  {
    id: 'shell-frames-under-sandbox',
    title: 'The generated shell loads and announces itself inside `sandbox="allow-scripts"`',
    steps: ['production-bridge'],
    observers: ['parent'],
    verdict:
      "The parent received one global `shell-ready` whose `event.source` is the frame's own `contentWindow`, within the production ready deadline.",
  },
  {
    id: 'opaque-origin',
    title: 'The frame has an opaque origin, so nothing about it can be authenticated by origin',
    steps: ['production-bridge', 'probe-egress'],
    observers: ['parent', 'frame'],
    verdict:
      'The `event.origin` the parent saw is the literal string "null", and the frame reports `self.origin` — the serialization of its document\'s ORIGIN — as "null". `location.origin` is derived from the document\'s URL and still reads as the serving origin, so it is recorded and never asserted; `document.origin` is non-standard and may be absent, so it is recorded too.',
  },
  {
    id: 'global-channel-closes-after-handshake',
    title: 'A second global message offering a second port is ignored',
    steps: ['production-bridge'],
    observers: ['parent'],
    verdict:
      'A command sent over the second port draws no reply on it, while the first port still answers — so the frame is alive and declined the second channel rather than having died.',
  },
  {
    id: 'port-only-traffic',
    title: 'Everything after the handshake travels on the paired port',
    steps: ['production-bridge', 'mermaid-correct-hash', 'lottie'],
    observers: ['parent'],
    verdict: 'Zero global messages reached the parent after `shell-ready`; every reply arrived on the first port.',
  },
  {
    id: 'mermaid-svg-accepted-by-production-gate',
    title: 'The compiled diagram passes the production message parser and the production SVG gate',
    steps: ['mermaid-correct-hash'],
    observers: ['parent'],
    verdict:
      '`parseFyRenderSandboxMessage` returns a `mermaid-svg` message and `fyRenderMermaidSvg` admits its SVG — both the shipped functions, running in Safari.',
  },
  {
    id: 'correct-hash-inline-install-runs',
    title: 'A dynamically inserted inline script whose text matches a pinned hash RUNS',
    steps: ['mermaid-correct-hash'],
    observers: ['parent'],
    verdict:
      "The frame produced a diagram, which it can only do once the bundle's global exists — the global appearing is the evidence, never the absence of a throw.",
  },
  {
    id: 'wrong-hash-inline-install-does-not-run',
    title: 'The identical primitive with one byte appended does NOT run',
    steps: ['mermaid-wrong-hash'],
    observers: ['parent'],
    verdict:
      "The frame reported that the library did not load and sent no diagram, so the mutated bundle's global never appeared.",
  },
  {
    id: 'mermaid-ordinary-and-init-directive-stay-svg-safe',
    title: 'Ordinary and nested-init Mermaid diagrams stay in safe SVG and pass the production gate',
    steps: ['mermaid-correct-hash', 'mermaid-init-directive'],
    observers: ['frame', 'parent'],
    verdict:
      'Both the ordinary diagram and a diagram whose nested init directive asks for HTML labels complete with neither `<foreignObject>` nor `<script>`, and `fyRenderMermaidSvg` admits each result. The extended `secure` list holds the top-level `htmlLabels` key; this pinned build is measured not to let nested `flowchart.htmlLabels` defeat it, while the separate SVG-gate fixtures prove that a forbidden element is refused.',
  },
  {
    id: 'lottie-renders-and-acknowledges-play',
    title: 'Lottie renders from parent-owned bytes and acknowledges a play command',
    steps: ['lottie'],
    observers: ['parent'],
    verdict:
      'A `rendered` message carries finite integer width and height within the production dimension cap, and a later `set-playing` draws `playing: true` — both parsed by the production parser.',
  },
  {
    id: 'frame-issues-no-library-request',
    title: 'The frame issues no request for its own library; the parent fetches it exactly once',
    steps: ['mermaid-correct-hash', 'mermaid-wrong-hash', 'lottie'],
    observers: ['ledger'],
    verdict:
      'Each fixed asset was requested exactly once for the whole run, no request arrived for any other path, and every recorded `Sec-Fetch-*` value is reported as-is rather than asserted, because Safari does not send those headers.',
  },
  {
    id: 'eval-and-function-constructor-blocked',
    title: '`eval` and the Function constructor evaluate nothing',
    steps: ['probe-egress'],
    observers: ['frame'],
    verdict: 'Neither primitive produced the value of `1+1`; the outcome is "no value", not a particular error type.',
  },
  {
    id: 'dynamic-external-script-blocked',
    title: 'A dynamically inserted external script is never fetched',
    steps: ['probe-egress'],
    observers: ['ledger'],
    verdict: "No request arrived for the frame's `external-script` path.",
  },
  {
    id: 'forbidden-subresources-blocked',
    title: 'Ten subresource and egress sinks reach nothing',
    steps: ['probe-egress'],
    observers: ['ledger'],
    verdict:
      "Zero requests arrived under the frame's nonce for image, stylesheet, `@import`, nested iframe, prefetch, `fetch`, `XMLHttpRequest`, WebSocket, `sendBeacon` and `<a ping>`.",
  },
  {
    id: 'storage-denied',
    title: 'No storage mechanism retains anything',
    steps: ['probe-egress'],
    observers: ['frame', 'ledger'],
    verdict:
      'Every read-back after a write returned nothing, and nothing egressed. The verdict is "no effect" and never "SecurityError", because Safari may silently no-op where Chromium throws.',
  },
  {
    id: 'parent-document-unreachable',
    title: 'The parent document and location are unreadable from inside the frame',
    steps: ['probe-egress'],
    observers: ['frame'],
    verdict: "The frame's report carries no parent title and no parent URL — both reads yielded nothing.",
  },
  {
    id: 'top-navigation-denied',
    title: 'The frame cannot navigate the top-level document',
    steps: ['probe-egress'],
    observers: ['driver', 'ledger'],
    verdict:
      "The URL WebDriver reports for the session is the parent page it was before the attempt, and no request arrived for the frame's `top-nav` path.",
  },
  {
    id: 'popups-and-downloads-denied',
    title: 'No popup opens and no download is fetched',
    steps: ['probe-egress'],
    observers: ['driver', 'frame', 'ledger'],
    verdict:
      "`window.open` returned null, WebDriver reports the same window-handle count as before the attempt, and no request arrived for the frame's `popup` or `download` paths.",
  },
  {
    id: 'hard-watchdog-independent',
    title: 'A shell that never becomes usable falls back, and the hard watchdog is not clearable by the frame',
    steps: ['never-ready', 'watchdog'],
    observers: ['parent'],
    verdict:
      'A missing shell and a shell whose script cannot run both produce the source-view fallback with a stated reason inside the ready deadline; and a frame that completed the handshake and delivered a well-formed `rendered` message is still torn down at the production hard deadline, because nothing the frame sends clears that timer.',
  },
];

/**
 * The diagram the journey compiles. Small on purpose: the property under test is
 * whether a hash-pinned bundle installs and runs at all, not whether Mermaid can
 * draw something elaborate.
 */
export const FY_RENDER_JOURNEY_MERMAID_SOURCE = 'graph TD;\n  A[Start] --> B[Done];\n';

/**
 * The same diagram, opened with an init directive that asks for HTML labels back.
 *
 * The shell's extended `secure` list holds the top-level `htmlLabels` key, while
 * nested `flowchart.htmlLabels` remains reachable on paper. This browser step
 * measures that the nested request does not defeat the pinned build; only the real
 * library parses this syntax. The production SVG gate remains the fail-closed
 * refusal for a future Mermaid change that did emit a forbidden element.
 */
export const FY_RENDER_JOURNEY_MERMAID_INIT_DIRECTIVE_SOURCE =
  '%%{init: {"htmlLabels": true, "flowchart": {"htmlLabels": true}}}%%\ngraph TD;\n  A[Start] --> B[Done];\n';

/**
 * A minimal Lottie animation: one filled rectangle, 64×64, thirty frames.
 *
 * It carries no `"x"` key at any depth, which keeps the fixture away from a
 * distinction it is not here to test: the grammar refuses a STRING-valued `x`,
 * because that is expression source, while admitting the numeric easing and
 * split-dimension shapes that also use the key. The light player ships no
 * expression evaluator either way. This animation exercises the frame, not the
 * grammar's `x` handling.
 */
export const FY_RENDER_JOURNEY_LOTTIE_ANIMATION = {
  v: '5.13.0',
  fr: 30,
  ip: 0,
  op: 30,
  w: 64,
  h: 64,
  nm: 'fy-render journey probe',
  ddd: 0,
  assets: [],
  layers: [
    {
      ddd: 0,
      ind: 1,
      ty: 4,
      nm: 'square',
      sr: 1,
      ks: {
        o: { a: 0, k: 100 },
        r: { a: 0, k: 0 },
        p: { a: 0, k: [32, 32, 0] },
        a: { a: 0, k: [0, 0, 0] },
        s: { a: 0, k: [100, 100, 100] },
      },
      ao: 0,
      shapes: [
        {
          ty: 'gr',
          it: [
            { ty: 'rc', d: 1, s: { a: 0, k: [40, 40] }, p: { a: 0, k: [0, 0] }, r: { a: 0, k: 0 } },
            { ty: 'fl', c: { a: 0, k: [1, 0.4, 0.1, 1] }, o: { a: 0, k: 100 } },
            {
              ty: 'tr',
              p: { a: 0, k: [0, 0] },
              a: { a: 0, k: [0, 0] },
              s: { a: 0, k: [100, 100] },
              r: { a: 0, k: 0 },
              o: { a: 0, k: 100 },
            },
          ],
        },
      ],
      ip: 0,
      op: 30,
      st: 0,
      bm: 0,
    },
  ],
  markers: [],
} as const;
