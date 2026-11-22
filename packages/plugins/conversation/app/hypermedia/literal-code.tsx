import type { InlineDef } from 'durian-hypermedia/react/strict';
import type { ReactElement } from 'react';
import { CODE_SPAN, LITERAL_CODE_INLINE } from './literal-code-match.ts';
import { HypermediaInlineCode } from './slots.tsx';

/**
 * INLINE CODE SHOWS THE BYTES THE AUTHOR TYPED (reference-standard §7). Durian decodes the six character references
 * (`&amp; &lt; &gt; &quot; &#39; &#x27;`) of a code span before any host code sees it, so `&lt;demo&gt;` and `<demo>`
 * arrive as the same `<demo>` and nothing downstream can tell which was typed. Only the source can. Durian lets a host
 * claim a token before Markdown does (`inlines`, one `ref` node per match), so we claim exactly the code spans that
 * contain one of those references and draw their raw text ourselves: every other span keeps Durian's own path and its
 * slot. The pattern is the parser half's (`literal-code-match.ts`, which runs in the Durian worker); this file draws it.
 *
 * Upstream ask: Durian should hand the slot the literal code (C1-upstream-ask, item 11). This goes when it does.
 */

/** The text of a code span as CommonMark reads it from its raw source: no ticks, line ends as spaces, one padding space off. */
function literalCodeOf(raw: string): string {
  const ticks = /^`+/u.exec(raw)?.[0].length ?? 0;
  const body = raw.slice(ticks, raw.length - ticks).replace(/\n/gu, ' ');
  return /[^ ]/u.test(body) && body.startsWith(' ') && body.endsWith(' ') ? body.slice(1, -1) : body;
}

function LiteralCode({ text }: { readonly text: string; readonly data: unknown }): ReactElement {
  return <HypermediaInlineCode text={literalCodeOf(text)} />;
}

/** The token for the renderer (a stable array: Durian keys its settings on its identity). */
export const LITERAL_CODE_INLINES: readonly InlineDef[] = [
  { name: LITERAL_CODE_INLINE, match: CODE_SPAN, Component: LiteralCode },
];
