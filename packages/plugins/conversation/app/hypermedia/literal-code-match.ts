import type { InlineDef } from 'durian-markdown';

/**
 * THE PARSER HALF OF LITERAL INLINE CODE (the renderer half, and the reason, are `literal-code.tsx`). No React in this file:
 * it runs inside the Durian worker (`durian-worker.ts`) as well as in a unit test.
 *
 * Durian lets a host claim a token before Markdown does (`inlines`, one `ref` node per match): we claim exactly the code
 * spans that contain one of the six character references Durian decodes, and draw their raw text ourselves. A span longer
 * than {@link SPAN_LIMIT} characters is left to Durian (decoded), which bounds the scan.
 */

export const LITERAL_CODE_INLINE = 'fy-code';

const SPAN_LIMIT = 400;
const REFERENCE = '&(?:amp|lt|gt|quot|#39|#x27);';

/**
 * A CommonMark code span (a run of N backticks, content, the next run of exactly N) that holds a decoded reference.
 * A content unit is one non-backtick or one WHOLE backtick run of another length (a lookahead capture and its backreference take a run atomically,
 * so a longer run is never split to fake a closer).
 */
export const CODE_SPAN = new RegExp(
  '(?<!`)(`+)(?!`)' +
    `(?:[^\`]|(?!\\1(?!\`))(?=(\`+))\\2){0,${SPAN_LIMIT}}?` +
    REFERENCE +
    `(?:[^\`]|(?!\\1(?!\`))(?=(\`+))\\3){0,${SPAN_LIMIT}}?` +
    '\\1(?!`)',
  'u',
);

/** Whether the message could hold such a span at all: the cheap test that decides if the token is offered to the parser. */
export const mayHoldLiteralCode = (text: string): boolean => new RegExp(REFERENCE, 'u').test(text);

/** The token for the parser (`parse`'s `inlines`, a stable array: Durian caches its lexer by identity). */
export const LITERAL_CODE_PARSE_INLINES: readonly InlineDef[] = [{ name: LITERAL_CODE_INLINE, match: CODE_SPAN }];
