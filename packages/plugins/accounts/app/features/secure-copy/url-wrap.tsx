/**
 * Text that may hold a URL, laid out so a long one wraps at its separators.
 *
 * A bare `overflow-wrap` breaks a URL wherever the line runs out ("…example.te / st"). A `<wbr>` after each of
 * `/ ? & .` offers the browser a break at a place a reader expects, and it leaves the text itself unchanged
 * (copying the line still copies one URL, with no stray space).
 */

import { Fragment } from 'react';

/** After one of these a break is welcome; the separator stays on the line it ends. */
const URL_BREAKS = /(?<=[/?&.])/;

/** The text, with a `<wbr>` after each URL separator. */
export function WrapAtUrlSeparators({ text }: { readonly text: string }) {
  const parts = text.split(URL_BREAKS);
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={`${String(index)} ${part}`}>
          {index > 0 && <wbr />}
          {part}
        </Fragment>
      ))}
    </>
  );
}
