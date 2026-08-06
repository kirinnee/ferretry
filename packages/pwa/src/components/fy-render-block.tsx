/**
 * The inert renderer for a parsed `fy-render` fence.
 *
 * NOTHING IN THIS COMPONENT EXECUTES AUTHOR-SUPPLIED CODE, and the way it
 * avoids doing so is structural rather than a policy it follows. There is no
 * `iframe`, no `srcdoc`, no `dangerouslySetInnerHTML`, no `eval`, no `Function`,
 * and no script element anywhere below. Every payload that is not a vector or a
 * raster reaches a `<pre>` as escaped text through React's own escaping.
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
 * IT ALSO HOLDS NO CREDENTIAL. Its props are a parsed block and nothing else:
 * no `DaemonConnection`, no session id, no daemon URL, no fetcher. The type
 * proves that no such field is present today (soundness); it cannot prove a
 * careless future prop addition impossible (completeness), which is why this
 * paragraph is here and why a reviewer should read the props before the body —
 * the same stance `rich-file-preview.tsx` takes for file previews.
 *
 * `html`, `mermaid` and `lottie` render as their own source with the limitation
 * stated on screen. That is this build's declared gap, not a loading state:
 * `docs/fy-render.md` records the evidence for why executable rendering is
 * absent, and the note the reader sees says so in the same words.
 */

import { Code2, Maximize2, Minimize2, RotateCcw } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { useDialogFocus } from '../hooks/use-dialog-focus.ts';
import { type FyRenderBlock as ParsedBlock, FY_RENDER_LIMITS, fyRenderPresentation } from '../lib/fy-render.ts';
import { Button } from '../shell/primitives.tsx';

export interface FyRenderBlockProps {
  /** The only input. See the credential note above before adding a second. */
  readonly block: ParsedBlock;
}

/**
 * A percent-encoded `data:` URL rather than base64: it is correct for any
 * Unicode payload without a manual byte-to-binary-string dance, and `<img>`
 * treats the two identically.
 */
const svgDataUrl = (payload: string): string => `data:image/svg+xml,${encodeURIComponent(payload)}`;

const humanType: Record<ParsedBlock['type'], string> = {
  html: 'HTML',
  svg: 'SVG',
  image: 'image',
  mermaid: 'Mermaid',
  lottie: 'Lottie',
};

export function FyRenderBlock({ block }: FyRenderBlockProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const presentation = fyRenderPresentation(block.type);
  /**
   * WHY the source panel is open, not merely whether — because the two reasons
   * have different lifetimes. A panel the READER opened is theirs to close. A
   * panel a decode FAILURE opened is scaffolding for that failure, and has to go
   * when the failure does, or a streamed illustration finishes correct with an
   * unsolicited wall of markup underneath it.
   *
   * A source-only type starts `opened` because its source is the only content it
   * has; it can never reach `failure`, because it never reaches an `<img>`.
   */
  const [sourcePanel, setSourcePanel] = useState<'closed' | 'opened' | 'failure'>(
    presentation === 'source' ? 'opened' : 'closed',
  );
  const showSource = sourcePanel !== 'closed';
  const [fullscreen, setFullscreen] = useState(false);
  const [failed, setFailed] = useState(false);
  // Remounting the `<img>` is what "reload" means for a static payload: the
  // element is discarded and the data URL decoded again.
  const [revision, setRevision] = useState(0);

  /**
   * A NEW PAYLOAD CLEARS AN OLD FAILURE, and this is a streaming bug, not a tidy-up.
   *
   * A transcript row re-renders as the assistant emits it, so this component
   * sees a half-written SVG before it sees the whole one. The grammar admits a
   * payload by prefix, so the half-written document reaches the `<img>`, fails
   * to decode, and sets `failed`. Without this, the completed SVG arriving a
   * moment later would render into a component still showing the error, and the
   * reader would have to press Reload to see something that was never broken.
   *
   * Adjusted during render rather than in an effect — React re-runs this
   * component before touching the DOM, so no failed frame is painted. It is
   * deliberately narrow: `showSource` and `fullscreen` belong to the READER, and
   * a block that grows by one token must not close a panel they opened or throw
   * them out of fullscreen. Only what the OLD bytes caused is discarded.
   */
  const [renderedSource, setRenderedSource] = useState(block.source);
  if (renderedSource !== block.source) {
    setRenderedSource(block.source);
    setFailed(false);
    // Only the panel the FAILURE opened. A reader who opened it themselves keeps
    // it, and a source-only type keeps its own.
    setSourcePanel(panel => (panel === 'failure' ? 'closed' : panel));
  }

  const collapse = useCallback(() => setFullscreen(false), []);
  const focus = useDialogFocus(fullscreen, hostRef, collapse, { autoFocus: false });

  const reload = (): void => {
    setFailed(false);
    setRevision(value => value + 1);
  };

  const onDecodeFailure = (): void => {
    setFailed(true);
    // The source is the fallback, so it is opened rather than merely offered —
    // but a panel the reader already opened stays THEIRS, so its provenance is
    // not overwritten. Otherwise recovering from the failure would close it.
    setSourcePanel(panel => (panel === 'closed' ? 'failure' : panel));
  };

  const preview = block.source.slice(0, FY_RENDER_LIMITS.sourcePreviewCharacters);
  const truncated = block.source.length > preview.length;

  /**
   * NO LIVE REGION ON THE FAILURE, and this is a decision rather than an omission.
   *
   * `role="alert"` was the obvious choice and is the wrong one. A transcript row
   * re-renders as the assistant streams it, and a half-written SVG genuinely
   * fails to decode, so an assertive live region would interrupt a screen-reader
   * user — repeatedly — to announce an error that is not one yet and that this
   * component cannot distinguish from a real one, because nothing tells it the
   * message has stopped growing. `role="status"` only makes the same false
   * announcement politely.
   *
   * So the failure is ordinary visible text, read when the reader reaches the
   * block, exactly like the "this build does not run X" note beside it. Nothing
   * here is time-critical or happening away from where they are reading. The
   * cost is honest and small: a reader already inside the block is not
   * interrupted when a decode fails. The alternative was interrupting everyone,
   * wrongly, several times per streamed message.
   */
  const stage = failed ? (
    <div className="kt-fs-note" data-fy-render-error="true" data-tone="err">
      This {humanType[block.type]} payload could not be decoded. The authored source is shown below.
    </div>
  ) : presentation === 'visual' ? (
    <img
      alt={block.alt}
      className="kt-rich-file-image fy-render-image"
      key={revision}
      onError={onDecodeFailure}
      src={block.type === 'image' ? `data:${block.mime};base64,${block.payload}` : svgDataUrl(block.payload)}
    />
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
   * Fullscreen button the reader just pressed — before `useDialogFocus` captures
   * the element to restore focus to. It captures `document.body` instead, and
   * with nothing auto-focused the reader lands outside the modal they opened. A
   * stable host keeps the trigger mounted, so focus never leaves the dialog and
   * the hook's restore is the same button the reader pressed.
   *
   * `role` and `aria-modal` travel as one object because they are one fact: an
   * `aria-modal` without the role it belongs to is a claim no assistive
   * technology owes anything.
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
    <div className={fullscreen ? 'fy-render-fullscreen' : undefined} ref={hostRef} {...modal}>
      <figure
        className="kt-rich-file fy-render"
        data-fy-render-fullscreen={fullscreen ? 'true' : 'false'}
        // The stage reserves an illustration's worth of height only when there is
        // an illustration. Handing CSS the presentation directly beats three type
        // selectors that would then have to be kept in step with the switch.
        data-fy-render-presentation={presentation}
        data-fy-render-type={block.type}
      >
        <div className="fy-render-stage">{stage}</div>
        {showSource ? (
          <div className="kt-fs-code scroll-thin" data-fy-render-source="true">
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
        <div className="kt-rich-file-actions fy-render-actions">
          {/* Opening it from here makes it the READER's panel, whatever opened
              it before — so recovering from a decode failure cannot take it away. */}
          <Button
            aria-expanded={showSource}
            onClick={() => setSourcePanel(panel => (panel === 'closed' ? 'opened' : 'closed'))}
            size="sm"
            type="button"
          >
            <Code2 aria-hidden="true" size={14} /> {showSource ? 'Hide source' : 'Source'}
          </Button>
          {presentation === 'visual' ? (
            <Button onClick={reload} size="sm" type="button">
              <RotateCcw aria-hidden="true" size={14} /> Reload
            </Button>
          ) : null}
          {/* Labelled for what the reader gets, not for how it is implemented:
            this fills the viewport, so it is "Fullscreen". The mechanism is the
            in-app overlay explained in `fy-render.css` — the Fullscreen API is
            not available on a first-class target for this app. */}
          <Button aria-pressed={fullscreen} onClick={() => setFullscreen(value => !value)} size="sm" type="button">
            {fullscreen ? <Minimize2 aria-hidden="true" size={14} /> : <Maximize2 aria-hidden="true" size={14} />}
            {fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          </Button>
        </div>
      </figure>
    </div>
  );
}
