/**
 * The renderer for a parsed `fy-render` fence.
 *
 * IT RENDERS INLINE, AS IF NATIVE. The owner's decision (`docs/fy-render.md`,
 * "Inline by default"): an illustration appears in the message flow by itself,
 * sized to the column and painted in the theme, with no card around it, no
 * caption or status line under it and no Render control in front of it. The
 * gesture gate that used to stand in front of every decoder is gone; nothing
 * about WHERE author bytes run changed with it. Two quiet affordances remain —
 * Source and Fullscreen — as a small icon cluster in the corner that appears on
 * hover, on keyboard focus, or on a long press.
 *
 * WHAT REPLACED THE GESTURE IS DISTANCE AND SETTLING. A block renders the first
 * time it comes within a screen or so of the viewport (`useViewportPresence`),
 * so a long transcript does not decode, download a renderer or run a page for
 * every block a reader never scrolls to. And a block whose bytes are still
 * changing — the ordinary case while an assistant streams — is not re-rendered
 * on every chunk: new bytes take effect once they have stopped changing for a
 * moment (`useSettledBlock`). Neither bounds what drawing costs; the caps bound
 * the input and nothing bounds the work (gap 3).
 *
 * NOTHING IN THIS COMPONENT EXECUTES AUTHOR-SUPPLIED CODE IN THIS DOCUMENT, and
 * the way it avoids doing so is structural. There is no `srcdoc`, no
 * `dangerouslySetInnerHTML`, no `eval`, no `Function`, and no script element
 * anywhere below. An `html` block WITHOUT script is a static fragment, sanitized
 * and rendered into a closed shadow root by `FyRenderFragment`, where nothing
 * runs. One WITH script runs in `FyRenderHtmlFrame` — a separate opaque-origin
 * document on its own static shell with its own policy, reached only as data over
 * a message port. The only other frame is the library sandbox, where a trusted
 * library interprets Lottie or Mermaid data. Every authored source reaches a
 * `<pre>` as escaped text through React's own escaping.
 *
 * THE `<img>` SINK IS A SECURITY INVARIANT, not an implementation detail. An
 * authored SVG — and a compiled Mermaid diagram, re-admitted through the same
 * grammar — reaches this page only as the `src` of an HTML `<img>`, and a
 * real-Chromium probe measured that exact sink: script and handlers did not run
 * and no external subresource was fetched. Moving these bytes to inline SVG,
 * `<object>`, `<embed>`, `<iframe>` or a CSS image would move them OUT of the only
 * context that was measured — which is why `fy-render-block.test.tsx` asserts the
 * absence of each of those elements. Rendering without a gesture does not change
 * the sink; it changes only who starts the decode.
 *
 * IT HOLDS NO CREDENTIAL. Its props are a parsed block and ONE narrow
 * capability: `readWorkspaceMedia(path) → bytes | refusal`, which a media
 * block's `src: @path` needs and which the session's reference surface builds
 * around its own connection. No `DaemonConnection`, no session id, no daemon URL,
 * no token and no fetcher crosses into this file. The type proves that no such
 * field is present today; it cannot prove a careless future prop addition
 * impossible, which is why this paragraph is here.
 *
 * A FAILURE FALLS BACK TO THE CODE BLOCK, QUIETLY. A payload the browser will not
 * decode, a diagram Mermaid refuses, a sandbox that never started, a page that
 * navigated away: each shows the authored source as the ordinary fence it would
 * have been without this feature, with no sentence in the app's voice. The
 * classified reason travels as `data-fy-render-failure` and the raw library
 * wording as a `title`, for whoever is debugging. The one designed bound that is
 * not a failure — a Lottie frame reaching its wall-clock life — keeps
 * its place with one muted line and a way to run it again.
 */

import { Code2, Maximize2, Minimize2, MousePointerClick, Pause, Play, RotateCcw } from 'lucide-react';
import { type RefObject, useCallback, useEffect, useId, useRef, useState } from 'react';
import { useDialogFocus } from '../hooks/use-dialog-focus.ts';
import {
  FY_RENDER_LIMITS,
  type FyRenderSandboxTheme,
  type FyRenderWorkspaceReader,
  fyRenderMermaidSvg,
  fyRenderPresentation,
  isFyRenderMediaBlock,
  type FyRenderBlock as ParsedBlock,
} from '../lib/fy-render.ts';
import { isNarrowColumn, verticalizeMermaid } from '../lib/fy-render-mermaid-layout.ts';
import { mermaidThemeVariables, paletteKey, type ResolvedTheme } from '../lib/fy-render-palette.ts';
import { MERMAID_LEGIBLE_SCALE, svgNaturalSize, viewBoxSize } from '../lib/fy-render-viewport.ts';
import { FyRenderChart, type FyRenderChartModules } from './fy-render-chart.tsx';
import { FyRenderFragment } from './fy-render-fragment.tsx';
import { FyRenderHtmlFrame, type FyRenderHtmlPaint } from './fy-render-html-frame.tsx';
import { FyRenderMap, type FyRenderMapModules } from './fy-render-map.tsx';
import { FyRenderMedia } from './fy-render-media.tsx';
import { FyRenderSandbox, type FyRenderSandboxFailure } from './fy-render-sandbox.tsx';
import { documentThemeName, readTheme } from './fy-render-theme.ts';
import { FyRenderViewport } from './fy-render-viewport.tsx';

/**
 * How long new bytes must stop changing before they replace what is on screen.
 * Long enough to swallow a streaming assistant's chunk cadence, short enough that
 * a finished message settles before a reader has looked at it.
 */
const SETTLE_MS = 400;

/** "Near" is about one phone screen above and below — far enough that a block is drawn before it arrives. */
const NEAR_MARGIN = '800px 0px';

/** How long a press must last before it counts as a long press on touch. */
const LONG_PRESS_MS = 450;

/**
 * Read once, the first time the block is near, rather than subscribed to: a
 * reduced-motion preference decides whether an animation STARTS playing, it is
 * not a live setting that should yank playback away from somebody who pressed
 * Play. `matchMedia` is guarded because the unit tier's DOM does not always carry
 * it.
 */
const prefersReducedMotion = (): boolean => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

/** The app's theme name: what a theme switch changes, and so what a repaint is keyed on. */
const themeName = documentThemeName;

const TRANSPARENT = new Set(['', 'transparent', 'rgba(0, 0, 0, 0)']);

/**
 * WHAT AN INTERACTIVE PAGE PAINTS ITSELF WITH, so a frameless page reads as part of the message rather
 * than as a window into another one: the first painted ancestor's background (the column may sit on
 * any surface), the column's own colour and font, and the reader's mode. Three CSS values handed to the
 * shell as data — nothing of the app beyond what is already on screen.
 */
const paintFrom = (element: HTMLElement | null, scheme: FyRenderSandboxTheme): FyRenderHtmlPaint => {
  const unpainted = { background: '', color: '', font: '', scheme };
  if (element === null) return unpainted;
  try {
    const own = getComputedStyle(element);
    let background = '';
    for (let at: Element | null = element; at !== null && background === ''; at = at.parentElement) {
      const value = getComputedStyle(at).backgroundColor;
      if (!TRANSPARENT.has(value)) background = value;
    }
    return { background, color: own.color, font: own.fontFamily, scheme };
  } catch {
    // Not a laid-out element — the page then keeps the shell's own system colours.
    return unpainted;
  }
};

/** The one muted line a designed stop leaves, and the word on its button. */
const STOPS = {
  lifetime: { action: 'Run again', html: 'This interactive illustration stopped after ten minutes.' },
  unresponsive: { action: 'Run again', html: 'This interactive illustration stopped because it stopped responding.' },
} as const;

/**
 * A percent-encoded `data:` URL rather than base64: it is correct for any
 * Unicode payload without a manual byte-to-binary-string dance, and `<img>`
 * treats the two identically. The grammar refuses lone surrogates, so
 * `encodeURIComponent` here cannot throw.
 */
const svgDataUrl = (payload: string): string => `data:image/svg+xml,${encodeURIComponent(payload)}`;

/**
 * NEAR AND VISIBLE, from one observer.
 *
 * `near` is sticky: once a block has been drawn it stays drawn, so scrolling
 * back up does not re-run a page or re-download a renderer. `visible` is live,
 * and decides the two things that should only happen on screen — an animation
 * playing, and a diagram drawn for the other theme being redrawn.
 *
 * Without an element (the unit tier's renderer has none) or without
 * `IntersectionObserver`, a block is treated as on screen rather than never
 * rendering anything.
 */
const useViewportPresence = (ref: RefObject<HTMLElement | null>): { near: boolean; visible: boolean } => {
  const [presence, setPresence] = useState({ near: false, visible: false });
  useEffect(() => {
    const element = ref.current;
    if (element === null || typeof IntersectionObserver === 'undefined') {
      setPresence({ near: true, visible: true });
      return;
    }
    const observer = new IntersectionObserver(
      entries => {
        const visible = entries.some(entry => entry.isIntersecting);
        setPresence(previous => ({ near: previous.near || visible, visible }));
      },
      { rootMargin: NEAR_MARGIN },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return presence;
};

/**
 * THE BYTES ON SCREEN LAG THE BYTES ARRIVING, by one quiet moment.
 *
 * A transcript row re-renders as the assistant emits it, so this block sees a
 * half-written payload before the whole one. Re-rendering per chunk would decode
 * a partial SVG over and over, recompile a diagram per token, and re-sanitize an
 * `html` fragment with every character. So the first bytes render at once — a
 * finished message from history must not wait — and later bytes replace them
 * only once they have stopped changing. A change of TYPE is not something to
 * wait out, so it takes effect immediately.
 */
const useSettledBlock = (block: ParsedBlock, settleMs: number): ParsedBlock => {
  const [settled, setSettled] = useState(block);
  useEffect(() => {
    if (settled.source === block.source) return;
    const timer = setTimeout(() => setSettled(block), settleMs);
    return () => clearTimeout(timer);
  }, [block, settleMs, settled.source]);
  return settled.type === block.type ? settled : block;
};

export interface FyRenderBlockProps {
  readonly block: ParsedBlock;
  /**
   * THE ONE CAPABILITY BESIDE THE BLOCK, and it is deliberately not a connection. A media block's
   * `src: @path` needs a workspace file read as the reader; this is that read, as a function from a
   * path to bytes or a refusal. See the credential note above before adding anything else.
   */
  readonly readWorkspaceMedia?: FyRenderWorkspaceReader;
  /** Shortened so streaming can be proven; the app never passes this. */
  readonly settleMs?: number;
  /** Where a map's engine comes from; a test passes a fake so no map library loads, the app never passes this. */
  readonly loadMap?: () => Promise<FyRenderMapModules>;
  /** Where a chart's reader and engine come from; a test passes a fake, the app never passes this. */
  readonly loadChart?: () => Promise<FyRenderChartModules>;
}

const humanType: Record<ParsedBlock['type'], string> = {
  audio: 'audio',
  chart: 'chart',
  html: 'HTML',
  image: 'image',
  lottie: 'Lottie',
  map: 'map',
  mermaid: 'Mermaid',
  pdf: 'PDF',
  svg: 'SVG',
  video: 'video',
};

const RETRYABLE: ReadonlySet<Fallback['kind']> = new Set(['startup', 'library', 'deadline']);

/** A failure that hands the block back to its source, as opposed to a designed stop. */
type Fallback = { readonly kind: FyRenderSandboxFailure['kind'] | 'decode'; readonly detail: string | null };

export function FyRenderBlock({
  block: arriving,
  readWorkspaceMedia,
  settleMs = SETTLE_MS,
  loadMap,
  loadChart,
}: FyRenderBlockProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const block = useSettledBlock(arriving, settleMs);
  const presentation = fyRenderPresentation(block);
  const { near, visible } = useViewportPresence(hostRef);
  const sourcePanelId = useId();

  const [sourceOpen, setSourceOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  /** Shown by a long press on touch, where there is no hover to reveal the corner tools. */
  const [toolsShown, setToolsShown] = useState(false);
  const [fallback, setFallback] = useState<Fallback | null>(null);
  /** A Lottie frame reached its wall-clock life — a designed stop, not a failure. */
  const [stopped, setStopped] = useState<'lifetime' | 'unresponsive' | null>(null);
  /** Remounting the stage is what "run again" means: there is no `iframe.terminate()`. */
  const [revision, setRevision] = useState(0);
  /** A media block showing a file row (a PDF, or a refusal) rather than a picture or a player. */
  const [mediaRow, setMediaRow] = useState(false);
  /** A map block showing its coordinate list because it could not be drawn: nothing to enlarge. */
  const [mapListing, setMapListing] = useState(false);

  /**
   * A COMPILED DIAGRAM OUTLIVES THE FRAME THAT DREW IT. Mermaid is static, so the
   * frame hands back SVG text and is destroyed, and the text goes to the measured
   * `<img>` sink. It records the bytes and the theme it was drawn for, so new bytes
   * or a theme switch can redraw it while the old picture stays on screen — the
   * reader never sees a diagram blink out and back.
   */
  const [compiled, setCompiled] = useState<{
    readonly svg: string;
    readonly theme: FyRenderSandboxTheme;
    /** The palette it was painted in, as the shell echoed it. */
    readonly palette: string;
    readonly source: string;
    /** The text that was compiled: the authored payload, or its top-to-bottom form for a narrow column. */
    readonly drawn: string;
  } | null>(null);

  /**
   * Reduced motion starts an animation PAUSED; it never removes Play. `chosen` is
   * the reader's own decision and wins over the preference from then on.
   */
  const [chosen, setChosen] = useState<boolean | null>(null);
  const [reduced, setReduced] = useState<boolean | null>(null);
  useEffect(() => {
    if (near && reduced === null) setReduced(prefersReducedMotion());
  }, [near, reduced]);
  const wantsPlay = chosen ?? reduced === false;

  /**
   * THE GENERATION, for a decode failure that arrives late. A retained `error`
   * callback closes over the value it was created with; comparing it against a
   * ref reads the CURRENT one, which is the only way to tell a live failure from
   * one belonging to bytes that have already been replaced.
   */
  const [renderedSource, setRenderedSource] = useState(block.source);
  const generation = useRef(0);
  if (renderedSource !== block.source) {
    setRenderedSource(block.source);
    generation.current += 1;
    // New bytes are a new attempt: nothing the old ones failed or stopped on carries over.
    setFallback(null);
    setStopped(null);
    // And a play decision belongs to the bytes it was made about.
    setChosen(null);
  }

  const [theme, setTheme] = useState(themeName);
  useEffect(() => {
    if (!near || typeof MutationObserver === 'undefined') return;
    // Sync on attach: the document may have been repainted before this block was near.
    setTheme(themeName());
    const observer = new MutationObserver(() => setTheme(themeName()));
    observer.observe(document.documentElement, { attributeFilter: ['data-theme'], attributes: true });
    return () => observer.disconnect();
  }, [near]);
  const mode: FyRenderSandboxTheme = theme.includes('light') ? 'light' : 'dark';

  /**
   * THE THEME AS DATA, for the two illustrations painted by a library that cannot read CSS: a chart's
   * canvas and a Mermaid diagram compiled in another document. Read from this block's own element when it
   * is near and again whenever the theme changes, then resolved to hex literals
   * (`fy-render-theme.ts`). The KEY is the mode and the palette together, so a switch between two dark
   * themes is a repaint too.
   */
  const themed = presentation === 'chart' || (presentation === 'sandbox' && block.type === 'mermaid');
  const [resolved, setResolved] = useState<{ readonly theme: ResolvedTheme; readonly key: string } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `theme` is the repaint trigger; the read is the DOM's
  useEffect(() => {
    if (!themed || !near) return;
    const read = readTheme(hostRef.current);
    const key = paletteKey(read);
    setResolved(previous => (previous?.key === key ? previous : { key, theme: read }));
  }, [themed, near, theme]);
  const sandboxPalette =
    resolved === null ? undefined : { key: resolved.key, variables: mermaidThemeVariables(resolved.theme) };

  /**
   * THE COLUMN A DIAGRAM LIVES IN, measured from this block's own element (content box, so the fullscreen
   * overlay's padding is not counted) together with the body text size around it. `null` until the first
   * reading, and a diagram is not compiled before then so its direction is decided once, not twice.
   *
   * WHETHER THE COLUMN IS A PHONE'S (`narrow`) is decided only from the inline column. Entering fullscreen
   * widens the host, and a diagram that flipped direction because the reader enlarged it would be a
   * surprise; the decision stays what the message showed, and moves again only on resize or rotation.
   */
  const mermaidBlock = presentation === 'sandbox' && block.type === 'mermaid';
  const [column, setColumn] = useState<{ readonly px: number; readonly bodyPx: number } | null>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (!mermaidBlock || !near) return;
    const element = hostRef.current;
    const settle = (px: number, bodyPx: number): void => {
      setColumn(previous => (previous?.px === px && previous.bodyPx === bodyPx ? previous : { bodyPx, px }));
      if (!fullscreen) setNarrow(isNarrowColumn(px));
    };
    /** The content box and the body text size, read now. A node that is not a laid-out element reads as 0. */
    const read = (): void => {
      try {
        if (element === null) {
          settle(0, 14);
          return;
        }
        const style = getComputedStyle(element);
        const body = Number.parseFloat(style.fontSize);
        const inner =
          element.clientWidth -
          (Number.parseFloat(style.paddingLeft) || 0) -
          (Number.parseFloat(style.paddingRight) || 0);
        settle(Math.max(0, Math.round(inner)), Number.isFinite(body) && body > 0 ? body : 14);
      } catch {
        settle(0, 14);
      }
    };
    read();
    if (element === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, [mermaidBlock, near, fullscreen]);
  const diagramSource = mermaidBlock && narrow ? verticalizeMermaid(block.payload) : block.payload;

  const [paint, setPaint] = useState<FyRenderHtmlPaint>(() => paintFrom(null, mode));
  // biome-ignore lint/correctness/useExhaustiveDependencies: `theme` is the repaint trigger; the read is the DOM's
  useEffect(() => {
    if (presentation === 'interactive' && near) setPaint(paintFrom(hostRef.current, mode));
  }, [presentation, near, theme]);
  /** The page's last reported height, so a parked page keeps its place in the column. */
  const [pageHeight, setPageHeight] = useState<number | null>(null);
  const [pageReady, setPageReady] = useState(false);
  const onPageRendered = useCallback((): void => setPageReady(true), []);

  const collapse = useCallback(() => setFullscreen(false), []);
  const focus = useDialogFocus(fullscreen, hostRef, collapse, { autoFocus: false });

  const fail = useCallback((failure: FyRenderSandboxFailure): void => {
    if (failure.kind === 'lifetime' || failure.kind === 'unresponsive') setStopped(failure.kind);
    else setFallback({ detail: failure.detail, kind: failure.kind });
    // There is nothing left to enlarge, and Exit must not vanish under a reader standing in it.
    setFullscreen(false);
  }, []);

  const runAgain = (): void => {
    setFallback(null);
    setStopped(null);
    setRevision(value => value + 1);
  };

  const onDecodeFailure = (from: number) => (): void => {
    if (from !== generation.current) return;
    setFallback({ detail: null, kind: 'decode' });
    setFullscreen(false);
  };

  /**
   * The compiled diagram is re-admitted through the grammar before it reaches the
   * page. Mermaid is trusted and its input was bounded, so this is the cheap
   * second gate rather than the primary one — but it is what makes a Mermaid
   * release that started emitting `<script>` or a `<foreignObject>` fall back
   * visibly instead of silently changing the sink's diet.
   */
  const source = block.source;
  const onCompiled = useCallback(
    (svg: string, drawnFor: FyRenderSandboxTheme, palette: string): void => {
      const admitted = fyRenderMermaidSvg(svg);
      if (!admitted.ok) {
        fail({ detail: admitted.reason, kind: 'render' });
        return;
      }
      // THE SHELL'S OWN THEME, never the document's: a switch during the compile
      // must not be recorded as the theme this diagram was drawn for.
      setCompiled({ drawn: diagramSource, palette, source, svg: admitted.svg, theme: drawnFor });
    },
    [diagramSource, fail, source],
  );

  const noop = useCallback((): void => undefined, []);

  const live = near && fallback === null && stopped === null;
  const mermaid = presentation === 'sandbox' && block.type === 'mermaid';
  /**
   * WHEN A DIAGRAM IS DRAWN. Once for its bytes, and again only when the palette it
   * was painted in is no longer the page's AND it is on screen: a theme toggle with
   * ten diagrams in a long transcript redraws the two in view, and the rest when
   * they come back into view — never all of them at once.
   */
  const drawDiagram =
    live &&
    mermaid &&
    resolved !== null &&
    column !== null &&
    (compiled === null ||
      compiled.source !== source ||
      ((compiled.palette !== resolved.key || compiled.drawn !== diagramSource) && visible));
  const diagram = mermaid && fallback === null && compiled !== null;
  /** The compiled diagram's natural size, from its `viewBox`: what the viewport fits, zooms and pans. */
  const natural = diagram && compiled !== null ? viewBoxSize(compiled.svg) : null;
  /** An authored SVG with a size is shown through the same viewport. Without one it stays a plain image. */
  const svgSize = presentation === 'visual' && block.type === 'svg' ? svgNaturalSize(block.payload) : null;
  const lottie = live && presentation === 'sandbox' && block.type === 'lottie';
  const fragment = live && presentation === 'fragment';
  /**
   * AN INTERACTIVE PAGE RUNS ONLY WHILE IT IS ON (OR NEAR) SCREEN. Scrolled well away it is UNLOADED —
   * the frame removed, its scripts with it — and a plane of its last height holds its place; scrolled
   * back, it starts again. A page left running a screen and more away is work nobody is watching.
   * Fullscreen keeps it, because then it is the only thing on screen.
   */
  const interactive = live && presentation === 'interactive';
  const running = interactive && (visible || fullscreen);
  // A parked page is a new frame when it comes back, so its first draw is awaited again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new page, a run-again or a re-entry is a new frame
  useEffect(() => setPageReady(false), [source, revision, running]);
  const media = near && presentation === 'media' && isFyRenderMediaBlock(block);
  const map = live && presentation === 'map';
  const chart = live && presentation === 'chart';
  const picture = live && presentation === 'visual';
  /**
   * A stage with something to enlarge and something to show the source of. Not a
   * file row, and not an audio player: its own controls fill the corner the tools
   * would sit on, and there is nothing to see in fullscreen.
   */
  const tooled =
    fallback === null &&
    stopped === null &&
    !mediaRow &&
    block.type !== 'audio' &&
    (picture || diagram || lottie || fragment || interactive || media || map || chart);

  /**
   * THE LONG PRESS, on touch only. A tap belongs to the content — a video's
   * controls, a link in an `html` fragment — so it is a press held still for a moment
   * that reveals the corner tools, and a second one that hides them.
   */
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPress = (): void => {
    if (pressTimer.current !== null) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };
  // A press still timing when the block unmounts must not fire into it.
  useEffect(
    () => () => {
      if (pressTimer.current !== null) clearTimeout(pressTimer.current);
    },
    [],
  );
  const touch = tooled
    ? {
        onPointerCancel: cancelPress,
        onPointerDown: (event: { readonly pointerType: string }): void => {
          if (event.pointerType !== 'touch') return;
          cancelPress();
          pressTimer.current = setTimeout(() => {
            pressTimer.current = null;
            setToolsShown(shown => !shown);
          }, LONG_PRESS_MS);
        },
        onPointerMove: cancelPress,
        onPointerUp: cancelPress,
      }
    : {};

  const preview = block.source.slice(0, FY_RENDER_LIMITS.sourcePreviewCharacters);
  const truncated = block.source.length > preview.length;
  /**
   * THE CODE BLOCK, as the fence would have been without this feature. It is the
   * fallback for every failure and the panel behind the Source affordance.
   */
  const code = (
    <>
      <pre>
        <code className="language-fy-render">{preview}</code>
      </pre>
      {truncated ? (
        <p className="fy-render-truncated">
          Source preview truncated at {FY_RENDER_LIMITS.sourcePreviewCharacters} characters.
        </p>
      ) : null}
    </>
  );

  const fallen =
    fallback === null ? null : (
      <div
        className="fy-render fy-render--fallback"
        data-fy-render-error="true"
        data-fy-render-failure={fallback.kind}
        data-fy-render-type={block.type}
        title={fallback.detail ?? undefined}
      >
        {code}
        {/* A RETRY ONLY WHERE ONE CAN HELP. Three classes are about the deployment
            rather than the bytes — a shell that never started, a renderer that did
            not load, a deadline a cold download used up — and the reader cannot be
            expected to reload the app. Bytes the browser or the library refused, or
            a page that navigated away, would only do the same thing again. */}
        {RETRYABLE.has(fallback.kind) ? (
          <button className="fy-render-quiet-action" onClick={runAgain} type="button">
            <RotateCcw aria-hidden="true" size={12} /> Try rendering again
          </button>
        ) : null}
      </div>
    );

  const stage =
    stopped !== null ? (
      <p className="fy-render-stopped" data-fy-render-stopped={stopped}>
        {block.type === 'html' ? STOPS[stopped].html : 'This animation stopped.'}{' '}
        <button className="fy-render-quiet-action" onClick={runAgain} type="button">
          <RotateCcw aria-hidden="true" size={12} /> {block.type === 'html' ? STOPS[stopped].action : 'Replay'}
        </button>
      </p>
    ) : media && isFyRenderMediaBlock(block) ? (
      /** Reads or fetches only now, once near; owns its own loading and refusal rows. */
      <FyRenderMedia
        block={block}
        key={`media:${generation.current}:${revision}`}
        onShape={setMediaRow}
        {...(readWorkspaceMedia === undefined ? {} : { readWorkspaceMedia })}
      />
    ) : picture && svgSize !== null ? (
      <FyRenderViewport
        alt={block.alt}
        diagram={false}
        fullscreen={fullscreen}
        key={`${generation.current}:${revision}`}
        kind="Illustration"
        legibleScale={0}
        natural={svgSize}
        onError={onDecodeFailure(generation.current)}
        src={svgDataUrl(block.payload)}
      />
    ) : picture ? (
      <img
        alt={block.alt}
        className="fy-render-image"
        key={`${generation.current}:${revision}`}
        onError={onDecodeFailure(generation.current)}
        src={'mime' in block ? `data:${block.mime};base64,${block.payload}` : svgDataUrl(block.payload)}
      />
    ) : map ? (
      /** Data, not markup: drawn in this document by Leaflet from nodes it creates — see `fy-render-map.tsx`. */
      <FyRenderMap
        alt={block.alt}
        fullscreen={fullscreen}
        key={`map:${generation.current}:${revision}`}
        load={loadMap}
        mode={mode}
        onListing={setMapListing}
        payload={block.payload}
      />
    ) : chart && resolved !== null ? (
      /** Data, not code: a chart description drawn by Chart.js in this document, in the theme — see `fy-render-chart.tsx`. */
      <FyRenderChart
        alt={block.alt}
        fullscreen={fullscreen}
        key={`chart:${generation.current}:${revision}`}
        load={loadChart}
        onFailed={fail}
        payload={block.payload}
        theme={resolved.theme}
        visible={visible || fullscreen}
      />
    ) : fragment ? (
      /** Static markup, sanitized into a closed shadow root — see `fy-render-fragment.tsx`. Nothing runs. */
      <FyRenderFragment
        alt={block.alt}
        key={`fragment:${generation.current}:${revision}`}
        source={block.payload}
        {...(readWorkspaceMedia === undefined ? {} : { readWorkspaceMedia })}
      />
    ) : interactive ? (
      <>
        {/* A SUBTLE MARKER, always on: this one is not a picture, it runs, and the reader can tell. */}
        <span className="fy-render-marker" data-fy-render-marker="true">
          <MousePointerClick aria-hidden="true" size={11} /> interactive
        </span>
        {running ? (
          /**
           * AUTHOR CODE RUNS HERE, in its own opaque frame with its own policy — see
           * `fy-render-html-frame.tsx`. Frameless: it paints the column's background, colour and font,
           * and takes the (bounded) height it reports.
           */
          <FyRenderHtmlFrame
            block={block}
            fullscreen={fullscreen}
            key={`html:${generation.current}:${revision}`}
            onEscape={collapse}
            onFailed={fail}
            onHeight={setPageHeight}
            onRendered={onPageRendered}
            paint={paint}
            ready={pageReady}
            title={`Interactive illustration: ${block.alt}`}
          />
        ) : (
          <div
            aria-hidden="true"
            className="fy-render-placeholder"
            data-fy-render-parked="true"
            style={pageHeight === null ? undefined : { height: `${pageHeight}px` }}
          />
        )}
      </>
    ) : lottie ? (
      <FyRenderSandbox
        block={block}
        key={`frame:${generation.current}:${revision}`}
        onCompiled={noop}
        onFailed={fail}
        onRendered={noop}
        playing={wantsPlay && (visible || fullscreen)}
        theme={mode}
      />
    ) : (
      <>
        {diagram && natural !== null ? (
          /**
           * FITTED, ZOOMABLE, PANNABLE. The compiled image has no size of its own, so the viewport gives it one
           * from its `viewBox` (`fy-render-viewport.ts`): the whole diagram at rest, text no smaller than
           * 10px, and Zoom / Reset / drag / pinch from there.
           */
          <FyRenderViewport
            alt={block.alt}
            diagram
            fullscreen={fullscreen}
            key={`diagram:${generation.current}`}
            kind="Diagram"
            legibleScale={MERMAID_LEGIBLE_SCALE}
            natural={natural}
            onError={onDecodeFailure(generation.current)}
            src={svgDataUrl(compiled?.svg as string)}
          />
        ) : diagram ? (
          <img
            alt={block.alt}
            className="fy-render-image"
            data-fy-render-diagram="true"
            key={`diagram:${generation.current}`}
            onError={onDecodeFailure(generation.current)}
            src={svgDataUrl(compiled?.svg as string)}
          />
        ) : near || presentation === 'map' || presentation === 'chart' ? (
          // A diagram's first draw holds a quiet plane rather than nothing, so the
          // prose below does not jump twice. A map holds its plane from the start, for the same reason.
          <div aria-hidden="true" className="fy-render-placeholder" />
        ) : null}
        {drawDiagram ? (
          /**
           * OFF STAGE. The frame only compiles; what the reader sees is the `<img>`
           * it hands back. Hidden rather than absent, because Mermaid measures text
           * and needs a laid-out document to measure it in.
           */
          <div aria-hidden="true" className="fy-render-offstage">
            <FyRenderSandbox
              block={block}
              key={`frame:${generation.current}:${revision}:${resolved?.key}:${diagramSource === block.payload ? 'authored' : 'vertical'}`}
              diagramSource={diagramSource}
              onCompiled={onCompiled}
              onFailed={fail}
              onRendered={noop}
              palette={sandboxPalette}
              playing={false}
              theme={resolved?.theme.mode ?? mode}
            />
          </div>
        ) : null}
      </>
    );

  /**
   * ONE HOST ELEMENT IN BOTH STATES, and the reason is focus rather than tidiness:
   * a separate dialog element would change the root of this subtree, unmount the
   * control the reader just pressed before `useDialogFocus` captured it, and land
   * them outside the modal they opened. `kt-overlay` is the app's visible-viewport
   * contract, so the overlay does not run under a notch or behind a keyboard.
   */
  const modal = fullscreen
    ? { 'aria-label': `Illustration: ${block.alt}`, 'aria-modal': true, onKeyDown: focus.onKeyDown, role: 'dialog' }
    : {};

  /** Lottie's one control. Shown without hovering while paused, so reduced motion never hides Play. */
  const paused = lottie && !wantsPlay;

  return (
    <div
      className={fullscreen ? 'kt-overlay fy-render-fullscreen' : undefined}
      ref={hostRef}
      // Focusable only while it is a dialog, so focus has somewhere to land inside it.
      tabIndex={fullscreen ? -1 : undefined}
      {...modal}
    >
      {fallen ?? (
        <figure
          className="fy-render"
          data-fy-render-fullscreen={fullscreen ? 'true' : 'false'}
          data-fy-render-presentation={presentation}
          data-fy-render-tools={toolsShown || paused || fullscreen ? 'shown' : 'hover'}
          data-fy-render-type={block.type}
          {...touch}
        >
          <div
            className="fy-render-stage"
            data-fy-render-stage={media && mediaRow ? 'row' : stopped !== null ? 'note' : 'visual'}
          >
            {stage}
            {tooled ? (
              <div className="fy-render-tools">
                {block.type === 'lottie' && lottie ? (
                  <button
                    aria-label={wantsPlay ? 'Pause animation' : 'Play animation'}
                    className="fy-render-tool"
                    data-fy-render-playing={wantsPlay ? 'true' : 'false'}
                    onClick={() => setChosen(!wantsPlay)}
                    type="button"
                  >
                    {wantsPlay ? <Pause aria-hidden="true" size={14} /> : <Play aria-hidden="true" size={14} />}
                  </button>
                ) : null}
                {/* A STABLE NAME with `aria-expanded`, and `aria-controls` only while
                  the panel exists — an id that is not in the document is exactly
                  what `aria-valid-attr-value` flags. */}
                <button
                  aria-controls={sourceOpen ? sourcePanelId : undefined}
                  aria-expanded={sourceOpen}
                  aria-label={`${humanType[block.type]} source`}
                  className="fy-render-tool"
                  onClick={() => setSourceOpen(open => !open)}
                  type="button"
                >
                  <Code2 aria-hidden="true" size={14} />
                </button>
                {map && mapListing ? null : (
                  <button
                    aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                    className="fy-render-tool"
                    onClick={() => setFullscreen(value => !value)}
                    type="button"
                  >
                    {fullscreen ? (
                      <Minimize2 aria-hidden="true" size={14} />
                    ) : (
                      <Maximize2 aria-hidden="true" size={14} />
                    )}
                  </button>
                )}
              </div>
            ) : null}
          </div>
          {sourceOpen && tooled ? (
            /**
             * A KEYBOARD-REACHABLE SCROLLPORT: an authored payload is routinely one
             * enormous line, so the panel scrolls sideways and must be a tab stop for
             * a keyboard reader to pan it. A named `<section>` says what it holds.
             */
            <section
              aria-label={`Authored ${humanType[block.type]} source`}
              className="fy-render-source scroll-thin"
              data-fy-render-source="true"
              id={sourcePanelId}
              // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollport must be a tab stop, see above
              tabIndex={0}
            >
              {code}
            </section>
          ) : null}
        </figure>
      )}
    </div>
  );
}
