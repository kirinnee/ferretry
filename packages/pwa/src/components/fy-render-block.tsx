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
 * `html`, `mermaid` and `lottie` render as their own source with the limitation
 * stated on screen. That is this build's declared gap, not a loading state.
 */

import { Code2, ImageIcon, Maximize2, Minimize2, RotateCcw } from 'lucide-react';
import { useCallback, useId, useRef, useState } from 'react';
import { useDialogFocus } from '../hooks/use-dialog-focus.ts';
import {
  type FyRenderBlock as ParsedBlock,
  FY_RENDER_LIMITS,
  fyRenderPayloadBytes,
  fyRenderPresentation,
} from '../lib/fy-render.ts';
import { Button } from '../shell/primitives.tsx';

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
    if (presentation === 'visual') setFullscreen(false);
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
    // The panel a FAILURE opened is scaffolding for that failure, so it goes
    // when the failure does — by any route out of it, not only by new bytes.
    // Clearing `failed` while leaving it open left an unsolicited wall of markup
    // under a retried image, which is the very thing the ownership rule exists
    // to prevent. A panel the reader opened is theirs and stays.
    setSourcePanel(panel => (panel === 'failure' ? 'closed' : panel));
    setRevision(value => value + 1);
  };

  const onDecodeFailure = (from: number) => (): void => {
    // A failure from bytes that are no longer on screen is not this image's.
    if (from !== generation.current) return;
    setFailed(true);
    setSourcePanel(panel => (panel === 'closed' ? 'failure' : panel));
  };

  const preview = block.source.slice(0, FY_RENDER_LIMITS.sourcePreviewCharacters);
  const truncated = block.source.length > preview.length;
  const rendered = presentation === 'visual' && approved && !failed;
  const payloadSize = humanBytes(fyRenderPayloadBytes(block));

  const stage = failed ? (
    <div className="kt-fs-note" data-fy-render-error="true" data-tone="err">
      This {humanType[block.type]} payload could not be decoded. The authored source is shown below.
    </div>
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
  ) : presentation === 'visual' ? (
    /**
     * NO TONE. This is the resting state of every illustration in every
     * transcript, and an offer is not a warning: `warn` belongs to the declared
     * limitation and `err` to a failure, so wearing `warn` here made all three
     * read as the same kind of event and made "nothing has happened yet" look
     * like something had gone wrong. One sentence, and the price is on the
     * button rather than said twice.
     */
    <div className="kt-fs-note" data-fy-render-consent="true">
      Rendering starts only when you choose and may use substantial browser resources.
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
    <div className={fullscreen ? 'kt-overlay fy-render-fullscreen' : undefined} ref={hostRef} {...modal}>
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
          <div className="fy-render-stage" data-fy-render-stage={rendered ? 'image' : 'note'}>
            {stage}
          </div>
          {showSource ? (
            <div className="kt-fs-code scroll-thin" data-fy-render-source="true" id={sourcePanelId}>
              <pre className="kt-fs-pre">
                <code>{preview}</code>
              </pre>
              {truncated ? (
                <div className="kt-fs-note">
                  Source preview truncated at {FY_RENDER_LIMITS.sourcePreviewCharacters} characters.
                </div>
              ) : null}
            </div>
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
          {presentation === 'visual' ? (
            approved ? (
              <Button onClick={reload} size="sm" type="button">
                <RotateCcw aria-hidden="true" size={14} /> Reload
              </Button>
            ) : (
              <Button
                aria-label={`Render illustration (${humanType[block.type]}, ${payloadSize})`}
                data-fy-render-consent-action="true"
                onClick={() => setApproved(true)}
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
          {presentation === 'source' || approved || failed ? (
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
