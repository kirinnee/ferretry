/**
 * THE SIZE A MESSAGE MAY BE AND STILL BE PARSED AS HYPERMEDIA. Durian's own cap is 1 MB; `marked` is regex-driven and the
 * transcript tail the daemon hands the app is 512 KiB, so a message over 300,000 bytes is a log pasted whole, not prose
 * an agent wrote. It is shown as the text it is ({@link exceedsMessageCap}), never as Durian's "the page is too big"
 * error, which would hide the message.
 */
const MAX_MESSAGE_BYTES = 300_000;

/** The cap the AUTHOR's message is held to: what the CLI's `fy render check` and {@link exceedsMessageCap} count. */
export const MESSAGE_LIMITS = { maxInputBytes: MAX_MESSAGE_BYTES } as const;

/**
 * THE FIXED BUDGET OF THE PARSER, which is not the author's cap. The text Durian is given is not the message byte for
 * byte: line endings are normalised, a NUL becomes U+FFFD (1 byte to 3), and a held fence's opener gains a word. Durian
 * counts what it is given, so a cap equal to the message cap would answer a message just under it with Durian's own "the
 * page is too big" error. The parser's budget is Durian's default, a fixed number far above any reading of a message
 * under the cap (the worst growth, every byte a NUL, is three times 300,000); a text that still passes it is shown as
 * the text it is ({@link exceedsParserBudget}), never as that error.
 */
export const PARSER_LIMITS = { maxInputBytes: 1_000_000 } as const;

const encoder = new TextEncoder();

/**
 * THE PRE-PARSE LIMITS (r12 H11a): what a message may hold, per line and per paragraph, and still be handed to the parser.
 * A message over any of them is shown as plain text ({@link exceedsPreParseLimits}); this is a belt until the parser runs
 * off the main thread (r12 H11), where the same fallback is the answer to a worker that does not come back.
 *
 *  - `linkOpeners` and `emphasisRuns`: PER PARAGRAPH. Fifty is far above what prose, a table or a list holds in one
 *    block (a long paragraph has a handful of links and a few dozen emphasised words) and far below the counts at which
 *    inline reading is no longer cheap. They are the same number on purpose: one thing to remember.
 *  - `longLine` with `spaceRun`: a line longer than 2,000 characters (a paragraph of prose is ~1,000; a minified file or a
 *    base64 blob is far longer and has no runs of spaces) that ALSO holds a run of 64 or more spaces or tabs (aligned
 *    table and ASCII art lines are a few hundred characters at most, and their runs are 2 to 20). Either alone passes.
 */
export const PRE_PARSE_LIMITS = { linkOpeners: 50, emphasisRuns: 50, longLine: 2_000, spaceRun: 64 } as const;

const NEWLINE = 10;
const RETURN = 13;
const SPACE = 32;
const TAB = 9;
const STAR = 42;
const UNDERSCORE = 95;
const OPEN_BRACKET = 91;
const CLOSE_BRACKET = 93;
const OPEN_PAREN = 40;

/**
 * True when `text` is over any of {@link PRE_PARSE_LIMITS}: a SINGLE LINEAR PASS over the characters (no regular expression,
 * nothing to backtrack, nothing copied), so what it costs is the length of the text and nothing an author controls.
 *
 * What it counts, precisely. A PARAGRAPH is a run of lines with no blank line (only spaces and tabs) in it; a line ends at
 * LF, CR or CRLF (one end, not two). In each paragraph it counts
 *  - LINK OPENERS: every `[` (an image's `![` and a reference's `[x]` too) and, separately, every `](`; the paragraph is over
 *    when either count passes the limit, so a link `[a](b)` is one of each;
 *  - EMPHASIS RUNS: every maximal run of `*` or of `_`, whatever its length (`**` is one, `*_` is two).
 * and in each line the longest run of spaces and tabs and the line's length.
 *
 * EVERYWHERE, CODE BLOCKS INCLUDED. Skipping fenced code would be cheap but not exact: Durian, CommonMark and the Markdown
 * reader disagree about where a fence is (`fence-boundaries.ts`), so a count that trusts one fence reader can be made blind to
 * text another one reads as prose. The price is a false positive on a code block or a log of more than fifty brackets with
 * no blank line, which is shown as plain text (the message, whole, readable): a message that is a wall of brackets is not
 * one this app tries to dress.
 */
export function exceedsPreParseLimits(text: string): boolean {
  const { linkOpeners, emphasisRuns, longLine, spaceRun } = PRE_PARSE_LIMITS;
  let brackets = 0;
  let destinations = 0;
  let emphasis = 0;
  let lineStart = 0;
  let blank = true;
  let run = 0;
  let longestRun = 0;
  for (let at = 0; at <= text.length; at++) {
    const code = at === text.length ? NEWLINE : text.charCodeAt(at);
    if (code === NEWLINE || code === RETURN) {
      if (at - lineStart > longLine && longestRun >= spaceRun) return true;
      // CRLF is one line end: step over its LF, or the pair would read as a blank line.
      if (code === RETURN && text.charCodeAt(at + 1) === NEWLINE) at++;
      if (blank) {
        brackets = 0;
        destinations = 0;
        emphasis = 0;
      }
      lineStart = at + 1;
      blank = true;
      run = 0;
      longestRun = 0;
      continue;
    }
    if (code === SPACE || code === TAB) {
      run++;
      if (run > longestRun) longestRun = run;
      continue;
    }
    run = 0;
    blank = false;
    if (code === OPEN_BRACKET) {
      if (++brackets > linkOpeners) return true;
    } else if (code === CLOSE_BRACKET && text.charCodeAt(at + 1) === OPEN_PAREN) {
      if (++destinations > linkOpeners) return true;
    } else if ((code === STAR || code === UNDERSCORE) && text.charCodeAt(at - 1) !== code) {
      if (++emphasis > emphasisRuns) return true;
    }
  }
  return false;
}

/** True when `text` is over `limit` bytes in UTF-8, measured only when its length cannot settle it (a UTF-16 unit is at most 3 bytes). */
function exceedsBytes(text: string, limit: number): boolean {
  if (text.length > limit) return true;
  if (text.length * 3 <= limit) return false;
  return encoder.encode(text).length > limit;
}

/** True when the message the author wrote is over {@link MESSAGE_LIMITS}, counted in UTF-8 bytes. */
export const exceedsMessageCap = (text: string): boolean => exceedsBytes(text, MESSAGE_LIMITS.maxInputBytes);

/** True when the text Durian would be given is over {@link PARSER_LIMITS}, counted in UTF-8 bytes. */
export const exceedsParserBudget = (text: string): boolean => exceedsBytes(text, PARSER_LIMITS.maxInputBytes);
