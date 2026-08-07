/**
 * The inert renderer for a parsed `fy-render` fence.
 *
 * NOTHING IN THIS COMPONENT EXECUTES AUTHOR-SUPPLIED CODE, and the way it
 * avoids doing so is structural rather than a policy it follows. There is no
 * `iframe`, no `srcdoc`, no `dangerouslySetInnerHTML`, no `eval`, no `Function`,
 * and no script element anywhere below. Every payload that is not a vector or a
 * raster reaches a `<pre>` as escaped text through React's own escaping.
 *
 * NO DECODER MOUNTS WITHOUT A GESTURE. A bounded payload is still an unbounded
 * amount of rasterising, and a transcript is written by an agent rather than by
 * the reader, so an illustration is offered and not performed: the stage states
 * the resource risk, and one control starts it. The approval belongs to
 * the EXACT `block.source` and is discarded the moment those bytes change, so a
 * streamed message cannot inherit consent granted to an earlier draft of itself.
 * There is deliberately no always-render setting: it would put the automatic
 * path back.
 *
 * Say what that guarantees precisely. Nothing tells this component that a
 * message has stopped growing, so a reader who presses Render while an `svg` is
 * still arriving DOES decode a partial one — lexically admitted, inside every
 * cap, and their own deliberate choice. A partial RASTER cannot mount, but for a
 * different reason: the grammar's container checks require a terminal shape and
 * the selected record ordering, which an unfinished file fails, so it never
 * parses. The gate guarantees no automatic mount and no inherited consent; it
 * guarantees neither completeness nor validity — CRCs and compressed content are
 * the browser decoder's business, after the gesture.
 *
 * THE `<img>` SINK IS A SECURITY INVARIANT, not an implementation detail. An
 * authored SVG reaches this page only as the `src` of an HTML `<img>`, and a
 * real-Chromium probe measured that exact sink: in Chrome 150, script and script
 * event handlers did not run and no external subresource was fetched, while the
 * identical bytes in an active top-level SVG document fetched, executed and
 * navigated. Moving these bytes to inline SVG, `<object>`, `<embed>`,
 * `<iframe>`, or a CSS image consumer would move them OUT of the only context
 * that was measured — which is why `fy-render-block.test.tsx` asserts the
 * absence of each of those elements rather than merely the presence of the
 * `<img>`. Firefox, WebKit and Safari are unmeasured, and nothing here claims
 * declarative SVG animation is inert. `docs/fy-render.md` cites the ledger.
 *
 * IT IS ALSO WHERE MALFORMED SVG IS CAUGHT. The grammar deliberately does not
 * parse XML, so a payload that only looks like an SVG reaches the `<img>` and
 * fails to decode. That fires `error`, and the block shows its source with the
 * failure said out loud rather than an empty frame.
 *
 * IT HOLDS NO CREDENTIAL. Its props are a parsed block and nothing else: no
 * `DaemonConnection`, no session id, no daemon URL, no fetcher. The type proves
 * that no such field is present today (soundness); it cannot prove a careless
 * future prop addition impossible (completeness), which is why this paragraph is
 * here and why a reviewer should read the props before the body — the same
 * stance `rich-file-preview.tsx` takes for file previews.
 *
 * `mermaid` AND `lottie` NOW RENDER, and the way they do it does not weaken the
 * paragraph above. Neither runs author code: a trusted library interprets
 * bounded author DATA inside an opaque-origin frame that has no storage and no
 * reach into this document, fetches nothing for itself, and is denied ordinary
 * subresources by `default-src 'none'` — which is NOT the same as having no
 * network, since self-navigation, prerender and WebRTC egress were measured
 * from that frame shape and are a declared residual (`fy-render-sandbox.tsx`,
 * and `docs/fy-render.md` gap 2). A compiled
 * Mermaid diagram comes back as SVG text, is re-admitted through the grammar,
 * and reaches the very same `<img>` sink described above — so the measured
 * result covers it too. Lottie is the one thing here that stays live, because
 * an animation has to keep running to animate.
 *
 * A SANDBOX RENDER IS THE ONE ASYNCHRONOUS THING HERE, so it is the one thing
 * that reports itself. It follows a reader's gesture and takes as long as a
 * library download, so a single sandbox-only `role="status"` region carries
 * "preparing", then "ready", then a failure — visible and spoken, per WCAG 4.1.3.
 * The streamed decode path stays deliberately silent, because a half-written
 * `svg` fails for real while its message is still arriving and a live region
 * would announce an error that is not one yet. Those are different states
 * (`failed` versus `sandboxError`), presented by different elements, on purpose.
 *
 * AND A FAILURE IS CLASSIFIED, NEVER MATCHED ON. `FyRenderSandboxFailure` names
 * five kinds; this component writes one fixed reader sentence per kind and folds
 * the raw library or gate wording away underneath it. Two of those kinds are not
 * the payload's fault, and one — a Lottie frame reaching its permitted life — is
 * not a fault at all and is presented in the app's neutral voice with no source
 * panel unfurled beneath it.
 *
 * `html` still renders as its own source with the limitation stated on screen.
 * That remains this build's declared gap: executing author JavaScript, bounded
 * in CPU and memory, is NOT what this component does. `docs/fy-render.md` says
 * so in those words.
 */

import { Code2, ImageIcon, Maximize2, Minimize2, Pause, Play, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useDialogFocus } from '../hooks/use-dialog-focus.ts';
import {
  FY_RENDER_LIMITS,
  type FyRenderSandboxTheme,
  fyRenderMermaidSvg,
  fyRenderPayloadBytes,
  fyRenderPresentation,
  type FyRenderBlock as ParsedBlock,
} from '../lib/fy-render.ts';
import { Button } from '../shell/primitives.tsx';
import { FyRenderSandbox, type FyRenderSandboxFailure } from './fy-render-sandbox.tsx';

/**
 * Read once, at the moment a reader consents, rather than subscribed to.
 *
 * A reduced-motion preference decides whether an animation STARTS playing; it is
 * not a live setting that should yank playback away from somebody who pressed
 * Play. `matchMedia` is guarded because the unit tier's DOM does not always
 * carry it, and a missing media query must not be the thing that throws inside a
 * transcript row.
 */
const prefersReducedMotion = (): boolean => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

/** Mermaid needs to be told which way the page is painted; it cannot see it. */
const documentTheme = (): 'dark' | 'light' => {
  if (typeof document === 'undefined') return 'dark';
  return (document.documentElement.getAttribute('data-theme') ?? '').includes('light') ? 'light' : 'dark';
};

export interface FyRenderBlockProps {
  /** The only input. See the credential note above before adding a second. */
  readonly block: ParsedBlock;
}

/**
 * A percent-encoded `data:` URL rather than base64: it is correct for any
 * Unicode payload without a manual byte-to-binary-string dance, and `<img>`
 * treats the two identically. The grammar refuses lone surrogates, so
 * `encodeURIComponent` here cannot throw.
 */
const svgDataUrl = (payload: string): string => `data:image/svg+xml,${encodeURIComponent(payload)}`;

const humanType: Record<ParsedBlock['type'], string> = {
  html: 'HTML',
  svg: 'SVG',
  image: 'image',
  mermaid: 'Mermaid',
  lottie: 'Lottie',
};

/**
 * ONE FIXED SENTENCE PER FAILURE CLASS, and no library or gate wording in any of
 * them.
 *
 * Two things used to reach a transcript as the app's own voice: the
 * re-admission gate's exact refusal ("The compiled diagram contains a
 * `<foreignObject>` element"), which is the sentence a reader gets on the
 * flagship `%%{init}%%` fallback path, and the shell's forwarded `error.message`
 * — for Mermaid a multi-line jison dump carrying a slice of the AUTHOR's source
 * and an ASCII caret rule, collapsed by HTML whitespace handling into one
 * mangled line wearing the app's `err` styling. React escapes it, so that is a
 * spoofing and legibility problem rather than an injection one, and it is still
 * the app appearing to say something an author wrote. The precise wording is
 * kept — folded away under `kt-fs-why`, the idiom `files-views.tsx` already uses
 * for exactly this — because whoever is debugging a diagram needs it.
 *
 * `deadline` NAMES WHAT WAS BOUND rather than blaming the drawing. The timer
 * covers fetch, handshake, install and compile, and the Mermaid bundle is ~3.4
 * MiB: a cold first block on a slow connection can exhaust the bound while still
 * downloading the renderer. Telling that reader their diagram was too complex
 * points them at the one remedy that cannot help.
 *
 * `lifetime` IS NOT A FAILURE SENTENCE. Nothing went wrong; a healthy animation
 * reached its permitted life. See `sandboxTone`.
 */
const sandboxFailureSentence = (type: ParsedBlock['type'], kind: FyRenderSandboxFailure['kind']): string => {
  switch (kind) {
    case 'startup':
      return 'The illustration sandbox did not start. The authored source is shown below.';
    case 'library':
      return `The ${humanType[type]} renderer could not be loaded. The authored source is shown below.`;
    case 'render':
      return `This ${humanType[type]} illustration could not be rendered. The authored source is shown below.`;
    case 'deadline':
      return 'The diagram did not finish rendering in time and was stopped. Reload to try again.';
    case 'lifetime':
      return 'Playback was stopped after two minutes. Reload to play it again.';
  }
};

/**
 * A DESIGNED BOUND IS NOT AN ERROR, so it does not wear one's clothes.
 *
 * Every other class is a thing that went wrong with bytes or with a deployment.
 * `lifetime` is the frame doing exactly what it was built to do to a perfectly
 * healthy animation the reader chose to watch, and dressing it in `err` — with
 * the authored JSON unfurled underneath, which is scaffolding for diagnosing BAD
 * BYTES and no help at all with a wall-clock cap — told somebody their animation
 * was broken. `undefined` leaves the note in the app's neutral voice.
 */
const sandboxTone = (kind: FyRenderSandboxFailure['kind']): 'err' | undefined =>
  kind === 'lifetime' ? undefined : 'err';

/** Rounded to whole units — the reader is sizing a decision, not auditing bytes. */
const humanBytes = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${Math.round(bytes / (1024 * 1024))} MB`
    : bytes >= 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${bytes} bytes`;

export function FyRenderBlock({ block }: FyRenderBlockProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const presentation = fyRenderPresentation(block.type);
  const sourcePanelId = useId();

  /**
   * WHY the source panel is open, not merely whether — the two reasons have
   * different lifetimes. A panel the READER opened is theirs to close. A panel a
   * decode FAILURE opened is scaffolding for that failure and goes when the
   * failure does, or a streamed illustration finishes correct with an
   * unsolicited wall of markup underneath it.
   */
  const [sourcePanel, setSourcePanel] = useState<'closed' | 'opened' | 'failure'>(
    presentation === 'source' ? 'opened' : 'closed',
  );
  const showSource = sourcePanel !== 'closed';
  const [fullscreen, setFullscreen] = useState(false);
  const [failed, setFailed] = useState(false);
  const [approved, setApproved] = useState(false);
  // Remounting the `<img>` is what "reload" means for a static payload.
  const [revision, setRevision] = useState(0);

  /**
   * THE SANDBOX'S STATE, and why the diagram is kept as a string rather than
   * left on screen inside the frame.
   *
   * A compiled Mermaid diagram is static, so the frame that drew it has no
   * further job. Keeping it alive would leave a live opaque-origin document in
   * the transcript for every diagram a reader scrolls past. Instead the frame
   * hands back SVG text, the frame is destroyed, and the text goes to the same
   * `<img>` sink an authored SVG uses — the one that was actually measured.
   * Lottie cannot do this: it has to keep running to keep animating.
   *
   * THE THEME TRAVELS WITH THE DIAGRAM, and that is not bookkeeping. Mermaid
   * cannot see the page, so it is TOLD which way it is painted and bakes that
   * into the SVG it returns; the result then lives on as an `<img>` for the rest
   * of the transcript's life. This app ships 22 themes, so switching from a dark
   * one to a light one left light strokes on a light surface — unreadable, with
   * nothing on screen suggesting Reload was the remedy. Recording the theme the
   * compile used is what lets the effect below notice.
   */
  const [compiled, setCompiled] = useState<{ readonly svg: string; readonly theme: 'dark' | 'light' } | null>(null);
  const [sandboxError, setSandboxError] = useState<FyRenderSandboxFailure | null>(null);
  /**
   * THE FIRST SUCCESS ACKNOWLEDGEMENT FROM THE FRAME, which is what makes the
   * wait visible instead of a bordered empty plane.
   *
   * Consent moves the stage straight to the frame, and the frame is transparent
   * until the library has been fetched, installed and run — bounded at 15 s for
   * Mermaid and 120 s for Lottie. For a sighted reader that was an empty box; for
   * a screen-reader user nothing was announced on success OR failure. Lottie's
   * half of this arrives as the shell's `rendered` reply, which the parent used
   * to discard; Mermaid's is `onCompiled`.
   */
  const [sandboxReady, setSandboxReady] = useState(false);
  /**
   * Reduced motion starts an animation PAUSED; it never removes Play. Stripping
   * the control would be deciding for the reader rather than defaulting for them.
   *
   * READ AT CONSENT, NOT AT MOUNT. A transcript row mounts when the message
   * arrives and may sit unread for an hour; the preference that matters is the
   * one in force when somebody actually asks for the animation. Seeding this
   * from `useState` meant an OS preference changed in between was ignored, and
   * an animation could auto-start against a reduced-motion setting that was
   * already on by the time it started.
   *
   * `chosen` is what keeps that from overriding a person. Once the reader has
   * pressed Play or Pause the preference stops being consulted, so a Reload does
   * not quietly undo what they just asked for.
   */
  const [playing, setPlaying] = useState(false);
  const [chosen, setChosen] = useState(false);

  /**
   * THE EXACT BYTES THAT WERE CONSENTED TO, and a counter for the decode they
   * belong to. A transcript row re-renders as the assistant emits it, so this
   * component sees a half-written payload before it sees the whole one.
   *
   * The generation is a ref rather than state because a retained `error`
   * callback closes over the value it was created with; comparing that against a
   * ref reads the CURRENT generation, which is the only way to tell a live
   * failure from one belonging to bytes that have already been replaced. Without
   * it, an error queued for a superseded partial payload lands on the completed
   * one and fails an image that is perfectly fine.
   */
  const [renderedSource, setRenderedSource] = useState(block.source);
  const [renderedPresentation, setRenderedPresentation] = useState(presentation);
  const generation = useRef(0);
  if (renderedSource !== block.source || renderedPresentation !== presentation) {
    setRenderedSource(block.source);
    generation.current += 1;
    setFailed(false);
    // Consent is to bytes, not to a block. New bytes, new decision.
    setApproved(false);
    // And nothing the OLD bytes produced may survive into the new ones.
    setCompiled(null);
    setSandboxError(null);
    setSandboxReady(false);
    setPlaying(false);
    /**
     * AND THE PLAYBACK DECISION GOES WITH THEM. `chosen` records that the reader
     * overrode the motion preference for THESE bytes; carrying it into a
     * rewritten message would let a Play pressed on one animation autoplay a
     * different one under a reduce preference — a choice leaking across the byte
     * boundary the line above exists to enforce. A Reload keeps it, because that
     * is the same bytes and the reader's decision about them still stands.
     */
    setChosen(false);
    /**
     * AND THE OVERLAY CLOSES WITH IT, or the reader is trapped.
     *
     * Withdrawing approval hides the Fullscreen control, because an unrendered
     * visual has nothing to enlarge. If the reader was already IN fullscreen on
     * a rendered illustration when new bytes arrived, that hides the Exit button
     * out from under them and leaves a full-viewport overlay holding one line of
     * consent text — escapable by keyboard, and by nothing at all on touch,
     * where Exit is the only dismiss affordance.
     *
     * A source-only update keeps fullscreen: it still has source to show, and
     * its Exit control never goes away.
     */
    if (presentation !== 'source') setFullscreen(false);
    if (renderedPresentation === presentation) {
      // Same kind of block, new bytes: the panel is the READER's, except one a
      // failure opened, which goes when the failure does.
      setSourcePanel(panel => (panel === 'failure' ? 'closed' : panel));
    } else {
      /**
       * THE KIND OF BLOCK CHANGED, so the panel is re-derived rather than
       * inherited. A block that becomes source-only while its panel is closed —
       * the default for a visual type — otherwise shows a note saying "the
       * authored source is shown below" above nothing at all: no picture, no
       * source, one sentence pointing at an empty space. Reachable when a
       * transcript entry with a stable id is rewritten rather than appended to.
       */
      setRenderedPresentation(presentation);
      setSourcePanel(presentation === 'source' ? 'opened' : 'closed');
    }
  }

  const collapse = useCallback(() => setFullscreen(false), []);
  const focus = useDialogFocus(fullscreen, hostRef, collapse, { autoFocus: false });

  const reload = (): void => {
    setFailed(false);
    // A reload is a fresh frame and a fresh compile, so nothing the previous one
    // produced may survive it — including the diagram it had already handed back.
    setCompiled(null);
    setSandboxError(null);
    setSandboxReady(false);
    // The panel a FAILURE opened is scaffolding for that failure, so it goes
    // when the failure does — by any route out of it, not only by new bytes.
    // Clearing `failed` while leaving it open left an unsolicited wall of markup
    // under a retried image, which is the very thing the ownership rule exists
    // to prevent. A panel the reader opened is theirs and stays.
    setSourcePanel(panel => (panel === 'failure' ? 'closed' : panel));
    // A reload re-reads the preference UNLESS the reader has already overridden
    // it, so a Pause they chose survives and a stale auto-start does not.
    if (!chosen) setPlaying(!prefersReducedMotion());
    setRevision(value => value + 1);
  };

  const onDecodeFailure = (from: number) => (): void => {
    // A failure from bytes that are no longer on screen is not this image's.
    if (from !== generation.current) return;
    setFailed(true);
    setSourcePanel(panel => (panel === 'closed' ? 'failure' : panel));
  };

  /**
   * A failure inside the frame is scaffolding for that failure, exactly like a
   * decode failure, so it opens the source panel the same way and goes the same
   * way. The two are kept as separate state because they mean different things
   * — one is a browser refusing bytes, the other is a library refusing data —
   * but a reader is shown one sentence either way.
   *
   * EXCEPT FOR `lifetime`, WHICH OPENS NOTHING. The source panel exists to help
   * with bad bytes. A wall-clock cap reached by a healthy animation is not bad
   * bytes, and unfurling a wall of authored Lottie JSON under it is no help with
   * anything — it just makes a designed bound look like a breakage. This is a
   * discriminator on the failure's own kind rather than a match on its sentence,
   * which is the whole reason the seam is typed.
   */
  const failSandbox = useCallback((failure: FyRenderSandboxFailure): void => {
    setSandboxError(failure);
    if (failure.kind === 'lifetime') return;
    setSourcePanel(panel => (panel === 'closed' ? 'failure' : panel));
  }, []);

  /**
   * The compiled diagram is re-admitted through the grammar before it reaches
   * the page. Mermaid is trusted and its input was bounded, so this is the cheap
   * second gate rather than the primary one — the `<img>` sink is that — but it
   * is what makes a Mermaid release that started emitting `<script>` or a
   * `<foreignObject>` fail visibly instead of silently changing the sink's diet.
   *
   * A refusal is a `render` failure carrying the gate's precise reason as
   * `detail`. That reason used to BE the reader's sentence — so a refusal greeted
   * somebody with the words "The compiled diagram contains a <foreignObject>
   * element", which is developer wording in a transcript.
   *
   * HOW REACHABLE IS IT, exactly: not, today. Measured in real Chromium against the
   * shipped `securityLevel: 'strict'` config, both spellings of an in-diagram
   * `%%{init}%%` directive asking for HTML labels compile to SVG byte-identical to
   * the plain diagram, carrying no `<foreignObject>`. So this refusal is a
   * FAIL-CLOSED GUARD against a future Mermaid release changing that — not a fallback
   * path any reader walks, and it must not be described as one. The reachable
   * `mermaid` author failure is a parse error, whose wording is the worse of the two:
   * a multi-line jison dump quoting a slice of the author's own source.
   */
  const onCompiled = useCallback(
    (svg: string, theme: FyRenderSandboxTheme): void => {
      const admitted = fyRenderMermaidSvg(svg);
      if (!admitted.ok) {
        failSandbox({ detail: admitted.reason, kind: 'render' });
        return;
      }
      // THE SHELL'S OWN THEME, never `documentTheme()` read here. A reader who
      // switched during the compile would otherwise have the diagram recorded
      // against a theme it was never drawn for, and the staleness check below would
      // then agree with the document forever.
      setCompiled({ svg: admitted.svg, theme });
      setSandboxReady(true);
    },
    [failSandbox],
  );

  /** Lottie's half of the same fact: the shell drew its first frame. */
  const onRendered = useCallback((): void => setSandboxReady(true), []);

  /**
   * A THEME SWITCH MARKS A DIAGRAM STALE. It does not redraw it.
   *
   * The first repair dropped `compiled` when the theme changed, which put the block
   * back into its `framed` state and recompiled. That was right about the problem —
   * Mermaid bakes the painting direction into the SVG, and this app ships 22 themes,
   * so a dark diagram stranded on a light surface is unreadable — and wrong about the
   * remedy in two ways.
   *
   * It was UNBOUNDED IN N. The observer is per block, so a reader who had consented
   * to ten diagrams and then toggled the theme caused ten simultaneous frame
   * remounts, each fetching a multi-megabyte renderer and running a fresh compile.
   * This component's own doctrine is that a decoder mounts only on a gesture aimed at
   * rendering, and a theme toggle is not that gesture.
   *
   * It also RACED. Recording `documentTheme()` when the diagram arrived meant a
   * switch DURING the compile was recorded as the theme the diagram was drawn for, so
   * the check then agreed with the document and the mismatched diagram survived until
   * a manual Reload. The shell now echoes the theme it actually used, which closes
   * that from the other end.
   *
   * So staleness is DERIVED and the reader is told. The diagram stays on screen,
   * consent is untouched, no frame is created and nothing is fetched; the status
   * region says the theme changed and names Reload as the remedy — the one thing the
   * original defect never did. Switching back before reloading clears the note by
   * itself, because a derived comparison has nothing to undo.
   *
   * `session-terminal-deck.tsx` uses the same attribute-filtered observer idiom to
   * repaint xterm; the difference is that this one only records a fact.
   */
  const [liveTheme, setLiveTheme] = useState<FyRenderSandboxTheme>(documentTheme);
  useEffect(() => {
    // Only a compiled diagram can go stale, so no observer exists for the blocks that
    // hold none — which is every block in a transcript except the compiled ones.
    if (compiled === null || typeof MutationObserver === 'undefined') return;
    // Sync on attach: the document may have been repainted while this block held no
    // diagram, and the state above would still carry the theme read at mount.
    setLiveTheme(documentTheme());
    const observer = new MutationObserver(() => setLiveTheme(documentTheme()));
    observer.observe(document.documentElement, { attributeFilter: ['data-theme'], attributes: true });
    return () => observer.disconnect();
  }, [compiled]);

  /** True only while a diagram drawn for one mode is sitting on the other. */
  const themeStale = compiled !== null && compiled.theme !== liveTheme;

  const preview = block.source.slice(0, FY_RENDER_LIMITS.sourcePreviewCharacters);
  const truncated = block.source.length > preview.length;
  const sandboxed = presentation === 'sandbox';
  /** Types a reader can choose to render, and so the ones that get a gate. */
  const offerable = presentation === 'visual' || sandboxed;
  const rendered = presentation === 'visual' && approved && !failed;
  /** Mermaid has finished and the frame is gone; what remains is an image. */
  const diagram = sandboxed && block.type === 'mermaid' && compiled !== null && sandboxError === null;
  /** Lottie stays live, and Mermaid keeps its frame only until it yields one. */
  const framed = sandboxed && approved && sandboxError === null && !diagram;
  const payloadSize = humanBytes(fyRenderPayloadBytes(block));

  /**
   * FOCUS COMES BACK WHEN A CONTROL VANISHES UNDER THE READER, which Slice B is
   * the first state to make possible.
   *
   * Play/Pause is mounted only while `framed`, and `framed` becomes false the
   * instant a sandbox failure is set — which the Lottie watchdog does after 120 s
   * of wall-clock life, with no reader action at all. So somebody watching an
   * animation in fullscreen with focus on Pause has that control removed while the
   * overlay stays open. React does not relocate focus, so `document.activeElement`
   * becomes `<body>` — OUTSIDE an `aria-modal="true"` container — and both halves
   * of the trap stop working: the next Tab starts from the top of the document
   * behind the overlay, and `useDialogFocus`'s trap is an `onKeyDown` on the host,
   * which no longer sees the key. Escape survives only because that listener is on
   * `document`.
   *
   * In Slice A every control that could hold focus while fullscreen was open —
   * Source, Reload, Exit — was stable for the overlay's whole life, so this could
   * not happen. The host is made programmatically focusable ONLY in fullscreen:
   * `tabIndex={-1}` keeps it out of the tab order while giving it somewhere for
   * focus to land, exactly as this app's other dialog containers do.
   *
   * The guard is what stops it stealing focus from a control the reader is using:
   * it acts only when focus has already left the overlay.
   *
   * `framed` IS THE TRIGGER, not a value this body reads — the same shape
   * `runtime-controls.tsx` and `session-chat-page.tsx` use for a reset trigger.
   * Its transition to false is precisely the moment Play/Pause is unmounted, which
   * is the only event that can drop focus out of an open overlay. Removing it
   * because the body does not mention it would delete the repair while leaving
   * every line of it in place.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: framed is the control-removal trigger, see above
  useEffect(() => {
    const host = hostRef.current;
    if (!fullscreen || host === null || host.contains(document.activeElement)) return;
    host.focus();
  }, [fullscreen, framed]);

  /**
   * FOUR STATES FOR ONE SANDBOX-ONLY REGION, and `idle` is a real one.
   *
   * The region is mounted for every sandbox block from the start, holding nothing.
   * A live region that is INSERTED already carrying text is announced
   * inconsistently across assistive technologies; one that exists and then
   * changes is the reliable shape, and there is no gesture before consent for it
   * to describe anyway.
   */
  const sandboxPhase: 'idle' | 'preparing' | 'ready' | 'stale' | 'failed' =
    sandboxError !== null
      ? 'failed'
      : themeStale
        ? 'stale'
        : diagram || (framed && sandboxReady)
          ? 'ready'
          : framed
            ? 'preparing'
            : 'idle';

  /** Absent for `lifetime`, which is the whole point of `sandboxTone`. */
  const sandboxToneAttribute = sandboxError === null ? undefined : sandboxTone(sandboxError.kind);

  const sandboxStatus =
    sandboxError !== null
      ? sandboxFailureSentence(block.type, sandboxError.kind)
      : sandboxPhase === 'stale'
        ? // NAMES THE REMEDY, because the reader cannot be expected to know that
          // Reload is what redraws a diagram. The old behaviour redrew silently and
          // the behaviour before that left an unreadable diagram with nothing said.
          'The theme changed. Reload to redraw this diagram.'
        : sandboxPhase === 'ready'
          ? `The ${humanType[block.type]} illustration is ready.`
          : sandboxPhase === 'preparing'
            ? `Preparing the ${humanType[block.type]} renderer…`
            : '';

  /**
   * THE STREAMED DECODE FAILURE STAYS IN THE STAGE, AND STAYS SILENT.
   *
   * A `failed` payload is one that is very possibly still arriving — a
   * half-written SVG genuinely fails to decode — so announcing it would interrupt
   * a screen-reader user with an error that is not one yet. That rationale does
   * not reach the sandbox path, whose outcome can only ever follow a reader's
   * gesture, which is why the two are presented by different elements rather than
   * merged into one `failureNote`. A sandbox failure is stated once, in the region
   * below, and never here as well.
   */
  const stage = failed ? (
    <div className="kt-fs-note" data-fy-render-error="true" data-tone="err">
      This {humanType[block.type]} payload could not be decoded. The authored source is shown below.
    </div>
  ) : sandboxError !== null ? null : diagram ? (
    <img
      // Empty for the same reason as below: the `figcaption` is the description.
      alt=""
      className="kt-rich-file-image fy-render-image"
      data-fy-render-diagram="true"
      key={`diagram:${generation.current}:${revision}`}
      onError={onDecodeFailure(generation.current)}
      src={svgDataUrl(compiled?.svg as string)}
    />
  ) : framed ? (
    /**
     * A NEW `key` PER REVISION, because removing the element from the DOM is the
     * only reliable way to stop a frame's scripts — there is no
     * `iframe.terminate()`. Reload is therefore a remount, not a message.
     */
    <FyRenderSandbox
      block={block}
      key={`frame:${generation.current}:${revision}`}
      onCompiled={onCompiled}
      onFailed={failSandbox}
      onRendered={onRendered}
      playing={playing}
      theme={documentTheme()}
    />
  ) : rendered ? (
    <img
      // EMPTY ON PURPOSE. The required description is already the visible
      // `figcaption`, which also names the figure and the fullscreen dialog;
      // repeating it here makes a screen reader say the same sentence three
      // times, four in fullscreen. The caption does the work, and the decode
      // failure above covers the case a broken `alt` would otherwise serve.
      alt=""
      className="kt-rich-file-image fy-render-image"
      key={`${generation.current}:${revision}`}
      onError={onDecodeFailure(generation.current)}
      src={block.type === 'image' ? `data:${block.mime};base64,${block.payload}` : svgDataUrl(block.payload)}
    />
  ) : offerable ? (
    /**
     * NO TONE. This is the resting state of every illustration in every
     * transcript, and an offer is not a warning: `warn` belongs to the declared
     * limitation and `err` to a failure, so wearing `warn` here made all three
     * read as the same kind of event and made "nothing has happened yet" look
     * like something had gone wrong. One sentence, and the price is on the
     * button rather than said twice.
     */
    <div className="kt-fs-note" data-fy-render-consent="true">
      {/* THE RENDERER DOWNLOAD IS NAMED HERE rather than priced on the button.
          A sandbox type fetches a renderer the authored bytes say nothing about
          — a 20 KB diagram pulls a multi-megabyte Mermaid build — so a lone
          source figure on the control would understate the action by two orders
          of magnitude. It is also a once-per-deploy cost, since the bundle
          revalidates to a 304 for every later block, which is why this says
          "the first time" instead of quoting a number that would be wrong for
          every block after the first. */}
      {sandboxed
        ? `Rendering starts only when you choose. It may download the ${humanType[block.type]} renderer on first use — cached bytes are revalidated — and may use substantial browser resources.`
        : 'Rendering starts only when you choose and may use substantial browser resources.'}
    </div>
  ) : (
    <div className="kt-fs-note" data-tone="warn">
      This build does not run {humanType[block.type]} illustrations. The authored source is shown below.
    </div>
  );

  /**
   * ONE HOST ELEMENT IN BOTH STATES, and the reason is focus rather than tidiness.
   *
   * Making the dialog a separate element that only exists while open changes the
   * root of this subtree, so React unmounts the whole figure — including the
   * control the reader just pressed — before `useDialogFocus` captures the
   * element to restore focus to. It captures `document.body` instead, and the
   * reader lands outside the modal they opened.
   *
   * `role` and `aria-modal` travel as one object because they are one fact, and
   * `kt-overlay` is the app's own visible-viewport contract: it follows the shell
   * box rather than the layout viewport, so the overlay does not run under a
   * notch or behind a software keyboard.
   */
  const modal = fullscreen
    ? {
        'aria-label': `Illustration: ${block.alt}`,
        'aria-modal': true,
        onKeyDown: focus.onKeyDown,
        role: 'dialog',
      }
    : {};

  return (
    <div
      className={fullscreen ? 'kt-overlay fy-render-fullscreen' : undefined}
      ref={hostRef}
      /**
       * FOCUSABLE ONLY WHILE IT IS A DIALOG. `-1` keeps it out of the tab order
       * and gives focus somewhere inside the overlay to land when a control is
       * removed under the reader — see the effect above. `undefined` inline,
       * because a transcript row is not a focus stop.
       */
      tabIndex={fullscreen ? -1 : undefined}
      {...modal}
    >
      {/**
       * THE CARD IS THE WRAPPER; THE FIGURE IS THE CONTENT.
       *
       * The controls are chrome, not part of the illustration, so they sit
       * OUTSIDE the `<figure>` as its sibling. That buys both halves of what an
       * earlier arrangement could only trade between: `figcaption` is the
       * figure's last child (its content model allows only first or last), and
       * DOM order now equals visual order, so a screen reader and a sighted
       * reader meet stage, source, caption and controls in the same sequence.
       * The `order` rules that used to reconcile the two are gone.
       */}
      <div
        className="kt-rich-file fy-render"
        data-fy-render-fullscreen={fullscreen ? 'true' : 'false'}
        data-fy-render-presentation={presentation}
        data-fy-render-type={block.type}
      >
        <figure className="fy-render-figure">
          {/* A stage holding a paragraph must not be squeezed by a long source
              panel beside it: in two states the paragraph IS the block's whole
              explanation, so it is the last thing that may shrink. */}
          {/* THREE STAGE KINDS, because there are three things a stage can hold
              and only two of them are illustrations. `note` is the plane for a
              sentence — an offer, a limitation, a failure — and the stylesheet
              strips the illustration border from it and gives it `flex: 0` in
              fullscreen so the text does not sit in the middle of an empty
              viewport. A live frame and a compiled diagram are pictures and want
              the same plane a decoded `<img>` gets; reading `note` for them
              removed the border and collapsed them in fullscreen. */}
          <div
            className="fy-render-stage"
            data-fy-render-stage={rendered || diagram ? 'image' : framed ? 'sandbox' : 'note'}
          >
            {stage}
          </div>
          {/* THE SANDBOX'S OWN STATUS, VISIBLE AND SPOKEN, AND NOWHERE ELSE.
              WCAG 4.1.3 (Status Messages) covers exactly this: an outcome that
              follows a reader's gesture and changes nothing about focus. It is
              mounted for every sandbox block and empty until there is something
              to say, because an inserted live region is announced
              inconsistently while one that changes is not.

              IT IS THE ONLY PLACE a sandbox sentence appears — the stage renders
              nothing for `sandboxError`, so the failure is stated once. The
              streamed decode failure keeps its own silent note in the stage, and
              the test that pins that silence uses an `svg` block, which never
              mounts this element at all.

              `role="status"` sits on an inner span so that `aria-atomic` covers
              the sentence and NOT the fold beside it: a `<details>` inside the
              atomic region would put "Why" on the end of every announcement. */}
          {sandboxed ? (
            <div
              className={sandboxPhase === 'failed' ? 'kt-fs-note fy-render-status' : 'fy-render-status'}
              data-fy-render-sandbox-status={sandboxPhase}
              {...(sandboxPhase === 'failed' ? { 'data-fy-render-error': 'true' } : {})}
              {...(sandboxToneAttribute === undefined ? {} : { 'data-tone': sandboxToneAttribute })}
            >
              <span aria-atomic="true" aria-live="polite" role="status">
                {sandboxStatus}
              </span>
              {/* THE MACHINE'S EXACT WORDING, FOLDED. `files-views.tsx` already
                  pairs a plain reader sentence with the precise reason under
                  `kt-fs-why`, and `files.css` gives that summary a 44px hit
                  area. React escapes the text, and `white-space: pre-wrap` in
                  the body rule keeps a multi-line jison dump legible instead of
                  collapsing an author's source and its caret rule into one line.
                  A `lifetime` stop has no detail to fold, by construction. */}
              {sandboxError !== null && sandboxError.detail !== null ? (
                <details className="kt-fs-why">
                  <summary>Why</summary>
                  <p className="kt-fs-why-body fy-render-why-body">{sandboxError.detail}</p>
                </details>
              ) : null}
            </div>
          ) : null}
          {showSource ? (
            /**
             * A KEYBOARD-REACHABLE SCROLLPORT, and it needs saying explicitly.
             *
             * This panel is `overflow-x: auto` and an authored payload is routinely
             * one enormous line — a Lottie source measured 5194px wide inside a
             * 336px box. Chromium 127+ focuses such a scroller natively, so a
             * pointer reader could always pan it; a keyboard reader could not,
             * because `useDialogFocus`'s selector matches no attribute this element
             * carried, and inline there was no way to give it the keyboard at all.
             * `tabIndex={0}` fixes both at once: it enters the app's shared
             * focusable list AND becomes a tab stop outside fullscreen.
             *
             * A NAMED `<section>` is what stops that stop being a mystery. A focusable
             * box with no accessible name announces as nothing; a named `<section>`
             * carries the region role implicitly, so it says what it holds without an
             * explicit `role`. `aria-label` rather than a visible heading, because the
             * control that opened it is already labelled Source.
             */
            <section
              aria-label={`Authored ${humanType[block.type]} source`}
              className="kt-fs-code scroll-thin"
              data-fy-render-source="true"
              id={sourcePanelId}
              // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollport must be a tab stop, see above
              tabIndex={0}
            >
              <pre className="kt-fs-pre">
                <code>{preview}</code>
              </pre>
              {truncated ? (
                <div className="kt-fs-note">
                  Source preview truncated at {FY_RENDER_LIMITS.sourcePreviewCharacters} characters.
                </div>
              ) : null}
            </section>
          ) : null}
          <figcaption className="fy-render-caption">{block.alt}</figcaption>
        </figure>
        <div className="kt-rich-file-actions fy-render-actions">
          {/* A STABLE LABEL with `aria-expanded`, rather than a label that also
              changes: a toggle that says its state twice invites the reader to
              wonder which channel is authoritative.

              `aria-controls` is present ONLY while the panel is. The panel is
              unmounted when closed, so an unconditional reference points at an
              id that is not in the document — the default state of every visual
              block, and exactly what `aria-valid-attr-value` flags. */}
          <Button
            aria-controls={showSource ? sourcePanelId : undefined}
            aria-expanded={showSource}
            onClick={() => setSourcePanel(panel => (panel === 'closed' ? 'opened' : 'closed'))}
            size="sm"
            type="button"
          >
            <Code2 aria-hidden="true" size={14} /> Source
          </Button>
          {/* ONE SLOT, TWO JOBS. Render becomes Reload in place, so the control
              the reader just pressed is still under the focus ring afterwards.

              The VISIBLE text stays short — a priced label could not share a row
              at 390px and pushed every unrendered block to three stacked rows —
              while the price moves into the accessible name. WCAG 2.5.3 holds
              because the visible string is contained in the accessible one. */}
          {/* PAUSE IS SHOWN ONLY WHERE THERE IS SOMETHING TO PAUSE, which is
              Lottie and nothing else. A Mermaid diagram is static, so it gets no
              control rather than a disabled one — the same rule Reload and
              Fullscreen already follow. Reduced motion decides the STARTING
              state above; it never removes the control. */}
          {sandboxed && block.type === 'lottie' && framed ? (
            <Button
              aria-label={playing ? 'Pause animation' : 'Play animation'}
              data-fy-render-playing={playing ? 'true' : 'false'}
              onClick={() => {
                // From here on the reader has decided, so a Reload must not
                // quietly put the preference's answer back.
                setChosen(true);
                setPlaying(value => !value);
              }}
              size="sm"
              type="button"
            >
              {playing ? <Pause aria-hidden="true" size={14} /> : <Play aria-hidden="true" size={14} />}
              {playing ? 'Pause' : 'Play'}
            </Button>
          ) : null}
          {offerable ? (
            approved ? (
              <Button onClick={reload} size="sm" type="button">
                <RotateCcw aria-hidden="true" size={14} /> Reload
              </Button>
            ) : (
              <Button
                /**
                 * NO BYTE FIGURE FOR A SANDBOX TYPE, because the honest number
                 * is not the one we have. `payloadSize` is the authored source,
                 * which for `svg` and `image` IS the whole cost — but pressing
                 * Render on a 20 KB Mermaid block also fetches a 3.4 MiB
                 * renderer. Quoting "Mermaid, 20 KB" would understate that by
                 * two orders of magnitude, and quoting the renderer instead
                 * would overstate every block after the first, since the bundle
                 * revalidates to a 304. A figure that means one thing for two
                 * types and something else for the other two is worse than no
                 * figure, so these say what they are and not what they weigh.
                 */
                aria-label={
                  sandboxed
                    ? `Render illustration (${humanType[block.type]})`
                    : `Render illustration (${humanType[block.type]}, ${payloadSize})`
                }
                data-fy-render-consent-action="true"
                onClick={() => {
                  setApproved(true);
                  // THE PREFERENCE IS READ HERE, at the gesture. A transcript row
                  // mounts when the message arrives and may sit unread for an
                  // hour; what matters is the setting in force when somebody
                  // actually asks for the animation.
                  if (!chosen) setPlaying(!prefersReducedMotion());
                }}
                size="sm"
                type="button"
              >
                <ImageIcon aria-hidden="true" size={14} /> Render illustration
              </Button>
            )
          ) : null}
          {/* HIDDEN UNTIL THERE IS SOMETHING TO ENLARGE. Before consent a visual
              block has no picture, no source and no failure, so fullscreen gave
              a full-viewport overlay holding one line of text and 839px of empty
              background. The same rule Reload already follows: a control that
              cannot act is hidden, not shown. The changing label carries the
              state, so there is no `aria-pressed` to disagree with it. */}
          {presentation === 'source' || approved || failed || sandboxError !== null ? (
            <Button onClick={() => setFullscreen(value => !value)} size="sm" type="button">
              {fullscreen ? <Minimize2 aria-hidden="true" size={14} /> : <Maximize2 aria-hidden="true" size={14} />}
              {fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
