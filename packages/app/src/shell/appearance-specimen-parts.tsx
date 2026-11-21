/**
 * THE SPECIMEN'S SECOND HALF (r11 T13): the parts of a look that are not a control: how markdown is set, what a hypermedia
 * diagram looks like, the style's own busy mark, the page's background and grain, and a disabled field. Each draws with the
 * real shared classes and tokens (`.md`, `--hm-*`, `.fy-spinner`, `--bg-pattern`, `.kt-input`), so a style kit that changes
 * any of them changes the specimen with no edit here.
 *
 * The diagram is a STATIC mini one: three nodes, two edges and a header, drawn from the `--hm-*` slots a style fills
 * (`styles/tokens/base-style.css`). It is not the conversation's renderer (that is r12 H5's); it shows what the slots say.
 */
import { Spinner } from '../ui/spinner.tsx';

/** A small markdown document: a heading, a paragraph with strong text, a link and inline code, a quote, a list and a code block. */
export function MarkdownSample() {
  return (
    <div className="md fy-spec__md" data-spec-md="">
      <h2>Ferret notes</h2>
      <p>
        A <strong>strong</strong> word, an{' '}
        {/* biome-ignore lint/a11y/useValidAnchor: a specimen link that shows how the style sets `.md a`; it never navigates */}
        <a href="#specimen" tabIndex={-1} onClick={event => event.preventDefault()}>
          inline link
        </a>{' '}
        and <code>fy run</code>.
      </p>
      <blockquote>One line, quoted.</blockquote>
      <ul>
        <li>First point</li>
        <li>Second point</li>
      </ul>
      <pre>
        <code>{'fy status\n--subtree'}</code>
      </pre>
    </div>
  );
}

/** Three nodes joined by edges, drawn from the `--hm-*` slots. Which edge shows is the style's `--hm-edge`. */
export function HypermediaSample() {
  return (
    <figure className="fy-spec__hm" data-hm="" aria-label="A small diagram">
      <figcaption className="fy-spec__hm-header">Request flow</figcaption>
      <div className="fy-spec__hm-body">
        <span className="fy-spec__hm-node" data-hm-node="">
          Ask
        </span>
        <svg className="fy-spec__hm-edges" viewBox="0 0 120 48" preserveAspectRatio="none" aria-hidden="true">
          <path data-hm-edge="curve" d="M0 24 C40 24 40 12 120 12" />
          <path data-hm-edge="curve" d="M0 24 C40 24 40 36 120 36" />
          <path data-hm-edge="orthogonal" d="M0 24 H48 M48 12 V36 M48 12 H120 M48 36 H120" />
          <path data-hm-edge="straight" d="M0 24 L120 12 M0 24 L120 36" />
        </svg>
        <span className="fy-spec__hm-nodes">
          <span className="fy-spec__hm-node" data-hm-node="">
            Plan
          </span>
          <span className="fy-spec__hm-node" data-hm-node="">
            Build
          </span>
        </span>
      </div>
    </figure>
  );
}

/** The style's busy mark, moving (the page's own motion rules decide when it holds still). */
export function SpinnerSample() {
  return (
    <div className="fy-spec__row" data-spec-spinner="">
      <Spinner size={28} />
      <span className="fy-spec__spinner-word">Working…</span>
    </div>
  );
}

/** The page's background as a swatch: the style's pattern and its grain over the palette's own colour. */
export function BackdropSample() {
  return (
    <div className="fy-spec__backdrop" data-spec-backdrop="">
      <span className="fy-spec__backdrop-chip">Surface</span>
    </div>
  );
}

/** A disabled field: it must LOOK disabled (faded, not-allowed), not only be, so it sits beside the enabled one in the Input section. */
export function DisabledFieldSample() {
  return <input className="kt-input" value="Disabled field" disabled readOnly aria-label="Specimen disabled field" />;
}
