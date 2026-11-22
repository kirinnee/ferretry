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
