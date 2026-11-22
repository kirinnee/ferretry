/**
 * A MESSAGE SHOWN AS THE PLAIN TEXT IT IS (r12 H11a): the one fallback for a message that is not handed to the parser, and
 * the one the off-thread parser (r12 H11) reuses when its worker does not answer. The text is an ordinary text child of a
 * `<pre>`, never HTML and never read as Markdown. With `noted`, a small line above it says so, so the reader knows why the
 * message is not dressed. A message over the size cap (`limits.ts`) is shown the same way without the line, as before.
 */

/** What the note says. One string, so the worker and the belt say the same thing. */
export const PLAIN_TEXT_NOTE = 'shown as plain text';

export function PlainFallback({ text, noted }: { readonly text: string; readonly noted: boolean }) {
  return (
    <>
      {noted ? (
        <p className="fy-hm-plain-note" data-fy-plain-note="" style={{ fontSize: '0.75rem', opacity: 0.7, margin: 0 }}>
          {PLAIN_TEXT_NOTE}
        </p>
      ) : null}
      <pre className="fy-hm-plain" style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
        {text}
      </pre>
    </>
  );
}
