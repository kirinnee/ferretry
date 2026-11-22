import type { InlineDef } from 'durian-hypermedia/react/strict';
import type { ReactElement } from 'react';
import { HypermediaInlineCode } from './slots.tsx';

/**
 * INLINE CODE SHOWS THE BYTES THE AUTHOR TYPED (reference-standard §7). Durian decodes the six character references
 * (`&amp; &lt; &gt; &quot; &#39; &#x27;`) of a code span before any host code sees it, so `&lt;demo&gt;` and `<demo>`
 * arrive as the same `<demo>` and nothing downstream can tell which was typed. Only the source can. Durian lets a host
 * claim a token before Markdown does (`inlines`, one `ref` node per match), so we claim exactly the code spans that
 * contain one of those references and draw their raw text ourselves: every other span keeps Durian's own path and its
 * slot. A span longer than {@link SPAN_LIMIT} characters is left to Durian (decoded), which bounds the scan.
 *
 * Upstream ask: Durian should hand the slot the literal code (C1-upstream-ask, item 11). This goes when it does.
 */

const LITERAL_CODE_INLINE = 'fy-code';

const SPAN_LIMIT = 400;
const REFERENCE = '&(?:amp|lt|gt|quot|#39|#x27);';

/**
 * A CommonMark code span (a run of N backticks, content, the next run of exactly N) that holds a decoded reference.
 * A content unit is one non-backtick or one WHOLE backtick run of another length (a lookahead capture and its backreference take a run atomically,
 * so a longer run is never split to fake a closer).
 */
const CODE_SPAN = new RegExp(
  '(?<!`)(`+)(?!`)' +
    `(?:[^\`]|(?!\\1(?!\`))(?=(\`+))\\2){0,${SPAN_LIMIT}}?` +
    REFERENCE +
    `(?:[^\`]|(?!\\1(?!\`))(?=(\`+))\\3){0,${SPAN_LIMIT}}?` +
    '\\1(?!`)',
  'u',
);

/** Whether the message could hold such a span at all: the cheap test that decides if the token is offered to the parser. */
export const mayHoldLiteralCode = (text: string): boolean => new RegExp(REFERENCE, 'u').test(text);

/** The text of a code span as CommonMark reads it from its raw source: no ticks, line ends as spaces, one padding space off. */
function literalCodeOf(raw: string): string {
  const ticks = /^`+/u.exec(raw)?.[0].length ?? 0;
  const body = raw.slice(ticks, raw.length - ticks).replace(/\n/gu, ' ');
  return /[^ ]/u.test(body) && body.startsWith(' ') && body.endsWith(' ') ? body.slice(1, -1) : body;
}

function LiteralCode({ text }: { readonly text: string; readonly data: unknown }): ReactElement {
  return <HypermediaInlineCode text={literalCodeOf(text)} />;
}

/** The token for the parser (`parse`'s `inlines`, a stable array: Durian caches its lexer by identity) and the renderer. */
export const LITERAL_CODE_INLINES: readonly InlineDef[] = [
  { name: LITERAL_CODE_INLINE, match: CODE_SPAN, Component: LiteralCode },
];
